import fs = require('fs');
import path = require('path');
import { spawnSync } from 'child_process';
import type {
  RunResult, JobPacket, JobStatus, JobResult, RepoProof,
  PRReviewResult, PrReviewIntegration, RemediationResult, DiscordMessageResult, DiscordThreadResult,
  SupervisorCycleSummary, PreflightResult, LinearSyncResult, PrWatcherCycleResult,
} from '../types';
const { syncJobToLinear } = require('./linear');
const { dispatchLinearIssues } = require('./linear-dispatch');
const { reviewPr } = require('./pr-review');
// Lazy-require to avoid circular dependency (pr-watcher imports from jobs)
let _runPrWatcherCycle: (() => Promise<PrWatcherCycleResult>) | undefined;
function getRunPrWatcherCycle(): () => Promise<PrWatcherCycleResult> {
  if (!_runPrWatcherCycle) _runPrWatcherCycle = require('./pr-watcher').runPrWatcherCycle;
  return _runPrWatcherCycle!;
}

const ROOT: string = path.resolve(process.env.CCP_ROOT || path.join(__dirname, '..', '..'));
const JOBS_DIR: string = path.join(ROOT, 'jobs');
const DISCORD_RUNS_CHANNEL: string = process.env.CCP_DISCORD_RUNS_CHANNEL || '';
const DISCORD_ERRORS_CHANNEL: string = process.env.CCP_DISCORD_ERRORS_CHANNEL || '';
const DISCORD_REVIEW_CHANNEL: string = process.env.CCP_DISCORD_REVIEW_CHANNEL || '';

function ensureDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
}

function nowIso(): string {
  return new Date().toISOString();
}

function readJson(file: string): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function writeJson(file: string, data: unknown): void {
  fs.writeFileSync(file, JSON.stringify(data, null, 2) + '\n');
}

function appendLog(jobId: string, text: string): void {
  const file = path.join(jobDir(jobId), 'worker.log');
  fs.appendFileSync(file, text.endsWith('\n') ? text : text + '\n');
}

function shellQuote(value: string): string {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

function run(command: string, args: string[] = [], options: Record<string, unknown> = {}): RunResult {
  return spawnSync(command, args, { encoding: 'utf8', ...options }) as unknown as RunResult;
}

const _commandExistsCache = new Map<string, string>();
function commandExists(cmd: string): string {
  if (_commandExistsCache.has(cmd)) return _commandExistsCache.get(cmd)!;
  const out = spawnSync('sh', ['-lc', `command -v ${cmd}`], { encoding: 'utf8' });
  const result = out.status === 0 ? out.stdout.trim() : '';
  _commandExistsCache.set(cmd, result);
  return result;
}

function gitIdentity(): { name: string; email: string } {
  const name = process.env.CCP_GIT_USER_NAME || process.env.GIT_AUTHOR_NAME || (run('git', ['config', '--global', '--get', 'user.name']).stdout || '').trim() || 'CodePlane';
  const email = process.env.CCP_GIT_USER_EMAIL || process.env.GIT_AUTHOR_EMAIL || (run('git', ['config', '--global', '--get', 'user.email']).stdout || '').trim() || 'codeplane@localhost';
  return { name, email };
}

function safeExcerpt(text: string, max: number = 500): string {
  if (!text) return '';
  return text.length <= max ? text : text.slice(-max);
}

function makeJobId(): string {
  const d = new Date();
  const pad = (n: number): string => String(n).padStart(2, '0');
  const stamp = `${d.getUTCFullYear()}${pad(d.getUTCMonth()+1)}${pad(d.getUTCDate())}_${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}`;
  const rand = Math.random().toString(36).slice(2, 8);
  return `job_${stamp}_${rand}`;
}

function jobDir(jobId: string): string {
  return path.join(JOBS_DIR, jobId);
}

function statusPath(jobId: string): string {
  return path.join(jobDir(jobId), 'status.json');
}

function packetPath(jobId: string): string {
  return path.join(jobDir(jobId), 'packet.json');
}

function resultPath(jobId: string): string {
  return path.join(jobDir(jobId), 'result.json');
}

function loadStatus(jobId: string): JobStatus {
  return readJson(statusPath(jobId)) as unknown as JobStatus;
}

function saveStatus(jobId: string, patch: Partial<JobStatus>): JobStatus {
  const file = statusPath(jobId);
  const lockFile = file + '.lock';
  const maxWait = 3000;
  const start = Date.now();
  while (fs.existsSync(lockFile)) {
    if (Date.now() - start > maxWait) {
      console.warn(`[ccp] lock timeout for ${jobId}, removing stale lock`);
      try { fs.unlinkSync(lockFile); } catch (_) {}
      break;
    }
    spawnSync('sleep', ['0.05']);
  }
  try {
    fs.writeFileSync(lockFile, String(process.pid), { flag: 'wx' });
  } catch (_) {
    // Another process grabbed it; proceed anyway (advisory lock)
  }
  try {
    const current = loadStatus(jobId);
    const mergedNotifications = patch.notifications
      ? { ...(current.notifications || {}), ...patch.notifications }
      : current.notifications;
    const next: JobStatus = {
      ...current,
      ...patch,
      notifications: mergedNotifications,
      updated_at: nowIso(),
    } as JobStatus;
    writeJson(file, next);
    return next;
  } finally {
    try { fs.unlinkSync(lockFile); } catch (_) {}
  }
}

function createJob(packet: JobPacket): { jobId: string; packet: JobPacket; status: JobStatus } {
  ensureDir(JOBS_DIR);
  const jobId = packet.job_id || makeJobId();
  const dir = jobDir(jobId);
  ensureDir(dir);
  const createdAt = nowIso();
  const normalized: JobPacket = { ...packet, job_id: jobId, created_at: packet.created_at || createdAt };
  const status: JobStatus = {
    job_id: jobId,
    ticket_id: normalized.ticket_id || null,
    repo: normalized.repo || null,
    state: 'queued',
    started_at: null,
    updated_at: createdAt,
    elapsed_sec: 0,
    tmux_session: null,
    last_heartbeat_at: null,
    last_output_excerpt: '',
    exit_code: null,
    notifications: { start: false, final: false },
    integrations: {
      linear: {
        attempted_at: null,
        ok: false,
        skipped: false,
        reason: null,
      },
    },
  };
  writeJson(packetPath(jobId), normalized);
  writeJson(statusPath(jobId), status);
  fs.writeFileSync(path.join(dir, 'worker.log'), '');
  writeJson(resultPath(jobId), {
    job_id: jobId,
    state: 'queued',
    commit: 'none',
    prod: 'no',
    verified: 'not yet',
    blocker: null,
    updated_at: createdAt,
  });
  appendLog(jobId, `[${createdAt}] job created`);
  return { jobId, packet: normalized, status };
}

function listJobs(): JobStatus[] {
  ensureDir(JOBS_DIR);
  const results: JobStatus[] = [];
  for (const name of fs.readdirSync(JOBS_DIR)) {
    if (!fs.existsSync(statusPath(name))) continue;
    try {
      results.push(loadStatus(name));
    } catch (err) {
      console.warn(`[ccp] skipping job ${name}: malformed status.json: ${(err as Error).message}`);
    }
  }
  return results.sort((a, b) => (a.updated_at < b.updated_at ? 1 : -1));
}

function jobsByState(): Record<string, JobStatus[]> {
  const buckets: Record<string, JobStatus[]> = {
    queued: [],
    preflight: [],
    running: [],
    failed: [],
    blocked: [],
    coded: [],
    done: [],
    verified: [],
    other: [],
  };
  for (const job of listJobs()) {
    const key = Object.prototype.hasOwnProperty.call(buckets, job.state) ? job.state : 'other';
    buckets[key].push(job);
  }
  return buckets;
}

function inspectEnvironment(repo: string | null): Record<string, unknown> {
  const tmux = commandExists('tmux');
  const claudeOpus = commandExists('claude-opus');
  const claude = commandExists('claude');
  const git = commandExists('git');
  const node = commandExists('node');
  const openclaw = commandExists('openclaw');
  const shell = process.env.SHELL || '';
  const home = process.env.HOME || '';

  const repoExists = !!repo && fs.existsSync(repo);
  let gitStatus: Record<string, unknown> | null = null;
  if (repoExists && git) {
    const out = run('git', ['-C', repo!, 'status', '--short']);
    gitStatus = {
      ok: out.status === 0,
      clean: out.status === 0 ? out.stdout.trim().length === 0 : null,
      stdout: (out.stdout || '').trim(),
      stderr: (out.stderr || '').trim(),
    };
  }

  const claudeCommand = claudeOpus || claude || '';
  let claudeVersion: Record<string, unknown> | null = null;
  if (claudeCommand) {
    const out = run(claudeCommand, ['--version']);
    claudeVersion = {
      ok: out.status === 0,
      stdout: (out.stdout || '').trim(),
      stderr: (out.stderr || '').trim(),
    };
  }

  const openclawStatus = openclaw ? run('openclaw', ['status']) : null;

  return {
    checked_at: nowIso(),
    repo,
    repo_exists: repoExists,
    commands: {
      tmux,
      claude_opus: claudeOpus,
      claude,
      git,
      node,
      openclaw,
    },
    shell,
    home,
    git_status: gitStatus,
    claude_version: claudeVersion,
    openclaw_status: openclawStatus ? {
      ok: openclawStatus.status === 0,
      stdout: (openclawStatus.stdout || '').trim(),
      stderr: (openclawStatus.stderr || '').trim(),
    } : null,
  };
}

function preflight(jobId: string): PreflightResult {
  const packet = readJson(packetPath(jobId)) as unknown as JobPacket;
  const env = inspectEnvironment(packet.repo);
  const failures: string[] = [];
  if (!packet.ticket_id) failures.push('ticket_id missing');
  if (!packet.repo || !(env.repo_exists as boolean)) failures.push(`repo missing: ${packet.repo || '(unset)'}`);
  const cmds = env.commands as Record<string, string>;
  if (!cmds.tmux) failures.push('tmux not found on PATH');
  if (!(cmds.claude_opus || cmds.claude)) failures.push('claude-opus/claude not found on PATH');
  if (!cmds.git) failures.push('git not found on PATH');
  if (!cmds.node) failures.push('node not found on PATH');
  if (!cmds.openclaw) failures.push('openclaw not found on PATH');

  return {
    ok: failures.length === 0,
    tmux: cmds.tmux,
    claude: cmds.claude_opus || cmds.claude,
    failures,
    environment: env,
  };
}

function markBlocked(jobId: string, reason: string): void {
  appendLog(jobId, `[${nowIso()}] BLOCKED: ${reason}`);
  saveStatus(jobId, {
    state: 'blocked',
    last_output_excerpt: safeExcerpt(reason),
    exit_code: 1,
    last_heartbeat_at: nowIso(),
  });
  writeJson(resultPath(jobId), {
    job_id: jobId,
    state: 'blocked',
    commit: 'none',
    prod: 'no',
    verified: 'not yet',
    blocker: reason,
    updated_at: nowIso(),
  });
}

function buildPrompt(packet: JobPacket): string {
  const bits: string[] = [];
  bits.push(`Ticket: ${packet.ticket_id || 'UNTRACKED'}`);
  bits.push(`Goal: ${packet.goal || 'No goal provided'}`);
  if (packet.constraints?.length) bits.push(`Constraints:\n- ${packet.constraints.join('\n- ')}`);
  if (packet.acceptance_criteria?.length) bits.push(`Acceptance criteria:\n- ${packet.acceptance_criteria.join('\n- ')}`);
  if (packet.verification_steps?.length) bits.push(`Verification steps:\n- ${packet.verification_steps.join('\n- ')}`);
  if (packet.review_feedback?.length) bits.push(`Review feedback to address:\n- ${packet.review_feedback.join('\n- ')}`);
  bits.push('Make only the minimum necessary changes for this task.');
  bits.push('At the end, output a final compact summary with these exact labels on separate lines:');
  bits.push('State: <coded/deployed/verified/blocked>');
  bits.push('Commit: <hash or none>');
  bits.push('Prod: <yes/no>');
  bits.push('Verified: <exact test or not yet>');
  bits.push('Blocker: <reason or none>');
  bits.push('Do not claim pushed or deployed unless it actually happened. A local commit on main is not the same as pushed.');
  bits.push('If you make code changes, you must finish one delivery path before considering the task complete: either (A) push to origin/main, or (B) push a branch for review. Do not stop at a local-only commit.');
  return bits.join('\n\n');
}

function sendDiscordMessage(channelId: string, message: string): DiscordMessageResult {
  const out = run('openclaw', ['message', 'send', '--channel', 'discord', '--target', `channel:${channelId}`, '--message', message]);
  let messageId: string | null = null;
  try {
    const parsed = JSON.parse(out.stdout || '{}');
    messageId = parsed.messageId || parsed.id || null;
  } catch {
    const match = (out.stdout || '').match(/(\d{17,20})/);
    messageId = match ? match[1] : null;
  }
  return { ok: out.status === 0, stdout: out.stdout, stderr: out.stderr, messageId };
}

function createDiscordThread(channelId: string, messageId: string, threadName: string): DiscordThreadResult {
  const out = run('openclaw', [
    'message', 'thread-create',
    '--channel', 'discord',
    '--channel-id', channelId,
    '--message-id', messageId,
    '--thread-name', threadName.slice(0, 100),
  ]);
  let threadId: string | null = null;
  try {
    const parsed = JSON.parse(out.stdout || '{}');
    threadId = parsed.threadId || parsed.id || null;
  } catch {
    const match = (out.stdout || '').match(/(\d{17,20})/);
    threadId = match ? match[1] : null;
  }
  return { ok: out.status === 0, threadId, stdout: out.stdout, stderr: out.stderr };
}

function sendToThread(threadId: string, message: string): DiscordMessageResult {
  return sendDiscordMessage(threadId, message);
}

function prReviewPolicy(repoPath?: string): { enabled: boolean; autoMerge: boolean; mergeMethod: string } {
  const globalAutoMerge = String(process.env.CCP_PR_AUTOMERGE || 'false').toLowerCase() === 'true';
  const globalMergeMethod = process.env.CCP_PR_MERGE_METHOD || 'squash';

  let repoAutoMerge = globalAutoMerge;
  let repoMergeMethod = globalMergeMethod;
  try {
    const { findRepoByPath } = require('./repos');
    const repo = repoPath ? findRepoByPath(repoPath) : null;
    if (repo?.autoMerge !== undefined) repoAutoMerge = !!repo.autoMerge;
    if (repo?.mergeMethod) repoMergeMethod = repo.mergeMethod;
  } catch { /* repos module not available */ }

  return {
    enabled: String(process.env.CCP_PR_REVIEW_ENABLED || 'true').toLowerCase() !== 'false',
    autoMerge: repoAutoMerge,
    mergeMethod: repoMergeMethod,
  };
}

function formatPrReview(review: PRReviewResult | null): string | null {
  if (!review) return null;
  return [
    `PR review: ${review.disposition}`,
    `PR URL: ${review.prUrl}`,
    `Mergeable: ${review.mergeable}`,
    `Review decision: ${review.reviewDecision}`,
    `Auto-merge: ${review.autoMergeEnabled ? 'enabled' : 'no'}`,
    review.blockers?.length ? `Review blockers: ${review.blockers.join('; ')}` : 'Review blockers: none',
  ].join('\n');
}

function maybeReviewPr(jobId: string, result: JobResult): PRReviewResult & { skipped?: boolean; reason?: string } {
  const packet = readJson(packetPath(jobId)) as unknown as JobPacket;
  const policy = prReviewPolicy(packet?.repo || undefined);
  if (!policy.enabled || !result?.pr_url) {
    return { ok: false, skipped: true, reason: !result?.pr_url ? 'no PR URL' : 'PR review disabled' } as PRReviewResult & { skipped?: boolean; reason?: string };
  }
  try {
    const review: PRReviewResult = reviewPr({ prUrl: result.pr_url, autoMerge: policy.autoMerge, mergeMethod: policy.mergeMethod });
    appendLog(jobId, `[${nowIso()}] pr review: ${review.disposition}${review.autoMergeEnabled ? ' (auto-merge enabled)' : ''}`);
    return { ...review, ok: true, skipped: false };
  } catch (error) {
    appendLog(jobId, `[${nowIso()}] pr review error: ${(error as Error).message}`);
    return { ok: false, skipped: false, reason: (error as Error).message } as PRReviewResult & { skipped?: boolean; reason?: string };
  }
}

function maybeEnqueueReviewRemediation(jobId: string, packet: JobPacket, result: JobResult, prReview: PRReviewResult & { skipped?: boolean }): RemediationResult {
  const enabled = String(process.env.CCP_PR_REMEDIATE_ENABLED || 'true').toLowerCase() !== 'false';
  if (!enabled) return { ok: false, skipped: true, reason: 'remediation disabled' };
  if (/__deployfix|__reviewfix/.test(jobId)) return { ok: false, skipped: true, reason: 'remediation depth limit: job is already a remediation' };
  if (!prReview?.ok || prReview.disposition !== 'block') return { ok: false, skipped: true, reason: 'no blocking PR review' };
  const remediationSuffix = prReview.blockerType === 'deploy' ? '__deployfix' : '__reviewfix';
  const remediationJobId = `${jobId}${remediationSuffix}`;
  if (fs.existsSync(statusPath(remediationJobId))) {
    return { ok: true, skipped: true, reason: 'remediation job already exists', job_id: remediationJobId };
  }
  const relevantChecks = (prReview.failedChecks?.length ? prReview.failedChecks : (prReview.checks || []).filter((c) => c.state !== 'SUCCESS' && c.state !== 'NEUTRAL' && c.state !== 'SKIPPED'));
  const feedback: string[] = [
    `PR review blocked for ${packet.ticket_id || jobId}`,
    `PR: ${prReview.prUrl}`,
    `Disposition: ${prReview.disposition}`,
    `Blocker type: ${prReview.blockerType || 'unknown'}`,
    ...(prReview.blockers || []).map((b) => `Blocker: ${b}`),
    ...relevantChecks.map((c) => `Check ${c.name}: ${c.state}${c.url ? ` (${c.url})` : ''}`),
    prReview.blockerType === 'deploy'
      ? 'Investigate the deployment/platform failure, fix anything code-side that can resolve it, and push updates to the same branch. If the issue is definitely external/platform-only, leave a precise blocker note with the exact failing service and URL.'
      : 'Fix the blocking PR issues on the existing branch, push updates to the same branch, and do not create a new PR.',
  ];
  const remediationPacket: JobPacket = {
    ...packet,
    job_id: remediationJobId,
    goal: `${prReview.blockerType === 'deploy' ? 'Remediate deploy blocker' : 'Remediate PR blockers'} for ${packet.ticket_id || jobId}`,
    source: prReview.blockerType === 'deploy' ? 'vercel' : 'pr-review',
    kind: prReview.blockerType === 'deploy' ? 'deploy' : 'bug',
    label: prReview.blockerType === 'deploy' ? 'deploy' : 'review-fix',
    review_feedback: feedback,
    working_branch: prReview.headRefName || packet.working_branch || null,
    base_branch: prReview.baseRefName || packet.base_branch || 'main',
    acceptance_criteria: [
      ...(packet.acceptance_criteria || []),
      'Address the blocking PR review findings.',
      'Push updates to the existing PR branch.',
      'Do not create a new PR.',
    ],
    verification_steps: [
      ...(packet.verification_steps || []),
      'Re-run failing checks or the closest local equivalent.',
      'Leave the PR in a state that can pass reviewer re-check.',
    ],
    created_at: nowIso(),
  };
  const created = createJob(remediationPacket);
  appendLog(jobId, `[${nowIso()}] remediation job queued: ${created.jobId}`);
  return { ok: true, skipped: false, job_id: created.jobId, branch: remediationPacket.working_branch, blockerType: prReview.blockerType || 'unknown' };
}

async function maybeSyncLinear(jobId: string): Promise<LinearSyncResult> {
  const packet = readJson(packetPath(jobId)) as unknown as JobPacket;
  const status = loadStatus(jobId);
  const result = readJson(resultPath(jobId)) as unknown as JobResult;
  try {
    const sync: LinearSyncResult = await syncJobToLinear({ packet, status, result });
    const current = loadStatus(jobId);
    saveStatus(jobId, {
      integrations: {
        ...(current.integrations || {}),
        linear: {
          attempted_at: nowIso(),
          ok: !!sync.ok,
          skipped: !!sync.skipped,
          reason: sync.reason || null,
          issueId: sync.issueId || null,
          identifier: sync.identifier || null,
          url: sync.url || null,
          state: sync.state || null,
        },
      },
    });
    appendLog(jobId, `[${nowIso()}] linear sync: ${sync.ok ? 'ok' : (sync.skipped ? `skipped (${sync.reason})` : 'failed')}`);
    return sync;
  } catch (error) {
    const current = loadStatus(jobId);
    saveStatus(jobId, {
      integrations: {
        ...(current.integrations || {}),
        linear: {
          attempted_at: nowIso(),
          ok: false,
          skipped: false,
          reason: (error as Error).message,
        },
      },
    });
    appendLog(jobId, `[${nowIso()}] linear sync error: ${(error as Error).message}`);
    return { ok: false, skipped: false, reason: (error as Error).message };
  }
}

function notifyStart(jobId: string): void {
  const status = loadStatus(jobId);
  if (status.notifications?.start) return;
  const packet = readJson(packetPath(jobId)) as unknown as JobPacket;
  const repoName = packet.repo ? path.basename(packet.repo) : 'unknown';
  const ticket = packet.ticket_id || jobId;
  const goal = packet.goal ? (packet.goal.length > 80 ? packet.goal.slice(0, 77) + '...' : packet.goal) : '';
  const msg = `🟡 START — ${ticket} | ${repoName} | ${goal}`;
  const sent = sendDiscordMessage(DISCORD_RUNS_CHANNEL, msg);
  appendLog(jobId, `[${nowIso()}] START notify: ${sent.ok ? 'ok' : (sent.stderr || 'failed')}`);
  saveStatus(jobId, { notifications: { start: sent.ok, final: false } });
}

function parseSummary(logText: string): Record<string, string> {
  const fields: Record<string, string> = {};
  for (const key of ['State', 'Commit', 'Prod', 'Verified', 'Blocker']) {
    const re = new RegExp(`^${key}:\\s*(.+)$`, 'gmi');
    const matches = [...logText.matchAll(re)];
    if (matches.length) fields[key.toLowerCase()] = matches[matches.length - 1][1].trim();
  }
  const prMatches = [...logText.matchAll(/PR created:\s*(https:\/\/github\.com\/\S+)/gmi)];
  if (prMatches.length) fields.pr_url = prMatches[prMatches.length - 1][1].trim();
  return fields;
}

function inspectRepoProof(repo: string | null, claimedCommit: string): RepoProof {
  if (!repo || !fs.existsSync(repo)) {
    return { repoExists: false, git: false, dirty: false, commitExists: false, branch: null, pushed: null, upstream: null, ahead: null, behind: null };
  }
  const git = commandExists('git');
  if (!git) {
    return { repoExists: true, git: false, dirty: false, commitExists: false, branch: null, pushed: null, upstream: null, ahead: null, behind: null };
  }
  const statusOut = run(git, ['-C', repo, 'status', '--short', '--branch']);
  const dirty = statusOut.status === 0
    ? statusOut.stdout.split('\n').slice(1).join('\n').trim().length > 0
    : false;
  const branchOut = run(git, ['-C', repo, 'rev-parse', '--abbrev-ref', 'HEAD']);
  const branch = branchOut.status === 0 ? branchOut.stdout.trim() : null;
  const upstreamOut = run(git, ['-C', repo, 'rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}']);
  const upstream = upstreamOut.status === 0 ? upstreamOut.stdout.trim() : null;
  let ahead: number | null = null;
  let behind: number | null = null;
  if (upstream) {
    const countsOut = run(git, ['-C', repo, 'rev-list', '--left-right', '--count', `${upstream}...HEAD`]);
    if (countsOut.status === 0) {
      const [behindStr, aheadStr] = countsOut.stdout.trim().split(/\s+/);
      behind = Number(behindStr);
      ahead = Number(aheadStr);
    }
  }
  let commitExists = false;
  if (claimedCommit && claimedCommit !== 'none') {
    const revOut = run(git, ['-C', repo, 'rev-parse', '--verify', `${claimedCommit}^{commit}`]);
    commitExists = revOut.status === 0;
  }
  return {
    repoExists: true,
    git: true,
    dirty,
    commitExists,
    branch,
    upstream,
    ahead,
    behind,
    pushed: commitExists ? (upstream ? ahead === 0 : false) : null,
  };
}

function inferBlockedReason(logText: string, result: { state: string; commit: string; prod: string; verified: string; pr_url: string | null }, proof: RepoProof): string | null {
  const permissionMatch = logText.match(/I need file write permission to proceed\.[\s\S]*?(?=WORKER_EXIT_CODE:|$)/i);
  if (permissionMatch) {
    return permissionMatch[0].trim();
  }
  const hasReviewDelivery = !!result.pr_url;
  if ((result.state === 'coded' || result.state === 'done' || result.state === 'verified') && !proof.commitExists && !proof.dirty) {
    return 'worker reported progress without a commit or working tree changes';
  }
  if ((result.state === 'coded' || result.state === 'done' || result.state === 'verified') && proof.dirty && !proof.commitExists) {
    return 'worker left uncommitted local changes without creating a verifiable commit';
  }
  if ((result.state === 'coded' || result.state === 'done' || result.state === 'verified') && proof.commitExists && proof.pushed === false && !hasReviewDelivery) {
    return 'worker created a local-only commit but did not push it';
  }
  if ((result.state === 'done' || result.state === 'verified') && !proof.commitExists) {
    return 'worker reported completion without a verifiable commit';
  }
  if (result.prod === 'yes' && !proof.commitExists) {
    return 'worker reported prod=yes without a verifiable commit';
  }
  return null;
}

function tmuxSessionAlive(session: string | null): boolean {
  if (!session) return false;
  const tmux = commandExists('tmux') || 'tmux';
  const out = run(tmux, ['has-session', '-t', session]);
  return out.status === 0;
}

async function finalizeJob(jobId: string): Promise<{ ok: boolean; state: string; exitCode: number; result: JobResult; linear: LinearSyncResult }> {
  const status = loadStatus(jobId);
  const packet = readJson(packetPath(jobId)) as unknown as JobPacket;
  const logText = fs.readFileSync(path.join(jobDir(jobId), 'worker.log'), 'utf8');
  const summary = parseSummary(logText);
  const exitCodeMatch = logText.match(/WORKER_EXIT_CODE:\s*(\d+)/);
  const exitCode = exitCodeMatch ? Number(exitCodeMatch[1]) : (status.exit_code ?? 0);
  const provisionalState = exitCode === 0 ? (summary.state || 'coded') : (summary.state || 'failed');
  const proof = inspectRepoProof(packet.repo, summary.commit || 'none');
  const inferredBlocker = inferBlockedReason(logText, {
    state: provisionalState,
    commit: summary.commit || 'none',
    prod: summary.prod || 'no',
    verified: summary.verified || 'not yet',
    pr_url: summary.pr_url || null,
  }, proof);
  const finalState = inferredBlocker ? 'blocked' : provisionalState;
  const result: JobResult = {
    job_id: jobId,
    state: finalState,
    commit: proof.commitExists ? (summary.commit || 'none') : 'none',
    branch: proof.branch || 'unknown',
    pushed: typeof proof.pushed === 'boolean' ? (proof.pushed ? 'yes' : 'no') : 'unknown',
    pr_url: summary.pr_url || null,
    prod: finalState === 'blocked' ? 'no' : (summary.prod || 'no'),
    verified: finalState === 'blocked' ? 'not yet' : (summary.verified || 'not yet'),
    blocker: inferredBlocker || (summary.blocker && summary.blocker !== 'none' ? summary.blocker : null),
    blocker_type: null,
    failed_checks: [],
    tmux_session: status.tmux_session,
    worker_exit_code: exitCode,
    proof,
    updated_at: nowIso(),
  };
  writeJson(resultPath(jobId), result);
  const started = status.started_at ? new Date(status.started_at).getTime() : Date.now();
  const elapsed = Math.max(0, Math.round((Date.now() - started) / 1000));
  saveStatus(jobId, {
    state: finalState,
    elapsed_sec: elapsed,
    exit_code: exitCode,
    last_heartbeat_at: nowIso(),
    last_output_excerpt: safeExcerpt(logText),
  });

  const prReview = maybeReviewPr(jobId, result);
  if (prReview?.ok) {
    result.blocker_type = prReview.blockerType || null;
    result.failed_checks = prReview.failedChecks || [];
    writeJson(resultPath(jobId), result);
  }
  const remediation = maybeEnqueueReviewRemediation(jobId, packet, result, prReview);
  const linear = await maybeSyncLinear(jobId);

  const currentAfterIntegrations = loadStatus(jobId);
  saveStatus(jobId, {
    integrations: {
      ...(currentAfterIntegrations.integrations || {}),
      prReview: prReview.ok || prReview.skipped ? { ...prReview, skipped: !!prReview.skipped } as PrReviewIntegration : {
        ok: false,
        skipped: false,
        reason: prReview.reason || 'unknown PR review error',
      },
      remediation,
    },
  });

  if (!status.notifications?.final) {
    const ticket = packet.ticket_id || jobId;
    const repoName = packet.repo ? path.basename(packet.repo) : 'unknown';
    const commitShort = result.commit && result.commit !== 'none' ? result.commit.slice(0, 7) : null;

    let runsMsg: string;
    if (exitCode !== 0 || result.state === 'blocked' || result.state === 'failed') {
      const blocker = result.blocker ? (result.blocker.length > 100 ? result.blocker.slice(0, 97) + '...' : result.blocker) : 'unknown';
      runsMsg = `🔴 ${result.state === 'blocked' ? 'BLOCKED' : 'FAIL'} — ${ticket} | ${repoName} | ${blocker}`;
    } else {
      const parts: string[] = [`✅ DONE — ${ticket} | ${repoName}`];
      if (commitShort) parts.push(commitShort);
      if (result.pr_url) parts.push(`→ PR ${result.pr_url.split('/').pop()}`);
      if (result.verified && result.verified !== 'not yet') {
        const v = result.verified.length > 60 ? result.verified.slice(0, 57) + '...' : result.verified;
        parts.push(v);
      }
      runsMsg = parts.join(' | ');
    }

    const target = exitCode === 0 && result.state !== 'blocked' && result.state !== 'failed' ? DISCORD_RUNS_CHANNEL : DISCORD_ERRORS_CHANNEL;
    const sentMain = sendDiscordMessage(target, runsMsg);

    if (result.pr_url && prReview.ok) {
      const reviewParts: string[] = [
        `📋 PR REVIEW — ${ticket}`,
        `PR: ${result.pr_url}`,
        `Disposition: ${prReview.disposition || 'pending'}`,
      ];
      if (prReview.autoMergeEnabled) reviewParts.push('Auto-merge: enabled');
      if (prReview.blockers?.length) reviewParts.push(`Blockers: ${prReview.blockers.join('; ')}`);
      if (result.verified && result.verified !== 'not yet') reviewParts.push(`Tests: ${result.verified}`);
      if (remediation.ok && !remediation.skipped) reviewParts.push(`Remediation: ${remediation.job_id}`);
      sendDiscordMessage(DISCORD_REVIEW_CHANNEL, reviewParts.join('\n'));
    }

    appendLog(jobId, `[${nowIso()}] FINAL notify: ${sentMain.ok ? 'ok' : (sentMain.stderr || 'failed')}`);

    const isCleanMerge = exitCode === 0
      && result.state !== 'blocked' && result.state !== 'failed'
      && (!result.pr_url || (prReview.ok && prReview.autoMergeEnabled));
    let threadId: string | null = null;
    if (!isCleanMerge && sentMain.ok && sentMain.messageId) {
      const threadName = `${ticket} — ${packet.goal || packet.ticket_id || repoName}`;
      const thread = createDiscordThread(target, sentMain.messageId, threadName);
      if (thread.ok && thread.threadId) {
        threadId = thread.threadId;
        const threadParts: string[] = [`**${ticket}** — ${repoName}`];
        if (result.pr_url) threadParts.push(`PR: ${result.pr_url}`);
        if (result.branch) threadParts.push(`Branch: \`${result.branch}\``);
        if (result.blocker) threadParts.push(`Blocker: ${result.blocker}`);
        if (prReview.ok && prReview.blockers?.length) threadParts.push(`PR blockers: ${prReview.blockers.join('; ')}`);
        if (remediation.ok && !remediation.skipped) threadParts.push(`Remediation job: \`${remediation.job_id}\``);
        threadParts.push(`\nUpdates will be posted here. Thread auto-archives after 24h of inactivity.`);
        sendToThread(threadId, threadParts.join('\n'));
        appendLog(jobId, `[${nowIso()}] thread created: ${threadId}`);
      }
    }

    saveStatus(jobId, { notifications: { final: sentMain.ok, start: true }, discord_thread_id: threadId });
  }

  return { ok: true, state: finalState, exitCode, result, linear };
}

async function reconcileJob(jobId: string): Promise<{ ok: boolean; state: string; live?: boolean; exitCode?: number; result?: JobResult; linear?: LinearSyncResult }> {
  const status = loadStatus(jobId);
  if (status.state === 'running' && !tmuxSessionAlive(status.tmux_session)) {
    return await finalizeJob(jobId);
  }
  if (status.state === 'running') {
    notifyStart(jobId);
    const tmux = commandExists('tmux') || 'tmux';
    const capture = run(tmux, ['capture-pane', '-pt', status.tmux_session!]);
    if (capture.status === 0) {
      saveStatus(jobId, {
        last_heartbeat_at: nowIso(),
        last_output_excerpt: safeExcerpt(capture.stdout || ''),
      });
    }
    return { ok: true, state: 'running', live: true };
  }
  return { ok: true, state: status.state, live: false };
}

function startTmuxWorker(jobId: string, packet: JobPacket, pf: PreflightResult): string {
  const session = `ccp_${jobId}`.replace(/[^a-zA-Z0-9_]/g, '_');
  run(pf.tmux, ['kill-session', '-t', session]);

  const logFile = path.join(jobDir(jobId), 'worker.log');
  const promptFile = path.join(jobDir(jobId), 'prompt.txt');
  fs.writeFileSync(promptFile, buildPrompt(packet));

  const workerCmd = `${shellQuote(pf.claude)} --print --permission-mode bypassPermissions -p ${shellQuote(fs.readFileSync(promptFile, 'utf8'))}`;
  const gitUser = gitIdentity();
  const shellScript = [
    'set -euo pipefail',
    `export GIT_AUTHOR_NAME=${shellQuote(gitUser.name)}`,
    `export GIT_AUTHOR_EMAIL=${shellQuote(gitUser.email)}`,
    `export GIT_COMMITTER_NAME=${shellQuote(gitUser.name)}`,
    `export GIT_COMMITTER_EMAIL=${shellQuote(gitUser.email)}`,
    `cd ${shellQuote(packet.repo!)}`,
    packet.working_branch ? `git checkout ${shellQuote(packet.working_branch)}` : null,
    packet.working_branch ? `git pull --ff-only origin ${shellQuote(packet.working_branch)} || true` : null,
    `echo "[${nowIso()}] worker start" >> ${shellQuote(logFile)}`,
    `{ ${workerCmd}; } 2>&1 | tee -a ${shellQuote(logFile)}`,
    'exit_code=${PIPESTATUS[0]}',
    `echo "WORKER_EXIT_CODE: ${'$'}exit_code" >> ${shellQuote(logFile)}`,
    'exit $exit_code',
  ].filter(Boolean).join('\n');

  const out = run(pf.tmux, ['new-session', '-d', '-s', session, 'bash', '-lc', shellScript]);
  if (out.status !== 0) {
    throw new Error((out.stderr || out.stdout || 'tmux new-session failed').trim());
  }
  return session;
}

function interruptJob(jobId: string): { ok: boolean; job_id: string; state: string; interrupted: boolean } {
  const status = loadStatus(jobId);
  appendLog(jobId, `[${nowIso()}] interrupt requested`);
  if (status.tmux_session && tmuxSessionAlive(status.tmux_session)) {
    const tmux = commandExists('tmux') || 'tmux';
    const out = run(tmux, ['kill-session', '-t', status.tmux_session]);
    appendLog(jobId, `[${nowIso()}] tmux kill-session: ${out.status === 0 ? 'ok' : (out.stderr || out.stdout || 'failed').trim()}`);
  }
  saveStatus(jobId, {
    state: 'blocked',
    exit_code: 130,
    last_heartbeat_at: nowIso(),
    last_output_excerpt: 'interrupted by operator',
  });
  writeJson(resultPath(jobId), {
    job_id: jobId,
    state: 'blocked',
    commit: 'none',
    prod: 'no',
    verified: 'not yet',
    blocker: 'interrupted by operator',
    tmux_session: status.tmux_session,
    worker_exit_code: 130,
    updated_at: nowIso(),
  });
  return { ok: true, job_id: jobId, state: 'blocked', interrupted: true };
}

function summarizeJobs(): Record<string, unknown> {
  const buckets = jobsByState();
  const counts = Object.fromEntries(Object.entries(buckets).map(([key, value]) => [key, value.length]));
  return {
    root: ROOT,
    counts,
    running: buckets.running.map((job) => ({
      job_id: job.job_id,
      ticket_id: job.ticket_id,
      repo: job.repo,
      started_at: job.started_at,
      tmux_session: job.tmux_session,
    })),
    queued: buckets.queued.map((job) => ({
      job_id: job.job_id,
      ticket_id: job.ticket_id,
      repo: job.repo,
      updated_at: job.updated_at,
    })),
    blocked: buckets.blocked.slice(0, 10).map((job) => ({
      job_id: job.job_id,
      ticket_id: job.ticket_id,
      repo: job.repo,
      updated_at: job.updated_at,
      last_output_excerpt: job.last_output_excerpt,
    })),
    coded: buckets.coded.slice(0, 10).map((job) => ({
      job_id: job.job_id,
      ticket_id: job.ticket_id,
      repo: job.repo,
      updated_at: job.updated_at,
    })),
  };
}

function startJob(jobId: string): Record<string, unknown> {
  const packet = readJson(packetPath(jobId)) as unknown as JobPacket;
  saveStatus(jobId, {
    state: 'preflight',
    started_at: nowIso(),
    exit_code: null,
    notifications: { start: false, final: false },
  });
  appendLog(jobId, `[${nowIso()}] preflight start`);
  const pf = preflight(jobId);
  if (!pf.ok) {
    const reason = pf.failures.join('; ');
    markBlocked(jobId, reason);
    return { ok: false, blocked: true, reason, packet, environment: pf.environment };
  }

  try {
    const session = startTmuxWorker(jobId, packet, pf);
    appendLog(jobId, `[${nowIso()}] tmux session started: ${session}`);
    saveStatus(jobId, {
      state: 'running',
      tmux_session: session,
      last_heartbeat_at: nowIso(),
      last_output_excerpt: 'tmux worker started',
      exit_code: null,
    });
    writeJson(resultPath(jobId), {
      job_id: jobId,
      state: 'running',
      commit: 'none',
      prod: 'no',
      verified: 'not yet',
      blocker: null,
      proof: {
        branch: (pf.environment?.git_status as Record<string, unknown>)?.ok ? (run(commandExists('git') || 'git', ['-C', packet.repo!, 'rev-parse', '--abbrev-ref', 'HEAD']).stdout || '').trim() || null : null,
        pushed: null,
      },
      tmux_session: session,
      updated_at: nowIso(),
    });
    notifyStart(jobId);
    return { ok: true, session, packet, environment: pf.environment };
  } catch (error) {
    const reason = `worker start failed: ${(error as Error).message}`;
    markBlocked(jobId, reason);
    return { ok: false, blocked: true, reason, packet, environment: pf.environment };
  }
}

async function runSupervisorCycle(options: { maxConcurrent?: number } = {}): Promise<SupervisorCycleSummary> {
  const maxConcurrent = Number.isFinite(Number(options.maxConcurrent)) ? Number(options.maxConcurrent) : 1;
  const summary: SupervisorCycleSummary = {
    started_at: nowIso(),
    max_concurrent: maxConcurrent,
    linearDispatched: [],
    reconciled: [],
    started: [],
    skipped: [],
    errors: [],
  };

  try {
    summary.linearDispatched = await dispatchLinearIssues();
  } catch (error) {
    summary.errors.push({ action: 'linear-dispatch', error: (error as Error).message });
  }

  const jobs = listJobs();
  const running = jobs.filter((job) => job.state === 'running');
  for (const job of running) {
    try {
      summary.reconciled.push({ job_id: job.job_id, ...(await reconcileJob(job.job_id)) });
    } catch (error) {
      summary.errors.push({ job_id: job.job_id, action: 'reconcile', error: (error as Error).message });
    }
  }

  try {
    summary.prWatcher = await getRunPrWatcherCycle()();
  } catch (error) {
    summary.errors.push({ action: 'pr-watcher', error: (error as Error).message });
  }

  const refreshed = listJobs();
  const activeRunning = refreshed.filter((job) => job.state === 'running').length;
  const capacity = Math.max(0, maxConcurrent - activeRunning);
  const queued = refreshed
    .filter((job) => job.state === 'queued')
    .sort((a, b) => (a.updated_at > b.updated_at ? 1 : -1));

  // Check peak-hour scheduling before dispatching new jobs
  const { canDispatchJobs } = require('./scheduling');
  const scheduleCheck = canDispatchJobs();
  (summary as unknown as Record<string, unknown>).scheduling = scheduleCheck;

  if (!scheduleCheck.allowed && queued.length > 0) {
    queued.forEach((job) => {
      summary.skipped.push({ job_id: job.job_id, reason: scheduleCheck.reason });
    });
  } else {
    queued.forEach((job, index) => {
      if (index >= capacity) {
        summary.skipped.push({ job_id: job.job_id, reason: 'capacity' });
        return;
      }
      try {
        summary.started.push({ job_id: job.job_id, ...startJob(job.job_id) });
      } catch (error) {
        summary.errors.push({ job_id: job.job_id, action: 'start', error: (error as Error).message });
      }
    });
  }

  try {
    summary.archived = archiveOldJobs();
  } catch (error) {
    summary.errors.push({ action: 'archive', error: (error as Error).message });
  }

  summary.finished_at = nowIso();
  summary.snapshot = summarizeJobs();
  return summary;
}

const TERMINAL_STATES = new Set(['done', 'verified', 'blocked', 'failed', 'coded']);
const ARCHIVE_AGE_MS = 7 * 24 * 60 * 60 * 1000;

function archiveOldJobs(): string[] {
  ensureDir(JOBS_DIR);
  const archiveDir = path.join(JOBS_DIR, 'archived');
  const now = Date.now();
  const moved: string[] = [];
  for (const name of fs.readdirSync(JOBS_DIR)) {
    if (name === 'archived') continue;
    const sPath = statusPath(name);
    if (!fs.existsSync(sPath)) continue;
    let status: JobStatus;
    try { status = readJson(sPath) as unknown as JobStatus; } catch { continue; }
    if (!TERMINAL_STATES.has(status.state)) continue;
    const updatedAt = status.updated_at ? new Date(status.updated_at).getTime() : 0;
    if (now - updatedAt < ARCHIVE_AGE_MS) continue;
    ensureDir(archiveDir);
    const src = jobDir(name);
    const dest = path.join(archiveDir, name);
    fs.renameSync(src, dest);
    moved.push(name);
  }
  return moved;
}

function healthCheck(): Record<string, unknown> {
  const heartbeatFile = path.join(ROOT, 'supervisor', 'daemon', 'heartbeat.json');
  let heartbeatAge: number | null = null;
  if (fs.existsSync(heartbeatFile)) {
    try {
      const hb = readJson(heartbeatFile);
      const ts = (hb.finished_at || hb.at) as string;
      if (ts) heartbeatAge = Math.round((Date.now() - new Date(ts).getTime()) / 1000);
    } catch { /* ignore */ }
  }

  const jobs = listJobs();
  const now = Date.now();
  const TWO_HOURS = 2 * 60 * 60 * 1000;
  const stuckJobs = jobs.filter((j) => j.state === 'running' && j.started_at && (now - new Date(j.started_at).getTime()) > TWO_HOURS);
  const blockedJobs = jobs.filter((j) => j.state === 'blocked');

  let launchdSupervisor = false;
  let launchdPrWatcher = false;
  try {
    const out = run('launchctl', ['list']);
    if (out.status === 0) {
      launchdSupervisor = out.stdout.includes('ai.openclaw.coding-control-plane');
      launchdPrWatcher = out.stdout.includes('ai.openclaw.coding-control-plane.intake');
    }
  } catch { /* ignore */ }

  let diskUsage: string | null = null;
  try {
    const out = run('du', ['-sh', JOBS_DIR]);
    if (out.status === 0) diskUsage = out.stdout.trim().split(/\s+/)[0];
  } catch { /* ignore */ }

  return {
    heartbeatAgeSec: heartbeatAge,
    stuckJobCount: stuckJobs.length,
    stuckJobs: stuckJobs.map((j) => j.job_id),
    blockedJobCount: blockedJobs.length,
    launchd: { supervisor: launchdSupervisor, prWatcher: launchdPrWatcher },
    diskUsage,
  };
}

module.exports = {
  ROOT,
  JOBS_DIR,
  createJob,
  listJobs,
  jobsByState,
  summarizeJobs,
  runSupervisorCycle,
  loadStatus,
  readJson,
  saveStatus,
  packetPath,
  resultPath,
  jobDir,
  startJob,
  appendLog,
  reconcileJob,
  finalizeJob,
  inspectEnvironment,
  interruptJob,
  maybeEnqueueReviewRemediation,
  maybeReviewPr,
  prReviewPolicy,
  statusPath,
  archiveOldJobs,
  healthCheck,
  sendDiscordMessage,
  createDiscordThread,
  sendToThread,
};

export {
  ROOT,
  JOBS_DIR,
  createJob,
  listJobs,
  jobsByState,
  summarizeJobs,
  runSupervisorCycle,
  loadStatus,
  readJson,
  saveStatus,
  packetPath,
  resultPath,
  jobDir,
  startJob,
  appendLog,
  reconcileJob,
  finalizeJob,
  inspectEnvironment,
  interruptJob,
  maybeEnqueueReviewRemediation,
  maybeReviewPr,
  prReviewPolicy,
  statusPath,
  archiveOldJobs,
  healthCheck,
  sendDiscordMessage,
  createDiscordThread,
  sendToThread,
};
