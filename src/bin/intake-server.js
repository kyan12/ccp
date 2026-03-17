#!/usr/bin/env node
const http = require('http');
const fs = require('fs');
const path = require('path');
const { intakeToLinear } = require('../lib/intake-runner');
const { loadConfig } = require('../lib/config');
const { getSecret } = require('../lib/secrets');
const { listJobs, jobsByState, loadStatus, readJson, healthCheck, packetPath, resultPath, jobDir } = require('../lib/jobs');

const port = Number(process.env.CCP_INTAKE_PORT || 4318);
const vercelCfg = loadConfig('vercel', {});
const autoDispatch = String(process.env.CCP_INTAKE_AUTO_DISPATCH || 'true').toLowerCase() !== 'false';
const autoStart = String(process.env.CCP_INTAKE_AUTO_START || 'true').toLowerCase() !== 'false';
const maxConcurrent = Number(process.env.CCP_MAX_CONCURRENT || 1);

const ROOT = path.resolve(process.env.CCP_ROOT || path.join(process.env.HOME || '/Users/crab', 'coding-control-plane'));
const REPOS_PATH = path.join(ROOT, 'configs', 'repos.json');
const DASHBOARD_PATH = path.join(__dirname, '..', 'dashboard', 'index.html');

const { dispatchLinearIssues } = require('../lib/linear-dispatch');
const { runSupervisorCycle } = require('../lib/jobs');

// Debounce Linear webhook processing to avoid duplicate rapid-fire triggers
let _linearWebhookTimeout = null;
const LINEAR_WEBHOOK_DEBOUNCE_MS = 3000;

async function handleLinearWebhook(payload, res) {
  const action = payload.action; // 'create', 'update', 'remove'
  const type = payload.type; // 'Issue', 'Comment', etc.
  const identifier = payload.data?.identifier || payload.data?.id || 'unknown';

  process.stdout.write(`[linear-webhook] ${action} ${type} ${identifier}\n`);

  // Only react to issue creates and state changes
  if (type !== 'Issue' || (action !== 'create' && action !== 'update')) {
    return json(res, 200, { ok: true, ignored: true, reason: `${action} ${type} not actionable` });
  }

  // Respond immediately, process async
  json(res, 200, { ok: true, queued: true, action, type, identifier });

  // Debounce: if multiple webhooks arrive in quick succession, only run once
  if (_linearWebhookTimeout) clearTimeout(_linearWebhookTimeout);
  _linearWebhookTimeout = setTimeout(async () => {
    _linearWebhookTimeout = null;
    try {
      process.stdout.write(`[linear-webhook] dispatching + supervisor cycle\n`);
      const dispatched = await dispatchLinearIssues();
      const started = dispatched.filter((d) => d.queued);
      if (started.length > 0) {
        process.stdout.write(`[linear-webhook] dispatched ${started.length} new jobs, running supervisor\n`);
        await runSupervisorCycle({ maxConcurrent });
      }
    } catch (error) {
      process.stderr.write(`[linear-webhook] error: ${error.message}\n`);
    }
  }, LINEAR_WEBHOOK_DEBOUNCE_MS);
}

function json(res, status, payload) {
  res.writeHead(status, { 'content-type': 'application/json', 'access-control-allow-origin': '*' });
  res.end(JSON.stringify(payload, null, 2) + '\n');
}

function parseBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk) => { data += chunk; });
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

function verifyVercel(req) {
  const expected = getSecret(vercelCfg.webhookSecretEnv || 'VERCEL_WEBHOOK_SECRET');
  if (!expected) return true;
  const provided = req.headers['x-vercel-signature'] || req.headers['x-webhook-secret'] || '';
  return provided === expected;
}

// ── Dashboard & API routes ──

function serveDashboard(res) {
  try {
    const html = fs.readFileSync(DASHBOARD_PATH, 'utf8');
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(html);
  } catch (err) {
    res.writeHead(500, { 'content-type': 'text/plain' });
    res.end('Dashboard not found: ' + err.message);
  }
}

function handleGetJobs(url, res) {
  const state = url.searchParams.get('state');
  const limit = Number(url.searchParams.get('limit')) || 200;
  let jobs = listJobs();
  if (state) jobs = jobs.filter(j => j.state === state);
  json(res, 200, jobs.slice(0, limit));
}

function handleGetJob(jobId, res) {
  try {
    const status = loadStatus(jobId);
    let packet = null;
    let result = null;
    let logTail = null;
    try { packet = readJson(packetPath(jobId)); } catch (_) {}
    try { result = readJson(resultPath(jobId)); } catch (_) {}
    try {
      const logFile = path.join(jobDir(jobId), 'worker.log');
      if (fs.existsSync(logFile)) {
        const content = fs.readFileSync(logFile, 'utf8');
        logTail = content.slice(-2000);
      }
    } catch (_) {}
    json(res, 200, { status, packet, result, logTail });
  } catch (err) {
    json(res, 404, { ok: false, error: 'job not found: ' + err.message });
  }
}

function handleGetRepos(res) {
  try {
    const repos = readJson(REPOS_PATH);
    json(res, 200, repos);
  } catch (err) {
    json(res, 500, { ok: false, error: err.message });
  }
}

async function handlePutRepo(key, req, res) {
  try {
    const body = await parseBody(req);
    const repos = readJson(REPOS_PATH);
    const idx = repos.mappings.findIndex(r => r.key === key);
    if (idx === -1) return json(res, 404, { ok: false, error: 'repo not found: ' + key });

    if (body.autoMerge !== undefined) repos.mappings[idx].autoMerge = !!body.autoMerge;
    if (body.mergeMethod !== undefined) {
      if (!['squash', 'merge', 'rebase'].includes(body.mergeMethod)) {
        return json(res, 400, { ok: false, error: 'invalid mergeMethod' });
      }
      repos.mappings[idx].mergeMethod = body.mergeMethod;
    }
    if (body.nightly !== undefined && typeof body.nightly === 'object') {
      repos.mappings[idx].nightly = { ...repos.mappings[idx].nightly, ...body.nightly };
    }

    fs.writeFileSync(REPOS_PATH, JSON.stringify(repos, null, 2) + '\n');
    json(res, 200, { ok: true, repo: repos.mappings[idx] });
  } catch (err) {
    json(res, 500, { ok: false, error: err.message });
  }
}

function handleGetHealth(res) {
  try {
    json(res, 200, healthCheck());
  } catch (err) {
    json(res, 500, { ok: false, error: err.message });
  }
}

function handleGetStats(res) {
  try {
    const buckets = jobsByState();
    const counts = Object.fromEntries(Object.entries(buckets).map(([k, v]) => [k, v.length]));
    json(res, 200, { counts });
  } catch (err) {
    json(res, 500, { ok: false, error: err.message });
  }
}

const server = http.createServer(async (req, res) => {
  // Handle CORS preflight
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'access-control-allow-origin': '*',
      'access-control-allow-methods': 'GET, POST, PUT, OPTIONS',
      'access-control-allow-headers': 'content-type',
    });
    return res.end();
  }

  try {
    const url = new URL(req.url, `http://${req.headers.host}`);

    // ── Dashboard ──
    if (req.method === 'GET' && (url.pathname === '/dashboard' || url.pathname === '/dashboard/')) {
      return serveDashboard(res);
    }

    // ── API: GET routes ──
    if (req.method === 'GET') {
      if (url.pathname === '/api/jobs') return handleGetJobs(url, res);
      if (url.pathname === '/api/health') return handleGetHealth(res);
      if (url.pathname === '/api/stats') return handleGetStats(res);
      if (url.pathname === '/api/repos') return handleGetRepos(res);
      const jobMatch = url.pathname.match(/^\/api\/jobs\/(.+)$/);
      if (jobMatch) return handleGetJob(decodeURIComponent(jobMatch[1]), res);
    }

    // ── API: PUT routes ──
    if (req.method === 'PUT') {
      const repoMatch = url.pathname.match(/^\/api\/repos\/(.+)$/);
      if (repoMatch) return await handlePutRepo(decodeURIComponent(repoMatch[1]), req, res);
    }

    // ── Ingest routes (existing) ──
    if (req.method !== 'POST') {
      return json(res, 405, { ok: false, error: 'method not allowed' });
    }

    const payload = await parseBody(req);

    if (url.pathname === '/ingest/vercel') {
      if (!verifyVercel(req)) return json(res, 403, { ok: false, error: 'bad webhook secret' });
      return json(res, 200, await intakeToLinear('vercel', payload, { autoDispatch, autoStart, maxConcurrent }));
    }

    if (url.pathname === '/ingest/sentry') {
      // Sentry internal integration sends installation.created and other lifecycle events — ack them
      const sentryAction = payload.action || '';
      const sentryResource = payload.resource || '';
      if (sentryResource === 'installation' || sentryAction === 'installation') {
        process.stdout.write(`[sentry-webhook] lifecycle event: ${sentryAction} ${sentryResource}\n`);
        return json(res, 200, { ok: true, action: 'ack-lifecycle' });
      }
      // Only process issue events
      if (payload.action && payload.data?.issue) {
        // Skip resolved/ignored — only create tickets for new/regressed issues
        if (['resolved', 'ignored', 'archived'].includes(payload.action)) {
          process.stdout.write(`[sentry-webhook] skipping ${payload.action} issue\n`);
          return json(res, 200, { ok: true, action: 'skipped', reason: payload.action });
        }
        process.stdout.write(`[sentry-webhook] processing ${payload.action} issue: ${payload.data.issue.shortId || payload.data.issue.title}\n`);
      }
      return json(res, 200, await intakeToLinear('sentry', payload, { autoDispatch, autoStart, maxConcurrent }));
    }

    if (url.pathname === '/ingest/manual') {
      return json(res, 200, await intakeToLinear('manual', payload, { autoDispatch, autoStart, maxConcurrent }));
    }

    // GitHub webhook — check_run failures and PR events
    if (url.pathname === '/webhook/github') {
      const ghEvent = req.headers['x-github-event'] || '';
      const action = payload.action || '';

      // check_run completed with failure
      if (ghEvent === 'check_run' && action === 'completed' && payload.check_run?.conclusion === 'failure') {
        const cr = payload.check_run;
        const repo = payload.repository?.full_name || '';
        const branch = cr.check_suite?.head_branch || '';
        const sha = cr.head_sha?.slice(0, 7) || '';
        const checkName = cr.name || 'unknown';
        const detailsUrl = cr.details_url || cr.html_url || '';

        // Find associated PR
        const prs = cr.pull_requests || [];
        const prNum = prs[0]?.number || null;
        const prUrl = prNum ? `https://github.com/${repo}/pull/${prNum}` : null;

        process.stdout.write(`[github-webhook] check_run FAILURE: ${checkName} on ${repo}@${branch} (${sha})${prUrl ? ` PR#${prNum}` : ''}\n`);

        // If there's a PR, find the matching job and trigger remediation
        if (prUrl) {
          try {
            const { listJobs, loadStatus, readJson, resultPath, packetPath, saveStatus } = require('../lib/jobs');
            const { reviewPr } = require('../lib/pr-review');
            const { findRepoMapping } = require('../lib/repos');
            const jobs = listJobs();

            // Find job with this PR URL
            let matchedJob = null;
            for (const job of jobs) {
              try {
                const result = readJson(resultPath(job.job_id));
                if (result.pr_url === prUrl) { matchedJob = { job, result }; break; }
              } catch { continue; }
            }

            if (matchedJob) {
              const { job, result } = matchedJob;
              const packet = readJson(packetPath(job.job_id));

              // Get per-repo policy for merge
              const { prReviewPolicy } = require('../lib/jobs');
              const policy = prReviewPolicy(packet?.repo);

              // Review the PR to get current state
              const review = reviewPr({ prUrl, autoMerge: false, mergeMethod: policy.mergeMethod });

              // Attempt remediation if blocked
              if (review.disposition === 'block') {
                const { maybeEnqueueReviewRemediation } = require('../lib/jobs');
                const remResult = maybeEnqueueReviewRemediation(job.job_id, packet, result, review);
                process.stdout.write(`[github-webhook] remediation for ${job.job_id}: ${JSON.stringify(remResult)}\n`);
                return json(res, 200, { ok: true, action: 'remediation-attempted', job_id: job.job_id, remediation: remResult });
              }
              return json(res, 200, { ok: true, action: 'reviewed', job_id: job.job_id, disposition: review.disposition });
            }

            // No matching job — create an incident for untracked CI failures
            const repoMapping = findRepoMapping({ repo });
            if (repoMapping) {
              process.stdout.write(`[github-webhook] untracked CI failure on ${repo}#${prNum}, creating incident\n`);
              const result = await intakeToLinear('manual', {
                title: `CI failure: ${checkName} on PR #${prNum} (${branch})`,
                summary: `Check "${checkName}" failed on ${repo}@${sha}. PR: ${prUrl}. Details: ${detailsUrl}`,
                repo: repoMapping.localPath,
                repoKey: repoMapping.key,
                kind: 'ci-failure',
                label: 'deploy',
                metadata: { checkName, branch, sha, prUrl, detailsUrl, prNum },
              }, { autoDispatch, autoStart, maxConcurrent });
              return json(res, 200, { ok: true, action: 'incident-created', ...result });
            }
          } catch (error) {
            process.stderr.write(`[github-webhook] error processing check_run: ${error.message}\n`);
          }
        }

        return json(res, 200, { ok: true, action: 'ack', event: ghEvent });
      }

      // PR merged — track for jobs
      if (ghEvent === 'pull_request' && action === 'closed' && payload.pull_request?.merged) {
        const pr = payload.pull_request;
        const repo = payload.repository?.full_name || '';
        const prUrl = pr.html_url || '';
        process.stdout.write(`[github-webhook] PR merged: ${repo}#${pr.number} ${pr.title}\n`);

        // Find matching job and mark as verified/merged
        try {
          const { listJobs, readJson, resultPath, saveStatus } = require('../lib/jobs');
          const jobs = listJobs();
          for (const job of jobs) {
            try {
              const result = readJson(resultPath(job.job_id));
              if (result.pr_url === prUrl && job.state !== 'done' && job.state !== 'verified') {
                saveStatus(job.job_id, { state: 'verified' });
                process.stdout.write(`[github-webhook] job ${job.job_id} → verified (PR merged)\n`);
                break;
              }
            } catch { continue; }
          }
        } catch (error) {
          process.stderr.write(`[github-webhook] error processing PR merge: ${error.message}\n`);
        }
        return json(res, 200, { ok: true, action: 'pr-merged', pr: pr.number });
      }

      return json(res, 200, { ok: true, action: 'ack', event: ghEvent });
    }

    // Linear webhook — triggered on issue create/update
    if (url.pathname === '/webhook/linear') {
      return handleLinearWebhook(payload, res);
    }

    return json(res, 404, { ok: false, error: 'not found' });
  } catch (error) {
    return json(res, 500, { ok: false, error: error.message });
  }
});

server.listen(port, () => {
  process.stdout.write(JSON.stringify({ ok: true, port, dashboard: `http://localhost:${port}/dashboard` }, null, 2) + '\n');
});
