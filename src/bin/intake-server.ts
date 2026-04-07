#!/usr/bin/env node
import http = require('http');
import fs = require('fs');
import path = require('path');
import type { IntakeToLinearResult } from '../types';
const { intakeToLinear } = require('../lib/intake-runner');
const { loadConfig } = require('../lib/config');
const { getSecret } = require('../lib/secrets');
const { listJobs, jobsByState, loadStatus, readJson, healthCheck, packetPath, resultPath, jobDir, aggregateMetrics } = require('../lib/jobs');

const port: number = Number(process.env.CCP_INTAKE_PORT || 4318);
const vercelCfg = loadConfig('vercel', {});
const autoDispatch: boolean = String(process.env.CCP_INTAKE_AUTO_DISPATCH || 'true').toLowerCase() !== 'false';
const autoStart: boolean = String(process.env.CCP_INTAKE_AUTO_START || 'true').toLowerCase() !== 'false';
const maxConcurrent: number = Number(process.env.CCP_MAX_CONCURRENT || 1);

const ROOT: string = path.resolve(process.env.CCP_ROOT || path.join(__dirname, '..', '..'));
const REPOS_PATH: string = path.join(ROOT, 'configs', 'repos.json');
const DASHBOARD_PATH: string = path.join(__dirname, '..', 'dashboard', 'index.html');

const { dispatchLinearIssues } = require('../lib/linear-dispatch');
const { runSupervisorCycle } = require('../lib/jobs');

// Debounce Linear webhook processing to avoid duplicate rapid-fire triggers
let _linearWebhookTimeout: ReturnType<typeof setTimeout> | null = null;
const LINEAR_WEBHOOK_DEBOUNCE_MS = 3000;

async function handleLinearWebhook(payload: Record<string, unknown>, res: http.ServerResponse): Promise<void> {
  const action = payload.action as string;
  const type = payload.type as string;
  const data = payload.data as Record<string, unknown> | undefined;
  const identifier = data?.identifier || data?.id || 'unknown';

  process.stdout.write(`[linear-webhook] ${action} ${type} ${identifier}\n`);

  if (type !== 'Issue' || (action !== 'create' && action !== 'update')) {
    json(res, 200, { ok: true, ignored: true, reason: `${action} ${type} not actionable` });
    return;
  }

  // Ignore updates triggered by our own API key to prevent feedback loops.
  // Linear includes updatedFrom with changed fields — if the only changes are
  // state or comment-related, it's likely our own sync. Also check actor.
  if (action === 'update') {
    const updatedFrom = payload.updatedFrom as Record<string, unknown> | undefined;
    const changedFields = updatedFrom ? Object.keys(updatedFrom) : [];
    // If the only changes are state, stateId, or updatedAt — skip (our own sync)
    const ownUpdateFields = new Set(['stateId', 'state', 'updatedAt', 'sortOrder', 'startedAt', 'completedAt', 'canceledAt', 'triagedAt']);
    const isOwnUpdate = changedFields.length > 0 && changedFields.every((f) => ownUpdateFields.has(f));
    if (isOwnUpdate) {
      process.stdout.write(`[linear-webhook] skipping own state update for ${identifier} (fields: ${changedFields.join(', ')})\n`);
      json(res, 200, { ok: true, ignored: true, reason: 'own state update' });
      return;
    }
    // Also skip if no meaningful fields changed at all
    if (changedFields.length === 0) {
      process.stdout.write(`[linear-webhook] skipping update with no changed fields for ${identifier}\n`);
      json(res, 200, { ok: true, ignored: true, reason: 'no changed fields' });
      return;
    }
    process.stdout.write(`[linear-webhook] processing update for ${identifier} (changed: ${changedFields.join(', ')})\n`);
  }

  json(res, 200, { ok: true, queued: true, action, type, identifier });

  if (_linearWebhookTimeout) clearTimeout(_linearWebhookTimeout);
  _linearWebhookTimeout = setTimeout(async () => {
    _linearWebhookTimeout = null;
    try {
      process.stdout.write(`[linear-webhook] dispatching + supervisor cycle\n`);
      const dispatched = await dispatchLinearIssues();
      const started = dispatched.filter((d: { queued?: boolean }) => d.queued);
      if (started.length > 0) {
        process.stdout.write(`[linear-webhook] dispatched ${started.length} new jobs, running supervisor\n`);
        await runSupervisorCycle({ maxConcurrent });
      }
    } catch (error) {
      process.stderr.write(`[linear-webhook] error: ${(error as Error).message}\n`);
    }
  }, LINEAR_WEBHOOK_DEBOUNCE_MS);
}

function json(res: http.ServerResponse, status: number, payload: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json', 'access-control-allow-origin': '*' });
  res.end(JSON.stringify(payload, null, 2) + '\n');
}

function parseBody(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk: string) => { data += chunk; });
    req.on('end', () => {
      try {
        resolve(data ? JSON.parse(data) : {});
      } catch (error) {
        reject(error);
      }
    });
    req.on('error', reject);
  });
}

function verifyVercel(req: http.IncomingMessage): boolean {
  const expected = getSecret(vercelCfg.webhookSecretEnv || 'VERCEL_WEBHOOK_SECRET');
  if (!expected) return true;
  const provided = (req.headers['x-vercel-signature'] || req.headers['x-webhook-secret'] || '') as string;
  return provided === expected;
}

// ── Dashboard & API routes ──

function serveDashboard(res: http.ServerResponse): void {
  try {
    const html = fs.readFileSync(DASHBOARD_PATH, 'utf8');
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(html);
  } catch (err) {
    res.writeHead(500, { 'content-type': 'text/plain' });
    res.end('Dashboard not found: ' + (err as Error).message);
  }
}

function handleGetJobs(url: URL, res: http.ServerResponse): void {
  const state = url.searchParams.get('state');
  const limit = Number(url.searchParams.get('limit')) || 200;
  let jobs = listJobs();
  if (state) jobs = jobs.filter((j: { state: string }) => j.state === state);
  const enriched = jobs.slice(0, limit).map((job: Record<string, unknown>) => {
    try {
      const result = readJson(resultPath(job.job_id as string)) as Record<string, unknown>;
      if (result?.pr_url) return { ...job, pr_url: result.pr_url };
    } catch (e) { console.error(`[ccp] failed to read result for ${job.job_id}: ${(e as Error).message}`); }
    return job;
  });
  json(res, 200, enriched);
}

function handleGetJob(jobId: string, res: http.ServerResponse): void {
  try {
    const status = loadStatus(jobId);
    let packet: unknown = null;
    let result: unknown = null;
    let logTail: string | null = null;
    try { packet = readJson(packetPath(jobId)); } catch (e) { console.error(`[ccp] failed to read packet for ${jobId}: ${(e as Error).message}`); }
    try { result = readJson(resultPath(jobId)); } catch (e) { console.error(`[ccp] failed to read result for ${jobId}: ${(e as Error).message}`); }
    try {
      const logFile = path.join(jobDir(jobId), 'worker.log');
      if (fs.existsSync(logFile)) {
        const content = fs.readFileSync(logFile, 'utf8');
        logTail = content.slice(-2000);
      }
    } catch (e) { console.error(`[ccp] failed to read worker log for ${jobId}: ${(e as Error).message}`); }
    json(res, 200, { status, packet, result, logTail });
  } catch (err) {
    json(res, 404, { ok: false, error: 'job not found: ' + (err as Error).message });
  }
}

function handleGetRepos(res: http.ServerResponse): void {
  try {
    const repos = readJson(REPOS_PATH);
    json(res, 200, repos);
  } catch (err) {
    json(res, 500, { ok: false, error: (err as Error).message });
  }
}

async function handlePutRepo(key: string, req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  try {
    const body = await parseBody(req);
    const repos = readJson(REPOS_PATH);
    const idx = (repos.mappings as Array<Record<string, unknown>>).findIndex((r) => r.key === key);
    if (idx === -1) { json(res, 404, { ok: false, error: 'repo not found: ' + key }); return; }

    if (body.autoMerge !== undefined) (repos.mappings as Array<Record<string, unknown>>)[idx].autoMerge = !!body.autoMerge;
    if (body.mergeMethod !== undefined) {
      if (!['squash', 'merge', 'rebase'].includes(body.mergeMethod as string)) {
        json(res, 400, { ok: false, error: 'invalid mergeMethod' });
        return;
      }
      (repos.mappings as Array<Record<string, unknown>>)[idx].mergeMethod = body.mergeMethod;
    }
    if (body.nightly !== undefined && typeof body.nightly === 'object') {
      const mappings = repos.mappings as Array<Record<string, unknown>>;
      mappings[idx].nightly = { ...(mappings[idx].nightly as Record<string, unknown> || {}), ...(body.nightly as Record<string, unknown>) };
    }

    fs.writeFileSync(REPOS_PATH, JSON.stringify(repos, null, 2) + '\n');
    json(res, 200, { ok: true, repo: (repos.mappings as Array<Record<string, unknown>>)[idx] });
  } catch (err) {
    json(res, 500, { ok: false, error: (err as Error).message });
  }
}

function handleGetScheduling(res: http.ServerResponse): void {
  try {
    const { isPeakHour, canDispatchJobs, loadConfig } = require('../lib/scheduling');
    const config = loadConfig();
    const status = isPeakHour();
    const dispatch = canDispatchJobs();
    json(res, 200, { config, status, dispatch });
  } catch (err) {
    json(res, 500, { ok: false, error: (err as Error).message });
  }
}

function handleGetHealth(res: http.ServerResponse): void {
  try {
    json(res, 200, healthCheck());
  } catch (err) {
    json(res, 500, { ok: false, error: (err as Error).message });
  }
}

function handleGetMetrics(url: URL, res: http.ServerResponse): void {
  try {
    const sinceDays = Number(url.searchParams.get('days') || 7);
    json(res, 200, aggregateMetrics({ sinceDays }));
  } catch (err) {
    json(res, 500, { ok: false, error: (err as Error).message });
  }
}

function handleGetStats(res: http.ServerResponse): void {
  try {
    const buckets = jobsByState();
    const counts = Object.fromEntries(Object.entries(buckets).map(([k, v]) => [k, (v as unknown[]).length]));
    const allJobsList = listJobs();
    const now = Date.now();
    const oneDayAgo = now - 86400000;
    const sevenDaysAgo = now - 7 * 86400000;

    const recentDay = allJobsList.filter((j: { updated_at: string }) => new Date(j.updated_at).getTime() > oneDayAgo);
    const recentWeek = allJobsList.filter((j: { updated_at: string }) => new Date(j.updated_at).getTime() > sevenDaysAgo);

    const dailyDone = recentDay.filter((j: { state: string }) => ['coded', 'done', 'verified'].includes(j.state)).length;
    const weeklyDone = recentWeek.filter((j: { state: string }) => ['coded', 'done', 'verified'].includes(j.state)).length;
    const dailyTotal = recentDay.length;
    const weeklyTotal = recentWeek.length;

    // Merge rate: of coded/done/verified jobs, how many have merged (state=verified or done with prReview.merged)
    const codedJobs = allJobsList.filter((j: { state: string }) => ['coded', 'done', 'verified'].includes(j.state));
    const mergedJobs = allJobsList.filter((j: { state: string; integrations?: Record<string, unknown> }) =>
      j.state === 'verified' || (j.state === 'done' && (j.integrations as Record<string, unknown>)?.prReview && ((j.integrations as Record<string, unknown>).prReview as Record<string, unknown>)?.merged)
    );
    const mergeRate = codedJobs.length > 0 ? Math.round((mergedJobs.length / codedJobs.length) * 100) : 0;
    const blockedRate = allJobsList.length > 0 ? Math.round(((counts.blocked || 0) + (counts.failed || 0)) / allJobsList.length * 100) : 0;

    // Avg duration of completed jobs (last 7 days)
    const completedWithDuration = recentWeek.filter((j: { state: string; elapsed_sec?: number }) =>
      ['coded', 'done', 'verified'].includes(j.state) && j.elapsed_sec && j.elapsed_sec > 0
    );
    const avgDuration = completedWithDuration.length > 0
      ? Math.round(completedWithDuration.reduce((sum: number, j: { elapsed_sec: number }) => sum + j.elapsed_sec, 0) / completedWithDuration.length)
      : 0;

    json(res, 200, {
      counts,
      daily: { total: dailyTotal, completed: dailyDone },
      weekly: { total: weeklyTotal, completed: weeklyDone },
      mergeRate,
      blockedRate,
      avgDuration,
      mergedCount: mergedJobs.length,
      codedCount: codedJobs.length,
    });
  } catch (err) {
    json(res, 500, { ok: false, error: (err as Error).message });
  }
}

// ── SSE: Server-Sent Events for real-time activity feed ──
const sseClients: Set<http.ServerResponse> = new Set();
let lastJobSnapshot: string = '';

function broadcastSSE(event: string, data: unknown): void {
  const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const client of sseClients) {
    try { client.write(msg); } catch { sseClients.delete(client); }
  }
}

function handleSSE(res: http.ServerResponse): void {
  res.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache',
    'connection': 'keep-alive',
    'access-control-allow-origin': '*',
  });
  res.write(`event: connected\ndata: ${JSON.stringify({ time: new Date().toISOString() })}\n\n`);
  sseClients.add(res);
  res.on('close', () => sseClients.delete(res));
}

// Poll for job changes and broadcast to SSE clients
setInterval(() => {
  if (sseClients.size === 0) return;
  try {
    const jobs = listJobs().slice(0, 50);
    const snapshot = JSON.stringify(jobs.map((j: { job_id: string; state: string; updated_at: string }) => `${j.job_id}:${j.state}:${j.updated_at}`));
    if (snapshot !== lastJobSnapshot) {
      lastJobSnapshot = snapshot;
      broadcastSSE('jobs', jobs);
    }
  } catch (e) { console.error(`[ccp] SSE polling error: ${(e as Error).message}`); }
}, 5000);

const server = http.createServer(async (req: http.IncomingMessage, res: http.ServerResponse) => {
  // Handle CORS preflight
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'access-control-allow-origin': '*',
      'access-control-allow-methods': 'GET, POST, PUT, OPTIONS',
      'access-control-allow-headers': 'content-type',
    });
    res.end();
    return;
  }

  try {
    const url = new URL(req.url!, `http://${req.headers.host}`);

    // ── Dashboard ──
    if (req.method === 'GET' && url.pathname === '/') {
      res.writeHead(302, { Location: '/dashboard' });
      res.end();
      return;
    }
    if (req.method === 'GET' && (url.pathname === '/dashboard' || url.pathname === '/dashboard/')) {
      serveDashboard(res);
      return;
    }

    // ── API: GET routes ──
    if (req.method === 'GET') {
      if (url.pathname === '/api/jobs') { handleGetJobs(url, res); return; }
      if (url.pathname === '/api/health') { handleGetHealth(res); return; }
      if (url.pathname === '/api/stats') { handleGetStats(res); return; }
      if (url.pathname === '/api/metrics') { handleGetMetrics(url, res); return; }
      if (url.pathname === '/api/repos') { handleGetRepos(res); return; }
      if (url.pathname === '/api/scheduling') { handleGetScheduling(res); return; }
      if (url.pathname === '/api/events') { handleSSE(res); return; }
      const jobMatch = url.pathname.match(/^\/api\/jobs\/(.+)$/);
      if (jobMatch) { handleGetJob(decodeURIComponent(jobMatch[1]), res); return; }
    }

    // ── API: PUT routes ──
    if (req.method === 'PUT') {
      const repoMatch = url.pathname.match(/^\/api\/repos\/(.+)$/);
      if (repoMatch) { await handlePutRepo(decodeURIComponent(repoMatch[1]), req, res); return; }
    }

    // ── Ingest routes (existing) ──
    if (req.method !== 'POST') {
      json(res, 405, { ok: false, error: 'method not allowed' });
      return;
    }

    const payload = await parseBody(req);

    if (url.pathname === '/ingest/vercel') {
      if (!verifyVercel(req)) { json(res, 403, { ok: false, error: 'bad webhook secret' }); return; }
      json(res, 200, await intakeToLinear('vercel', payload, { autoDispatch, autoStart, maxConcurrent }));
      return;
    }

    if (url.pathname === '/ingest/sentry') {
      const sentryAction = (payload.action || '') as string;
      const sentryResource = (payload.resource || '') as string;
      if (sentryResource === 'installation' || sentryAction === 'installation') {
        process.stdout.write(`[sentry-webhook] lifecycle event: ${sentryAction} ${sentryResource}\n`);
        json(res, 200, { ok: true, action: 'ack-lifecycle' });
        return;
      }
      if (payload.action && (payload.data as Record<string, unknown>)?.issue) {
        if (['resolved', 'ignored', 'archived'].includes(sentryAction)) {
          process.stdout.write(`[sentry-webhook] skipping ${sentryAction} issue\n`);
          json(res, 200, { ok: true, action: 'skipped', reason: sentryAction });
          return;
        }
        const issue = (payload.data as Record<string, unknown>).issue as Record<string, unknown>;
        process.stdout.write(`[sentry-webhook] processing ${sentryAction} issue: ${issue.shortId || issue.title}\n`);
      }
      json(res, 200, await intakeToLinear('sentry', payload, { autoDispatch, autoStart, maxConcurrent }));
      return;
    }

    if (url.pathname === '/ingest/manual') {
      json(res, 200, await intakeToLinear('manual', payload, { autoDispatch, autoStart, maxConcurrent }));
      return;
    }

    // ── App intake (proteusx-seo control-plane client) ──
    if (url.pathname === '/api/intake') {
      // Verify HMAC signature if CONTROL_PLANE_SECRET is set
      const secret = process.env.CONTROL_PLANE_SECRET;
      if (secret) {
        const sigHeader = (req.headers['x-signature-256'] || '') as string;
        const rawBody = JSON.stringify(payload);
        const expected = `sha256=${require('crypto').createHmac('sha256', secret).update(rawBody).digest('hex')}`;
        if (!sigHeader || sigHeader !== expected) {
          json(res, 403, { ok: false, error: 'bad signature' });
          return;
        }
      }

      // Map app fix request to Linear ticket
      const fixId = (payload.fixId || '') as string;
      const title = (payload.title || 'App-dispatched fix request') as string;
      const description = (payload.description || '') as string;
      const issueType = (payload.issueType || 'fix') as string;
      const pageUrl = (payload.pageUrl || null) as string | null;
      const severity = (payload.severity || 'medium') as string;
      const cmsType = (payload.cmsType || null) as string | null;
      const fixInstructions = payload.fixInstructions as Record<string, unknown> | null;
      const context = payload.context as Record<string, unknown> || {};
      const webhookUrl = (payload.webhookUrl || null) as string | null;

      // Resolve repo from context — auto-onboard if unknown
      const repoTag = (context.repo || context.ownerRepo) as string | undefined;
      if (!repoTag) {
        return json(res, 400, { error: 'Missing context.repo — cannot determine target repository' });
      }
      const { findRepoMapping } = require('../lib/repos');
      let repoMapping = findRepoMapping({ repo: repoTag, repoKey: repoTag });
      if (!repoMapping) {
        // Auto-onboard: clone, add to repos.json, set up webhook
        console.log(`[intake] Auto-onboarding unknown repo: ${repoTag}`);
        try {
          const { onboardRepo } = require('../lib/onboard-repo');
          const onboardResult = await onboardRepo(repoTag);
          if (!onboardResult.ok) {
            return json(res, 400, { error: `Failed to onboard repo ${repoTag}: ${onboardResult.error}` });
          }
          console.log(`[intake] Onboarded ${repoTag}: ${onboardResult.steps.map((s: { name: string; result: string }) => `${s.name}=${s.result}`).join(', ')}`);
          // Re-resolve after onboarding
          repoMapping = findRepoMapping({ repo: repoTag, repoKey: repoTag });
          if (!repoMapping) {
            return json(res, 500, { error: `Onboarded ${repoTag} but still cannot resolve mapping` });
          }
        } catch (e: unknown) {
          const msg = e instanceof Error ? e.message : String(e);
          return json(res, 400, { error: `Failed to onboard repo ${repoTag}: ${msg}` });
        }
      }

      // Build structured description for CCP worker
      const descParts: string[] = [
        `**Repo:** ${repoMapping?.ownerRepo || repoTag}`,
        '',
        description,
      ];
      if (pageUrl) descParts.push('', `**Affected URL:** ${pageUrl}`);
      if (severity !== 'medium') descParts.push(`**Severity:** ${severity}`);
      if (cmsType) descParts.push(`**CMS:** ${cmsType}`);
      if (fixInstructions) descParts.push('', '**Fix Instructions:**', '```json', JSON.stringify(fixInstructions, null, 2), '```');

      const intakePayload = {
        title,
        summary: description,
        description: descParts.join('\n'),
        repo: repoMapping?.localPath || null,
        repoKey: repoMapping?.key || null,
        ownerRepo: repoMapping?.ownerRepo || repoTag,
        kind: issueType,
        label: severity === 'critical' ? 'bug' : 'feature',
        source: 'app',
        metadata: {
          fixId,
          pageUrl,
          severity,
          cmsType,
          webhookUrl,
          ...(context || {}),
        },
      };

      const result = await intakeToLinear('manual', intakePayload, { autoDispatch, autoStart, maxConcurrent });

      json(res, 200, {
        requestId: fixId || result.identifier || 'unknown',
        linearTicketId: result.identifier || null,
        linearTicketUrl: result.url || null,
        status: 'queued',
      });
      return;
    }

    // Onboard a new repo
    if (url.pathname === '/api/onboard') {
      try {
        const ownerRepo = (payload.ownerRepo || payload.repo) as string | undefined;
        if (!ownerRepo || !ownerRepo.includes('/')) {
          return json(res, 400, { error: 'Missing or invalid ownerRepo (expected owner/name)' });
        }
        const { onboardRepo } = require('../lib/onboard-repo');
        const result = await onboardRepo(ownerRepo);
        return json(res, result.ok ? 200 : 400, result);
      } catch (e: unknown) {
        return json(res, 500, { error: e instanceof Error ? e.message : String(e) });
      }
    }

    // GitHub webhook
    if (url.pathname === '/webhook/github') {
      const ghEvent = (req.headers['x-github-event'] || '') as string;
      const action = (payload.action || '') as string;

      if (ghEvent === 'check_run' && action === 'completed' && (payload.check_run as Record<string, unknown>)?.conclusion === 'failure') {
        const cr = payload.check_run as Record<string, unknown>;
        const repo = (payload.repository as Record<string, unknown>)?.full_name as string || '';
        const checkSuite = cr.check_suite as Record<string, unknown> | undefined;
        const branch = (checkSuite?.head_branch as string) || '';
        const sha = ((cr.head_sha as string) || '').slice(0, 7);
        const checkName = (cr.name as string) || 'unknown';
        const detailsUrl = (cr.details_url as string) || (cr.html_url as string) || '';

        const prs = (cr.pull_requests as Array<Record<string, unknown>>) || [];
        const prNum = (prs[0]?.number as number) || null;
        const prUrl = prNum ? `https://github.com/${repo}/pull/${prNum}` : null;

        process.stdout.write(`[github-webhook] check_run FAILURE: ${checkName} on ${repo}@${branch} (${sha})${prUrl ? ` PR#${prNum}` : ''}\n`);

        if (prUrl) {
          try {
            const { listJobs: lj, readJson: rj, resultPath: rp, packetPath: pp } = require('../lib/jobs');
            const { reviewPr: rp2 } = require('../lib/pr-review');
            const { findRepoMapping } = require('../lib/repos');
            const allJobs = lj();

            let matchedJob: { job: Record<string, unknown>; result: Record<string, unknown> } | null = null;
            for (const job of allJobs) {
              try {
                const jobResult = rj(rp(job.job_id));
                if (jobResult.pr_url === prUrl) { matchedJob = { job, result: jobResult }; break; }
              } catch { continue; }
            }

            if (matchedJob) {
              const { job, result: jobResult } = matchedJob;
              const packet = rj(pp(job.job_id));
              const { prReviewPolicy } = require('../lib/jobs');
              const policy = prReviewPolicy(packet?.repo);
              const review = rp2({ prUrl, autoMerge: false, mergeMethod: policy.mergeMethod });

              if (review.disposition === 'block') {
                const { maybeEnqueueReviewRemediation } = require('../lib/jobs');
                const remResult = maybeEnqueueReviewRemediation(job.job_id, packet, jobResult, review);
                process.stdout.write(`[github-webhook] remediation for ${job.job_id}: ${JSON.stringify(remResult)}\n`);
                json(res, 200, { ok: true, action: 'remediation-attempted', job_id: job.job_id, remediation: remResult });
                return;
              }
              json(res, 200, { ok: true, action: 'reviewed', job_id: job.job_id, disposition: review.disposition });
              return;
            }

            const repoMapping = findRepoMapping({ repo });
            if (repoMapping) {
              process.stdout.write(`[github-webhook] untracked CI failure on ${repo}#${prNum}, creating incident\n`);
              const incidentResult = await intakeToLinear('manual', {
                title: `CI failure: ${checkName} on PR #${prNum} (${branch})`,
                summary: `Check "${checkName}" failed on ${repo}@${sha}. PR: ${prUrl}. Details: ${detailsUrl}`,
                repo: repoMapping.localPath,
                repoKey: repoMapping.key,
                kind: 'ci-failure',
                label: 'deploy',
                priority: 2, // CI failures are high priority
                metadata: { checkName, branch, sha, prUrl, detailsUrl, prNum },
              }, { autoDispatch, autoStart, maxConcurrent });
              json(res, 200, { ok: true, action: 'incident-created', ...incidentResult });
              return;
            }
          } catch (error) {
            process.stderr.write(`[github-webhook] error processing check_run: ${(error as Error).message}\n`);
          }
        }

        json(res, 200, { ok: true, action: 'ack', event: ghEvent });
        return;
      }

      if (ghEvent === 'pull_request' && action === 'closed' && (payload.pull_request as Record<string, unknown>)?.merged) {
        const pr = payload.pull_request as Record<string, unknown>;
        const repo = (payload.repository as Record<string, unknown>)?.full_name as string || '';
        const prUrl = (pr.html_url as string) || '';
        const mergedBy = ((pr.merged_by as Record<string, unknown>)?.login as string) || 'unknown';
        process.stdout.write(`[github-webhook] PR merged: ${repo}#${pr.number} ${pr.title}\n`);

        let matchedTicket: string | null = null;
        try {
          const { listJobs: lj, readJson: rj, resultPath: rp, saveStatus: ss, packetPath: pktPath } = require('../lib/jobs');
          const allJobs = lj();
          for (const job of allJobs) {
            try {
              const jobResult = rj(rp(job.job_id));
              if (jobResult.pr_url === prUrl) {
                try {
                  const pkt = rj(pktPath(job.job_id));
                  matchedTicket = pkt.ticket_id || null;
                } catch (e) { console.error(`[ccp] failed to read packet for ticket match: ${(e as Error).message}`); }
                if (job.state !== 'done' && job.state !== 'verified') {
                  ss(job.job_id, { state: 'verified' });
                  process.stdout.write(`[github-webhook] job ${job.job_id} → verified (PR merged)\n`);
                }
                break;
              }
            } catch { continue; }
          }
        } catch (error) {
          process.stderr.write(`[github-webhook] error processing PR merge: ${(error as Error).message}\n`);
        }

        // Post merge notification to Discord status channel
        try {
          const { sendDiscordMessage } = require('../lib/jobs');
          const statusChannel = process.env.CCP_DISCORD_STATUS_CHANNEL || process.env.CCP_DISCORD_REVIEW_CHANNEL || '';
          if (statusChannel) {
            const ticketLabel = matchedTicket || 'untracked';
            const repoName = repo.split('/').pop() || repo;
            const mergeMsg = `🔀 MERGED — ${ticketLabel} | ${repoName} | PR #${pr.number}\nTitle: ${(pr.title as string) || ''}\nMerged by: ${mergedBy}`;
            sendDiscordMessage(statusChannel, mergeMsg);
          }
        } catch (error) {
          process.stderr.write(`[github-webhook] error sending merge notification: ${(error as Error).message}\n`);
        }

        json(res, 200, { ok: true, action: 'pr-merged', pr: pr.number });
        return;
      }

      // ── PR review submitted → follow-up job with review feedback ──
      if (ghEvent === 'pull_request_review' && action === 'submitted') {
        const review = payload.review as Record<string, unknown>;
        const pr = payload.pull_request as Record<string, unknown>;
        const repo = (payload.repository as Record<string, unknown>)?.full_name as string || '';
        const reviewState = (review.state as string || '').toLowerCase();
        const reviewBody = (review.body as string) || '';
        const prUrl = (pr.html_url as string) || '';
        const prNum = pr.number as number;
        const branch = (pr.head as Record<string, unknown>)?.ref as string || '';
        const reviewer = (review.user as Record<string, unknown>)?.login as string || 'unknown';

        process.stdout.write(`[github-webhook] PR review: ${reviewState} on ${repo}#${prNum} by ${reviewer}\n`);

        // Only act on "changes_requested" reviews with a non-empty body
        if (reviewState === 'changes_requested' && reviewBody.trim()) {
          try {
            const { listJobs: lj, readJson: rj, resultPath: rp, packetPath: pp, createJob } = require('../lib/jobs');
            const { findRepoMapping } = require('../lib/repos');
            const allJobs = lj();

            // Find the original job that created this PR
            let matchedJob: { job: Record<string, unknown>; packet: Record<string, unknown> } | null = null;
            for (const job of allJobs) {
              try {
                const jobResult = rj(rp(job.job_id));
                if (jobResult.pr_url === prUrl) {
                  const packet = rj(pp(job.job_id));
                  matchedJob = { job, packet };
                  break;
                }
              } catch { continue; }
            }

            const repoMapping = findRepoMapping({ repo });
            if (matchedJob || repoMapping) {
              // ── Depth limit: max 3 review-feedback jobs per PR ──
              const MAX_REVIEW_FEEDBACK_DEPTH = 3;
              const existingFeedbackJobs = allJobs.filter((j: Record<string, unknown>) => {
                if (j.state === 'archived') return false;
                try {
                  const p = rj(pp(j.job_id));
                  return p.kind === 'review-feedback' && p.metadata?.prUrl === prUrl;
                } catch { return false; }
              });
              if (existingFeedbackJobs.length >= MAX_REVIEW_FEEDBACK_DEPTH) {
                process.stdout.write(`[github-webhook] review-feedback depth limit (${MAX_REVIEW_FEEDBACK_DEPTH}) reached for ${repo}#${prNum} — skipping\n`);
                json(res, 200, { ok: true, action: 'review-feedback-depth-limit', pr: prNum, existing: existingFeedbackJobs.length });
                return;
              }

              const originalPacket = matchedJob?.packet as Record<string, unknown> | undefined;
              const feedbackLines = reviewBody.split('\n').filter((l: string) => l.trim());

              const reviewPacket = {
                ticket_id: (originalPacket?.ticket_id as string) || `review-${repo.replace('/', '-')}-${prNum}`,
                repo: (originalPacket?.repo as string) || repoMapping?.localPath || null,
                repoKey: (originalPacket?.repoKey as string) || repoMapping?.key || null,
                ownerRepo: (originalPacket?.ownerRepo as string) || repo,
                goal: `Address PR review feedback on #${prNum}: ${feedbackLines[0] || reviewBody.slice(0, 100)}`,
                source: 'github-review',
                kind: 'review-feedback',
                label: 'review',
                priority: 2, // Review feedback is high priority
                review_feedback: feedbackLines,
                working_branch: branch,
                constraints: [
                  `This is a follow-up to PR #${prNum} (${prUrl}).`,
                  `Reviewer ${reviewer} requested changes.`,
                  'Address ALL review comments. Do not close or recreate the PR — push fixes to the existing branch.',
                ],
                metadata: {
                  prUrl,
                  prNum,
                  reviewer,
                  reviewState,
                  originalJobId: matchedJob?.job.job_id || null,
                },
              };

              const created = createJob(reviewPacket);
              if (created.deduplicated) {
                process.stdout.write(`[github-webhook] review-feedback job deduplicated for ${repo}#${prNum} (existing: ${created.jobId})\n`);
                json(res, 200, { ok: true, action: 'review-feedback-deduplicated', job_id: created.jobId, pr: prNum });
                return;
              }
              process.stdout.write(`[github-webhook] created review-feedback job ${created.jobId} for ${repo}#${prNum}\n`);

              if (autoStart) {
                await runSupervisorCycle({ maxConcurrent });
              }

              json(res, 200, { ok: true, action: 'review-feedback-job-created', job_id: created.jobId, pr: prNum, reviewer });
              return;
            }
          } catch (error) {
            process.stderr.write(`[github-webhook] error processing PR review: ${(error as Error).message}\n`);
          }
        }

        json(res, 200, { ok: true, action: 'ack', event: ghEvent, reviewState });
        return;
      }

      json(res, 200, { ok: true, action: 'ack', event: ghEvent });
      return;
    }

    // Linear webhook
    if (url.pathname === '/webhook/linear') {
      await handleLinearWebhook(payload, res);
      return;
    }

    json(res, 404, { ok: false, error: 'not found' });
  } catch (error) {
    json(res, 500, { ok: false, error: (error as Error).message });
  }
});

server.listen(port, () => {
  process.stdout.write(JSON.stringify({ ok: true, port, dashboard: `http://localhost:${port}/dashboard` }, null, 2) + '\n');
});
