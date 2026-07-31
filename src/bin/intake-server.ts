#!/usr/bin/env node
import http = require('http');
import fs = require('fs');
import path = require('path');
const { loadConfig } = require('../lib/config');
const { getSecret } = require('../lib/secrets');
const { constantTimeEquals: safeEquals, verifyHmacSha256, isLoopbackAddress } = require('../lib/webhook-auth');
const { retiredGitHubWebhookResponse } = require('../lib/github-webhook-retirement');
const { submitSentryToKanban } = require('../lib/sentry-kanban');
const { listJobs, jobsByState, loadStatus, readJson, healthCheck, packetPath, resultPath, jobDir } = require('../lib/jobs');

const port: number = Number(process.env.CCP_INTAKE_PORT || 4318);
const vercelCfg = loadConfig('vercel', {});
const ROOT: string = path.resolve(process.env.CCP_ROOT || path.join(__dirname, '..', '..'));
const REPOS_PATH: string = path.join(ROOT, 'configs', 'repos.json');
const DASHBOARD_PATH: string = path.join(__dirname, '..', 'dashboard', 'index.html');
class RequestBodyError extends Error {
  constructor(message: string, readonly statusCode: number) {
    super(message);
    this.name = 'RequestBodyError';
  }
}

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

function readRawBody(req: http.IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const configuredLimit = Number(process.env.CCP_INTAKE_MAX_BODY_BYTES || 1024 * 1024);
    const maxBodyBytes = Number.isFinite(configuredLimit) && configuredLimit > 0
      ? Math.floor(configuredLimit)
      : 1024 * 1024;
    const chunks: Buffer[] = [];
    let totalBytes = 0;
    let rejected = false;

    const contentLength = Number(req.headers['content-length'] || 0);
    if (Number.isFinite(contentLength) && contentLength > maxBodyBytes) {
      rejected = true;
      req.resume();
      reject(new RequestBodyError('request body too large', 413));
      return;
    }

    req.on('data', (chunk: Buffer | string) => {
      if (rejected) return;
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      totalBytes += buffer.length;
      if (totalBytes > maxBodyBytes) {
        rejected = true;
        chunks.length = 0;
        req.resume();
        reject(new RequestBodyError('request body too large', 413));
        return;
      }
      chunks.push(buffer);
    });
    req.on('end', () => {
      if (!rejected) resolve(Buffer.concat(chunks));
    });
    req.on('error', (error) => {
      if (!rejected) reject(error);
    });
  });
}

async function parseBody(req: http.IncomingMessage): Promise<ParsedBody> {
  const rawBody = await readRawBody(req);
  try {
    return {
      payload: rawBody.length ? JSON.parse(rawBody.toString('utf8')) : {},
      rawBody,
    };
  } catch {
    throw new RequestBodyError('request body is not valid JSON', 400);
  }
}

function verifyVercel(req: http.IncomingMessage): boolean {
  const expected = getSecret(vercelCfg.webhookSecretEnv || 'VERCEL_WEBHOOK_SECRET');
  if (!expected) return false;
  const provided = (req.headers['x-vercel-signature'] || req.headers['x-webhook-secret'] || '') as string;
  return !!provided && safeEquals(provided, expected);
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

    // Authenticate GitHub's exact raw bytes before attempting JSON parsing.
    // The retired endpoint does not need a decoded payload: authenticated
    // deliveries receive the terminal drain response even when JSON is malformed.
    if (url.pathname === '/webhook/github') {
      const rawBody = await readRawBody(req);
      const retired = retiredGitHubWebhookResponse({
        secret: getSecret('GITHUB_WEBHOOK_SECRET'),
        rawBody,
        signature: String(req.headers['x-hub-signature-256'] || ''),
      });
      json(res, retired.status, retired.body);
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

    // Repository auto-onboarding retired with general CCP intake. Keep the
    // authenticated endpoint explicit so old operators receive a terminal
    // migration response instead of silently mutating GitHub or repos.json.
    if (url.pathname === '/api/onboard') {
      if (!verifyAdminApi(req)) { json(res, 403, { ok: false, error: 'admin API auth failed' }); return; }
      retiredIntake(res, 'onboard');
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
