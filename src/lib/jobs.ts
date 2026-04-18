import fs = require('fs');
import path = require('path');
import { spawnSync } from 'child_process';
import type {
  JobPacket, JobStatus, JobResult, RepoProof,
  PRReviewResult, PrReviewIntegration, RemediationResult, DiscordMessageResult, DiscordThreadResult,
  SupervisorCycleSummary, PreflightResult, LinearSyncResult, PrWatcherCycleResult,
  ReviewComment, AddressedComment, ValidationReport,
} from '../types';
import { run, commandExists, shellQuote } from './shell';
import { resolveAgent, getAgent, claudeCodeDriver } from './agents';
import type { AgentDriver } from './agents';
import { runValidation, summarizeReport, shouldGateOnValidation, buildValidationBlocker } from './validator';
const { findRepoByPath } = require('./repos');
const { loadRepoMemory } = require('./memory');
const { isWorktreeEnabled, getParallelJobLimit, acquireWorktree, releaseWorktree } = require('./worktree');
const { inspectDiscordTransport, hasDiscordTransport, sendDiscordMessage, createDiscordThread } = require('./discord');
const { syncJobToLinear, postCompletionComment, getJobLinearLink } = require('./linear');
const { dispatchLinearIssues } = require('./linear-dispatch');
const { reviewPr } = require('./pr-review');
const { isApiOutageLog, recordJobOutcome, runOutageProbe, getOutageStatus } = require('./outage');
const { prReviewPolicy } = require('./pr-policy');
const { fireWebhookCallback } = require('./webhook-callback');
const { fetchPrReviewComments, postRemediationComments } = require('./pr-comments');
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

function inspectEnvironment(repo: string | null, agent?: AgentDriver): Record<string, unknown> {
  // `doctor` / `phase0` CLI commands call this without a resolved driver;
  // default to the registry-resolved agent (honours CCP_AGENT) so diagnostic
  // commands keep working without requiring a packet/mapping.
  if (!agent) agent = resolveAgent(null, null).driver;
  const tmux = commandExists('tmux');
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

  // Delegate coding-agent binary/version detection to the resolved driver so
  // adding new agents doesn't require editing this function.
  const agentPreflight = agent.preflight();
  let agentVersion: Record<string, unknown> | null = null;
  if (agentPreflight.bin) {
    agentVersion = {
      ok: agentPreflight.ok,
      stdout: agentPreflight.version || '',
      stderr: '',
    };
  }

  const openclawStatus = openclaw ? run('openclaw', ['status']) : null;

  // `commands.claude_opus` / `commands.claude` stay populated so existing
  // dashboards/logs keep working; drivers return them in their commands map.
  const agentCmds = agentPreflight.commands || {};

  return {
    checked_at: nowIso(),
    repo,
    repo_exists: repoExists,
    agent: agent.name,
    commands: {
      tmux,
      claude_opus: agentCmds.claude_opus || '',
      claude: agentCmds.claude || '',
      git,
      node,
      openclaw,
      // Driver-specific entries (e.g. future 'codex') flow through verbatim.
      ...Object.fromEntries(
        Object.entries(agentCmds).filter(([k]) => k !== 'claude' && k !== 'claude_opus'),
      ),
    },
    shell,
    home,
    git_status: gitStatus,
    // `claude_version` retained for backward-compat with dashboard/preflight
    // consumers; represents whichever driver is active.
    claude_version: agentVersion,
    agent_version: agentVersion,
    openclaw_status: openclawStatus ? {
      ok: openclawStatus.status === 0,
      stdout: (openclawStatus.stdout || '').trim(),
      stderr: (openclawStatus.stderr || '').trim(),
    } : null,
  };
}

function preflight(jobId: string): PreflightResult {
  const packet = readJson(packetPath(jobId)) as unknown as JobPacket;
  // Resolve the agent driver once so env inspection + failure gate both see
  // the same choice. `findRepoByPath` returns the mapping (if any) for the
  // repo path; RepoMapping.agent / agentFallback are read off that.
  //
  // Fallback wiring (PR B): when the primary driver's circuit breaker is
  // open AND the repo has opted into `agentFallback`, resolveAgent swaps us
  // to the fallback driver here. The swap is logged to worker.log so the
  // operator sees why a job ran on the non-default agent.
  const mapping = packet.repo ? findRepoByPath(packet.repo) : null;
  const mappingAgent = (mapping && typeof mapping === 'object' ? (mapping as { agent?: string }).agent : undefined);
  const mappingFallback = (mapping && typeof mapping === 'object' ? (mapping as { agentFallback?: string }).agentFallback : undefined);
  const {
    getOutageStatus: getOutageStatusForAgent,
    isRateLimited: isRateLimitedForAgent,
  } = require('./outage') as typeof import('./outage');
  // "Circuit" here means "don't dispatch to this driver right now" — that
  // covers both the consecutive-failure breaker (outage=true) AND the
  // provider's own rate-limit window (paused=true). Rate-limit failures
  // don't increment the outage counter (they're matched by the separate
  // rateLimit regex bucket), so without this second check a
  // rate-limited driver would pass the per-job defer gate and get
  // dispatched every cycle until the window expires. resolveAgent uses
  // the same predicate for the primary-vs-fallback swap so fallback is
  // triggered by rate limits too, not just API errors.
  const checkCircuit = (name: string): boolean => {
    try {
      if (getOutageStatusForAgent(name)?.outage) return true;
    } catch { /* fall through */ }
    try {
      if (isRateLimitedForAgent(name)?.paused) return true;
    } catch { /* fall through */ }
    return false;
  };
  const resolution = resolveAgent(
    packet,
    (mappingAgent || mappingFallback)
      ? { agent: mappingAgent, agentFallback: mappingFallback }
      : null,
    { checkCircuit },
  );
  if (resolution.fellBackDueToOutage && resolution.primaryDriver) {
    appendLog(
      jobId,
      `[${nowIso()}] agent-fallback: primary '${resolution.primaryDriver.name}' circuit open → dispatching via fallback '${resolution.driver.name}'`,
    );
  }
  // Per-job defer gate (PR B): if the resolved driver's circuit is open
  // (including cases where fallback resolved back to the same circuit-open
  // driver), tell the supervisor to skip this cycle instead of burning
  // quota on a known-failing agent. The scheduler now only blocks dispatch
  // globally when ALL agents are out, so this per-job deferral is what
  // preserves the "don't hammer a dead API" semantics for repos pinned to
  // a specific agent with no viable alternative.
  const resolvedCircuitOpen = checkCircuit(resolution.driver.name);
  // Explicit packet-level overrides bypass the defer gate: an operator
  // who sets `packet.agent` is deliberately forcing a dispatch to that
  // driver (documented in docs/agents.md as the escape hatch for
  // driving the probe cycle on a circuit-open provider). resolveAgent
  // already preserves packet choice over fallback at
  // src/lib/agents/index.ts:140; this mirrors that precedence here so
  // the explicit choice isn't silently demoted to a deferral.
  if (resolvedCircuitOpen && resolution.source !== 'packet') {
    const label = resolution.driver.label || resolution.driver.name;
    // Narrow the defer reason so operators see whether we're waiting on an
    // outage circuit vs. a rate-limit window. isRateLimited takes
    // precedence in the message when both are true because the reset
    // time is more actionable than the outage-since timestamp.
    let cause = 'circuit open';
    try {
      const rl = isRateLimitedForAgent(resolution.driver.name);
      if (rl?.paused) {
        const resetStr = rl.resetAt
          ? new Date(rl.resetAt).toLocaleTimeString('en-US', { timeZone: 'America/New_York', hour: 'numeric', minute: '2-digit' })
          : null;
        cause = resetStr ? `rate-limited until ${resetStr} ET` : 'rate-limited';
      }
    } catch { /* keep default cause */ }
    // Three cases for the reason string:
    //   1. fellBackDueToOutage=true → we swapped to fallback successfully
    //      but the fallback's circuit is now also open (rare, usually a
    //      second consecutive provider failure).
    //   2. mappingFallback is configured → resolveAgent evaluated the
    //      swap but kept the primary because BOTH circuits are open
    //      (see src/lib/agents/index.ts:154-160). Operators need to see
    //      both driver names here so they don't waste time adding
    //      fallback config that already exists.
    //   3. No fallback configured → the original single-agent message.
    const deferReason = resolution.fellBackDueToOutage
      ? `both primary and fallback ('${label}') unavailable (${cause}) — deferring`
      : mappingFallback
        ? `primary '${resolution.driver.name}' and fallback '${mappingFallback}' both unavailable (${cause}) — deferring`
        : `${label} ${cause} — deferring (no fallback configured for this repo)`;
    appendLog(jobId, `[${nowIso()}] agent-defer: ${deferReason}`);
    return {
      ok: false,
      deferred: true,
      deferReason,
      tmux: '',
      claude: '',
      agent: resolution.driver.name,
      failures: [],
      environment: inspectEnvironment(packet.repo, resolution.driver),
    };
  }
  const agentPf = resolution.driver.preflight();
  const env = inspectEnvironment(packet.repo, resolution.driver);
  const failures: string[] = [];
  if (!packet.ticket_id) failures.push('ticket_id missing');
  if (!packet.repo || !(env.repo_exists as boolean)) failures.push(`repo missing: ${packet.repo || '(unset)'}`);
  const cmds = env.commands as Record<string, string>;
  if (!cmds.tmux) failures.push('tmux not found on PATH');
  if (!agentPf.ok) failures.push(...agentPf.failures);
  if (!cmds.git) failures.push('git not found on PATH');
  if (!cmds.node) failures.push('node not found on PATH');
  if (!cmds.openclaw) failures.push('openclaw not found on PATH');

  return {
    ok: failures.length === 0,
    tmux: cmds.tmux,
    // `claude` here is the resolved agent binary — name retained for back-
    // compat with PreflightResult consumers (startTmuxWorker etc.). When a
    // non-claude driver is active this will be that driver's binary path.
    claude: agentPf.bin,
    agent: resolution.driver.name,
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

function buildPrompt(packet: JobPacket, memory?: string | null): string {
  const bits: string[] = [];
  // Repository memory goes first so the agent reads project conventions
  // BEFORE the ticket goal — same mental order a human developer would
  // follow (skim the project README, then start on the ticket). We wrap
  // it in a labelled section with clear begin/end markers so the agent
  // can't confuse persistent context with the ticket's own ask. Review
  // comments / acceptance criteria still take precedence because they
  // appear later and are more specific.
  if (memory && memory.trim()) {
    bits.push(
      [
        'Repository context (persistent memory — read this first, then the ticket):',
        '--- BEGIN REPOSITORY MEMORY ---',
        memory.trim(),
        '--- END REPOSITORY MEMORY ---',
      ].join('\n'),
    );
  }
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
  if (packet.reviewComments?.length) {
    bits.push('You MUST address each of the following PR review comments individually.');
    bits.push('Review comments to address:');
    for (const rc of packet.reviewComments) {
      bits.push(`--- Comment #${rc.commentId} (${rc.path}${rc.line ? `:${rc.line}` : ''}) by ${rc.author || 'reviewer'} ---`);
      bits.push(rc.body);
      bits.push('---');
    }
  }
  bits.push('Never ask clarifying questions. You are running non-interactively — no one will answer.');
  bits.push('If the ticket is ambiguous, investigate the codebase and make your best judgment.');
  bits.push('If truly blocked (missing credentials, broken build, etc.), exit with a clear blocker description — do not ask questions.');
  bits.push('Make only the minimum necessary changes for this task.');
  bits.push('Before reporting State: coded/done/verified, you MUST describe what you did to verify your changes work. If you cannot verify, report State: blocked with Blocker: unable to verify.');
  bits.push('At the end, output a final compact summary with these exact labels on separate lines:');
  bits.push('State: <coded/deployed/verified/blocked>');
  bits.push('Commit: <hash or none>');
  bits.push('Prod: <yes/no>');
  bits.push('Verified: <exact test or not yet>');
  bits.push('Blocker: <reason or none>');
  bits.push('Risk: <low/medium/high>');
  bits.push('Summary: <1-3 sentence description of what you did>');
  bits.push('Do not claim pushed or deployed unless it actually happened. A local commit on main is not the same as pushed.');
  bits.push('If you make code changes, you MUST create a feature branch FROM main (e.g. `git checkout -b feat/my-branch main`), push it to origin, and create a pull request via `gh pr create --base main`. Never push directly to main. Never branch from another feature branch. Do not stop at a local-only commit.');
  if (packet.reviewComments?.length) {
    bits.push('IMPORTANT: After your final summary, you MUST also output an AddressedComments JSON block.');
    bits.push('For EACH review comment listed above, report what you did. Output a SINGLE line in this exact format:\nAddressedComments: [{"commentId": <number>, "status": "fixed"|"not_fixed"|"partial", "explanation": "<what changed or why not fixed>"}, ...]');
    bits.push('The AddressedComments block MUST be valid JSON on a single line starting with "AddressedComments: ". Include one entry per review comment. Do not skip any.');
  }
  return bits.join('\n\n');
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

/**
 * Phase 2b: if validation gating promoted the job to `validation-failed`, spawn
 * a `__valfix` remediation job with the failing-step output as feedback. The
 * fix job targets the same branch so the existing PR gets updated in place.
 *
 * Gated on CCP_PR_REMEDIATE_ENABLED (shared with PR-review remediation) and
 * the per-repo `validation.gate` flag that already produced the blocker.
 */
function maybeEnqueueValidationRemediation(
  jobId: string,
  packet: JobPacket,
  result: JobResult,
): RemediationResult {
  const enabled = String(process.env.CCP_PR_REMEDIATE_ENABLED || 'true').toLowerCase() !== 'false';
  if (!enabled) return { ok: false, skipped: true, reason: 'remediation disabled' };
  if (/__deployfix|__reviewfix|__valfix/.test(jobId)) {
    return { ok: false, skipped: true, reason: 'remediation depth limit: job is already a remediation' };
  }
  if (result.blocker_type !== 'validation-failed') {
    return { ok: false, skipped: true, reason: 'job is not blocked on validation' };
  }
  if (!result.validation || result.validation.skipped) {
    return { ok: false, skipped: true, reason: 'no validation report to remediate' };
  }

  const remediationJobId = `${jobId}__valfix`;
  if (fs.existsSync(statusPath(remediationJobId))) {
    return { ok: true, skipped: true, reason: 'remediation job already exists', job_id: remediationJobId };
  }

  const blocker = buildValidationBlocker(result.validation);
  const failingList = blocker.failedStepNames.join(', ') || 'unknown';
  const feedback: string[] = [
    `Static validation failed for ${packet.ticket_id || jobId}.`,
    `Failing required steps: ${failingList}.`,
    result.pr_url ? `PR: ${result.pr_url}` : `Branch: ${result.branch || 'unknown'}`,
    'Fix every failing step on the existing branch. Do not create a new PR.',
    'Re-run the same validation commands locally after your fix to confirm green before pushing.',
    ...blocker.feedback,
  ];

  const remediationPacket: JobPacket = {
    ...packet,
    job_id: remediationJobId,
    goal: `Remediate validation failure(s) for ${packet.ticket_id || jobId} (${failingList})`,
    source: 'validation',
    kind: 'bug',
    label: 'validation-fix',
    review_feedback: feedback,
    // Clear inherited PR review comments — this is a validation-fix task, not a
    // review-fix task. Leaving them set would cause buildPrompt to instruct the
    // agent to also "address each review comment individually" + emit an
    // AddressedComments block, which is irrelevant here and splits attention.
    reviewComments: undefined,
    working_branch: result.branch && result.branch !== 'unknown' ? result.branch : packet.working_branch || null,
    base_branch: packet.base_branch || 'main',
    acceptance_criteria: [
      ...(packet.acceptance_criteria || []),
      `Make every failing validation step pass: ${failingList}.`,
      'Push updates to the existing PR branch.',
      'Do not create a new PR.',
    ],
    verification_steps: [
      ...(packet.verification_steps || []),
      'Re-run the failing validation commands locally before declaring done.',
      'If a command cannot reasonably be made green in this patch, leave a precise blocker note explaining why.',
    ],
    created_at: nowIso(),
  };
  const created = createJob(remediationPacket);
  appendLog(jobId, `[${nowIso()}] validation remediation job queued: ${created.jobId}`);
  return { ok: true, skipped: false, job_id: created.jobId, branch: remediationPacket.working_branch, blockerType: 'validation-failed' };
}

function maybeEnqueueReviewRemediation(jobId: string, packet: JobPacket, result: JobResult, prReview: PRReviewResult & { skipped?: boolean }): RemediationResult {
  const enabled = String(process.env.CCP_PR_REMEDIATE_ENABLED || 'true').toLowerCase() !== 'false';
  if (!enabled) return { ok: false, skipped: true, reason: 'remediation disabled' };
  // Include __valfix so a Phase 2b validation remediation PR that picks up a
  // blocking review doesn't cascade into a __valfix__reviewfix job — one layer
  // of auto-remediation per original job id, period.
  if (/__deployfix|__reviewfix|__valfix/.test(jobId)) return { ok: false, skipped: true, reason: 'remediation depth limit: job is already a remediation' };
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

  // Fetch structured review comments from the PR for comment-level tracking
  let reviewComments: ReviewComment[] = [];
  if (prReview.blockerType === 'review' || prReview.blockerType === 'checks') {
    try {
      reviewComments = fetchPrReviewComments(prReview.prUrl);
      if (reviewComments.length > 0) {
        appendLog(jobId, `[${nowIso()}] fetched ${reviewComments.length} review comments from PR`);
      }
    } catch (e) {
      appendLog(jobId, `[${nowIso()}] failed to fetch review comments: ${(e as Error).message}`);
    }
  }

  const remediationPacket: JobPacket = {
    ...packet,
    job_id: remediationJobId,
    goal: `${prReview.blockerType === 'deploy' ? 'Remediate deploy blocker' : 'Remediate PR blockers'} for ${packet.ticket_id || jobId}`,
    source: prReview.blockerType === 'deploy' ? 'vercel' : 'pr-review',
    kind: prReview.blockerType === 'deploy' ? 'deploy' : 'bug',
    label: prReview.blockerType === 'deploy' ? 'deploy' : 'review-fix',
    review_feedback: feedback,
    reviewComments: reviewComments.length > 0 ? reviewComments : undefined,
    working_branch: prReview.headRefName || packet.working_branch || null,
    base_branch: prReview.baseRefName || packet.base_branch || 'main',
    acceptance_criteria: [
      ...(packet.acceptance_criteria || []),
      'Address every blocking PR review finding individually, not just the first one.',
      'Push updates to the existing PR branch.',
      'Do not create a new PR.',
    ],
    verification_steps: [
      ...(packet.verification_steps || []),
      'Re-run failing checks or the closest local equivalent.',
      'Explicitly verify each review comment is addressed in code or call out why it is not applicable.',
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

function parseSummary(logText: string): Record<string, string> & { addressedComments?: AddressedComment[] } {
  const fields: Record<string, string> & { addressedComments?: AddressedComment[] } = {};
  for (const key of ['State', 'Commit', 'Prod', 'Verified', 'Blocker', 'Risk', 'Summary']) {
    const re = new RegExp(`^${key}:\\s*(.+)$`, 'gmi');
    const matches = [...logText.matchAll(re)];
    if (matches.length) fields[key.toLowerCase()] = matches[matches.length - 1][1].trim();
  }
  // Extract PR URL — try multiple patterns workers use:
  // 1. "PR created: <url>"
  // 2. "PR: <url>"  
  // 3. Any github.com pull request URL in the log
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

  // Extract AddressedComments JSON block from worker output
  const addressedPattern = /^AddressedComments:\s*(\[[\s\S]*?\])$/gm;
  const addressedMatches = [...logText.matchAll(addressedPattern)];
  if (addressedMatches.length > 0) {
    const lastMatch = addressedMatches[addressedMatches.length - 1][1];
    try {
      const parsed = JSON.parse(lastMatch);
      if (Array.isArray(parsed)) {
        fields.addressedComments = parsed.filter((c: Record<string, unknown>) =>
          typeof c.commentId === 'number' &&
          typeof c.status === 'string' &&
          typeof c.explanation === 'string'
        ).map((c: Record<string, unknown>): AddressedComment => ({
          commentId: c.commentId as number,
          status: c.status as 'fixed' | 'not_fixed' | 'partial',
          explanation: c.explanation as string,
          commitSha: (c.commitSha as string) || null,
        }));
      }
    } catch (e) {
      console.error(`[parseSummary] failed to parse AddressedComments JSON: ${(e as Error).message}`);
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

/**
 * Detect if the worker outcome is a legitimate no-op (nothing to change).
 * Signals: exit 0, no commit, no dirty files, and summary indicates nothing-to-do.
 */
function isNoOpOutcome(summary: Record<string, string>, proof: RepoProof): boolean {
  if (proof.commitExists || proof.dirty) return false;
  if (summary.commit && summary.commit !== 'none') return false;
  const noOpPatterns = /\b(no.?op|no changes? needed|already (?:fixed|addressed|met|resolved|done|implemented|merged|satisfied|complete)|nothing to (?:do|change|fix)|acceptance criteria (?:already|are already) met|all acceptance criteria already met)\b/i;
  const addressedComments = (summary as Record<string, unknown>).addressedComments as Array<{ status?: string }> | undefined;
  const allCommentsAlreadyFixed = Array.isArray(addressedComments) && addressedComments.length > 0
    && addressedComments.every((c) => c.status === 'fixed');
  const text = [summary.summary, summary.blocker, summary.verified].filter(Boolean).join(' ');
  return noOpPatterns.test(text) || allCommentsAlreadyFixed;
}

function inferPrUrlFromPacket(packet: JobPacket): string | null {
  const metadata = packet.metadata as Record<string, unknown> | undefined;
  const metadataUrl = metadata?.pr_url || metadata?.prUrl;
  if (typeof metadataUrl === 'string' && /^https:\/\/github\.com\/.+\/pull\/\d+/i.test(metadataUrl)) {
    return metadataUrl;
  }

  for (const line of packet.review_feedback || []) {
    const match = line.match(/https:\/\/github\.com\/[^\s]+\/pull\/\d+/i);
    if (match) return match[0];
  }

  return null;
}

function inferBlockedReason(logText: string, result: { state: string; commit: string; prod: string; verified: string; pr_url: string | null }, proof: RepoProof): string | null {
  const permissionMatch = logText.match(/I need file write permission to proceed\.[\s\S]*?(?=WORKER_EXIT_CODE:|$)/i);
  if (permissionMatch) {
    return permissionMatch[0].trim();
  }
  const hasReviewDelivery = !!result.pr_url;
  const workerContext = extractWorkerFailureContext(logText);
  const proofDetail = `(commit=${proof.commitExists ? 'yes' : 'no'}, dirty=${proof.dirty ? 'yes' : 'no'}, pushed=${proof.pushed ?? 'unknown'})`;

  // Note: dirty-repo (proof.dirty && !proof.commitExists) is handled as its own
  // classification in finalizeJob before this function is called.

  if ((result.state === 'coded' || result.state === 'done' || result.state === 'verified') && !proof.commitExists && !proof.dirty) {
    return `no commit or file changes found ${proofDetail}. Worker said: ${workerContext}`;
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

/**
 * Run the per-repo post-worker validation pipeline (typecheck/test/build/etc.).
 *
 * Phase 2a: **informational only** — the report is attached to result.json and
 * surfaced in logs/Discord, but the final job state is NOT changed by validation
 * outcome. Phase 2b will promote a failing required step into a blocking state
 * and auto-spawn a `__valfix` remediation job.
 *
 * Returns null if validation wasn't even attempted (e.g. no repo mapping,
 * globally disabled, or terminal state with no produced commit).
 */
function runPostWorkerValidation(
  jobId: string,
  packet: JobPacket,
  result: JobResult,
  finalState: string,
  workdir: string,
): ValidationReport | null {
  if (String(process.env.CCP_VALIDATION_ENABLED || 'true').toLowerCase() === 'false') {
    return null;
  }
  // Only validate productive terminal states. Notably we must exclude 'blocked'
  // and 'failed' because cleanRepoIfDirty may have discarded the worker's
  // uncommitted work and checked the repo back out to main before this point —
  // running install/typecheck/test against main would produce a bogus report
  // attributed to the job.
  if (!['coded', 'done', 'verified'].includes(finalState)) return null;
  if (!packet.repo) return null;

  const mapping = findRepoByPath(packet.repo);
  if (!mapping || !mapping.validation) return null;

  const logFile = path.join(jobDir(jobId), 'validation.log');
  try {
    fs.writeFileSync(logFile, `[${nowIso()}] validator start — job=${jobId} repo=${workdir}\n`);
  } catch {
    // non-fatal
  }

  appendLog(
    jobId,
    `[${nowIso()}] validation: starting ${mapping.validation.steps?.length || 0} step(s) on ${result.branch || 'unknown'}`,
  );

  try {
    return runValidation({
      repoPath: workdir,
      config: mapping.validation,
      logFile,
      commit: result.commit && result.commit !== 'none' ? result.commit : null,
      branch: result.branch || null,
      onStepStart: (step, i, total) => {
        appendLog(jobId, `[${nowIso()}] validation step ${i + 1}/${total}: ${step.name}`);
      },
      onStepEnd: (stepResult, i, total) => {
        const tag = stepResult.ok ? 'pass' : (stepResult.timedOut ? 'timeout' : 'fail');
        appendLog(
          jobId,
          `[${nowIso()}] validation step ${i + 1}/${total} ${stepResult.name}: ${tag} ` +
            `(exit=${stepResult.exitCode ?? 'null'}, ${stepResult.durationMs}ms)`,
        );
      },
    });
  } catch (err) {
    // runValidation swallows errors itself; this is belt-and-suspenders.
    const msg = err instanceof Error ? err.message : String(err);
    appendLog(jobId, `[${nowIso()}] validation: unexpected error: ${msg}`);
    return {
      ok: false,
      skipped: true,
      reason: `validator error: ${msg}`,
      steps: [],
      startedAt: nowIso(),
      finishedAt: nowIso(),
      durationMs: 0,
    };
  }
}

async function finalizeJob(jobId: string): Promise<{ ok: boolean; state: string; exitCode: number; result: JobResult; linear: LinearSyncResult }> {
  const status = loadStatus(jobId);
  const packet = readJson(packetPath(jobId)) as unknown as JobPacket;
  const logText = fs.readFileSync(path.join(jobDir(jobId), 'worker.log'), 'utf8');
  const summary = parseSummary(logText);
  const exitCodeMatch = logText.match(/WORKER_EXIT_CODE:\s*(\d+)/);
  const exitCode = exitCodeMatch ? Number(exitCodeMatch[1]) : (status.exit_code ?? 0);
  const provisionalState = exitCode === 0 ? (summary.state || 'coded') : (summary.state || 'failed');
  // Phase 3: operate on the per-job worktree if one was allocated, else
  // fall back to packet.repo (pre-Phase-3 behavior). Every repo-path
  // consumer below — inspectRepoProof, cleanRepoIfDirty, resolveOwnerRepo,
  // validator — reads from this single source of truth so the cd target
  // is consistent across the whole finalize path.
  const workdir = status.workdir || packet.repo;
  const proof = inspectRepoProof(workdir, summary.commit || 'none');
  const hasSummaryOutput = !!(summary.state || summary.summary || summary.commit);

  // Classification priority:
  // 1. Harness failure: exit 0 but worker produced no parseable summary at all
  // 2. No-op: worker produced summary but determined nothing needs to change
  // 3. Dirty-repo: uncommitted changes but no commit created
  // 4. Regular blocked inference
  let finalState: string;
  let inferredBlocker: string | null;

  if (exitCode === 0 && !hasSummaryOutput) {
    finalState = 'harness-failure';
    inferredBlocker = 'worker exited 0 but produced no final summary — harness or contract failure (check worker.log for raw output)';
  } else if (exitCode === 0 && isNoOpOutcome(summary, proof)) {
    finalState = 'no-op';
    inferredBlocker = null;
  } else if (proof.dirty && !proof.commitExists && ['coded', 'done', 'verified'].includes(provisionalState)) {
    finalState = 'dirty-repo';
    const workerContext = extractWorkerFailureContext(logText);
    inferredBlocker = `uncommitted local changes but no commit created — worker may have been interrupted or failed to commit. Branch: ${proof.branch || 'unknown'}. Action: inspect repo changes, commit manually, or discard with git checkout. Worker said: ${workerContext}`;
  } else {
    inferredBlocker = inferBlockedReason(logText, {
      state: provisionalState,
      commit: summary.commit || 'none',
      prod: summary.prod || 'no',
      verified: summary.verified || 'not yet',
      pr_url: summary.pr_url || null,
    }, proof);
    finalState = inferredBlocker ? 'blocked' : provisionalState;
  }

  // If the job is blocked/dirty-repo due to dirty repo state, clean it up immediately so
  // subsequent jobs don't inherit dirty working tree (e.g. from API 500 mid-run)
  if ((finalState === 'blocked' || finalState === 'dirty-repo') && proof.dirty && workdir) {
    const cleanResult = cleanRepoIfDirty(workdir, proof);
    appendLog(jobId, `[${nowIso()}] repo cleanup: ${cleanResult}`);
  }

  // Fallback: if no PR URL found in logs but branch was pushed, check GitHub for an open PR
  let prUrl: string | null = summary.pr_url || inferPrUrlFromPacket(packet) || null;
  if (!prUrl && proof.pushed && proof.branch && proof.branch !== 'main' && proof.branch !== 'master' && workdir) {
    const gh = commandExists('gh');
    if (gh) {
      const ownerRepo = resolveOwnerRepo(workdir);
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
    addressedComments: summary.addressedComments || undefined,
    tmux_session: status.tmux_session,
    worker_exit_code: exitCode,
    proof,
    updated_at: nowIso(),
  };

  // Post-worker static validation.
  //   Phase 2a: attach the report to result.json for visibility (always on).
  //   Phase 2b: if the repo opts in via `validation.gate=true` (or global
  //             CCP_VALIDATION_GATE=true), a failing required step promotes the
  //             job to `blocked` with blocker_type='validation-failed' and a
  //             `__valfix` remediation job is spawned below.
  // See docs/validation.md. Gate with CCP_VALIDATION_ENABLED=false to disable globally.
  const validationReport = runPostWorkerValidation(jobId, packet, result, finalState, workdir || '');
  let validationGated = false;
  if (validationReport) {
    result.validation = validationReport;
    appendLog(jobId, `[${nowIso()}] validation: ${summarizeReport(validationReport)}`);

    const mapping = packet.repo ? findRepoByPath(packet.repo) : null;
    const mappingValidation = (mapping && typeof mapping === 'object' ? (mapping as { validation?: unknown }).validation : null) as
      | import('../types').ValidationConfig
      | null
      | undefined;
    if (shouldGateOnValidation(mappingValidation, validationReport)) {
      const blocker = buildValidationBlocker(validationReport);
      finalState = 'blocked';
      result.state = 'blocked';
      result.blocker = blocker.message;
      result.blocker_type = 'validation-failed';
      result.failed_checks = blocker.failedChecks;
      result.prod = 'no';
      result.verified = 'not yet';
      validationGated = true;
      appendLog(jobId, `[${nowIso()}] validation gate: promoted to blocked (${blocker.failedStepNames.join(', ') || 'unknown'})`);
    }
  }
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
    // Preserve the validation blocker if we set one \u2014 a green PR-review disposition
    // must not silently erase a local validation failure.
    if (!validationGated) {
      result.blocker_type = prReview.blockerType || null;
      result.failed_checks = prReview.failedChecks || [];
    } else if (prReview.blockerType) {
      // PR review found its own blocker on top of the validation failure: keep
      // the validation blocker_type (it's the primary signal locally) but append
      // PR-side failing checks so operators see both.
      const existing = result.failed_checks || [];
      const extra = (prReview.failedChecks || []).filter(
        (c) => !existing.some((e) => e.name === c.name),
      );
      result.failed_checks = [...existing, ...extra];
    }
    writeJson(resultPath(jobId), result);
  }
  const remediation = maybeEnqueueReviewRemediation(jobId, packet, result, prReview);
  const validationRemediation = validationGated
    ? maybeEnqueueValidationRemediation(jobId, packet, result)
    : { ok: false, skipped: true, reason: 'validation not gated' } as RemediationResult;

  // Post per-comment replies and summary for remediation jobs that have addressedComments
  const isRemediationJob = /__deployfix|__reviewfix/.test(jobId);
  if (isRemediationJob && result.addressedComments?.length && prUrl) {
    try {
      const commentResult = postRemediationComments({
        prUrl,
        addressedComments: result.addressedComments,
        reviewComments: packet.reviewComments,
        commitSha: result.commit !== 'none' ? result.commit : null,
        resolveThreads: result.addressedComments.some((c: AddressedComment) => c.status === 'fixed'),
      });
      appendLog(jobId, `[${nowIso()}] pr comment replies: ${commentResult.replyResults.length} sent, ${commentResult.replyResults.filter((r: { ok: boolean }) => r.ok).length} ok, summary=${commentResult.summaryResult.ok ? 'ok' : 'failed'}${commentResult.fallbackUsed ? ' (fallback)' : ''}`);
    } catch (e) {
      appendLog(jobId, `[${nowIso()}] pr comment replies error: ${(e as Error).message}`);
    }
  }

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
      validationRemediation,
    },
  });

  if (!status.notifications?.final) {
    const ticket = packet.ticket_id || jobId;
    const repoName = packet.repo ? path.basename(packet.repo) : 'unknown';
    const commitShort = result.commit && result.commit !== 'none' ? result.commit.slice(0, 7) : null;

    let runsMsg: string;
    const isErrorState = exitCode !== 0 || ['blocked', 'failed', 'dirty-repo', 'harness-failure'].includes(result.state);
    // Build a short validation tag (e.g. "validation:ok (pass=3 fail=0 42s)") if validation ran.
    const validationTag = result.validation && !result.validation.skipped
      ? `validation:${summarizeReport(result.validation)}`
      : null;
    if (result.state === 'no-op') {
      runsMsg = `⏭️ NO-OP — ${ticket} | ${repoName}\n${result.summary || 'No changes needed — already resolved'}`;
    } else if (isErrorState) {
      const maxBlocker = 1800;
      const blocker = result.blocker ? (result.blocker.length > maxBlocker ? result.blocker.slice(0, maxBlocker - 3) + '...' : result.blocker) : 'unknown';
      const emojiMap: Record<string, string> = {
        'blocked': '🔴 BLOCKED',
        'dirty-repo': '🟠 DIRTY-REPO',
        'harness-failure': '🟣 HARNESS-FAILURE',
        'failed': '❌ FAIL',
      };
      const emoji = emojiMap[result.state] || '❌ FAIL';
      const exitInfo = exitCode !== 0 ? ` (exit ${exitCode})` : '';
      runsMsg = `${emoji} — ${ticket} | ${repoName}${exitInfo}\n${blocker}`;
      if (validationTag) runsMsg += `\n${validationTag}`;
      if (validationRemediation.ok && !validationRemediation.skipped && validationRemediation.job_id) {
        runsMsg += `\n🔁 valfix: ${validationRemediation.job_id}`;
      }
    } else {
      const parts: string[] = [`✅ DONE — ${ticket} | ${repoName}`];
      if (commitShort) parts.push(commitShort);
      if (result.risk) parts.push(`risk:${result.risk}`);
      if (result.pr_url) parts.push(`→ PR ${result.pr_url.split('/').pop()}`);
      if (result.verified && result.verified !== 'not yet') {
        const v = result.verified.length > 200 ? result.verified.slice(0, 197) + '...' : result.verified;
        parts.push(v);
      }
      if (validationTag) parts.push(validationTag);
      runsMsg = parts.join(' | ');
    }

    // Route: successes + no-ops → status channel, all failures/blocked → errors channel
    const isFailure = exitCode !== 0 || ['blocked', 'failed', 'dirty-repo', 'harness-failure'].includes(result.state);
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
      && !['blocked', 'failed', 'dirty-repo', 'harness-failure'].includes(result.state)
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
        sendToThread(thread.threadId, threadParts.join('\n'));
        appendLog(jobId, `[${nowIso()}] thread created: ${thread.threadId}`);
      }
    }

    saveStatus(jobId, { notifications: { final: sentMain.ok, start: true }, discord_thread_id: threadId });

    // Post completion comment to Linear ticket
    const didWork = result.commit !== 'none' || ['blocked', 'coded', 'done', 'verified', 'dirty-repo', 'harness-failure'].includes(result.state);
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
    'no-op': 'completed', 'dirty-repo': 'failed', 'harness-failure': 'failed',
  };
  const webhookStatus = statusMap[finalState] || 'in_progress';
  const whLog = fireWebhookCallback({
    packet, jobId, status: webhookStatus,
    prUrl: result.pr_url || null, error: result.blocker || null,
  });
  if (whLog) appendLog(jobId, `[${nowIso()}] ${whLog}`);

  // Outage circuit breaker: detect API failures and trigger outage mode.
  // Per-agent (PR B): log + state file are keyed by whichever driver actually
  // ran the job (pf.agent). Falls back to the packet's configured agent so
  // circuit flips happen even when preflight didn't stash agent on status.
  // status.agent is stamped at dispatch time (startJob → saveStatus), so it
  // reflects the driver that actually ran — including post-fallback swaps.
  // packet.agent is the static configuration fallback; 'claude-code' is the
  // ultimate default.
  const activeAgent = status.agent || packet.agent || 'claude-code';
  const activeDriverLabel = (getAgent(activeAgent) || claudeCodeDriver).label;
  const wasApiFailure = (exitCode !== 0 || ['blocked', 'harness-failure'].includes(finalState)) && isApiOutageLog(logText, activeAgent);
  const { enteredOutage } = recordJobOutcome(wasApiFailure, activeAgent);
  if (enteredOutage) {
    const outagePct = packet.ticket_id || jobId;
    const alertMsg = `⚠️ OUTAGE DETECTED — ${activeDriverLabel} API is returning errors. Pausing dispatch for this agent until it recovers. Last job: ${outagePct}`;
    sendDiscordMessage(DISCORD_ERRORS_CHANNEL, alertMsg);
    appendLog(jobId, `[${nowIso()}] outage mode activated for agent '${activeAgent}'`);
  }

  // Rate limit detection: if worker hit usage limits, pause until reset time.
  // Rate-limit state stays on the active agent's circuit; only Anthropic's
  // wall-clock reset phrasing is currently parseable, so Codex jobs will
  // generally take the generic API-error path above instead.
  const { detectRateLimit: detectRL, recordRateLimit } = require('./outage');
  const rateLimit = detectRL(logText);
  if (rateLimit) {
    recordRateLimit(rateLimit.resetAt, rateLimit.reason, activeAgent);
    const resetDate = new Date(rateLimit.resetAt);
    const resetStr = resetDate.toLocaleTimeString('en-US', { timeZone: 'America/New_York', hour: 'numeric', minute: '2-digit' });
    const alertMsg = `⏸️ RATE LIMITED — ${activeDriverLabel} usage limit hit. Pausing dispatch for this agent until ${resetStr} ET. Last job: ${packet.ticket_id || jobId}`;
    sendDiscordMessage(DISCORD_ERRORS_CHANNEL, alertMsg);
    appendLog(jobId, `[${nowIso()}] rate limit detected for '${activeAgent}' — pausing until ${rateLimit.resetAt}`);
  }

  // Phase 3: tear down the per-job worktree now that proof inspection,
  // cleanup, validation, PR review, remediation, and notifications have
  // all completed. We intentionally do this AFTER everything else —
  // every upstream step needs access to the worker's working tree, so
  // releasing earlier would invalidate subsequent git reads. Failure
  // to release is logged but does not change the job's outcome.
  if (status.workdir) {
    const releaseResult = releaseWorktree(status.workdir, packet.repo);
    appendLog(
      jobId,
      `[${nowIso()}] worktree release: ${releaseResult.ok ? 'ok' : 'failed'} — ${releaseResult.detail}`,
    );
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

  // Phase 3: if this repo opts into worktrees, allocate one now and
  // use its path as the cd target. Falls back to packet.repo on
  // allocation failure so a transient git issue doesn't brick the
  // job — downstream per-repo serial gate still prevents concurrent
  // workers from colliding on localPath. Stash the resolved workdir
  // on JobStatus so finalizeJob / reconcileJob survive supervisor
  // restarts mid-job.
  const mapping = packet.repo ? findRepoByPath(packet.repo) : null;
  let workdir: string | null = null;
  if (mapping && isWorktreeEnabled(mapping)) {
    try {
      const acquired = acquireWorktree(mapping, jobId);
      workdir = acquired.path;
      appendLog(
        jobId,
        `[${nowIso()}] worktree ${acquired.reused ? 'reused' : 'acquired'}: ${acquired.path}`,
      );
    } catch (err) {
      appendLog(
        jobId,
        `[${nowIso()}] worktree acquire failed — falling back to localPath: ${(err as Error).message}`,
      );
    }
  }
  if (workdir) {
    saveStatus(jobId, { workdir });
  }
  const repoPathForWorker = workdir || packet.repo!;
  // Load per-repo memory (Phase 5a). loadRepoMemory returns null when
  // no memory file is configured or present, in which case buildPrompt
  // skips the memory section entirely. Surface the resolved path +
  // truncation state in the worker log so operators can tell at a
  // glance whether a job ran with memory.
  const memory = loadRepoMemory(packet);
  if (memory) {
    appendLog(
      jobId,
      `[${nowIso()}] repo memory loaded: ${memory.path} (${Buffer.byteLength(memory.content, 'utf8')} bytes${memory.truncated ? ', truncated' : ''})`,
    );
  }
  fs.writeFileSync(promptFile, buildPrompt(packet, memory?.content));

  // Build the agent invocation through the resolved driver. Claude Code's
  // shape is preserved verbatim here (cat prompt | claude --print ...) so
  // this refactor is behavior-neutral; non-claude drivers pick their own
  // command shape without touching jobs.ts.
  //
  // preflight() already resolved the agent (pf.agent) and wrote the name +
  // binary into the PreflightResult. Look the driver up by name instead of
  // re-resolving, so unknown-agent warnings aren't emitted twice per job and
  // we don't redundantly scan the repos config again.
  const agent: AgentDriver = (pf.agent && getAgent(pf.agent)) || claudeCodeDriver;
  const agentCommand = agent.buildCommand({
    promptPath: promptFile,
    repoPath: repoPathForWorker,
    packet,
    bin: pf.claude,
  });
  const workerCmd = agentCommand.shellCmd;
  appendLog(jobId, `[${nowIso()}] agent: ${agent.name}`);
  const extraEnv = Object.entries(agentCommand.env || {}).map(
    ([k, v]) => `export ${k}=${shellQuote(v)}`,
  );
  const gitUser = gitIdentity();
  const shellScript = [
    'set -euo pipefail',
    `export GIT_AUTHOR_NAME=${shellQuote(gitUser.name)}`,
    `export GIT_AUTHOR_EMAIL=${shellQuote(gitUser.email)}`,
    `export GIT_COMMITTER_NAME=${shellQuote(gitUser.name)}`,
    `export GIT_COMMITTER_EMAIL=${shellQuote(gitUser.email)}`,
    ...extraEnv,
    `cd ${shellQuote(repoPathForWorker)}`,
    // Ensure repo is on main with latest code before worker starts
    // (prevents stale branch issues and accidental branching from feature branches)
    packet.working_branch ? null : 'git checkout main 2>/dev/null || true',
    packet.working_branch ? null : 'git fetch origin main --quiet',
    packet.working_branch ? null : 'git reset --hard origin/main',
    packet.working_branch ? `git checkout ${shellQuote(packet.working_branch)}` : null,
    packet.working_branch ? `git pull --ff-only origin ${shellQuote(packet.working_branch)} || true` : null,
    `echo "[${nowIso()}] worker start" >> ${shellQuote(logFile)}`,
    `{ ${workerCmd}; } 2>&1 | tee -a ${shellQuote(logFile)}`,
    'exit_code=${PIPESTATUS[0]}',
    `echo "WORKER_EXIT_CODE: ${'$'}exit_code" >> ${shellQuote(logFile)}`,
    'exit $exit_code',
  ].filter(Boolean).join('\n');

  // Write shell script to file to avoid ARG_MAX limits when passing to tmux
  const scriptFile = path.join(jobDir(jobId), 'worker.sh');
  fs.writeFileSync(scriptFile, shellScript, { mode: 0o755 });

  // Phase 3: any post-acquire failure (tmux new-session, fs write, agent
  // build throw) must release the worktree we just allocated — otherwise
  // the job goes to `blocked` via startJob's catch and the worktree
  // directory leaks forever, since finalizeJob only runs for
  // state === 'running' jobs. Best-effort release: log and swallow any
  // secondary failure so the original error still surfaces.
  try {
    const out = run(pf.tmux, ['new-session', '-d', '-s', session, 'bash', '-l', scriptFile]);
    if (out.status !== 0) {
      throw new Error((out.stderr || out.stdout || 'tmux new-session failed').trim());
    }
  } catch (err) {
    if (workdir) {
      try {
        const release = releaseWorktree(workdir, packet.repo);
        appendLog(
          jobId,
          `[${nowIso()}] worktree release (startTmuxWorker failed): ${release.ok ? 'ok' : 'failed'} — ${release.detail}`,
        );
      } catch (releaseErr) {
        appendLog(
          jobId,
          `[${nowIso()}] worktree release (startTmuxWorker failed) errored: ${(releaseErr as Error).message}`,
        );
      }
    }
    throw err;
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
  // Phase 3: interrupt is a terminal path — operator-initiated jobs jump
  // straight to `blocked` and never hit finalizeJob (reconcileJob only
  // finalizes `state === 'running'`). If a worktree was allocated for
  // this job we have to release it here or it leaks on disk forever.
  // Best-effort: any release failure is logged but must not prevent the
  // interrupt from succeeding.
  if (status.workdir) {
    try {
      const packet = readJson(packetPath(jobId)) as unknown as JobPacket;
      const releaseResult = releaseWorktree(status.workdir, packet.repo);
      appendLog(
        jobId,
        `[${nowIso()}] worktree release (interrupt): ${releaseResult.ok ? 'ok' : 'failed'} — ${releaseResult.detail}`,
      );
    } catch (err) {
      appendLog(
        jobId,
        `[${nowIso()}] worktree release (interrupt) errored: ${(err as Error).message}`,
      );
    }
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
  if (pf.deferred) {
    // Restore queued so the next cycle picks it up again once the
    // circuit closes. No blocker, no tmux session, no alert.
    const reason = pf.deferReason || 'agent circuit open — deferring';
    appendLog(jobId, `[${nowIso()}] preflight deferred: ${reason}`);
    saveStatus(jobId, {
      state: 'queued',
      last_output_excerpt: safeExcerpt(reason),
    });
    return { ok: false, deferred: true, reason, packet, environment: pf.environment };
  }
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
      // Stamp the resolved driver name so finalizeJob's per-agent circuit
      // breaker attributes outcomes to whichever agent actually ran —
      // including post-fallback swaps where pf.agent differs from the
      // packet's configured agent. See comment block in finalizeJob.
      agent: pf.agent,
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
  const activeRunning = refreshed.filter((job) => job.state === 'running');
  const capacity = Math.max(0, maxConcurrent - activeRunning.length);
  const queued = refreshed
    .filter((job) => job.state === 'queued')
    .sort((a, b) => (a.updated_at > b.updated_at ? 1 : -1));

  // Phase 3: count-based per-repo gate. Each repo has its own parallel
  // capacity derived from `mapping.parallelJobs` (default 1 — matches
  // pre-Phase-3 serial behavior). We count concurrent jobs keyed by
  // packet.repo (the canonical localPath), which is stable across
  // worktree-enabled and non-worktree repos.
  const busyRepoCounts = new Map<string, number>();
  for (const job of activeRunning) {
    try {
      const packet = readJson(packetPath(job.job_id)) as unknown as JobPacket;
      if (packet.repo) busyRepoCounts.set(packet.repo, (busyRepoCounts.get(packet.repo) || 0) + 1);
    } catch (err) {
      console.error(`[ccp] failed to read packet for running job ${job.job_id}: ${(err as Error).message}`);
    }
  }

  // Check peak-hour scheduling + outage state before dispatching new jobs
  const { canDispatchJobs } = require('./scheduling');
  const {
    runOutageProbe: probeOutage,
    getOutageStatus,
    getAllOutageStatuses,
  } = require('./outage') as typeof import('./outage');
  const scheduleCheck = canDispatchJobs();
  (summary as unknown as Record<string, unknown>).scheduling = scheduleCheck;

  // Per-agent probe (PR B): probe every driver currently flagged as out,
  // not just claude-code. Each driver's probe hits its own health endpoint
  // so Anthropic and OpenAI recoveries are detected independently. We
  // emit a Discord note for each recovery so operators know which
  // provider came back. Runs every cycle whether or not the global
  // dispatch gate is open — a healthy driver's dispatch shouldn't delay
  // another driver's recovery detection.
  try {
    const statuses = getAllOutageStatuses();
    for (const [agentName, st] of Object.entries(statuses)) {
      if (!st.outage) continue;
      // Capture outageSince from the pre-probe snapshot: runOutageProbe
      // clears state.outageSince on recovery before returning, so
      // probe.state.outageSince is always null on the recovery branch
      // (pre-existing bug in the old single-agent path that would have
      // silently dropped the duration — caught on PR #39 review).
      const previousOutageSince = st.outageSince || null;
      const probe = probeOutage(agentName);
      if (probe.nowRecovered) {
        const outageDuration = previousOutageSince
          ? Math.round((Date.now() - new Date(previousOutageSince).getTime()) / 60000)
          : null;
        const msg = `✅ ${agentName} API recovered — resuming job dispatch${outageDuration ? ` (outage lasted ~${outageDuration} min)` : ''}.`;
        sendDiscordMessage(DISCORD_ERRORS_CHANNEL, msg);
      }
    }
  } catch (err) {
    console.error(`[ccp] per-agent outage probe failed: ${(err as Error).message}`);
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
      if (packet.repo) {
        const repoMapping = findRepoByPath(packet.repo);
        const repoLimit = getParallelJobLimit(repoMapping);
        const running = busyRepoCounts.get(packet.repo) || 0;
        if (running >= repoLimit) {
          summary.skipped.push({
            job_id: job.job_id,
            reason: `repo busy: ${path.basename(packet.repo)}${repoLimit > 1 ? ` (${running}/${repoLimit})` : ''}`,
          });
          continue;
        }
      }
      try {
        const result = startJob(job.job_id);
        if ((result as { deferred?: boolean }).deferred) {
          // Per-job outage deferral — keep the job in queued and surface
          // in the skipped list so ops can see the reason without the
          // job being marked blocked.
          summary.skipped.push({
            job_id: job.job_id,
            reason: (result as { reason?: string }).reason || 'agent circuit open',
          });
          continue;
        }
        summary.started.push({ job_id: job.job_id, ...result });
        if (packet.repo) busyRepoCounts.set(packet.repo, (busyRepoCounts.get(packet.repo) || 0) + 1);
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
  buildPrompt,
  isNoOpOutcome,
  inferBlockedReason,
  extractWorkerFailureContext,
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
  buildPrompt,
  isNoOpOutcome,
  inferBlockedReason,
  extractWorkerFailureContext,
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
