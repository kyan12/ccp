#!/usr/bin/env node
import http = require('http');
import fs = require('fs');
import path = require('path');
import { execFile } from 'child_process';
import { promisify } from 'util';
const execFileAsync = promisify(execFile);
const { submitSentryToKanban } = require('../lib/sentry-kanban');
const { loadConfig } = require('../lib/config');
const { getSecret } = require('../lib/secrets');
const { constantTimeEquals: safeEquals, verifyHmacSha256, isLoopbackAddress } = require('../lib/webhook-auth');
const { listJobs, jobsByState, loadStatus, readJson, healthCheck, packetPath, resultPath, jobDir } = require('../lib/jobs');

const port: number = Number(process.env.CCP_INTAKE_PORT || 4318);
const vercelCfg = loadConfig('vercel', {});
const ROOT: string = path.resolve(process.env.CCP_ROOT || path.join(__dirname, '..', '..'));
const REPOS_PATH: string = path.join(ROOT, 'configs', 'repos.json');
const DASHBOARD_PATH: string = path.join(__dirname, '..', 'dashboard', 'index.html');

function json(res: http.ServerResponse, status: number, payload: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json', 'access-control-allow-origin': '*' });
  res.end(JSON.stringify(payload, null, 2) + '\n');
}

function retiredIntake(res: http.ServerResponse, source: string, retryable = false): void {
  if (retryable) res.setHeader('retry-after', '3600');
  json(res, retryable ? 503 : 410, {
    ok: false,
    retired: true,
    retryable,
    source,
    error: 'CCP intake is retired; submit this work through native Hermes Kanban (proteusx-engineering)',
  });
}

interface ParsedBody {
  payload: Record<string, unknown>;
  rawBody: Buffer;
}

class RequestBodyError extends Error {
  constructor(message: string, readonly statusCode: number) {
    super(message);
    this.name = 'RequestBodyError';
  }
}

function parseBody(req: http.IncomingMessage): Promise<ParsedBody> {
  return new Promise((resolve, reject) => {
    const configuredLimit = Number(process.env.CCP_INTAKE_MAX_BODY_BYTES || 1024 * 1024);
    const maxBodyBytes = Number.isFinite(configuredLimit) && configuredLimit > 0
      ? Math.floor(configuredLimit)
      : 1024 * 1024;
    const chunks: Buffer[] = [];
    let bodyBytes = 0;
    let settled = false;
    const contentLength = Number(req.headers['content-length'] || 0);
    if (Number.isFinite(contentLength) && contentLength > maxBodyBytes) {
      settled = true;
      req.resume();
      reject(new RequestBodyError(`request body exceeds ${maxBodyBytes} bytes`, 413));
      return;
    }
    req.on('data', (chunk: Buffer | string) => {
      if (settled) return;
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      bodyBytes += buffer.length;
      if (bodyBytes > maxBodyBytes) {
        settled = true;
        chunks.length = 0;
        reject(new RequestBodyError(`request body exceeds ${maxBodyBytes} bytes`, 413));
        return;
      }
      chunks.push(buffer);
    });
    req.on('end', () => {
      if (settled) return;
      settled = true;
      try {
        const rawBody = Buffer.concat(chunks);
        resolve({ payload: rawBody.length ? JSON.parse(rawBody.toString('utf8')) : {}, rawBody });
      } catch (error) {
        reject(error instanceof RequestBodyError ? error : new RequestBodyError('request body is not valid JSON', 400));
      }
    });
    req.on('error', (error) => {
      if (settled) return;
      settled = true;
      reject(error);
    });
  });
}

function verifyVercel(req: http.IncomingMessage): boolean {
  const expected = getSecret(vercelCfg.webhookSecretEnv || 'VERCEL_WEBHOOK_SECRET');
  if (!expected) return false;
  const provided = (req.headers['x-vercel-signature'] || req.headers['x-webhook-secret'] || '') as string;
  return !!provided && safeEquals(provided, expected);
}

function verifyGitHub(req: http.IncomingMessage, rawBody: Buffer): boolean {
  const expected = getSecret('GITHUB_WEBHOOK_SECRET');
  const provided = String(req.headers['x-hub-signature-256'] || '');
  return verifyHmacSha256(expected, rawBody, provided, 'sha256=');
}

function verifySentry(req: http.IncomingMessage, rawBody: Buffer): boolean {
  const expected = getSecret('SENTRY_CLIENT_SECRET');
  const provided = String(req.headers['sentry-hook-signature'] || '');
  return verifyHmacSha256(expected, rawBody, provided);
}

function verifyDecisionApi(req: http.IncomingMessage): boolean {
  const expected = getSecret(process.env.CCP_DECISION_API_TOKEN_ENV || 'CCP_DECISION_API_TOKEN') || process.env.CONTROL_PLANE_SECRET || '';
  if (!expected) return false;
  const auth = String(req.headers.authorization || '');
  const bearer = auth.toLowerCase().startsWith('bearer ') ? auth.slice(7).trim() : '';
  const provided = bearer || String(req.headers['x-control-plane-token'] || req.headers['x-decision-token'] || '').trim();
  return !!provided && safeEquals(provided, expected);
}

function verifyAdminApi(req: http.IncomingMessage): boolean {
  const host = String(req.headers.host || '').toLowerCase().replace(/:\d+$/, '');
  const forwarded = !!(req.headers['x-forwarded-for'] || req.headers['x-forwarded-proto'] || req.headers['forwarded']);
  const localHost = host === 'localhost' || host === '127.0.0.1' || host === '[::1]';
  const directLoopback = isLoopbackAddress(req.socket.remoteAddress) && localHost && !forwarded;
  return directLoopback || verifyDecisionApi(req);
}

function isSafeJobId(jobId: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(jobId);
}

async function ghApiJson(pathOrArgs: string | string[]): Promise<unknown> {
  const args = ['api', ...(Array.isArray(pathOrArgs) ? pathOrArgs : [pathOrArgs])];
  try {
    const { stdout } = await execFileAsync('gh', args, { encoding: 'utf8' });
    return JSON.parse(stdout || 'null');
  } catch (err: unknown) {
    const e = err as { stderr?: string; stdout?: string; message?: string };
    throw new Error((e.stderr || e.stdout || e.message || `gh ${args.join(' ')} failed`).trim());
  }
}

async function collectPrReviewFeedback(repo: string, prNum: number): Promise<string[]> {
  const out: string[] = [];
  const seen = new Set<string>();

  const push = (text: string | null | undefined): void => {
    const normalized = String(text || '').trim();
    if (!normalized || seen.has(normalized)) return;
    seen.add(normalized);
    out.push(normalized);
  };

  const [reviewComments, reviews, issueComments] = await Promise.all([
    ghApiJson(`repos/${repo}/pulls/${prNum}/comments`).catch((err: Error) => { console.error(`[intake] failed to fetch review comments for ${repo}#${prNum}: ${err.message}`); return []; }) as Promise<Array<Record<string, unknown>>>,
    ghApiJson(`repos/${repo}/pulls/${prNum}/reviews`).catch((err: Error) => { console.error(`[intake] failed to fetch reviews for ${repo}#${prNum}: ${err.message}`); return []; }) as Promise<Array<Record<string, unknown>>>,
    ghApiJson(`repos/${repo}/issues/${prNum}/comments`).catch((err: Error) => { console.error(`[intake] failed to fetch issue comments for ${repo}#${prNum}: ${err.message}`); return []; }) as Promise<Array<Record<string, unknown>>>,
  ]);

  for (const comment of reviewComments || []) {
    const body = String(comment?.body || '').trim();
    if (!body) continue;
    const author = String((comment?.user as Record<string, unknown> | undefined)?.login || 'unknown');
    const filePath = String(comment?.path || '').trim();
    const line = Number(comment?.line || comment?.original_line || 0) || null;
    push(`review-comment ${filePath}${line ? `:${line}` : ''} by ${author}: ${body}`);
  }

  for (const review of reviews || []) {
    const body = String(review?.body || '').trim();
    if (!body) continue;
    const author = String((review?.user as Record<string, unknown> | undefined)?.login || 'unknown');
    const state = String(review?.state || '').toUpperCase();
    push(`review ${state || 'COMMENTED'} by ${author}: ${body}`);
  }

  for (const comment of issueComments || []) {
    const body = String(comment?.body || '').trim();
    if (!body) continue;
    const author = String((comment?.user as Record<string, unknown> | undefined)?.login || 'unknown');
    push(`issue-comment by ${author}: ${body}`);
  }

  return out;
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
    const { payload: body } = await parseBody(req);
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
      const incoming = body.nightly as Record<string, unknown>;
      const nextNightly: Record<string, unknown> = { ...((mappings[idx].nightly as Record<string, unknown>) || {}) };
      if (incoming.enabled !== undefined) nextNightly.enabled = !!incoming.enabled;
      if (incoming.autoMerge !== undefined) nextNightly.autoMerge = !!incoming.autoMerge;
      if (incoming.branch !== undefined) nextNightly.branch = String(incoming.branch || '').trim() || 'main';
      if (incoming.timeoutSec !== undefined) {
        const timeoutSec = Number(incoming.timeoutSec);
        if (!Number.isFinite(timeoutSec) || timeoutSec <= 0) {
          json(res, 400, { ok: false, error: 'invalid nightly.timeoutSec' });
          return;
        }
        nextNightly.timeoutSec = Math.floor(timeoutSec);
      }
      mappings[idx].nightly = nextNightly;
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
      'access-control-allow-headers': 'content-type, authorization, x-control-plane-token, x-decision-token',
    });
    res.end();
    return;
  }

  try {
    const url = new URL(req.url!, `http://${req.headers.host}`);

    if (req.method === 'POST' && url.pathname === '/webhook/linear') {
      json(res, 410, { ok: false, retired: true, error: 'Linear intake is retired; use native Hermes Kanban' });
      return;
    }

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
      if (url.pathname === '/api/repos') { handleGetRepos(res); return; }
      if (url.pathname === '/api/scheduling') { handleGetScheduling(res); return; }
      if (url.pathname === '/api/events') { handleSSE(res); return; }
      const jobMatch = url.pathname.match(/^\/api\/jobs\/(.+)$/);
      if (jobMatch) { handleGetJob(decodeURIComponent(jobMatch[1]), res); return; }
    }

    // ── API: PUT routes ──
    if (req.method === 'PUT') {
      const repoMatch = url.pathname.match(/^\/api\/repos\/(.+)$/);
      if (repoMatch) {
        if (!verifyAdminApi(req)) { json(res, 403, { ok: false, error: 'admin API auth failed' }); return; }
        await handlePutRepo(decodeURIComponent(repoMatch[1]), req, res);
        return;
      }
    }

    // ── Ingest routes (existing) ──
    if (req.method !== 'POST') {
      json(res, 405, { ok: false, error: 'method not allowed' });
      return;
    }

    const { payload, rawBody } = await parseBody(req);

    const decisionMatch = url.pathname.match(/^\/api\/jobs\/(.+)\/decision$/);
    if (decisionMatch || url.pathname === '/api/decide') {
      if (!verifyDecisionApi(req)) { json(res, 403, { ok: false, error: 'decision API auth failed' }); return; }
      const jobId = decisionMatch ? decodeURIComponent(decisionMatch[1]) : String(payload.jobId || payload.job_id || '').trim();
      const choice = String(payload.choice || payload.option || payload.optionId || payload.option_id || '').trim();
      const note = payload.note == null ? undefined : String(payload.note);
      if (!jobId) { json(res, 400, { ok: false, error: 'jobId missing' }); return; }
      if (!isSafeJobId(jobId)) { json(res, 400, { ok: false, error: 'invalid jobId' }); return; }
      if (!choice) { json(res, 400, { ok: false, error: 'choice missing' }); return; }
      const { answerDecision } = require('../lib/jobs');
      const result = answerDecision(jobId, choice, note);
      json(res, result.ok ? 200 : 400, result);
      return;
    }

    if (url.pathname === '/ingest/vercel') {
      if (!verifyVercel(req)) { json(res, 403, { ok: false, error: 'bad webhook secret' }); return; }
      retiredIntake(res, 'vercel', true);
      return;
    }

    if (url.pathname === '/ingest/sentry') {
      if (!verifySentry(req, rawBody)) { json(res, 403, { ok: false, error: 'bad Sentry signature' }); return; }
      const sentryAction = (payload.action || '') as string;
      const sentryResource = (payload.resource || '') as string;
      if (sentryResource === 'installation' || sentryAction === 'installation') {
        process.stdout.write('[sentry-webhook] acknowledged lifecycle event\n');
        json(res, 200, { ok: true, action: 'ack-lifecycle' });
        return;
      }
      if (payload.action && (payload.data as Record<string, unknown>)?.issue) {
        if (['resolved', 'ignored', 'archived'].includes(sentryAction)) {
          process.stdout.write(`[sentry-webhook] skipping ${sentryAction} issue\n`);
          json(res, 200, { ok: true, action: 'skipped', reason: sentryAction });
          return;
        }
        process.stdout.write('[sentry-webhook] processing issue webhook\n');
      } else {
        process.stderr.write('[sentry-webhook] rejected malformed issue payload\n');
        json(res, 422, { ok: false, action: 'validation-failed', retryable: false, error: 'Sentry issue payload is missing data.issue' });
        return;
      }
      try {
        json(res, 200, await submitSentryToKanban(payload));
      } catch (error) {
        const intakeError = error as Error & { statusCode?: number };
        const status = typeof intakeError.statusCode === 'number' ? intakeError.statusCode : 503;
        const publicError = status >= 500 ? 'native Kanban task creation failed' : intakeError.message;
        process.stderr.write(
          `[sentry-webhook] native Kanban intake failed (HTTP ${status}): ${intakeError.stack || intakeError.message}\n`,
        );
        json(res, status, { ok: false, action: 'kanban-create-failed', retryable: status >= 500, error: publicError });
      }
      return;
    }

    if (url.pathname === '/ingest/manual') {
      if (!verifyAdminApi(req)) { json(res, 403, { ok: false, error: 'admin API auth failed' }); return; }
      retiredIntake(res, 'manual');
      return;
    }

    // ── App intake (proteusx-os control-plane client) ──
    if (url.pathname === '/api/intake') {
      // App intake is public, so fail closed unless a shared HMAC secret is configured.
      const secret = getSecret('CONTROL_PLANE_SECRET');
      const sigHeader = String(req.headers['x-signature-256'] || '');
      const rawValid = verifyHmacSha256(secret, rawBody, sigHeader, 'sha256=');
      // Keep compatibility with clients that sign their parsed JSON serialization.
      const legacyValid = verifyHmacSha256(secret, JSON.stringify(payload), sigHeader, 'sha256=');
      if (!rawValid && !legacyValid) {
        json(res, 403, { ok: false, error: 'bad signature' });
        return;
      }

      retiredIntake(res, 'app');
      return;
    }

    // Onboard a new repo
    if (url.pathname === '/api/onboard') {
      if (!verifyAdminApi(req)) { json(res, 403, { ok: false, error: 'admin API auth failed' }); return; }
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
      if (!verifyGitHub(req, rawBody)) { json(res, 403, { ok: false, error: 'bad GitHub signature' }); return; }
      const ghEvent = (req.headers['x-github-event'] || '') as string;
      const action = (payload.action || '') as string;

      if (
        (ghEvent === 'pull_request_review_comment' && action === 'created') ||
        (ghEvent === 'pull_request_review' && action === 'submitted') ||
        (ghEvent === 'issue_comment' && action === 'created')
      ) {
        try {
          const repo = (payload.repository as Record<string, unknown>)?.full_name as string || '';

          let prNum: number | null = null;
          let body = '';
          let context = '';
          let reviewState = '';

          if (ghEvent === 'pull_request_review_comment') {
            const comment = payload.comment as Record<string, unknown>;
            const pr = payload.pull_request as Record<string, unknown>;
            prNum = Number(pr?.number || 0) || null;
            body = String(comment?.body || '').trim();
            const path = String(comment?.path || '').trim();
            const line = Number(comment?.line || comment?.original_line || 0) || null;
            context = `${path}${line ? `:${line}` : ''}`;
          } else if (ghEvent === 'pull_request_review') {
            const review = payload.review as Record<string, unknown>;
            const pr = payload.pull_request as Record<string, unknown>;
            prNum = Number(pr?.number || 0) || null;
            body = String(review?.body || '').trim();
            reviewState = String(review?.state || '').toUpperCase();
          } else if (ghEvent === 'issue_comment') {
            const issue = payload.issue as Record<string, unknown>;
            const comment = payload.comment as Record<string, unknown>;
            if (issue?.pull_request) {
              prNum = Number(issue?.number || 0) || null;
              body = String(comment?.body || '').trim();
            }
          }

          if (!repo || !prNum || !body) {
            json(res, 200, { ok: true, action: 'ack', event: ghEvent, reason: 'missing-pr-or-body' });
            return;
          }

          const prUrl = `https://github.com/${repo}/pull/${prNum}`;
          process.stdout.write(`[github-webhook] ${ghEvent}:${action} on ${prUrl}${context ? ` (${context})` : ''}\n`);

          const { listJobs: lj, readJson: rj, resultPath: rp, packetPath: pp, maybeEnqueueReviewRemediation } = require('../lib/jobs');
          const allJobs = lj();

          let matchedJob: { job: Record<string, unknown>; result: Record<string, unknown> } | null = null;
          for (const job of allJobs) {
            try {
              const jobResult = rj(rp(job.job_id));
              if (jobResult.pr_url === prUrl) { matchedJob = { job, result: jobResult }; break; }
            } catch { continue; }
          }

          if (!matchedJob) {
            json(res, 200, { ok: true, action: 'ack', event: ghEvent, pr_url: prUrl, tracked: false });
            return;
          }

          const { job, result: jobResult } = matchedJob;
          const packet = rj(pp(job.job_id));
          const blockerText = `${ghEvent}${reviewState ? ` ${reviewState}` : ''}${context ? ` ${context}` : ''}: ${body}`;
          const blockers = await collectPrReviewFeedback(repo, prNum);
          if (blockers.length === 0) blockers.push(blockerText);
          const review = {
            ok: true,
            skipped: false,
            disposition: 'block',
            blockerType: 'review',
            blockers,
            failedChecks: [],
            merged: false,
            autoMergeEnabled: false,
          };
          const remResult = maybeEnqueueReviewRemediation(job.job_id, packet, jobResult, review);
          process.stdout.write(`[github-webhook] review-comment remediation for ${job.job_id} (${blockers.length} blockers): ${JSON.stringify(remResult)}\n`);
          json(res, 200, { ok: true, action: 'remediation-attempted', job_id: job.job_id, pr_url: prUrl, remediation: remResult });
          return;
        } catch (error) {
          process.stderr.write(`[github-webhook] error processing ${ghEvent}: ${(error as Error).message}\n`);
          json(res, 200, { ok: false, action: 'ack', event: ghEvent, error: (error as Error).message });
          return;
        }
      }

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
              process.stderr.write(`[github-webhook] untracked CI failure on ${repo}#${prNum}; CCP incident creation is retired\n`);
              retiredIntake(res, 'github-check-run', true);
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

      json(res, 200, { ok: true, action: 'ack', event: ghEvent });
      return;
    }

    json(res, 404, { ok: false, error: 'not found' });
  } catch (error) {
    const requestError = error as Error & { statusCode?: number };
    const status = typeof requestError.statusCode === 'number' ? requestError.statusCode : 500;
    const message = status >= 500 ? 'internal intake error' : requestError.message;
    if (status >= 500) {
      process.stderr.write(`[intake] unhandled request error (HTTP ${status}): ${requestError.stack || requestError.message}\n`);
    }
    json(res, status, { ok: false, error: message });
  }
});

server.listen(port, () => {
  process.stdout.write(JSON.stringify({ ok: true, port, dashboard: `http://localhost:${port}/dashboard` }, null, 2) + '\n');
});
