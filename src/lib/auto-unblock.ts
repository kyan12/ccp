/**
 * Phase 6a: auto-unblock watchdog.
 *
 * Jobs that land in `blocked` today only recover via:
 *   - human operator intervention (Discord `/ccp retry`, dashboard)
 *   - a one-shot remediation spawn (`__valfix` / `__deployfix` /
 *     `__reviewfix`) that runs immediately at finalize time and then
 *     gives up if it too ends in `blocked`.
 *
 * That leaves a class of flaky-but-fixable failures stuck forever.
 * Example: a smoke test fails because the preview deployment hadn't
 * finished building yet, `__deployfix` fires a new attempt that also
 * fails for the same transient reason, and now the job needs an
 * operator to notice + manually retry.
 *
 * This watchdog adds a bounded, configurable second-chance loop:
 *   - scan `blocked` jobs every supervisor cycle,
 *   - for each one with an eligible `blocker_type` whose
 *     `retryAfterSec` cool-down has elapsed, spawn a `__autoretry<N>`
 *     child on the same branch with a refined prompt,
 *   - stop after `maxRetries` attempts and emit a single "exhausted"
 *     notification so operators know to step in.
 *
 * Design constraints:
 *   - Opt-in per repo (`autoUnblock.enabled: true`) + kill-switch env
 *     (`CCP_AUTO_UNBLOCK_ENABLED=false` globally disables). Default OFF.
 *   - Idempotent: if a retry with the target `__autoretryN` id already
 *     exists (e.g. from a previous cycle) we skip spawning a duplicate.
 *   - Depth-guarded: remediation jobs (`__valfix` / `__deployfix` /
 *     `__reviewfix` / `__autoretry`) never spawn their own retry.
 *     Failing remediations are the signal to give up, not to cascade.
 *   - Every branch is logged to `worker.log` of the parent job so an
 *     operator scrolling the job's log sees exactly what the watchdog
 *     did and why.
 *   - No side effects on agent / validation / smoke state — the
 *     watchdog only creates a new queued job and updates the parent's
 *     `status.autoUnblock` bookkeeping.
 *
 * Testability: subprocess/job-spawn IO is injected via a
 * `JobsIo` interface so unit tests can run the scanner with
 * deterministic in-memory fakes instead of touching the jobs dir.
 */

import type {
  AutoUnblockAttempt,
  AutoUnblockConfig,
  AutoUnblockState,
  JobPacket,
  JobResult,
  JobStatus,
  RepoMapping,
} from '../types';

/** Defaults approved by the operator for Phase 6a. */
export const DEFAULT_AUTO_UNBLOCK_RETRY_AFTER_SEC = 600; // 10 min
export const DEFAULT_AUTO_UNBLOCK_MAX_RETRIES = 2;
/**
 * Blocker types the watchdog will auto-retry by default.
 *
 * Phase 6a: `validation-failed`, `smoke-failed`, `pr-check-failed` \u2014
 *   structured failures with a reproducible signal.
 * Phase 6b: `ambiguity-transient` \u2014 environmental noise (rate limits,
 *   network hiccups, git lock contention, 5xx upstreams) classified by
 *   `src/lib/blocker-classifier.ts`. Crucially, `ambiguity-operator`
 *   (worker asked a human a question) is NOT in this list and never
 *   should be \u2014 operator-input blockers need a human answer, not a
 *   silent retry.
 */
export const DEFAULT_AUTO_UNBLOCK_ELIGIBLE_TYPES = [
  'validation-failed',
  'smoke-failed',
  'pr-check-failed',
  'ambiguity-transient',
];

/**
 * Any job id matching this pattern is itself a remediation or retry
 * child — the watchdog MUST NOT spawn further retries from it or the
 * dispatch tree would fan out without bound. A repeat failure on a
 * `__valfix` / `__deployfix` / `__reviewfix` / `__autoretry` job is
 * the signal that we've done all the cheap automation we can and need
 * an operator to look at it.
 */
export const AUTO_UNBLOCK_DEPTH_GUARD = /__valfix|__deployfix|__reviewfix|__autoretry/;

export interface ResolvedAutoUnblockConfig {
  enabled: boolean;
  retryAfterSec: number;
  maxRetries: number;
  eligibleTypes: string[];
  usePlannerRefresh: boolean;
}

/**
 * Normalize a raw per-repo config into concrete defaults. Unknown /
 * malformed fields fall back to the Phase 6a defaults so a misconfig
 * never breaks the watchdog — the worst case is we refuse to retry.
 */
export function resolveAutoUnblockConfig(
  raw: AutoUnblockConfig | undefined | null,
): ResolvedAutoUnblockConfig {
  const cfg = raw ?? {};
  const enabled = cfg.enabled === true;
  const retryAfterSec =
    typeof cfg.retryAfterSec === 'number' && cfg.retryAfterSec > 0
      ? Math.floor(cfg.retryAfterSec)
      : DEFAULT_AUTO_UNBLOCK_RETRY_AFTER_SEC;
  const maxRetries =
    typeof cfg.maxRetries === 'number' && cfg.maxRetries >= 0
      ? Math.floor(cfg.maxRetries)
      : DEFAULT_AUTO_UNBLOCK_MAX_RETRIES;
  const eligibleTypes =
    Array.isArray(cfg.eligibleTypes) && cfg.eligibleTypes.length > 0
      ? cfg.eligibleTypes.filter((t) => typeof t === 'string' && t.trim().length > 0)
      : DEFAULT_AUTO_UNBLOCK_ELIGIBLE_TYPES.slice();
  // Defensive: empty list after filtering falls back to defaults so we
  // never accidentally silently disable the watchdog for a repo whose
  // operator typo-ed every entry.
  const finalEligibleTypes = eligibleTypes.length > 0 ? eligibleTypes : DEFAULT_AUTO_UNBLOCK_ELIGIBLE_TYPES.slice();
  const usePlannerRefresh = cfg.usePlannerRefresh === true;
  return {
    enabled,
    retryAfterSec,
    maxRetries,
    eligibleTypes: finalEligibleTypes,
    usePlannerRefresh,
  };
}

/**
 * Global kill-switch. Mirrors the pattern used by validation/smoke:
 * `CCP_AUTO_UNBLOCK_ENABLED=false` disables across every repo. Any
 * other value (including unset) defers to the per-repo config. This
 * exists so operators can yank the watchdog in an incident without
 * editing every repos.json mapping.
 */
export function isAutoUnblockGloballyEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env.CCP_AUTO_UNBLOCK_ENABLED;
  if (raw === undefined || raw === null) return true;
  return String(raw).toLowerCase() !== 'false';
}

export interface AutoUnblockDecision {
  shouldRetry: boolean;
  /** Why the watchdog decided to retry or skip. */
  reason: string;
  /** When `shouldRetry: true`, the 1-indexed attempt number of the next child. */
  attemptNumber?: number;
  /**
   * True when the watchdog has hit `maxRetries` on this cycle and
   * should emit the "exhausted" notification. Only flips once per
   * parent job because the caller persists `exhausted: true` on the
   * status after firing the notification.
   */
  exhaustedNow?: boolean;
}

export interface ShouldAutoUnblockInput {
  status: JobStatus;
  result: JobResult | null;
  config: ResolvedAutoUnblockConfig;
  /** Supervisor-level kill-switch result (usually from isAutoUnblockGloballyEnabled). */
  globallyEnabled: boolean;
  /** Override for deterministic tests (defaults to Date.now()). */
  now?: Date;
}

/**
 * Decide whether to spawn a watchdog retry for a single blocked job.
 * All inputs are values the caller already has — this function does
 * no IO and is trivially unit-testable.
 */
export function shouldAutoUnblock(input: ShouldAutoUnblockInput): AutoUnblockDecision {
  const { status, result, config, globallyEnabled } = input;
  const now = input.now ?? new Date();

  if (!globallyEnabled) {
    return { shouldRetry: false, reason: 'auto-unblock globally disabled (CCP_AUTO_UNBLOCK_ENABLED=false)' };
  }
  if (!config.enabled) {
    return { shouldRetry: false, reason: 'auto-unblock disabled for repo (autoUnblock.enabled !== true)' };
  }
  if (status.state !== 'blocked') {
    return { shouldRetry: false, reason: `job state is "${status.state}", not blocked` };
  }
  if (AUTO_UNBLOCK_DEPTH_GUARD.test(status.job_id)) {
    return { shouldRetry: false, reason: 'depth guard: job id is itself a remediation/retry child' };
  }

  const blockerType = (result && result.blocker_type) || null;
  if (!blockerType) {
    return { shouldRetry: false, reason: 'no blocker_type on result (cannot classify)' };
  }
  if (!config.eligibleTypes.includes(blockerType)) {
    return {
      shouldRetry: false,
      reason: `blocker_type "${blockerType}" not in eligibleTypes [${config.eligibleTypes.join(', ')}]`,
    };
  }

  const prior: AutoUnblockState | undefined = status.autoUnblock;
  const attempts = prior?.attempts ?? 0;
  if (attempts >= config.maxRetries) {
    // Only signal `exhaustedNow` on the transition — callers rely on
    // the idempotent `exhausted: true` flag they set after firing the
    // Discord ping, so we don't spam on every subsequent cycle.
    const exhaustedNow = prior?.exhausted !== true;
    return {
      shouldRetry: false,
      reason: `max retries reached (${attempts}/${config.maxRetries})`,
      exhaustedNow,
    };
  }

  // Cool-down: the watchdog gives the immediate one-shot remediation a
  // window to land its own fix before piling on. `updated_at` is the
  // last write on the status — which for a blocked job is the moment
  // it transitioned to `blocked`. Using the last heartbeat would make
  // the cool-down reset on every reconcile, which is not what we want.
  const baselineIso = prior?.lastAttemptAt || status.updated_at;
  const baselineTime = Date.parse(baselineIso || '');
  if (!Number.isFinite(baselineTime)) {
    return { shouldRetry: false, reason: `cannot parse baseline timestamp "${baselineIso}"` };
  }
  const elapsedSec = Math.max(0, Math.floor((now.getTime() - baselineTime) / 1000));
  if (elapsedSec < config.retryAfterSec) {
    return {
      shouldRetry: false,
      reason: `cool-down: blocked for ${elapsedSec}s, need ${config.retryAfterSec}s`,
    };
  }

  return { shouldRetry: true, reason: `eligible (${blockerType}, attempt ${attempts + 1}/${config.maxRetries})`, attemptNumber: attempts + 1 };
}

/**
 * Build the refined worker prompt footer appended to the original
 * goal. We deliberately keep this tight: one block that tells the
 * agent it's a retry, summarizes what the previous attempt tried,
 * names the root cause we could extract, and asks it to avoid
 * repeating the same failure. Free-form additions should still come
 * from the original packet's `review_feedback` so we don't create
 * two conflicting sources of truth.
 */
export function buildRefinedFeedback(params: {
  priorBlockerType: string;
  priorBlockerDetail?: string | null;
  priorFailedChecks?: Array<{ name?: string; state?: string; url?: string | null } | null | undefined>;
  attemptNumber: number;
  maxRetries: number;
}): string[] {
  const lines: string[] = [];
  lines.push(
    `Automated retry attempt ${params.attemptNumber} of ${params.maxRetries}. The previous attempt landed in "blocked" with blocker_type=${params.priorBlockerType}.`,
  );
  if (params.priorBlockerDetail && params.priorBlockerDetail.trim()) {
    // Trim to keep the footer under control; anything >2KB tends to be
    // noisy trailing stderr that hurts more than it helps.
    const detail = params.priorBlockerDetail.trim();
    const clipped = detail.length > 2048 ? `${detail.slice(0, 2048)}\n…[blocker detail truncated]` : detail;
    lines.push('Previous blocker detail:');
    lines.push(clipped);
  }
  const failed = (params.priorFailedChecks || []).filter(Boolean) as Array<{ name?: string; state?: string; url?: string | null }>;
  if (failed.length > 0) {
    lines.push('Previous failing checks:');
    for (const c of failed) {
      const namePart = c.name || 'unknown';
      const statePart = c.state ? ` [${c.state}]` : '';
      const urlPart = c.url ? ` (${c.url})` : '';
      lines.push(`- ${namePart}${statePart}${urlPart}`);
    }
  }
  lines.push(
    'Treat this as a second chance, not a cold start: diagnose why the previous attempt failed against the symptom above, then push the fix to the same branch without creating a new PR.',
  );
  lines.push(
    'If the same symptom reproduces after your fix, leave a precise blocker note explaining the actual root cause instead of retrying blindly.',
  );
  return lines;
}

export interface BuildRetryPacketInput {
  parentPacket: JobPacket;
  parentStatus: JobStatus;
  parentResult: JobResult | null;
  attemptNumber: number;
  config: ResolvedAutoUnblockConfig;
  /** Override for deterministic tests (defaults to new Date().toISOString()). */
  now?: Date;
}

/**
 * Construct the child packet for an auto-retry. We inherit the parent
 * packet's repo / branch / goal / acceptance_criteria and append a
 * refined feedback block on top. We DO NOT inherit `reviewComments` —
 * this isn't a review-fix task and letting them leak in causes
 * `buildPrompt` to tell the agent to address review threads that don't
 * exist on a retry. The working branch is preserved so the retry
 * pushes to the same PR rather than opening a new one.
 */
export function buildRetryPacket(input: BuildRetryPacketInput): JobPacket {
  const { parentPacket, parentStatus, parentResult, attemptNumber } = input;
  const now = input.now ?? new Date();
  const childJobId = `${parentStatus.job_id}__autoretry${attemptNumber}`;
  const priorBlockerType = parentResult?.blocker_type || 'unknown';
  const priorBlockerDetail = parentResult?.blocker || null;
  const priorFailedChecks = (parentResult?.failed_checks || []).map((c) => ({
    name: c?.name,
    state: c?.state,
    url: c?.url ?? null,
  }));

  const refinedFeedback = buildRefinedFeedback({
    priorBlockerType,
    priorBlockerDetail,
    priorFailedChecks,
    attemptNumber,
    maxRetries: input.config.maxRetries,
  });

  const branch = parentResult?.branch && parentResult.branch !== 'unknown'
    ? parentResult.branch
    : parentPacket.working_branch || null;

  const retryPacket: JobPacket = {
    ...parentPacket,
    job_id: childJobId,
    goal: `Auto-retry (${attemptNumber}/${input.config.maxRetries}): ${parentPacket.goal}`,
    source: parentPacket.source || 'auto-unblock',
    label: parentPacket.label || 'auto-retry',
    review_feedback: [
      ...(parentPacket.review_feedback || []),
      ...refinedFeedback,
    ],
    // Drop PR-review comments: this path is not a reviewfix and
    // inheriting them causes buildPrompt to ask for an
    // AddressedComments block against threads the child can't see.
    reviewComments: undefined,
    working_branch: branch,
    base_branch: parentPacket.base_branch || 'main',
    acceptance_criteria: [
      ...(parentPacket.acceptance_criteria || []),
      `Resolve the prior "${priorBlockerType}" blocker; do not create a new PR.`,
    ],
    verification_steps: [
      ...(parentPacket.verification_steps || []),
      'Re-run the check that originally failed before declaring done.',
    ],
    metadata: {
      ...(parentPacket.metadata || {}),
      autoUnblock: {
        parentJobId: parentStatus.job_id,
        attemptNumber,
        priorBlockerType,
        triggeredAt: now.toISOString(),
        // Planner-refresh is advisory metadata — actually running the
        // planner lives in jobs.ts, which reads this key before
        // dispatch. Keeping the flag on the child packet means we can
        // test the decision in isolation from jobs.ts.
        usePlannerRefresh: input.config.usePlannerRefresh,
      },
    },
    created_at: now.toISOString(),
  };
  return retryPacket;
}

/**
 * Update the parent status's `autoUnblock` bookkeeping after a retry
 * has been spawned (or would have been, but was idempotent-skipped).
 * Pure — returns the new state rather than mutating status in place,
 * so callers can diff / persist atomically.
 */
export function applyRetryToState(params: {
  prior: AutoUnblockState | undefined;
  childJobId: string;
  priorBlockerType: string;
  priorBlockerDetail?: string | null;
  attemptNumber: number;
  at: Date;
}): AutoUnblockState {
  const attempt: AutoUnblockAttempt = {
    at: params.at.toISOString(),
    childJobId: params.childJobId,
    priorBlockerType: params.priorBlockerType,
    priorBlockerDetail: params.priorBlockerDetail || undefined,
    attemptNumber: params.attemptNumber,
  };
  const history = [...(params.prior?.history || []), attempt];
  return {
    attempts: Math.max(params.attemptNumber, params.prior?.attempts ?? 0),
    lastAttemptAt: attempt.at,
    history,
    exhausted: params.prior?.exhausted === true ? true : undefined,
  };
}

/**
 * Filesystem/jobs IO surface consumed by tickAutoUnblock. Kept as an
 * injected interface rather than a jobs.ts import so unit tests can
 * run the tick with a deterministic in-memory fake without spinning
 * up JOBS_DIR or a real clock.
 */
export interface JobsIo {
  /** Return every blocked JobStatus visible to the supervisor. */
  listBlockedJobs(): JobStatus[];
  /** Load the packet for a given job id (throw if missing). */
  loadPacket(jobId: string): JobPacket;
  /** Load the most recent result.json for a given job id (null if missing/malformed). */
  loadResult(jobId: string): JobResult | null;
  /** Create a new queued job from a packet; same semantics as jobs.createJob. */
  createJob(packet: JobPacket): { jobId: string };
  /** True when a job with the given id already exists on disk. */
  jobExists(jobId: string): boolean;
  /** Persist the updated AutoUnblockState back onto the parent status. */
  saveAutoUnblockState(jobId: string, state: AutoUnblockState): void;
  /** Append a line to the parent job's worker.log. */
  appendLog(jobId: string, line: string): void;
  /** Resolve the per-repo autoUnblock config for a given job's packet. */
  resolveRepoConfig(packet: JobPacket): AutoUnblockConfig | undefined | null;
  /** Fire a best-effort "exhausted" Discord ping (swallow errors). */
  notifyExhausted(params: {
    parentJobId: string;
    ticketId: string | null;
    blockerType: string;
    attempts: number;
  }): void;
}

export interface TickAutoUnblockOptions {
  io: JobsIo;
  env?: NodeJS.ProcessEnv;
  now?: Date;
}

export interface TickAutoUnblockSummary {
  scanned: number;
  retried: Array<{ parent: string; child: string; attempt: number; blockerType: string }>;
  skipped: Array<{ job_id: string; reason: string }>;
  errors: Array<{ job_id?: string; error: string }>;
}

/**
 * Run one watchdog pass. Iterates every blocked job, evaluates
 * eligibility, spawns retries, and updates parent bookkeeping. Pure
 * with respect to wall-clock (caller can inject `now`) and pure with
 * respect to filesystem (caller injects `JobsIo`).
 */
export function tickAutoUnblock(options: TickAutoUnblockOptions): TickAutoUnblockSummary {
  const io = options.io;
  const env = options.env ?? process.env;
  const now = options.now ?? new Date();
  const globallyEnabled = isAutoUnblockGloballyEnabled(env);

  const summary: TickAutoUnblockSummary = {
    scanned: 0,
    retried: [],
    skipped: [],
    errors: [],
  };

  let blocked: JobStatus[];
  try {
    blocked = io.listBlockedJobs();
  } catch (err) {
    summary.errors.push({ error: `listBlockedJobs failed: ${(err as Error).message}` });
    return summary;
  }

  summary.scanned = blocked.length;

  for (const status of blocked) {
    try {
      // Depth guard before the expensive loads — cheap filter.
      if (AUTO_UNBLOCK_DEPTH_GUARD.test(status.job_id)) {
        summary.skipped.push({ job_id: status.job_id, reason: 'remediation/retry child (depth guard)' });
        continue;
      }

      let packet: JobPacket;
      try {
        packet = io.loadPacket(status.job_id);
      } catch (err) {
        summary.errors.push({ job_id: status.job_id, error: `loadPacket failed: ${(err as Error).message}` });
        continue;
      }
      const result = io.loadResult(status.job_id);
      const rawCfg = io.resolveRepoConfig(packet);
      const config = resolveAutoUnblockConfig(rawCfg);

      const decision = shouldAutoUnblock({ status, result, config, globallyEnabled, now });
      if (!decision.shouldRetry) {
        summary.skipped.push({ job_id: status.job_id, reason: decision.reason });
        if (decision.exhaustedNow && status.autoUnblock) {
          try {
            io.notifyExhausted({
              parentJobId: status.job_id,
              ticketId: status.ticket_id || null,
              blockerType: result?.blocker_type || 'unknown',
              attempts: status.autoUnblock.attempts,
            });
            io.saveAutoUnblockState(status.job_id, {
              ...status.autoUnblock,
              exhausted: true,
            });
            io.appendLog(
              status.job_id,
              `[${now.toISOString()}] auto-unblock exhausted after ${status.autoUnblock.attempts} retries (blocker_type=${result?.blocker_type || 'unknown'})`,
            );
          } catch (err) {
            summary.errors.push({ job_id: status.job_id, error: `exhausted notify failed: ${(err as Error).message}` });
          }
        }
        continue;
      }

      const attemptNumber = decision.attemptNumber as number;
      const childPacket = buildRetryPacket({
        parentPacket: packet,
        parentStatus: status,
        parentResult: result,
        attemptNumber,
        config,
        now,
      });

      // Idempotency: if we've already spawned this exact child id in a
      // previous cycle (e.g. supervisor crashed before persisting state),
      // skip the createJob call but still update parent bookkeeping so
      // we don't re-enter this branch forever.
      if (io.jobExists(childPacket.job_id)) {
        summary.skipped.push({ job_id: status.job_id, reason: `retry child already exists (${childPacket.job_id})` });
        const state = applyRetryToState({
          prior: status.autoUnblock,
          childJobId: childPacket.job_id,
          priorBlockerType: result?.blocker_type || 'unknown',
          priorBlockerDetail: result?.blocker || null,
          attemptNumber,
          at: now,
        });
        io.saveAutoUnblockState(status.job_id, state);
        continue;
      }

      io.createJob(childPacket);
      io.appendLog(
        status.job_id,
        `[${now.toISOString()}] auto-unblock queued ${childPacket.job_id} (attempt ${attemptNumber}/${config.maxRetries}, blocker_type=${result?.blocker_type || 'unknown'})`,
      );
      const state = applyRetryToState({
        prior: status.autoUnblock,
        childJobId: childPacket.job_id,
        priorBlockerType: result?.blocker_type || 'unknown',
        priorBlockerDetail: result?.blocker || null,
        attemptNumber,
        at: now,
      });
      io.saveAutoUnblockState(status.job_id, state);
      summary.retried.push({
        parent: status.job_id,
        child: childPacket.job_id,
        attempt: attemptNumber,
        blockerType: result?.blocker_type || 'unknown',
      });
    } catch (err) {
      summary.errors.push({ job_id: status.job_id, error: (err as Error).message });
    }
  }

  return summary;
}

// Re-exported for CLI / debugging convenience — operators sometimes
// want to check the config resolution without actually running a tick.
export { isAutoUnblockGloballyEnabled as _internalIsGloballyEnabled };
export type { RepoMapping };
