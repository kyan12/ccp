/**
 * Phase 6d: blocker telemetry.
 *
 * Aggregates the existing per-job JSON artifacts (`status.json`,
 * `result.json`) into a point-in-time snapshot of how the supervisor
 * is actually performing. Operators can answer questions like:
 *
 *   - Which blocker types are driving the bulk of stuck work right now?
 *   - After Phase 6a landed, what fraction of `ambiguity-transient`
 *     retries actually recover vs. churn and re-block?
 *   - How many auto-retries are jobs taking on average? Any runaways
 *     hitting the per-repo `maxRetries` cap?
 *
 * Design constraints:
 *   - Pure function of the jobs directory. No new persistence, no new
 *     state file, no side effects. Every invocation re-derives the
 *     snapshot from on-disk JSON so a stale cache can never lie.
 *   - IO is injected via `TelemetryIo` so tests run deterministically
 *     with in-memory fixtures (same pattern as `auto-unblock.ts`).
 *   - Rolling-window filter applied on the caller-supplied clock so
 *     time-sensitive tests don't need to sleep.
 *   - Safe on malformed files: loading a job's result returns `null`
 *     rather than throwing, so one corrupt job never poisons the
 *     whole aggregate.
 *   - Retry children (`__autoretry<N>`, `__valfix`, `__deployfix`,
 *     `__reviewfix`) are counted in the state/blocker distributions
 *     but DO NOT inflate the auto-unblock parent stats — the parent's
 *     `status.autoUnblock.history` is the canonical record and each
 *     child is already reachable from it by id.
 */

import type {
  AutoUnblockAttempt,
  JobResult,
  JobStatus,
} from '../types';

/** Default rolling-window size for `collectTelemetry()`. */
export const DEFAULT_TELEMETRY_WINDOW_DAYS = 7;

/**
 * Job-id suffixes that identify remediation/retry children. Matches
 * `AUTO_UNBLOCK_DEPTH_GUARD` in `auto-unblock.ts` so the telemetry
 * view of "is this a parent?" lines up exactly with the watchdog's
 * view of "can we retry this?".
 */
const CHILD_JOB_ID_PATTERN = /__(?:valfix|deployfix|reviewfix|autoretry\d*)/;

export interface TelemetryIo {
  /** Return every JobStatus visible to the supervisor. */
  listJobs(): JobStatus[];
  /**
   * Load a job's `result.json`. Must return `null` (not throw) when
   * the file is missing or malformed — the aggregator tolerates
   * partial data because many jobs won't have a result yet.
   */
  loadResult(jobId: string): JobResult | null;
  /**
   * Load a job's `status.json` by id. Used to resolve outcomes of
   * auto-unblock child jobs referenced from parent history. Returns
   * `null` when the child has been garbage-collected or was never
   * written.
   */
  loadStatus(jobId: string): JobStatus | null;
}

export interface TelemetryOptions {
  io: TelemetryIo;
  /** Rolling-window size (days). Defaults to 7. */
  windowDays?: number;
  /** Clock injection for tests. Defaults to `new Date()`. */
  now?: Date;
}

export interface TelemetryWindow {
  /** ISO timestamp — upper bound (caller-supplied "now"). */
  to: string;
  /** ISO timestamp — lower bound (to - windowDays). */
  from: string;
  /** Window size in days (matches input or default). */
  days: number;
}

export interface BlockerTypeCount {
  /** Blocker type bucket name, e.g. `ambiguity-transient` or `<unknown>`. */
  type: string;
  /** Number of jobs in the window with this blocker_type. */
  count: number;
}

export interface BlockerDistribution {
  /** Count of jobs in `state === 'blocked'` in the window. */
  blockedTotal: number;
  /**
   * Count of jobs with a non-null `blocker_type` (including jobs that
   * have since moved out of `blocked` but still have the bucket set on
   * their result). Operators use this to spot jobs that "escaped" the
   * blocker state without actually resolving the underlying issue.
   */
  classifiedTotal: number;
  /** Per-bucket counts, sorted desc by count then asc by type. */
  byType: BlockerTypeCount[];
}

export interface AutoUnblockPerType {
  priorBlockerType: string;
  attempted: number;
  recovered: number;
  stillBlocked: number;
  pending: number;
  /** `recovered / attempted`, null when `attempted === 0`. */
  recoveryRate: number | null;
}

export interface AutoUnblockAttemptStats {
  /** How many parent jobs triggered at least one auto-retry. */
  parentCount: number;
  /** Sum of `status.autoUnblock.attempts` across all parents. */
  totalAttempts: number;
  /** Average attempts per parent (0 when `parentCount === 0`). */
  avgAttempts: number;
  /** Median attempts. */
  p50Attempts: number;
  /** 95th-percentile attempts. */
  p95Attempts: number;
  /** Max attempts across all parents. */
  maxAttempts: number;
}

export interface AutoUnblockTelemetry {
  /** Parents that have at least one attempt in `autoUnblock.history`. */
  parentCount: number;
  /** Total attempts = sum of `autoUnblock.attempts` over parents. */
  attempted: number;
  /** Parents whose current state is `done` or `verified`. */
  recovered: number;
  /** Parents whose current state is `blocked`. */
  stillBlocked: number;
  /** Subset of `stillBlocked` whose watchdog reached `maxRetries`. */
  exhausted: number;
  /**
   * Parents currently in a non-terminal state that is neither recovered
   * nor blocked (e.g. `queued`, `running`, `cleaned`). Tracked separately
   * so ratios don't drift as retries are mid-flight.
   */
  pending: number;
  /**
   * `recovered / parentCount`. Null when no parents have attempted a
   * retry yet — avoid reporting a spurious 0 % on a fresh install.
   */
  recoveryRate: number | null;
  /** Per-prior-blocker breakdown, sorted desc by attempted. */
  byPriorBlockerType: AutoUnblockPerType[];
  /** Per-parent attempt-count distribution. */
  attemptStats: AutoUnblockAttemptStats;
}

export interface TelemetrySummary {
  /** ISO timestamp of when this snapshot was generated. */
  generatedAt: string;
  window: TelemetryWindow;
  /** All jobs visible to the supervisor whose `updated_at` is in the window. */
  totalJobs: number;
  /** Current `state` distribution across `totalJobs`. */
  byState: Record<string, number>;
  blockers: BlockerDistribution;
  autoUnblock: AutoUnblockTelemetry;
}

/**
 * Collect a point-in-time telemetry snapshot. Pure wrt the clock
 * (injected via `options.now`) and pure wrt IO (injected via
 * `options.io`), so tests can run hundreds of scenarios without
 * hitting the disk.
 */
export function collectTelemetry(options: TelemetryOptions): TelemetrySummary {
  const windowDays = resolveWindowDays(options.windowDays);
  const now = options.now instanceof Date ? options.now : new Date();
  const to = now.toISOString();
  const from = new Date(now.getTime() - windowDays * 86_400_000).toISOString();

  const allJobs = safeList(options.io);
  const inWindow = allJobs.filter((j) => isInWindow(j.updated_at, from, to));

  const byState = tallyByState(inWindow);
  const blockers = tallyBlockers(inWindow, options.io);
  const autoUnblock = tallyAutoUnblock(inWindow, options.io);

  return {
    generatedAt: to,
    window: { from, to, days: windowDays },
    totalJobs: inWindow.length,
    byState,
    blockers,
    autoUnblock,
  };
}

/**
 * Render a compact human-readable report suitable for CLI stdout.
 * The JSON form is the source of truth — this view exists so
 * `ccp-jobs telemetry` prints something legible without `| jq`.
 */
export function renderTelemetry(summary: TelemetrySummary): string {
  const lines: string[] = [];
  lines.push(`Blocker telemetry (last ${summary.window.days}d)`);
  lines.push(`  window: ${summary.window.from} → ${summary.window.to}`);
  lines.push(`  jobs in window: ${summary.totalJobs}`);
  lines.push('');

  lines.push('State distribution:');
  if (summary.totalJobs === 0) {
    lines.push('  (no jobs)');
  } else {
    const states = Object.entries(summary.byState).sort((a, b) => b[1] - a[1]);
    for (const [state, count] of states) {
      lines.push(`  ${state.padEnd(16)} ${count}`);
    }
  }
  lines.push('');

  lines.push('Blocker types:');
  lines.push(`  currently blocked: ${summary.blockers.blockedTotal}`);
  lines.push(`  classified total:  ${summary.blockers.classifiedTotal}`);
  if (summary.blockers.byType.length === 0) {
    lines.push('  (no classified blockers)');
  } else {
    for (const b of summary.blockers.byType) {
      lines.push(`  ${b.type.padEnd(24)} ${b.count}`);
    }
  }
  lines.push('');

  lines.push('Auto-unblock (Phase 6a/6b watchdog):');
  const au = summary.autoUnblock;
  lines.push(`  parents with retries: ${au.parentCount}`);
  lines.push(`  total attempts:       ${au.attempted}`);
  lines.push(`  recovered:            ${au.recovered}`);
  lines.push(`  still blocked:        ${au.stillBlocked} (${au.exhausted} exhausted)`);
  lines.push(`  pending:              ${au.pending}`);
  lines.push(`  recovery rate:        ${formatRate(au.recoveryRate)}`);
  if (au.parentCount > 0) {
    lines.push('  attempt stats:');
    lines.push(`    avg=${au.attemptStats.avgAttempts.toFixed(2)}` +
      `  p50=${au.attemptStats.p50Attempts}` +
      `  p95=${au.attemptStats.p95Attempts}` +
      `  max=${au.attemptStats.maxAttempts}`);
  }
  if (au.byPriorBlockerType.length > 0) {
    lines.push('  by prior blocker_type:');
    for (const row of au.byPriorBlockerType) {
      lines.push(
        `    ${row.priorBlockerType.padEnd(24)}` +
          ` attempted=${row.attempted}` +
          ` recovered=${row.recovered}` +
          ` stillBlocked=${row.stillBlocked}` +
          ` rate=${formatRate(row.recoveryRate)}`,
      );
    }
  }
  return lines.join('\n');
}

// ── internals ──────────────────────────────────────────────────────

function resolveWindowDays(raw: number | undefined): number {
  if (typeof raw !== 'number' || !Number.isFinite(raw) || raw <= 0) {
    return DEFAULT_TELEMETRY_WINDOW_DAYS;
  }
  return Math.floor(raw);
}

function safeList(io: TelemetryIo): JobStatus[] {
  try {
    const jobs = io.listJobs();
    return Array.isArray(jobs) ? jobs : [];
  } catch {
    return [];
  }
}

function isInWindow(updatedAt: string | null | undefined, fromIso: string, toIso: string): boolean {
  if (!updatedAt || typeof updatedAt !== 'string') return false;
  // Lexical ISO-8601 comparison is correct for RFC 3339 Zulu timestamps,
  // which is the format every supervisor write-site produces. Cheaper
  // than a Date roundtrip and stable across malformed inputs.
  return updatedAt >= fromIso && updatedAt <= toIso;
}

function tallyByState(jobs: JobStatus[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const job of jobs) {
    const state = typeof job.state === 'string' && job.state.length > 0 ? job.state : '<unknown>';
    out[state] = (out[state] || 0) + 1;
  }
  return out;
}

function tallyBlockers(jobs: JobStatus[], io: TelemetryIo): BlockerDistribution {
  let blockedTotal = 0;
  const counts = new Map<string, number>();
  for (const job of jobs) {
    if (job.state === 'blocked') blockedTotal++;
    const type = resolveBlockerType(job, io);
    if (!type) continue;
    counts.set(type, (counts.get(type) || 0) + 1);
  }
  const byType: BlockerTypeCount[] = [...counts.entries()]
    .map(([type, count]) => ({ type, count }))
    .sort((a, b) => (b.count - a.count) || a.type.localeCompare(b.type));
  const classifiedTotal = byType.reduce((s, b) => s + b.count, 0);
  return { blockedTotal, classifiedTotal, byType };
}

function resolveBlockerType(job: JobStatus, io: TelemetryIo): string | null {
  // Only classify jobs that are either currently blocked OR whose
  // most recent result pinned a blocker type. Skipping everything
  // else keeps `done`/`verified` jobs out of the blocker distribution
  // even if they happen to carry a stale blocker field from an
  // earlier state.
  if (job.state !== 'blocked') {
    const result = safeLoadResult(io, job.job_id);
    if (!result) return null;
    const resultType = typeof result.blocker_type === 'string' ? result.blocker_type : null;
    if (!resultType || resultType === 'none') return null;
    return resultType;
  }
  const result = safeLoadResult(io, job.job_id);
  const resultType = result && typeof result.blocker_type === 'string' ? result.blocker_type : null;
  if (resultType && resultType !== 'none') return resultType;
  // Blocked with no classified type — bucket as <unknown> so it still
  // shows up in the distribution. Operators shouldn't see these once
  // Phase 6b classifier is fully wired, but older jobs may linger.
  return '<unknown>';
}

function safeLoadResult(io: TelemetryIo, jobId: string): JobResult | null {
  try {
    return io.loadResult(jobId);
  } catch {
    return null;
  }
}

function safeLoadStatus(io: TelemetryIo, jobId: string): JobStatus | null {
  try {
    return io.loadStatus(jobId);
  } catch {
    return null;
  }
}

interface ParentRecord {
  parent: JobStatus;
  attempts: number;
  history: AutoUnblockAttempt[];
  exhausted: boolean;
}

function collectParents(jobs: JobStatus[]): ParentRecord[] {
  const out: ParentRecord[] = [];
  for (const job of jobs) {
    if (isChildJobId(job.job_id)) continue;
    const au = job.autoUnblock;
    if (!au || typeof au.attempts !== 'number' || au.attempts <= 0) continue;
    out.push({
      parent: job,
      attempts: au.attempts,
      history: Array.isArray(au.history) ? au.history : [],
      exhausted: au.exhausted === true,
    });
  }
  return out;
}

function isChildJobId(jobId: string | null | undefined): boolean {
  if (!jobId || typeof jobId !== 'string') return false;
  return CHILD_JOB_ID_PATTERN.test(jobId);
}

function tallyAutoUnblock(jobs: JobStatus[], io: TelemetryIo): AutoUnblockTelemetry {
  const parents = collectParents(jobs);
  const byPrior = new Map<string, AutoUnblockPerType>();

  let recovered = 0;
  let stillBlocked = 0;
  let exhausted = 0;
  let pending = 0;
  let totalAttempts = 0;
  const attemptCounts: number[] = [];

  for (const rec of parents) {
    totalAttempts += rec.attempts;
    attemptCounts.push(rec.attempts);

    const outcome = classifyParentOutcome(rec.parent, io);
    if (outcome === 'recovered') recovered++;
    else if (outcome === 'blocked') {
      stillBlocked++;
      if (rec.exhausted) exhausted++;
    } else pending++;

    // Per prior-blocker-type rollup uses the LAST history entry (the
    // most recent retry's trigger). Earlier entries are the same
    // classification unless the operator manually changed blocker_type
    // between retries, which is rare.
    const priorType = pickPriorBlockerType(rec);
    const row = byPrior.get(priorType) || freshPerType(priorType);
    row.attempted += rec.attempts;
    if (outcome === 'recovered') row.recovered++;
    else if (outcome === 'blocked') row.stillBlocked++;
    else row.pending++;
    byPrior.set(priorType, row);
  }

  for (const row of byPrior.values()) {
    row.recoveryRate = row.attempted > 0 ? row.recovered / row.attempted : null;
  }

  const sortedByType: AutoUnblockPerType[] = [...byPrior.values()].sort(
    (a, b) => (b.attempted - a.attempted) || a.priorBlockerType.localeCompare(b.priorBlockerType),
  );

  return {
    parentCount: parents.length,
    attempted: totalAttempts,
    recovered,
    stillBlocked,
    exhausted,
    pending,
    recoveryRate: parents.length > 0 ? recovered / parents.length : null,
    byPriorBlockerType: sortedByType,
    attemptStats: {
      parentCount: parents.length,
      totalAttempts,
      avgAttempts: parents.length > 0 ? totalAttempts / parents.length : 0,
      p50Attempts: percentile(attemptCounts, 0.5),
      p95Attempts: percentile(attemptCounts, 0.95),
      maxAttempts: attemptCounts.length > 0 ? Math.max(...attemptCounts) : 0,
    },
  };
}

function classifyParentOutcome(
  parent: JobStatus,
  io: TelemetryIo,
): 'recovered' | 'blocked' | 'pending' {
  // A parent can be "recovered" either because the parent itself
  // landed in a successful state OR because its most recent auto-retry
  // child did (supervisor transitions the parent separately, and we
  // want the recovery rate to credit the watchdog even on the cycle
  // before the parent is reconciled).
  if (parent.state === 'done' || parent.state === 'verified') return 'recovered';
  if (parent.state === 'blocked') {
    const lastChildId = pickLastChildId(parent);
    if (lastChildId) {
      const child = safeLoadStatus(io, lastChildId);
      if (child && (child.state === 'done' || child.state === 'verified')) return 'recovered';
    }
    return 'blocked';
  }
  return 'pending';
}

function pickPriorBlockerType(rec: ParentRecord): string {
  const lastHistory = rec.history[rec.history.length - 1];
  if (lastHistory && typeof lastHistory.priorBlockerType === 'string' && lastHistory.priorBlockerType.length > 0) {
    return lastHistory.priorBlockerType;
  }
  return '<unknown>';
}

function pickLastChildId(parent: JobStatus): string | null {
  const history = parent.autoUnblock?.history;
  if (!Array.isArray(history) || history.length === 0) return null;
  const last = history[history.length - 1];
  return last && typeof last.childJobId === 'string' ? last.childJobId : null;
}

function freshPerType(priorBlockerType: string): AutoUnblockPerType {
  return {
    priorBlockerType,
    attempted: 0,
    recovered: 0,
    stillBlocked: 0,
    pending: 0,
    recoveryRate: null,
  };
}

function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  // Nearest-rank method: simple and stable for the small N (< 1000) we
  // ever see in practice; avoids interpolation edge cases.
  const rank = Math.ceil(p * sorted.length);
  const clamped = Math.min(Math.max(rank, 1), sorted.length);
  return sorted[clamped - 1];
}

function formatRate(rate: number | null): string {
  if (rate === null) return 'n/a';
  return `${(rate * 100).toFixed(1)}%`;
}
