import fs = require('fs');
import path = require('path');
import { spawnSync } from 'child_process';
import type {
  RunResult, JobPacket, JobStatus, JobResult, RepoProof,
  PRReviewResult, PrReviewIntegration, RemediationResult, DiscordMessageResult, DiscordThreadResult,
  SupervisorCycleSummary, PreflightResult, LinearSyncResult, PrWatcherCycleResult,
} from '../types';
const { syncJobToLinear, postCompletionComment, getJobLinearLink } = require('./linear');
const { dispatchLinearIssues } = require('./linear-dispatch');
const { reviewPr } = require('./pr-review');
const { isApiOutageLog, recordJobOutcome, runOutageProbe, getOutageStatus } = require('./outage');
const { prReviewPolicy } = require('./pr-policy');
const { fireWebhookCallback } = require('./webhook-callback');
const { scanRepoContext, formatContextForPrompt } = require('./repo-context');
const { getOrCreateKnowledge, formatKnowledgeForPrompt, loadKnowledge, saveKnowledge } = require('./repo-knowledge');
const { findRepoByPath } = require('./repos');
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
const DISCORD_STATUS_CHANNEL: string = process.env.CCP_DISCORD_STATUS_CHANNEL || process.env.CCP_DISCORD_REVIEW_CHANNEL || '';

/** Default max job duration (30 min). Overridable per-repo via repos.json maxJobDurationSec. */
const DEFAULT_MAX_JOB_DURATION_SEC = 30 * 60;
/** Max automatic retries for transient API failures */
const DEFAULT_MAX_RETRIES = 1;
/** Number of identical heartbeat excerpts before declaring a stuck loop */
const STUCK_LOOP_THRESHOLD = 4;

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

/** Resolve local repo path to "owner/repo" string via git remote */
function resolveOwnerRepo(repoPath: string): string | null {
  const git = commandExists('git');
  if (!git) return null;
  const out = run(git, ['-C', repoPath, 'remote', 'get-url', 'origin']);
  if (out.status !== 0) return null;
  const url = out.stdout.trim();
  // git@github.com:owner/repo.git or https://github.com/owner/repo.git
  const match = url.match(/github\.com[:/]([^/]+\/[^/]+?)(?:\.git)?$/);
  return match ? match[1] : null;
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
      try { fs.unlinkSync(lockFile); } catch (e) { console.error(`[ccp] failed to remove stale lock for ${jobId}: ${(e as Error).message}`); }
      break;
    }
    spawnSync('sleep', ['0.05']);
  }
  try {
    fs.writeFileSync(lockFile, String(process.pid), { flag: 'wx' });
  } catch (e) {
    // Another process grabbed it; proceed anyway (advisory lock)
    console.error(`[ccp] lock acquisition contention for ${jobId}: ${(e as Error).message}`);
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
    try { fs.unlinkSync(lockFile); } catch (e) { console.error(`[ccp] failed to release lock for ${jobId}: ${(e as Error).message}`); }
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

  // ── Repo context enrichment (CLAUDE.md, commands, knowledge) ──
  if (packet.repo) {
    try {
      const ctx = scanRepoContext(packet.repo);
      const ctxPrompt = formatContextForPrompt(ctx);
      if (ctxPrompt) bits.push(ctxPrompt);

      // Merge auto-detected commands into repo knowledge
      const knowledge = getOrCreateKnowledge(
        packet.repoKey || path.basename(packet.repo),
        packet.ownerRepo || null,
        { commands: ctx.commands, projectType: ctx.projectType, packageManager: ctx.packageManager },
      );
      const knowledgePrompt = formatKnowledgeForPrompt(knowledge);
      if (knowledgePrompt) bits.push(knowledgePrompt);
    } catch (err) {
      appendLog(packet.job_id, `[${nowIso()}] repo-context scan failed: ${(err as Error).message}`);
    }
  }

  // ── Task details ──
  bits.push(`Ticket: ${packet.ticket_id || 'UNTRACKED'}`);
  bits.push(`Goal: ${packet.goal || 'No goal provided'}`);
  if (packet.constraints?.length) bits.push(`Constraints:\n- ${packet.constraints.join('\n- ')}`);
  if (packet.acceptance_criteria?.length) {
    bits.push(`Acceptance criteria (you MUST satisfy every item):\n${packet.acceptance_criteria.map((ac) => `- [ ] ${ac}`).join('\n')}`);
  }
  if (packet.verification_steps?.length) {
    bits.push(`Verification steps (you MUST complete each step before reporting done):\n${packet.verification_steps.map((vs, i) => `${i + 1}. ${vs}`).join('\n')}`);
  }
  if (packet.review_feedback?.length) bits.push(`Review feedback to address:\n- ${packet.review_feedback.join('\n- ')}`);

  // ── Coding best practices ──
  bits.push(`## Coding Guidelines
- Prefer minimal, focused edits. Keep changes scoped and small.
- Follow existing conventions: mimic code style, use existing libraries, follow established patterns.
- Before importing a library, verify it exists in package.json / requirements.txt / go.mod / Cargo.toml.
- Place all imports at the top of files. Do not import inside functions or classes.
- Never expose or log secrets/keys. Never commit credentials.
- Run \`git diff\` before committing to review your changes.
- If pre-commit hooks modify files on commit, review the changes and retry the commit once. Do not use --no-verify.`);

  // ── Behavioral rules ──
  bits.push('Never ask clarifying questions. You are running non-interactively — no one will answer.');
  bits.push('If the ticket is ambiguous, investigate the codebase and make your best judgment.');
  bits.push('If truly blocked (missing credentials, broken build, etc.), exit with a clear blocker description — do not ask questions.');
  bits.push('Make only the minimum necessary changes for this task.');
  bits.push('Before reporting State: coded/done/verified, you MUST describe what you did to verify your changes work. If you cannot verify, report State: blocked with Blocker: unable to verify.');
  bits.push(`At the end, output a final compact summary bracketed by sentinel markers.
Output it EXACTLY in this format (the markers must be on their own lines):

CCP_SUMMARY_BEGIN
State: <coded/deployed/verified/blocked>
Commit: <hash or none>
Prod: <yes/no>
Verified: <exact test or not yet>
Blocker: <reason or none>
Risk: <low/medium/high>
Summary: <1-3 sentence description of what you did>
CCP_SUMMARY_END`);
  bits.push('Do not claim pushed or deployed unless it actually happened. A local commit on main is not the same as pushed.');
  bits.push('If you make code changes, you MUST create a feature branch FROM main (e.g. `git checkout -b feat/my-branch main`), push it to origin, and create a pull request via `gh pr create --base main`. Never push directly to main. Never branch from another feature branch. Do not stop at a local-only commit.');
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

// prReviewPolicy is now imported from ./pr-policy

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
  const goal = packet.goal ? (packet.goal.length > 200 ? packet.goal.slice(0, 197) + '...' : packet.goal) : '';
  const msg = `🟡 START — ${ticket} | ${repoName} | ${goal}`;
  const sent = sendDiscordMessage(DISCORD_RUNS_CHANNEL, msg);
  appendLog(jobId, `[${nowIso()}] START notify: ${sent.ok ? 'ok' : (sent.stderr || 'failed')}`);
  saveStatus(jobId, { notifications: { start: sent.ok, final: false } });
}

function parseSummary(logText: string): Record<string, string> {
  const fields: Record<string, string> = {};

  // Prefer structured sentinel block if present — much more reliable than scanning the full log
  // Use matchAll + take last match to preserve 'last match wins' behavior if worker outputs multiple blocks
  const allSentinelMatches = [...logText.matchAll(/CCP_SUMMARY_BEGIN\s*\n([\s\S]*?)\nCCP_SUMMARY_END/g)];
  const sentinelMatch = allSentinelMatches.length ? allSentinelMatches[allSentinelMatches.length - 1] : null;
  const searchText = sentinelMatch ? sentinelMatch[1] : logText;

  for (const key of ['State', 'Commit', 'Prod', 'Verified', 'Blocker', 'Risk', 'Summary']) {
    const re = new RegExp(`^${key}:\\s*(.+)$`, 'gmi');
    const matches = [...searchText.matchAll(re)];
    if (matches.length) fields[key.toLowerCase()] = matches[matches.length - 1][1].trim();
  }
  // Extract PR URL — try multiple patterns workers use:
  // 1. "PR created: <url>"
  // 2. "PR: <url>"  
  // 3. Any github.com pull request URL in the log
  // Always search full log for PR URLs since they may appear outside the sentinel block
  const prPatterns = [
    /PR created:\s*(https:\/\/github\.com\/\S+\/pull\/\d+)/gmi,
    /^PR:\s*(https:\/\/github\.com\/\S+\/pull\/\d+)/gmi,
    /(https:\/\/github\.com\/[^\s"']+\/pull\/\d+)/gm,
  ];
  for (const pattern of prPatterns) {
    const matches = [...logText.matchAll(pattern)];
    if (matches.length) {
      fields.pr_url = matches[matches.length - 1][1].trim();
      break;
    }
  }
  return fields;
}

function inspectRepoProof(repo: string | null, claimedCommit: string): RepoProof {
  // Normalize: workers sometimes report "abc1234 (already merged to main)" — extract just the hash
  const commitMatch = claimedCommit.match(/^([0-9a-f]{7,40})/i);
  claimedCommit = commitMatch ? commitMatch[1] : claimedCommit;

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
    // First try local object store
    const revOut = run(git, ['-C', repo, 'rev-parse', '--verify', `${claimedCommit}^{commit}`]);
    commitExists = revOut.status === 0;
    // If not found locally, fetch and check origin/main (covers reviewfix case where
    // work was already merged to main and the worker correctly identifies it)
    if (!commitExists) {
      run(git, ['-C', repo, 'fetch', '--quiet', 'origin', 'main']);
      const remoteOut = run(git, ['-C', repo, 'merge-base', '--is-ancestor', claimedCommit, 'FETCH_HEAD']);
      if (remoteOut.status === 0) commitExists = true;
    }
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

/**
 * After a job exits, if the repo is dirty with no commit, reset it back to main.
 * Prevents cascading failures where subsequent jobs find a dirty working tree.
 */
function cleanRepoIfDirty(repoPath: string, proof: RepoProof): string | null {
  if (!repoPath || !proof.dirty) return null;
  const git = commandExists('git') || 'git';
  const log: string[] = [];
  // Discard uncommitted changes
  run(git, ['-C', repoPath, 'checkout', '--', '.']);
  // Remove untracked files
  run(git, ['-C', repoPath, 'clean', '-fd']);
  // Switch back to main if on a feature branch
  const branchOut = run(git, ['-C', repoPath, 'branch', '--show-current']);
  const branch = branchOut.stdout.trim();
  if (branch && branch !== 'main') {
    const checkout = run(git, ['-C', repoPath, 'checkout', 'main']);
    if (checkout.status === 0) {
      log.push(`switched ${branch} → main`);
    }
  }
  // Verify clean
  const statusAfter = run(git, ['-C', repoPath, 'status', '--porcelain']);
  const stillDirty = (statusAfter.stdout || '').trim().length > 0;
  log.push(stillDirty ? 'still dirty after cleanup' : 'clean');
  return log.join('; ');
}

/**
 * Extract a concise reason the worker failed/blocked from its log output.
 * Looks for error patterns, the worker's own summary, or the last meaningful lines.
 */
function extractWorkerFailureContext(logText: string, maxLen: number = 500): string {
  // 1. Worker's own blocker/summary line
  const blockerMatch = logText.match(/^Blocker:\s*(.+)$/im);
  if (blockerMatch && blockerMatch[1].trim() !== 'none') {
    return blockerMatch[1].trim().slice(0, maxLen);
  }
  const summaryMatch = logText.match(/^Summary:\s*(.+)$/im);
  if (summaryMatch) {
    return summaryMatch[1].trim().slice(0, maxLen);
  }

  // 2. Common error patterns
  const errorPatterns = [
    /error(?:\[.+?\])?:\s*(.+)/im,
    /(?:ERR!|Error|FATAL|panic|Traceback)[\s:]+(.+)/im,
    /Cannot find module\s+'([^']+)'/i,
    /(?:ENOENT|EACCES|EPERM):\s*(.+)/i,
    /API Error[:\s]+(.+)/im,
    /rate.?limit|overloaded|529|503/im,
  ];
  for (const pat of errorPatterns) {
    const m = logText.match(pat);
    if (m) return (m[1] || m[0]).trim().slice(0, maxLen);
  }

  // 3. Last non-empty lines before WORKER_EXIT_CODE (often the most useful)
  const exitIdx = logText.lastIndexOf('WORKER_EXIT_CODE');
  const textBeforeExit = exitIdx > 0 ? logText.slice(Math.max(0, exitIdx - 1000), exitIdx) : logText.slice(-1000);
  const lines = textBeforeExit.split('\n').map(l => l.trim()).filter(l => l.length > 5);
  if (lines.length > 0) {
    return lines.slice(-3).join(' | ').slice(0, maxLen);
  }

  return 'no diagnostic output captured';
}

function inferBlockedReason(logText: string, result: { state: string; commit: string; prod: string; verified: string; pr_url: string | null }, proof: RepoProof): string | null {
  const permissionMatch = logText.match(/I need file write permission to proceed\.[\s\S]*?(?=WORKER_EXIT_CODE:|$)/i);
  if (permissionMatch) {
    return permissionMatch[0].trim();
  }
  const hasReviewDelivery = !!result.pr_url;
  const workerContext = extractWorkerFailureContext(logText);
  const proofDetail = `(commit=${proof.commitExists ? 'yes' : 'no'}, dirty=${proof.dirty ? 'yes' : 'no'}, pushed=${proof.pushed ?? 'unknown'})`;

  if ((result.state === 'coded' || result.state === 'done' || result.state === 'verified') && !proof.commitExists && !proof.dirty) {
    return `no commit or file changes found ${proofDetail}. Worker said: ${workerContext}`;
  }
  if ((result.state === 'coded' || result.state === 'done' || result.state === 'verified') && proof.dirty && !proof.commitExists) {
    return `uncommitted local changes but no commit created ${proofDetail}. Worker said: ${workerContext}`;
  }
  if ((result.state === 'coded' || result.state === 'done' || result.state === 'verified') && proof.commitExists && proof.pushed === false && !hasReviewDelivery) {
    return `local commit exists but was not pushed ${proofDetail}. Worker said: ${workerContext}`;
  }
  if ((result.state === 'done' || result.state === 'verified') && !proof.commitExists) {
    return `claimed done but no verifiable commit ${proofDetail}. Worker said: ${workerContext}`;
  }
  if (result.prod === 'yes' && !proof.commitExists) {
    return `claimed prod=yes but no verifiable commit ${proofDetail}. Worker said: ${workerContext}`;
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
  // Use worktree path for proof inspection (branch/dirty/pushed are per-working-tree)
  const proofPath = status.worktree_path || packet.repo;
  const proof = inspectRepoProof(proofPath, summary.commit || 'none');
  const inferredBlocker = inferBlockedReason(logText, {
    state: provisionalState,
    commit: summary.commit || 'none',
    prod: summary.prod || 'no',
    verified: summary.verified || 'not yet',
    pr_url: summary.pr_url || null,
  }, proof);
  const finalState = inferredBlocker ? 'blocked' : provisionalState;

  // If the job is blocked due to dirty repo state, clean it up.
  // For worktree jobs, skip cleanRepoIfDirty (it tries `git checkout main` which fails in worktrees)
  // — the worktree will be deleted entirely in the cleanup step below.
  // For shared-clone jobs, clean up so subsequent jobs don't inherit dirty state.
  if (finalState === 'blocked' && proof.dirty && proofPath && !status.worktree_path) {
    const cleanResult = cleanRepoIfDirty(proofPath, proof);
    appendLog(jobId, `[${nowIso()}] repo cleanup: ${cleanResult}`);
  }

  // Fallback: if no PR URL found in logs but branch was pushed, check GitHub for an open PR
  let prUrl: string | null = summary.pr_url || null;
  if (!prUrl && proof.pushed && proof.branch && proof.branch !== 'main' && proof.branch !== 'master' && packet.repo) {
    const gh = commandExists('gh');
    if (gh) {
      const ownerRepo = resolveOwnerRepo(packet.repo);
      if (ownerRepo) {
        const prCheck = run(gh, ['pr', 'view', proof.branch, '--repo', ownerRepo, '--json', 'url', '-q', '.url']);
        if (prCheck.status === 0 && prCheck.stdout.trim().startsWith('https://')) {
          prUrl = prCheck.stdout.trim();
          appendLog(jobId, `[${nowIso()}] pr_url recovered from GitHub: ${prUrl}`);
        }
      }
    }
  }

  const result: JobResult = {
    job_id: jobId,
    state: finalState,
    commit: proof.commitExists ? (summary.commit || 'none') : 'none',
    branch: proof.branch || 'unknown',
    pushed: typeof proof.pushed === 'boolean' ? (proof.pushed ? 'yes' : 'no') : 'unknown',
    pr_url: prUrl,
    prod: finalState === 'blocked' ? 'no' : (summary.prod || 'no'),
    verified: finalState === 'blocked' ? 'not yet' : (summary.verified || 'not yet'),
    blocker: inferredBlocker || (summary.blocker && summary.blocker !== 'none' ? summary.blocker : null),
    blocker_type: null,
    failed_checks: [],
    risk: summary.risk || null,
    summary: summary.summary || null,
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
      const maxBlocker = 1800;
      const blocker = result.blocker ? (result.blocker.length > maxBlocker ? result.blocker.slice(0, maxBlocker - 3) + '...' : result.blocker) : 'unknown';
      const emoji = result.state === 'blocked' ? '🔴 BLOCKED' : '❌ FAIL';
      const exitInfo = exitCode !== 0 ? ` (exit ${exitCode})` : '';
      runsMsg = `${emoji} — ${ticket} | ${repoName}${exitInfo}\n${blocker}`;
    } else {
      const parts: string[] = [`✅ DONE — ${ticket} | ${repoName}`];
      if (commitShort) parts.push(commitShort);
      if (result.risk) parts.push(`risk:${result.risk}`);
      if (result.pr_url) parts.push(`→ PR ${result.pr_url.split('/').pop()}`);
      if (result.verified && result.verified !== 'not yet') {
        const v = result.verified.length > 200 ? result.verified.slice(0, 197) + '...' : result.verified;
        parts.push(v);
      }
      runsMsg = parts.join(' | ');
    }

    // Route: successes → status channel, all failures/blocked → errors channel
    const isFailure = exitCode !== 0 || result.state === 'blocked' || result.state === 'failed';
    const target = isFailure ? DISCORD_ERRORS_CHANNEL : DISCORD_STATUS_CHANNEL;
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
      sendDiscordMessage(DISCORD_STATUS_CHANNEL, reviewParts.join('\n'));
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
        if (result.summary) threadParts.push(`**Summary:** ${result.summary}`);
        if (result.risk) threadParts.push(`**Risk:** ${result.risk}`);
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

    // Post completion comment to Linear ticket
    const didWork = result.commit !== 'none' || result.state === 'blocked' || result.state === 'coded' || result.state === 'done' || result.state === 'verified';
    if (didWork && packet.ticket_id) {
      const link = getJobLinearLink(jobId);
      if (link?.issueId) {
        postCompletionComment(link.issueId, result, { discordThreadId: threadId }).catch(() => null);
      }
    }
  }

  // Fire webhook callback if the job has a webhookUrl in metadata (app-dispatched fixes)
  const statusMap: Record<string, string> = {
    coded: 'pr_open', done: 'merged', verified: 'verified',
    blocked: 'failed', failed: 'failed',
  };
  const webhookStatus = statusMap[finalState] || 'in_progress';
  const whLog = fireWebhookCallback({
    packet, jobId, status: webhookStatus,
    prUrl: result.pr_url || null, error: result.blocker || null,
  });
  if (whLog) appendLog(jobId, `[${nowIso()}] ${whLog}`);

  // Outage circuit breaker: detect API failures and trigger outage mode
  const wasApiFailure = (exitCode !== 0 || finalState === 'blocked') && isApiOutageLog(logText);
  const { enteredOutage } = recordJobOutcome(wasApiFailure);
  if (enteredOutage) {
    const outagePct = packet.ticket_id || jobId;
    const alertMsg = `⚠️ OUTAGE DETECTED — Anthropic API is returning errors. Pausing all job dispatch until it recovers. Last job: ${outagePct}`;
    sendDiscordMessage(DISCORD_ERRORS_CHANNEL, alertMsg);
    appendLog(jobId, `[${nowIso()}] outage mode activated`);
  }

  // Rate limit detection: if worker hit usage limits, pause until reset time
  const { detectRateLimit: detectRL, recordRateLimit } = require('./outage');
  const rateLimit = detectRL(logText);
  if (rateLimit) {
    recordRateLimit(rateLimit.resetAt, rateLimit.reason);
    const resetDate = new Date(rateLimit.resetAt);
    const resetStr = resetDate.toLocaleTimeString('en-US', { timeZone: 'America/New_York', hour: 'numeric', minute: '2-digit' });
    const alertMsg = `⏸️ RATE LIMITED — Claude usage limit hit. Pausing all dispatch until ${resetStr} ET. Last job: ${packet.ticket_id || jobId}`;
    sendDiscordMessage(DISCORD_ERRORS_CHANNEL, alertMsg);
    appendLog(jobId, `[${nowIso()}] rate limit detected — pausing until ${rateLimit.resetAt}`);
  }

  // ── Automatic retry for transient API failures ──
  // If the job failed due to a transient API error and hasn't exhausted retries,
  // automatically queue a new attempt instead of leaving it as permanently failed.
  if (wasApiFailure && !rateLimit) {
    const retryCount = (packet.retryCount ?? 0);
    const maxRetries = (packet.maxRetries ?? DEFAULT_MAX_RETRIES);
    if (retryCount < maxRetries) {
      const retryPacket: JobPacket = {
        ...packet,
        job_id: `${packet.job_id}_retry${retryCount + 1}`,
        retryCount: retryCount + 1,
        constraints: [
          ...(packet.constraints || []),
          `This is automatic retry #${retryCount + 1} after a transient API failure. The previous attempt (${jobId}) failed with: ${extractWorkerFailureContext(logText, 200)}`,
        ],
      };
      const retryCreated = createJob(retryPacket);
      appendLog(jobId, `[${nowIso()}] auto-retry queued: ${retryCreated.jobId} (attempt ${retryCount + 1}/${maxRetries})`);
      sendDiscordMessage(DISCORD_ERRORS_CHANNEL,
        `🔁 AUTO-RETRY — job \`${jobId}\` failed with transient API error, queued retry \`${retryCreated.jobId}\` (${retryCount + 1}/${maxRetries})`);
    } else {
      appendLog(jobId, `[${nowIso()}] max retries exhausted (${retryCount}/${maxRetries}) — not retrying`);
    }
  }

  // ── Post-job knowledge extraction ──
  // Parse the worker log for discoverable patterns and enrich repo knowledge
  if (packet.repo && packet.repoKey) {
    try {
      extractAndPersistKnowledge(packet.repoKey, logText, finalState);
    } catch (err) {
      appendLog(jobId, `[${nowIso()}] knowledge extraction failed: ${(err as Error).message}`);
    }
  }

  // ── Worktree cleanup ──
  // Remove the isolated git worktree created for this job (if any)
  if (status.worktree_path && packet.repo) {
    try {
      removeJobWorktree(packet.repo, status.worktree_path);
      appendLog(jobId, `[${nowIso()}] worktree removed: ${status.worktree_path}`);
      saveStatus(jobId, { worktree_path: null });
    } catch (err) {
      appendLog(jobId, `[${nowIso()}] worktree cleanup failed: ${(err as Error).message}`);
    }
  }

  return { ok: true, state: finalState, exitCode, result, linear };
}

/**
 * Parse worker log output to extract learnings and persist them to repo knowledge.
 * Looks for:
 * - Command corrections (worker used different command than what we suggested)
 * - Error patterns and their fixes
 * - Useful notes about the repo
 */
function extractAndPersistKnowledge(repoKey: string, logText: string, finalState: string): void {
  const knowledge = loadKnowledge(repoKey);
  if (!knowledge) return;
  let changed = false;

  // 1. Detect command corrections — worker found a different command than what we auto-detected
  const commandCorrections: Array<{ key: string; pattern: RegExp }> = [
    { key: 'lint', pattern: /(?:lint command|linting)[:\s]*[`"]?([a-z]+ (?:run )?[a-z:_-]+)[`"]?/i },
    { key: 'typecheck', pattern: /(?:typecheck|type.?check)[:\s]*[`"]?([a-z]+ (?:run )?[a-z:_-]+)[`"]?/i },
    { key: 'test', pattern: /(?:running tests|test command)[:\s]*[`"]?([a-z]+ (?:run )?[a-z:_-]+)[`"]?/i },
    { key: 'build', pattern: /(?:build command|building)[:\s]*[`"]?([a-z]+ (?:run )?[a-z:_-]+)[`"]?/i },
  ];

  // Only look at the last portion of the log to avoid false positives from prompts
  const logTail = logText.slice(-5000);

  for (const { key, pattern } of commandCorrections) {
    const cmdKey = key as keyof typeof knowledge.commands;
    const match = logTail.match(pattern);
    if (match && match[1]) {
      const discovered = match[1].trim();
      // Only update if we don't already have a value or the worker used something different
      if (!knowledge.commands[cmdKey] && discovered.length > 3 && discovered.length < 60) {
        knowledge.commands[cmdKey] = discovered;
        changed = true;
      }
    }
  }

  // 2. Extract error patterns and fixes from worker's problem-solving
  const errorFixPatterns = [
    // Worker explicitly says how they fixed something
    /(?:fixed by|resolved by|solution was|workaround:)\s*(.{10,200})/gi,
    // "error X was caused by Y" patterns
    /(?:the error|this error|the issue)\s+(?:was caused by|is because|happens because)\s*(.{10,200})/gi,
  ];

  for (const pat of errorFixPatterns) {
    const matches = logTail.matchAll(pat);
    for (const m of matches) {
      const fix = m[1].trim();
      if (fix.length > 10 && fix.length < 200) {
        // Use a shortened version as the pattern key
        const patternKey = fix.slice(0, 80);
        const existing = knowledge.knownIssues.find((ki: { pattern: string }) => ki.pattern === patternKey);
        if (!existing && knowledge.knownIssues.length < 20) {
          knowledge.knownIssues.push({
            pattern: patternKey,
            fix,
            addedAt: new Date().toISOString(),
          });
          changed = true;
        }
      }
    }
  }

  // 3. If the job failed or blocked, record the failure pattern for future reference
  if ((finalState === 'blocked' || finalState === 'failed') && knowledge.knownIssues.length < 20) {
    const failureContext = extractWorkerFailureContext(logText, 150);
    if (failureContext && failureContext !== 'no diagnostic output captured') {
      const existing = knowledge.knownIssues.find((ki: { pattern: string }) => ki.pattern === failureContext);
      if (!existing) {
        knowledge.knownIssues.push({
          pattern: failureContext,
          fix: `Job ${finalState} — may need manual investigation`,
          addedAt: new Date().toISOString(),
        });
        changed = true;
      }
    }
  }

  if (changed) {
    saveKnowledge(knowledge);
  }
}

/**
 * Resolve the max duration for a job. Checks repo-level override in repos.json,
 * then falls back to the global default (30 min).
 */
function resolveMaxJobDuration(packet: JobPacket): number {
  if (packet.repo) {
    const mapping = findRepoByPath(packet.repo);
    if (mapping?.maxJobDurationSec && mapping.maxJobDurationSec > 0) {
      return mapping.maxJobDurationSec;
    }
  }
  return DEFAULT_MAX_JOB_DURATION_SEC;
}

/**
 * Detect if a worker is stuck in a loop by comparing recent heartbeat excerpts.
 * Reads the last N heartbeat files or compares against current status excerpts.
 */
function detectStuckLoop(jobId: string, currentExcerpt: string): boolean {
  const historyFile = path.join(jobDir(jobId), 'heartbeat-history.json');
  let history: string[] = [];
  try {
    if (fs.existsSync(historyFile)) {
      history = JSON.parse(fs.readFileSync(historyFile, 'utf8'));
    }
  } catch { /* start fresh */ }

  // Normalize: trim whitespace and collapse runs of whitespace
  const normalized = currentExcerpt.trim().replace(/\s+/g, ' ');
  if (normalized.length < 10) {
    // Too short to be meaningful — skip loop detection
    return false;
  }

  history.push(normalized);
  // Keep only the last N entries
  if (history.length > STUCK_LOOP_THRESHOLD + 2) {
    history = history.slice(-STUCK_LOOP_THRESHOLD - 2);
  }
  fs.writeFileSync(historyFile, JSON.stringify(history));

  // Check if the last N entries are identical
  if (history.length >= STUCK_LOOP_THRESHOLD) {
    const recent = history.slice(-STUCK_LOOP_THRESHOLD);
    if (recent.every(h => h === recent[0])) {
      return true;
    }
  }
  return false;
}

async function reconcileJob(jobId: string): Promise<{ ok: boolean; state: string; live?: boolean; exitCode?: number; result?: JobResult; linear?: LinearSyncResult }> {
  const status = loadStatus(jobId);
  if (status.state === 'running' && !tmuxSessionAlive(status.tmux_session)) {
    return await finalizeJob(jobId);
  }
  if (status.state === 'running') {
    notifyStart(jobId);

    // ── Job timeout detection ──
    // If exceeded, kill the tmux session and let the normal dead-session path
    // trigger finalizeJob on the next reconcile cycle. This ensures all
    // post-processing (webhooks, Linear sync, auto-retry, knowledge extraction)
    // still runs.
    if (status.started_at) {
      const elapsedSec = Math.round((Date.now() - new Date(status.started_at).getTime()) / 1000);
      let packet: JobPacket | null = null;
      try { packet = readJson(packetPath(jobId)) as unknown as JobPacket; } catch { /* ignore */ }
      const maxDuration = packet ? resolveMaxJobDuration(packet) : DEFAULT_MAX_JOB_DURATION_SEC;

      if (elapsedSec > maxDuration) {
        const durationMin = Math.round(elapsedSec / 60);
        const limitMin = Math.round(maxDuration / 60);
        appendLog(jobId, `[${nowIso()}] TIMEOUT: job running ${durationMin}min exceeds limit of ${limitMin}min — killing tmux session`);
        sendDiscordMessage(DISCORD_ERRORS_CHANNEL,
          `⏰ TIMEOUT — job \`${jobId}\` auto-interrupted after ${durationMin}min (limit: ${limitMin}min)`);
        // Kill tmux only — don't call interruptJob so finalizeJob runs next cycle
        if (status.tmux_session) {
          const tmuxBin = commandExists('tmux') || 'tmux';
          run(tmuxBin, ['kill-session', '-t', status.tmux_session]);
        }
        saveStatus(jobId, { exit_code: 124, last_output_excerpt: `timeout: exceeded ${limitMin}min limit` });
        return { ok: true, state: 'running', live: false };
      }
    }

    // ── Heartbeat capture ──
    const tmux = commandExists('tmux') || 'tmux';
    const capture = run(tmux, ['capture-pane', '-pt', status.tmux_session!]);
    if (capture.status === 0) {
      const excerpt = safeExcerpt(capture.stdout || '');
      saveStatus(jobId, {
        last_heartbeat_at: nowIso(),
        last_output_excerpt: excerpt,
      });

      // ── Stuck-loop detection ──
      // Kill tmux only — finalizeJob will handle cleanup on next cycle
      if (detectStuckLoop(jobId, excerpt)) {
        appendLog(jobId, `[${nowIso()}] STUCK LOOP: identical output repeated ${STUCK_LOOP_THRESHOLD}+ times — killing tmux session`);
        sendDiscordMessage(DISCORD_ERRORS_CHANNEL,
          `🔄 STUCK LOOP — job \`${jobId}\` appears stuck (same output ${STUCK_LOOP_THRESHOLD}x) — auto-interrupting`);
        if (status.tmux_session) {
          run(tmux, ['kill-session', '-t', status.tmux_session]);
        }
        saveStatus(jobId, { exit_code: 124, last_output_excerpt: `stuck loop: same output repeated ${STUCK_LOOP_THRESHOLD}+ heartbeats` });
        return { ok: true, state: 'running', live: false };
      }
    }
    return { ok: true, state: 'running', live: true };
  }
  return { ok: true, state: status.state, live: false };
}

/**
 * Resolve max conversation turns for the worker.
 * Checks per-repo config first, then global default.
 */
function resolveMaxTurns(packet: JobPacket): number | null {
  const mapping = packet.repo ? findRepoByPath(packet.repo) : null;
  if (mapping?.maxTurns) return mapping.maxTurns;
  const envVal = process.env.CCP_DEFAULT_MAX_TURNS;
  if (envVal && Number.isFinite(Number(envVal))) return Number(envVal);
  return null; // null = use Claude CLI default
}

/**
 * Create an isolated git worktree for the job so workers don't interfere with
 * each other or leave the shared clone in a dirty state.
 * Returns the worktree path on success, or null if worktree creation fails
 * (caller falls back to the shared clone).
 */
function createJobWorktree(jobId: string, repoPath: string, branch: string | null): string | null {
  const worktreeBase = path.join('/tmp', 'ccp-worktrees');
  const worktreePath = path.join(worktreeBase, jobId);
  try {
    fs.mkdirSync(worktreeBase, { recursive: true });
    const git = (args: string[]) => run('git', ['-C', repoPath, ...args]);
    // Fetch latest before creating worktree
    git(['fetch', 'origin', '--quiet']);
    if (branch) {
      // For working_branch jobs, create worktree on that branch
      const wt = git(['worktree', 'add', worktreePath, `origin/${branch}`, '--detach']);
      if (wt.status !== 0) return null;
      // Create a local tracking branch inside the worktree
      const gitWt = (args: string[]) => run('git', ['-C', worktreePath, ...args]);
      const checkoutResult = gitWt(['checkout', '-B', branch, `origin/${branch}`]);
      if (checkoutResult.status !== 0) return null;
    } else {
      // For new jobs, create worktree from origin/main in detached HEAD.
      // We intentionally leave it detached — checking out 'main' would fail because
      // it's already checked out in the shared clone. The worker will create its own
      // feature branch from this starting point.
      const wt = git(['worktree', 'add', worktreePath, 'origin/main', '--detach']);
      if (wt.status !== 0) return null;
    }
    return worktreePath;
  } catch {
    return null;
  }
}

/**
 * Remove a git worktree created for a job.
 */
function removeJobWorktree(repoPath: string, worktreePath: string): void {
  const result = run('git', ['-C', repoPath, 'worktree', 'remove', '--force', worktreePath]);
  if (result.status !== 0) {
    // Best-effort cleanup; if git worktree remove fails, try rm
    try { fs.rmSync(worktreePath, { recursive: true, force: true }); } catch { /* ignore */ }
    try { run('git', ['-C', repoPath, 'worktree', 'prune']); } catch { /* ignore */ }
  }
}

function startTmuxWorker(jobId: string, packet: JobPacket, pf: PreflightResult): { session: string; worktreePath: string | null } {
  const session = `ccp_${jobId}`.replace(/[^a-zA-Z0-9_]/g, '_');
  run(pf.tmux, ['kill-session', '-t', session]);

  const logFile = path.join(jobDir(jobId), 'worker.log');
  const promptFile = path.join(jobDir(jobId), 'prompt.txt');
  fs.writeFileSync(promptFile, buildPrompt(packet));

  // Build worker command with optional --max-turns
  const maxTurns = resolveMaxTurns(packet);
  const turnFlag = maxTurns ? ` --max-turns ${maxTurns}` : '';
  const workerCmd = `${shellQuote(pf.claude)} --print --permission-mode bypassPermissions${turnFlag} -p ${shellQuote(fs.readFileSync(promptFile, 'utf8'))}`;

  // Try to create an isolated worktree for this job
  const worktreePath = packet.repo ? createJobWorktree(jobId, packet.repo, packet.working_branch || null) : null;
  const workDir = worktreePath || packet.repo!;
  if (worktreePath) {
    appendLog(jobId, `[${nowIso()}] using git worktree: ${worktreePath}`);
  }

  const gitUser = gitIdentity();
  const shellScript = [
    'set -euo pipefail',
    `export GIT_AUTHOR_NAME=${shellQuote(gitUser.name)}`,
    `export GIT_AUTHOR_EMAIL=${shellQuote(gitUser.email)}`,
    `export GIT_COMMITTER_NAME=${shellQuote(gitUser.name)}`,
    `export GIT_COMMITTER_EMAIL=${shellQuote(gitUser.email)}`,
    `cd ${shellQuote(workDir)}`,
    // When using a worktree, the branch is already set up by createJobWorktree.
    // When falling back to shared clone, do the old checkout dance.
    ...(!worktreePath ? [
      packet.working_branch ? null : 'git checkout main 2>/dev/null || true',
      packet.working_branch ? null : 'git fetch origin main --quiet',
      packet.working_branch ? null : 'git reset --hard origin/main',
      packet.working_branch ? `git checkout ${shellQuote(packet.working_branch)}` : null,
      packet.working_branch ? `git pull --ff-only origin ${shellQuote(packet.working_branch)} || true` : null,
    ] : []).filter(Boolean),
    `echo "[${nowIso()}] worker start" >> ${shellQuote(logFile)}`,
    `{ ${workerCmd}; } 2>&1 | tee -a ${shellQuote(logFile)}`,
    'exit_code=${PIPESTATUS[0]}',
    `echo "WORKER_EXIT_CODE: ${'$'}exit_code" >> ${shellQuote(logFile)}`,
    'exit $exit_code',
  ].filter(Boolean).join('\n');

  const out = run(pf.tmux, ['new-session', '-d', '-s', session, 'bash', '-lc', shellScript]);
  if (out.status !== 0) {
    // Clean up worktree on failure
    if (worktreePath && packet.repo) removeJobWorktree(packet.repo, worktreePath);
    throw new Error((out.stderr || out.stdout || 'tmux new-session failed').trim());
  }
  return { session, worktreePath };
}

function interruptJob(jobId: string, reason: string = 'interrupted by operator'): { ok: boolean; job_id: string; state: string; interrupted: boolean } {
  const status = loadStatus(jobId);
  appendLog(jobId, `[${nowIso()}] interrupt requested: ${reason}`);
  if (status.tmux_session && tmuxSessionAlive(status.tmux_session)) {
    const tmux = commandExists('tmux') || 'tmux';
    const out = run(tmux, ['kill-session', '-t', status.tmux_session]);
    appendLog(jobId, `[${nowIso()}] tmux kill-session: ${out.status === 0 ? 'ok' : (out.stderr || out.stdout || 'failed').trim()}`);
  }
  // Clean up worktree before marking as blocked (prevents orphaned worktrees)
  if (status.worktree_path) {
    try {
      const packet = readJson(packetPath(jobId)) as unknown as JobPacket;
      if (packet.repo) {
        removeJobWorktree(packet.repo, status.worktree_path);
        appendLog(jobId, `[${nowIso()}] worktree removed on interrupt: ${status.worktree_path}`);
      }
    } catch { /* best-effort */ }
  }
  saveStatus(jobId, {
    state: 'blocked',
    exit_code: 130,
    last_heartbeat_at: nowIso(),
    last_output_excerpt: reason,
    worktree_path: null,
  });
  writeJson(resultPath(jobId), {
    job_id: jobId,
    state: 'blocked',
    commit: 'none',
    prod: 'no',
    verified: 'not yet',
    blocker: reason,
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
    const worker = startTmuxWorker(jobId, packet, pf);
    appendLog(jobId, `[${nowIso()}] tmux session started: ${worker.session}`);
    saveStatus(jobId, {
      state: 'running',
      tmux_session: worker.session,
      worktree_path: worker.worktreePath,
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
      tmux_session: worker.session,
      updated_at: nowIso(),
    });
    notifyStart(jobId);
    return { ok: true, session: worker.session, worktreePath: worker.worktreePath, packet, environment: pf.environment };
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
  const activeRunning = refreshed.filter((job) => job.state === 'running');
  const capacity = Math.max(0, maxConcurrent - activeRunning.length);
  // Sort queued jobs by priority (lower number = higher priority) then by timestamp (FIFO within same priority)
  const queued = refreshed.filter((job) => job.state === 'queued');
  // Pre-compute priorities in a single O(n) pass to avoid redundant disk reads inside the comparator
  const priorityMap = new Map<string, number>();
  for (const job of queued) {
    let pri = 3;
    try { pri = (readJson(packetPath(job.job_id)) as unknown as JobPacket).priority ?? 3; } catch { /* default */ }
    priorityMap.set(job.job_id, pri);
  }
  queued.sort((a, b) => {
    const aPri = priorityMap.get(a.job_id) ?? 3;
    const bPri = priorityMap.get(b.job_id) ?? 3;
    if (aPri !== bPri) return aPri - bPri;
    return a.updated_at > b.updated_at ? 1 : -1;
  });

  // Build set of repos that already have a running job (for per-repo serial enforcement)
  const busyRepos = new Set<string>();
  for (const job of activeRunning) {
    try {
      const packet = readJson(packetPath(job.job_id)) as unknown as JobPacket;
      if (packet.repo) busyRepos.add(packet.repo);
    } catch (err) {
      console.error(`[ccp] failed to read packet for running job ${job.job_id}: ${(err as Error).message}`);
    }
  }

  // Check peak-hour scheduling + outage state before dispatching new jobs
  const { canDispatchJobs } = require('./scheduling');
  const { runOutageProbe: probeOutage, getOutageStatus } = require('./outage');
  const scheduleCheck = canDispatchJobs();
  (summary as unknown as Record<string, unknown>).scheduling = scheduleCheck;

  // During outage: probe the API each cycle and auto-resume when it recovers
  if (!scheduleCheck.allowed && scheduleCheck.reason.includes('outage')) {
    const probe = probeOutage();
    if (probe.nowRecovered) {
      const outageDuration = probe.state.outageSince
        ? Math.round((Date.now() - new Date(probe.state.outageSince).getTime()) / 60000)
        : null;
      const msg = `✅ Anthropic API recovered — resuming job dispatch${outageDuration ? ` (outage lasted ~${outageDuration} min)` : ''}.`;
      sendDiscordMessage(DISCORD_ERRORS_CHANNEL, msg);
    }
  }

  if (!scheduleCheck.allowed && queued.length > 0) {
    queued.forEach((job) => {
      summary.skipped.push({ job_id: job.job_id, reason: scheduleCheck.reason });
    });
  } else {
    let started = 0;
    for (const job of queued) {
      if (started >= capacity) {
        summary.skipped.push({ job_id: job.job_id, reason: 'capacity' });
        continue;
      }
      // Per-repo serial: skip if another job is already running on this repo
      let packet: JobPacket;
      try {
        packet = readJson(packetPath(job.job_id)) as unknown as JobPacket;
      } catch (err) {
        console.error(`[ccp] failed to read packet for queued job ${job.job_id}: ${(err as Error).message}`);
        summary.errors.push({ job_id: job.job_id, action: 'read_packet', error: (err as Error).message });
        continue;
      }
      if (packet.repo && busyRepos.has(packet.repo)) {
        summary.skipped.push({ job_id: job.job_id, reason: `repo busy: ${path.basename(packet.repo)}` });
        continue;
      }
      try {
        summary.started.push({ job_id: job.job_id, ...startJob(job.job_id) });
        if (packet.repo) busyRepos.add(packet.repo);
        started++;
      } catch (error) {
        summary.errors.push({ job_id: job.job_id, action: 'start', error: (error as Error).message });
      }
    }
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
  buildPrompt,
  sendDiscordMessage,
  createDiscordThread,
  sendToThread,
  removeJobWorktree,
};

export {
  ROOT,
  JOBS_DIR,
  buildPrompt,
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
  removeJobWorktree,
};
