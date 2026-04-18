/**
 * Phase 6a: auto-unblock watchdog unit tests.
 *
 * Every branch of eligibility, retry spawn, idempotency, and exhaustion
 * exercised with in-memory `JobsIo` fakes and an injected clock. No
 * filesystem or subprocess IO.
 */

import assert = require('assert');
import type {
  AutoUnblockConfig,
  AutoUnblockState,
  JobPacket,
  JobResult,
  JobStatus,
} from '../types';
import {
  AUTO_UNBLOCK_DEPTH_GUARD,
  applyRetryToState,
  buildRefinedFeedback,
  buildRetryPacket,
  DEFAULT_AUTO_UNBLOCK_ELIGIBLE_TYPES,
  DEFAULT_AUTO_UNBLOCK_MAX_RETRIES,
  DEFAULT_AUTO_UNBLOCK_RETRY_AFTER_SEC,
  isAutoUnblockGloballyEnabled,
  resolveAutoUnblockConfig,
  shouldAutoUnblock,
  tickAutoUnblock,
  type JobsIo,
  type ResolvedAutoUnblockConfig,
  type TickAutoUnblockSummary,
} from './auto-unblock';

// ── Helpers ────────────────────────────────────────────────────────

// Merge defaults with overrides using the `in` operator so that an
// explicit `undefined` in the override (used to simulate "field absent")
// replaces the default, instead of the default leaking through.
function mergeDefaults<T>(defaults: T, overrides: Partial<T>): T {
  const out = { ...(defaults as unknown as Record<string, unknown>) };
  for (const key of Object.keys(overrides as unknown as Record<string, unknown>)) {
    out[key] = (overrides as unknown as Record<string, unknown>)[key];
  }
  return out as unknown as T;
}

function mkStatus(overrides: Partial<JobStatus> = {}): JobStatus {
  return mergeDefaults<JobStatus>(
    {
      job_id: 'JOB-1',
      ticket_id: 'TKT-1',
      repo: '/repo',
      state: 'blocked',
      started_at: '2025-01-01T00:00:00.000Z',
      updated_at: '2025-01-01T00:00:00.000Z',
      elapsed_sec: 0,
      tmux_session: null,
      last_heartbeat_at: null,
      last_output_excerpt: '',
      exit_code: 1,
    },
    overrides,
  );
}

function mkPacket(overrides: Partial<JobPacket> = {}): JobPacket {
  return mergeDefaults<JobPacket>(
    {
      job_id: 'JOB-1',
      ticket_id: 'TKT-1',
      repo: '/repo',
      goal: 'Do the thing',
      source: 'linear',
      kind: 'feature',
      label: 'feature',
      working_branch: 'feature/abc',
      base_branch: 'main',
      created_at: '2025-01-01T00:00:00.000Z',
    },
    overrides,
  );
}

function mkResult(overrides: Partial<JobResult> = {}): JobResult {
  return mergeDefaults<JobResult>(
    {
      job_id: 'JOB-1',
      state: 'blocked',
      commit: 'none',
      prod: 'no',
      verified: 'not yet',
      blocker: 'Validation failed',
      blocker_type: 'validation-failed',
      branch: 'feature/abc',
      updated_at: '2025-01-01T00:00:00.000Z',
    },
    overrides,
  );
}

function mkConfig(overrides: Partial<ResolvedAutoUnblockConfig> = {}): ResolvedAutoUnblockConfig {
  return {
    enabled: overrides.enabled ?? true,
    retryAfterSec: overrides.retryAfterSec ?? DEFAULT_AUTO_UNBLOCK_RETRY_AFTER_SEC,
    maxRetries: overrides.maxRetries ?? DEFAULT_AUTO_UNBLOCK_MAX_RETRIES,
    eligibleTypes: overrides.eligibleTypes ?? DEFAULT_AUTO_UNBLOCK_ELIGIBLE_TYPES.slice(),
    usePlannerRefresh: overrides.usePlannerRefresh ?? false,
  };
}

/**
 * Minimal in-memory JobsIo fake. Calls are recorded for later assertions.
 */
interface FakeJobsIoState {
  blocked: JobStatus[];
  packets: Record<string, JobPacket>;
  results: Record<string, JobResult | null>;
  existing: Set<string>;
  configs: Record<string, AutoUnblockConfig | undefined>;
  created: JobPacket[];
  savedStates: Array<{ jobId: string; state: AutoUnblockState }>;
  logs: Array<{ jobId: string; line: string }>;
  notifications: Array<{ parentJobId: string; ticketId: string | null; blockerType: string; attempts: number }>;
}

function mkFakeIo(init: Partial<FakeJobsIoState> = {}): { io: JobsIo; state: FakeJobsIoState } {
  const state: FakeJobsIoState = {
    blocked: init.blocked || [],
    packets: init.packets || {},
    results: init.results || {},
    existing: init.existing || new Set(),
    configs: init.configs || {},
    created: [],
    savedStates: [],
    logs: [],
    notifications: [],
  };
  const io: JobsIo = {
    listBlockedJobs: () => state.blocked,
    loadPacket: (jobId) => {
      const p = state.packets[jobId];
      if (!p) throw new Error(`no packet for ${jobId}`);
      return p;
    },
    loadResult: (jobId) => (state.results[jobId] === undefined ? null : state.results[jobId]),
    createJob: (packet) => {
      if (state.existing.has(packet.job_id)) {
        throw new Error(`test: createJob called for pre-existing id ${packet.job_id}`);
      }
      state.created.push(packet);
      state.existing.add(packet.job_id);
      return { jobId: packet.job_id };
    },
    jobExists: (jobId) => state.existing.has(jobId),
    saveAutoUnblockState: (jobId, newState) => {
      state.savedStates.push({ jobId, state: newState });
    },
    appendLog: (jobId, line) => {
      state.logs.push({ jobId, line });
    },
    resolveRepoConfig: (packet) => state.configs[packet.job_id],
    notifyExhausted: (params) => {
      state.notifications.push(params);
    },
  };
  return { io, state };
}

// ── resolveAutoUnblockConfig ───────────────────────────────────────

{
  // Defaults when raw is undefined / empty.
  const d1 = resolveAutoUnblockConfig(undefined);
  assert.strictEqual(d1.enabled, false, 'undefined cfg → enabled:false');
  assert.strictEqual(d1.retryAfterSec, DEFAULT_AUTO_UNBLOCK_RETRY_AFTER_SEC);
  assert.strictEqual(d1.maxRetries, DEFAULT_AUTO_UNBLOCK_MAX_RETRIES);
  assert.deepStrictEqual(d1.eligibleTypes, DEFAULT_AUTO_UNBLOCK_ELIGIBLE_TYPES);
  assert.strictEqual(d1.usePlannerRefresh, false);

  const d2 = resolveAutoUnblockConfig({});
  assert.deepStrictEqual(d1, d2, 'empty cfg object matches undefined');

  const d3 = resolveAutoUnblockConfig(null as unknown as AutoUnblockConfig);
  assert.deepStrictEqual(d1, d3, 'null cfg matches undefined');
}

{
  // Explicit enable.
  const r = resolveAutoUnblockConfig({ enabled: true });
  assert.strictEqual(r.enabled, true);
}

{
  // Invalid numeric fields fall back to defaults (negative / zero /
  // non-number) instead of silently producing a disabled-by-tiny-window
  // watchdog.
  const r1 = resolveAutoUnblockConfig({ enabled: true, retryAfterSec: -5 });
  assert.strictEqual(r1.retryAfterSec, DEFAULT_AUTO_UNBLOCK_RETRY_AFTER_SEC);
  const r2 = resolveAutoUnblockConfig({ enabled: true, retryAfterSec: 0 });
  assert.strictEqual(r2.retryAfterSec, DEFAULT_AUTO_UNBLOCK_RETRY_AFTER_SEC);
  const r3 = resolveAutoUnblockConfig({ enabled: true, retryAfterSec: 'abc' as unknown as number });
  assert.strictEqual(r3.retryAfterSec, DEFAULT_AUTO_UNBLOCK_RETRY_AFTER_SEC);

  // maxRetries=0 IS legal (means "gate is on but never retry"; useful
  // for dry-run shadowing), so test it separately.
  const r4 = resolveAutoUnblockConfig({ enabled: true, maxRetries: 0 });
  assert.strictEqual(r4.maxRetries, 0);

  // eligibleTypes: non-empty with garbage entries filters garbage and keeps real ones.
  const r5 = resolveAutoUnblockConfig({
    enabled: true,
    eligibleTypes: ['validation-failed', '', '   ', 123 as unknown as string],
  });
  assert.deepStrictEqual(r5.eligibleTypes, ['validation-failed']);

  // eligibleTypes: entirely garbage falls back to defaults so we never
  // accidentally disable by typo-only config.
  const r6 = resolveAutoUnblockConfig({
    enabled: true,
    eligibleTypes: ['', '   ', 123 as unknown as string],
  });
  assert.deepStrictEqual(r6.eligibleTypes, DEFAULT_AUTO_UNBLOCK_ELIGIBLE_TYPES);

  // eligibleTypes: empty array falls back to defaults (same reason).
  const r7 = resolveAutoUnblockConfig({ enabled: true, eligibleTypes: [] });
  assert.deepStrictEqual(r7.eligibleTypes, DEFAULT_AUTO_UNBLOCK_ELIGIBLE_TYPES);
}

{
  // floor() applied to non-integer numeric inputs.
  const r = resolveAutoUnblockConfig({
    enabled: true,
    retryAfterSec: 600.7,
    maxRetries: 2.9,
  });
  assert.strictEqual(r.retryAfterSec, 600);
  assert.strictEqual(r.maxRetries, 2);
}

// ── isAutoUnblockGloballyEnabled ───────────────────────────────────

{
  assert.strictEqual(isAutoUnblockGloballyEnabled({}), true, 'unset defaults to enabled');
  assert.strictEqual(
    isAutoUnblockGloballyEnabled({ CCP_AUTO_UNBLOCK_ENABLED: 'false' }),
    false,
    '"false" disables',
  );
  assert.strictEqual(
    isAutoUnblockGloballyEnabled({ CCP_AUTO_UNBLOCK_ENABLED: 'FALSE' }),
    false,
    'case-insensitive',
  );
  assert.strictEqual(
    isAutoUnblockGloballyEnabled({ CCP_AUTO_UNBLOCK_ENABLED: 'true' }),
    true,
    'explicit true',
  );
  assert.strictEqual(
    isAutoUnblockGloballyEnabled({ CCP_AUTO_UNBLOCK_ENABLED: '0' }),
    true,
    'non-false values (including 0/unknown) default to enabled — kill-switch is opt-out-only',
  );
}

// ── AUTO_UNBLOCK_DEPTH_GUARD ───────────────────────────────────────

{
  assert.ok(AUTO_UNBLOCK_DEPTH_GUARD.test('JOB-1__valfix'), 'valfix matches');
  assert.ok(AUTO_UNBLOCK_DEPTH_GUARD.test('JOB-1__deployfix'), 'deployfix matches');
  assert.ok(AUTO_UNBLOCK_DEPTH_GUARD.test('JOB-1__reviewfix'), 'reviewfix matches');
  assert.ok(AUTO_UNBLOCK_DEPTH_GUARD.test('JOB-1__autoretry1'), 'autoretry matches');
  assert.ok(AUTO_UNBLOCK_DEPTH_GUARD.test('JOB-1__autoretry99'), 'autoretry with any number matches');
  assert.ok(!AUTO_UNBLOCK_DEPTH_GUARD.test('JOB-1'), 'plain job id does not match');
  assert.ok(!AUTO_UNBLOCK_DEPTH_GUARD.test('JOB-feature-autofix'), 'false substring does not match');
}

// ── shouldAutoUnblock — guard branches ─────────────────────────────

const NOW = new Date('2025-01-01T01:00:00.000Z');

{
  // Globally disabled.
  const d = shouldAutoUnblock({
    status: mkStatus(),
    result: mkResult(),
    config: mkConfig(),
    globallyEnabled: false,
    now: NOW,
  });
  assert.strictEqual(d.shouldRetry, false);
  assert.ok(/globally disabled/i.test(d.reason));
}

{
  // Repo config disabled.
  const d = shouldAutoUnblock({
    status: mkStatus(),
    result: mkResult(),
    config: mkConfig({ enabled: false }),
    globallyEnabled: true,
    now: NOW,
  });
  assert.strictEqual(d.shouldRetry, false);
  assert.ok(/disabled for repo/i.test(d.reason));
}

{
  // Non-blocked state.
  const d = shouldAutoUnblock({
    status: mkStatus({ state: 'running' }),
    result: mkResult(),
    config: mkConfig(),
    globallyEnabled: true,
    now: NOW,
  });
  assert.strictEqual(d.shouldRetry, false);
  assert.ok(/not blocked/i.test(d.reason));
}

{
  // Depth guard: valfix id.
  const d = shouldAutoUnblock({
    status: mkStatus({ job_id: 'JOB-1__valfix' }),
    result: mkResult(),
    config: mkConfig(),
    globallyEnabled: true,
    now: NOW,
  });
  assert.strictEqual(d.shouldRetry, false);
  assert.ok(/depth guard/i.test(d.reason));
}

{
  // Depth guard: autoretry id (prevents infinite retry chains).
  const d = shouldAutoUnblock({
    status: mkStatus({ job_id: 'JOB-1__autoretry1' }),
    result: mkResult(),
    config: mkConfig(),
    globallyEnabled: true,
    now: NOW,
  });
  assert.strictEqual(d.shouldRetry, false);
  assert.ok(/depth guard/i.test(d.reason));
}

{
  // No blocker_type at all.
  const d = shouldAutoUnblock({
    status: mkStatus(),
    result: mkResult({ blocker_type: null as unknown as undefined }),
    config: mkConfig(),
    globallyEnabled: true,
    now: NOW,
  });
  assert.strictEqual(d.shouldRetry, false);
  assert.ok(/no blocker_type/i.test(d.reason));
}

{
  // result === null (file not yet written).
  const d = shouldAutoUnblock({
    status: mkStatus(),
    result: null,
    config: mkConfig(),
    globallyEnabled: true,
    now: NOW,
  });
  assert.strictEqual(d.shouldRetry, false);
  assert.ok(/no blocker_type/i.test(d.reason));
}

{
  // blocker_type not in eligibleTypes.
  const d = shouldAutoUnblock({
    status: mkStatus(),
    result: mkResult({ blocker_type: 'ambiguity' }),
    config: mkConfig(),
    globallyEnabled: true,
    now: NOW,
  });
  assert.strictEqual(d.shouldRetry, false);
  assert.ok(/not in eligibleTypes/i.test(d.reason));
}

{
  // agent-outage explicitly NOT eligible (owned by circuit breaker).
  const d = shouldAutoUnblock({
    status: mkStatus(),
    result: mkResult({ blocker_type: 'agent-outage' }),
    config: mkConfig(),
    globallyEnabled: true,
    now: NOW,
  });
  assert.strictEqual(d.shouldRetry, false);
  assert.ok(/not in eligibleTypes/i.test(d.reason));
}

// ── shouldAutoUnblock — cool-down window ───────────────────────────

{
  // Cool-down not yet elapsed.
  const d = shouldAutoUnblock({
    status: mkStatus({ updated_at: '2025-01-01T00:55:00.000Z' }), // 5 min ago
    result: mkResult(),
    config: mkConfig({ retryAfterSec: 600 }),
    globallyEnabled: true,
    now: NOW,
  });
  assert.strictEqual(d.shouldRetry, false);
  assert.ok(/cool-down/i.test(d.reason));
  assert.ok(/300s/.test(d.reason), `expected elapsed seconds in reason, got "${d.reason}"`);
}

{
  // Exactly at the boundary → eligible.
  const d = shouldAutoUnblock({
    status: mkStatus({ updated_at: '2025-01-01T00:50:00.000Z' }), // 10 min ago
    result: mkResult(),
    config: mkConfig({ retryAfterSec: 600 }),
    globallyEnabled: true,
    now: NOW,
  });
  assert.strictEqual(d.shouldRetry, true);
  assert.strictEqual(d.attemptNumber, 1);
}

{
  // Garbage baseline timestamp never retries (defensive).
  const d = shouldAutoUnblock({
    status: mkStatus({ updated_at: 'not-a-date' }),
    result: mkResult(),
    config: mkConfig(),
    globallyEnabled: true,
    now: NOW,
  });
  assert.strictEqual(d.shouldRetry, false);
  assert.ok(/baseline timestamp/i.test(d.reason));
}

{
  // Prior state's lastAttemptAt takes precedence over status.updated_at
  // as the cool-down baseline (so two retries in a row enforce their
  // own separate windows).
  const d = shouldAutoUnblock({
    status: mkStatus({
      updated_at: '2025-01-01T00:00:00.000Z',
      autoUnblock: {
        attempts: 1,
        lastAttemptAt: '2025-01-01T00:59:30.000Z', // 30s ago, still in cool-down
        history: [],
      },
    }),
    result: mkResult(),
    config: mkConfig({ retryAfterSec: 600 }),
    globallyEnabled: true,
    now: NOW,
  });
  assert.strictEqual(d.shouldRetry, false);
  assert.ok(/cool-down/i.test(d.reason));
}

// ── shouldAutoUnblock — max retries ────────────────────────────────

{
  // Attempts==maxRetries → exhausted, first transition.
  const d = shouldAutoUnblock({
    status: mkStatus({
      updated_at: '2025-01-01T00:00:00.000Z',
      autoUnblock: { attempts: 2, history: [] },
    }),
    result: mkResult(),
    config: mkConfig({ maxRetries: 2 }),
    globallyEnabled: true,
    now: NOW,
  });
  assert.strictEqual(d.shouldRetry, false);
  assert.ok(/max retries reached/i.test(d.reason));
  assert.strictEqual(d.exhaustedNow, true);
}

{
  // Attempts==maxRetries AND exhausted:true → NOT a fresh transition
  // (so no duplicate Discord ping).
  const d = shouldAutoUnblock({
    status: mkStatus({
      updated_at: '2025-01-01T00:00:00.000Z',
      autoUnblock: { attempts: 2, history: [], exhausted: true },
    }),
    result: mkResult(),
    config: mkConfig({ maxRetries: 2 }),
    globallyEnabled: true,
    now: NOW,
  });
  assert.strictEqual(d.shouldRetry, false);
  assert.ok(/max retries reached/i.test(d.reason));
  assert.strictEqual(d.exhaustedNow, false);
}

{
  // maxRetries:0 → never eligible (attempts already satisfies >=0).
  const d = shouldAutoUnblock({
    status: mkStatus({ updated_at: '2025-01-01T00:00:00.000Z' }),
    result: mkResult(),
    config: mkConfig({ maxRetries: 0 }),
    globallyEnabled: true,
    now: NOW,
  });
  assert.strictEqual(d.shouldRetry, false);
  assert.ok(/max retries reached/i.test(d.reason));
}

{
  // Happy path: fresh blocked job, eligible blocker, cool-down past,
  // no prior state.
  const d = shouldAutoUnblock({
    status: mkStatus({ updated_at: '2025-01-01T00:00:00.000Z' }),
    result: mkResult({ blocker_type: 'smoke-failed' }),
    config: mkConfig(),
    globallyEnabled: true,
    now: NOW,
  });
  assert.strictEqual(d.shouldRetry, true);
  assert.strictEqual(d.attemptNumber, 1);
  assert.ok(/eligible/i.test(d.reason));
  assert.ok(/smoke-failed/.test(d.reason));
}

{
  // Second retry: prior attempt 1, cool-down past. attemptNumber==2.
  const d = shouldAutoUnblock({
    status: mkStatus({
      updated_at: '2025-01-01T00:00:00.000Z',
      autoUnblock: {
        attempts: 1,
        lastAttemptAt: '2025-01-01T00:49:00.000Z', // 11 min ago
        history: [],
      },
    }),
    result: mkResult(),
    config: mkConfig({ retryAfterSec: 600, maxRetries: 2 }),
    globallyEnabled: true,
    now: NOW,
  });
  assert.strictEqual(d.shouldRetry, true);
  assert.strictEqual(d.attemptNumber, 2);
}

// ── buildRefinedFeedback ───────────────────────────────────────────

{
  const f = buildRefinedFeedback({
    priorBlockerType: 'validation-failed',
    priorBlockerDetail: 'typecheck failed\nerror TS2345: Argument of type string is not assignable',
    priorFailedChecks: [{ name: 'typecheck', state: 'FAILED', url: null }],
    attemptNumber: 1,
    maxRetries: 2,
  });
  assert.ok(f.length >= 3);
  assert.ok(f[0].includes('Automated retry attempt 1 of 2'));
  assert.ok(f[0].includes('validation-failed'));
  assert.ok(f.some((l) => l.includes('Previous blocker detail:')));
  assert.ok(f.some((l) => l.includes('error TS2345')));
  assert.ok(f.some((l) => l.includes('Previous failing checks:')));
  assert.ok(f.some((l) => l.includes('- typecheck [FAILED]')));
  assert.ok(f.some((l) => /same branch/i.test(l)));
  assert.ok(f.some((l) => /leave a precise blocker note/i.test(l)));
}

{
  // No prior detail + no failed checks: footer still emits retry-framing
  // lines so the agent knows it's a second attempt.
  const f = buildRefinedFeedback({
    priorBlockerType: 'pr-check-failed',
    priorBlockerDetail: null,
    priorFailedChecks: [],
    attemptNumber: 2,
    maxRetries: 2,
  });
  assert.ok(f.length >= 2);
  assert.ok(f.some((l) => /Automated retry attempt 2 of 2/.test(l)));
  assert.ok(!f.some((l) => l.includes('Previous blocker detail:')));
  assert.ok(!f.some((l) => l.includes('Previous failing checks:')));
}

{
  // Oversized blocker detail clipped, notice appended.
  const huge = 'x'.repeat(10000);
  const f = buildRefinedFeedback({
    priorBlockerType: 'smoke-failed',
    priorBlockerDetail: huge,
    attemptNumber: 1,
    maxRetries: 2,
  });
  const joined = f.join('\n');
  assert.ok(joined.includes('[blocker detail truncated]'));
  assert.ok(joined.length < huge.length, 'clipped total less than input');
}

{
  // Failed-check entries handle missing fields gracefully.
  const f = buildRefinedFeedback({
    priorBlockerType: 'pr-check-failed',
    priorFailedChecks: [{ name: 'ci', state: 'FAILED' }, { name: undefined, state: undefined, url: undefined }],
    attemptNumber: 1,
    maxRetries: 2,
  });
  const joined = f.join('\n');
  assert.ok(joined.includes('- ci [FAILED]'));
  assert.ok(joined.includes('- unknown'));
}

// ── buildRetryPacket ───────────────────────────────────────────────

{
  const parentPacket = mkPacket({
    job_id: 'JOB-42',
    goal: 'Fix bug X',
    review_feedback: ['Original feedback'],
    reviewComments: [{ id: 'c1', body: 'old review comment' } as unknown as never],
    acceptance_criteria: ['Works'],
    verification_steps: ['Run tests'],
    metadata: { foo: 'bar' },
  });
  const parentStatus = mkStatus({ job_id: 'JOB-42' });
  const parentResult = mkResult({
    job_id: 'JOB-42',
    blocker_type: 'smoke-failed',
    blocker: 'Smoke failed on preview',
    branch: 'feature/bug-x',
    failed_checks: [{ name: 'smoke', state: 'FAILED', url: 'https://…' }],
  });
  const retryTime = new Date('2025-05-01T12:00:00.000Z');
  const packet = buildRetryPacket({
    parentPacket,
    parentStatus,
    parentResult,
    attemptNumber: 1,
    config: mkConfig(),
    now: retryTime,
  });

  assert.strictEqual(packet.job_id, 'JOB-42__autoretry1');
  assert.ok(packet.goal.startsWith('Auto-retry (1/2): Fix bug X'));
  assert.strictEqual(packet.working_branch, 'feature/bug-x', 'preserves the PR branch from result');
  assert.strictEqual(packet.base_branch, 'main');
  assert.strictEqual(packet.reviewComments, undefined, 'reviewComments cleared');
  assert.ok((packet.review_feedback || []).includes('Original feedback'), 'original feedback preserved');
  assert.ok(
    (packet.review_feedback || []).some((l) => /Automated retry attempt 1 of 2/.test(l)),
    'refined footer appended',
  );
  assert.ok(
    (packet.acceptance_criteria || []).some((l) => /smoke-failed/.test(l)),
    'acceptance criteria mentions prior blocker',
  );
  assert.ok(
    (packet.verification_steps || []).some((l) => /re-run the check/i.test(l)),
    'verification step mentions re-check',
  );
  assert.strictEqual(packet.created_at, retryTime.toISOString());
  const meta = (packet.metadata || {}) as Record<string, unknown>;
  const meta_autoUnblock = meta.autoUnblock as Record<string, unknown>;
  assert.strictEqual(meta_autoUnblock.parentJobId, 'JOB-42');
  assert.strictEqual(meta_autoUnblock.attemptNumber, 1);
  assert.strictEqual(meta_autoUnblock.priorBlockerType, 'smoke-failed');
  assert.strictEqual(meta_autoUnblock.triggeredAt, retryTime.toISOString());
  assert.strictEqual(meta_autoUnblock.usePlannerRefresh, false);
  assert.strictEqual(meta.foo, 'bar', 'parent metadata preserved');
}

{
  // When result has no branch, fall back to the packet's working_branch.
  const packet = buildRetryPacket({
    parentPacket: mkPacket({ working_branch: 'fallback-branch' }),
    parentStatus: mkStatus(),
    parentResult: mkResult({ branch: 'unknown' }),
    attemptNumber: 1,
    config: mkConfig(),
  });
  assert.strictEqual(packet.working_branch, 'fallback-branch');
}

{
  // No branch anywhere: working_branch set to null (not 'unknown').
  const packet = buildRetryPacket({
    parentPacket: mkPacket({ working_branch: null }),
    parentStatus: mkStatus(),
    parentResult: mkResult({ branch: undefined }),
    attemptNumber: 1,
    config: mkConfig(),
  });
  assert.strictEqual(packet.working_branch, null);
}

{
  // Planner-refresh flag flows through to child metadata so jobs.ts
  // can consume it at dispatch time.
  const packet = buildRetryPacket({
    parentPacket: mkPacket(),
    parentStatus: mkStatus(),
    parentResult: mkResult(),
    attemptNumber: 1,
    config: mkConfig({ usePlannerRefresh: true }),
  });
  const meta = (packet.metadata || {}) as Record<string, unknown>;
  const meta_autoUnblock = meta.autoUnblock as Record<string, unknown>;
  assert.strictEqual(meta_autoUnblock.usePlannerRefresh, true);
}

{
  // Child job id uses attemptNumber → two retries get distinct IDs.
  const p1 = buildRetryPacket({
    parentPacket: mkPacket({ job_id: 'JOB-1' }),
    parentStatus: mkStatus({ job_id: 'JOB-1' }),
    parentResult: mkResult({ job_id: 'JOB-1' }),
    attemptNumber: 1,
    config: mkConfig(),
  });
  const p2 = buildRetryPacket({
    parentPacket: mkPacket({ job_id: 'JOB-1' }),
    parentStatus: mkStatus({ job_id: 'JOB-1' }),
    parentResult: mkResult({ job_id: 'JOB-1' }),
    attemptNumber: 2,
    config: mkConfig(),
  });
  assert.strictEqual(p1.job_id, 'JOB-1__autoretry1');
  assert.strictEqual(p2.job_id, 'JOB-1__autoretry2');
  assert.notStrictEqual(p1.job_id, p2.job_id);
}

// ── applyRetryToState ──────────────────────────────────────────────

{
  const at = new Date('2025-05-01T00:00:00.000Z');
  const st = applyRetryToState({
    prior: undefined,
    childJobId: 'JOB-1__autoretry1',
    priorBlockerType: 'validation-failed',
    priorBlockerDetail: 'npm test failed',
    attemptNumber: 1,
    at,
  });
  assert.strictEqual(st.attempts, 1);
  assert.strictEqual(st.lastAttemptAt, at.toISOString());
  assert.ok(Array.isArray(st.history));
  assert.strictEqual(st.history!.length, 1);
  const [entry] = st.history!;
  assert.strictEqual(entry.childJobId, 'JOB-1__autoretry1');
  assert.strictEqual(entry.priorBlockerType, 'validation-failed');
  assert.strictEqual(entry.priorBlockerDetail, 'npm test failed');
  assert.strictEqual(entry.attemptNumber, 1);
  assert.strictEqual(st.exhausted, undefined);
}

{
  // Second call appends to existing history, bumps attempts.
  const at1 = new Date('2025-05-01T00:00:00.000Z');
  const at2 = new Date('2025-05-01T01:00:00.000Z');
  const st1 = applyRetryToState({
    prior: undefined,
    childJobId: 'A__autoretry1',
    priorBlockerType: 'smoke-failed',
    attemptNumber: 1,
    at: at1,
  });
  const st2 = applyRetryToState({
    prior: st1,
    childJobId: 'A__autoretry2',
    priorBlockerType: 'smoke-failed',
    attemptNumber: 2,
    at: at2,
  });
  assert.strictEqual(st2.attempts, 2);
  assert.strictEqual(st2.lastAttemptAt, at2.toISOString());
  assert.strictEqual(st2.history!.length, 2);
  assert.strictEqual(st2.history![0].attemptNumber, 1);
  assert.strictEqual(st2.history![1].attemptNumber, 2);
}

{
  // prior.exhausted:true sticks across updates.
  const st = applyRetryToState({
    prior: { attempts: 2, exhausted: true, history: [] },
    childJobId: 'A__autoretry3',
    priorBlockerType: 'smoke-failed',
    attemptNumber: 3,
    at: new Date('2025-05-01T00:00:00.000Z'),
  });
  assert.strictEqual(st.exhausted, true);
}

// ── tickAutoUnblock — full scenarios ───────────────────────────────

{
  // Empty inbox → no-op.
  const { io, state } = mkFakeIo({ blocked: [] });
  const summary = tickAutoUnblock({ io, env: {}, now: NOW });
  assert.strictEqual(summary.scanned, 0);
  assert.deepStrictEqual(summary.retried, []);
  assert.deepStrictEqual(summary.skipped, []);
  assert.deepStrictEqual(summary.errors, []);
  assert.strictEqual(state.created.length, 0);
  assert.strictEqual(state.savedStates.length, 0);
}

{
  // Happy path: one eligible job → exactly one retry spawned.
  const status = mkStatus({ job_id: 'J1', updated_at: '2025-01-01T00:00:00.000Z' });
  const packet = mkPacket({ job_id: 'J1' });
  const result = mkResult({ job_id: 'J1', blocker_type: 'validation-failed' });
  const { io, state } = mkFakeIo({
    blocked: [status],
    packets: { J1: packet },
    results: { J1: result },
    configs: { J1: { enabled: true } },
    existing: new Set(['J1']),
  });
  const summary = tickAutoUnblock({ io, env: {}, now: NOW });
  assert.strictEqual(summary.scanned, 1);
  assert.strictEqual(summary.retried.length, 1);
  assert.strictEqual(summary.retried[0].parent, 'J1');
  assert.strictEqual(summary.retried[0].child, 'J1__autoretry1');
  assert.strictEqual(summary.retried[0].attempt, 1);
  assert.strictEqual(summary.retried[0].blockerType, 'validation-failed');
  assert.strictEqual(state.created.length, 1);
  assert.strictEqual(state.created[0].job_id, 'J1__autoretry1');
  assert.strictEqual(state.savedStates.length, 1);
  assert.strictEqual(state.savedStates[0].jobId, 'J1');
  assert.strictEqual(state.savedStates[0].state.attempts, 1);
  assert.strictEqual(state.logs.length, 1);
  assert.ok(state.logs[0].line.includes('auto-unblock queued J1__autoretry1'));
}

{
  // Depth-guard: blocked valfix doesn't retry.
  const status = mkStatus({ job_id: 'J1__valfix', updated_at: '2025-01-01T00:00:00.000Z' });
  const { io, state } = mkFakeIo({
    blocked: [status],
    packets: { 'J1__valfix': mkPacket({ job_id: 'J1__valfix' }) },
    results: { 'J1__valfix': mkResult({ job_id: 'J1__valfix' }) },
    configs: { 'J1__valfix': { enabled: true } },
  });
  const summary = tickAutoUnblock({ io, env: {}, now: NOW });
  assert.strictEqual(summary.scanned, 1);
  assert.strictEqual(summary.retried.length, 0);
  assert.strictEqual(summary.skipped.length, 1);
  assert.ok(/depth guard/i.test(summary.skipped[0].reason));
  assert.strictEqual(state.created.length, 0);
}

{
  // Blocker-type ineligible (ambiguity). Job is skipped without retry.
  const status = mkStatus({ job_id: 'J1', updated_at: '2025-01-01T00:00:00.000Z' });
  const { io, state } = mkFakeIo({
    blocked: [status],
    packets: { J1: mkPacket({ job_id: 'J1' }) },
    results: { J1: mkResult({ job_id: 'J1', blocker_type: 'ambiguity' }) },
    configs: { J1: { enabled: true } },
  });
  const summary = tickAutoUnblock({ io, env: {}, now: NOW });
  assert.strictEqual(summary.retried.length, 0);
  assert.strictEqual(summary.skipped.length, 1);
  assert.ok(/not in eligibleTypes/i.test(summary.skipped[0].reason));
  assert.strictEqual(state.created.length, 0);
}

{
  // Cool-down not elapsed.
  const status = mkStatus({ job_id: 'J1', updated_at: '2025-01-01T00:55:00.000Z' });
  const { io, state } = mkFakeIo({
    blocked: [status],
    packets: { J1: mkPacket({ job_id: 'J1' }) },
    results: { J1: mkResult({ job_id: 'J1' }) },
    configs: { J1: { enabled: true } },
  });
  const summary = tickAutoUnblock({ io, env: {}, now: NOW });
  assert.strictEqual(summary.retried.length, 0);
  assert.ok(/cool-down/i.test(summary.skipped[0].reason));
  assert.strictEqual(state.created.length, 0);
}

{
  // Multiple jobs, mixed eligibility.
  const j1 = mkStatus({ job_id: 'J1', updated_at: '2025-01-01T00:00:00.000Z' });
  const j2 = mkStatus({ job_id: 'J2', updated_at: '2025-01-01T00:55:00.000Z' }); // cool-down
  const j3 = mkStatus({ job_id: 'J3__valfix', updated_at: '2025-01-01T00:00:00.000Z' });
  const j4 = mkStatus({ job_id: 'J4', updated_at: '2025-01-01T00:00:00.000Z' }); // no cfg → disabled
  const { io, state } = mkFakeIo({
    blocked: [j1, j2, j3, j4],
    packets: {
      J1: mkPacket({ job_id: 'J1' }),
      J2: mkPacket({ job_id: 'J2' }),
      'J3__valfix': mkPacket({ job_id: 'J3__valfix' }),
      J4: mkPacket({ job_id: 'J4' }),
    },
    results: {
      J1: mkResult({ job_id: 'J1' }),
      J2: mkResult({ job_id: 'J2' }),
      'J3__valfix': mkResult({ job_id: 'J3__valfix' }),
      J4: mkResult({ job_id: 'J4' }),
    },
    configs: {
      J1: { enabled: true },
      J2: { enabled: true },
      'J3__valfix': { enabled: true },
      // J4 has no config (undefined → enabled:false default).
    },
  });
  const summary = tickAutoUnblock({ io, env: {}, now: NOW });
  assert.strictEqual(summary.scanned, 4);
  assert.strictEqual(summary.retried.length, 1);
  assert.strictEqual(summary.retried[0].parent, 'J1');
  assert.strictEqual(summary.skipped.length, 3);
  assert.strictEqual(state.created.length, 1);
}

{
  // Global kill-switch disables every job regardless of per-repo cfg.
  const status = mkStatus({ job_id: 'J1', updated_at: '2025-01-01T00:00:00.000Z' });
  const { io, state } = mkFakeIo({
    blocked: [status],
    packets: { J1: mkPacket({ job_id: 'J1' }) },
    results: { J1: mkResult({ job_id: 'J1' }) },
    configs: { J1: { enabled: true, retryAfterSec: 60, maxRetries: 2 } },
  });
  const summary = tickAutoUnblock({ io, env: { CCP_AUTO_UNBLOCK_ENABLED: 'false' }, now: NOW });
  assert.strictEqual(summary.retried.length, 0);
  assert.ok(/globally disabled/i.test(summary.skipped[0].reason));
  assert.strictEqual(state.created.length, 0);
}

{
  // Idempotent: child id already exists on disk → no createJob call,
  // but parent state still advances so we don't loop forever.
  const status = mkStatus({ job_id: 'J1', updated_at: '2025-01-01T00:00:00.000Z' });
  const { io, state } = mkFakeIo({
    blocked: [status],
    packets: { J1: mkPacket({ job_id: 'J1' }) },
    results: { J1: mkResult({ job_id: 'J1' }) },
    configs: { J1: { enabled: true } },
    existing: new Set(['J1', 'J1__autoretry1']),
  });
  const summary = tickAutoUnblock({ io, env: {}, now: NOW });
  assert.strictEqual(summary.retried.length, 0);
  assert.ok(summary.skipped.some((s) => /retry child already exists/i.test(s.reason)));
  assert.strictEqual(state.created.length, 0);
  assert.strictEqual(state.savedStates.length, 1);
  assert.strictEqual(state.savedStates[0].state.attempts, 1);
}

{
  // Second attempt: prior state already has attempts=1, cool-down past,
  // watchdog spawns attempt 2 correctly.
  const status = mkStatus({
    job_id: 'J1',
    updated_at: '2025-01-01T00:00:00.000Z',
    autoUnblock: {
      attempts: 1,
      lastAttemptAt: '2025-01-01T00:49:00.000Z', // 11 min ago
      history: [{
        at: '2025-01-01T00:49:00.000Z',
        childJobId: 'J1__autoretry1',
        priorBlockerType: 'validation-failed',
        attemptNumber: 1,
      }],
    },
  });
  const { io, state } = mkFakeIo({
    blocked: [status],
    packets: { J1: mkPacket({ job_id: 'J1' }) },
    results: { J1: mkResult({ job_id: 'J1' }) },
    configs: { J1: { enabled: true, maxRetries: 2 } },
    existing: new Set(['J1', 'J1__autoretry1']),
  });
  const summary = tickAutoUnblock({ io, env: {}, now: NOW });
  assert.strictEqual(summary.retried.length, 1);
  assert.strictEqual(summary.retried[0].child, 'J1__autoretry2');
  assert.strictEqual(summary.retried[0].attempt, 2);
  assert.strictEqual(state.created.length, 1);
  assert.strictEqual(state.created[0].job_id, 'J1__autoretry2');
  assert.strictEqual(state.savedStates[0].state.attempts, 2);
  assert.strictEqual(state.savedStates[0].state.history!.length, 2);
}

{
  // Exhausted transition: attempts==maxRetries, !exhausted → notify
  // + persist exhausted:true, no new child spawned.
  const status = mkStatus({
    job_id: 'J1',
    updated_at: '2025-01-01T00:00:00.000Z',
    autoUnblock: {
      attempts: 2,
      history: [],
    },
  });
  const { io, state } = mkFakeIo({
    blocked: [status],
    packets: { J1: mkPacket({ job_id: 'J1' }) },
    results: { J1: mkResult({ job_id: 'J1' }) },
    configs: { J1: { enabled: true, maxRetries: 2 } },
  });
  const summary = tickAutoUnblock({ io, env: {}, now: NOW });
  assert.strictEqual(summary.retried.length, 0);
  assert.strictEqual(state.created.length, 0);
  assert.strictEqual(state.notifications.length, 1);
  assert.strictEqual(state.notifications[0].parentJobId, 'J1');
  assert.strictEqual(state.notifications[0].attempts, 2);
  assert.strictEqual(state.savedStates.length, 1);
  assert.strictEqual(state.savedStates[0].state.exhausted, true);
  assert.ok(state.logs.some((l) => /auto-unblock exhausted/i.test(l.line)));
}

{
  // Exhausted AND already flagged: no second notification, no state save.
  const status = mkStatus({
    job_id: 'J1',
    updated_at: '2025-01-01T00:00:00.000Z',
    autoUnblock: {
      attempts: 2,
      history: [],
      exhausted: true,
    },
  });
  const { io, state } = mkFakeIo({
    blocked: [status],
    packets: { J1: mkPacket({ job_id: 'J1' }) },
    results: { J1: mkResult({ job_id: 'J1' }) },
    configs: { J1: { enabled: true, maxRetries: 2 } },
  });
  const summary = tickAutoUnblock({ io, env: {}, now: NOW });
  assert.strictEqual(summary.retried.length, 0);
  assert.strictEqual(state.notifications.length, 0, 'no duplicate notification');
  assert.strictEqual(state.savedStates.length, 0, 'no state churn');
}

{
  // loadPacket throws → error recorded, other jobs still evaluated.
  const j1 = mkStatus({ job_id: 'J1', updated_at: '2025-01-01T00:00:00.000Z' });
  const j2 = mkStatus({ job_id: 'J2', updated_at: '2025-01-01T00:00:00.000Z' });
  const { io, state } = mkFakeIo({
    blocked: [j1, j2],
    packets: { J2: mkPacket({ job_id: 'J2' }) }, // J1 missing
    results: { J1: mkResult({ job_id: 'J1' }), J2: mkResult({ job_id: 'J2' }) },
    configs: { J2: { enabled: true } },
  });
  const summary = tickAutoUnblock({ io, env: {}, now: NOW });
  assert.strictEqual(summary.errors.length, 1, 'J1 loadPacket error recorded');
  assert.strictEqual(summary.errors[0].job_id, 'J1');
  assert.strictEqual(summary.retried.length, 1, 'J2 still evaluated + retried');
  assert.strictEqual(summary.retried[0].parent, 'J2');
  assert.strictEqual(state.created.length, 1);
  assert.strictEqual(state.created[0].job_id, 'J2__autoretry1');
}

{
  // listBlockedJobs throws → return errors summary, don't crash.
  const io: JobsIo = {
    listBlockedJobs: () => { throw new Error('disk gone'); },
    loadPacket: () => { throw new Error('never'); },
    loadResult: () => null,
    createJob: () => ({ jobId: 'n/a' }),
    jobExists: () => false,
    saveAutoUnblockState: () => {},
    appendLog: () => {},
    resolveRepoConfig: () => null,
    notifyExhausted: () => {},
  };
  const summary: TickAutoUnblockSummary = tickAutoUnblock({ io, env: {}, now: NOW });
  assert.strictEqual(summary.scanned, 0);
  assert.strictEqual(summary.errors.length, 1);
  assert.ok(/listBlockedJobs failed/.test(summary.errors[0].error));
}

{
  // createJob throws: error recorded, state NOT advanced (so next cycle
  // can retry cleanly).
  const status = mkStatus({ job_id: 'J1', updated_at: '2025-01-01T00:00:00.000Z' });
  const failingIo: JobsIo = {
    listBlockedJobs: () => [status],
    loadPacket: () => mkPacket({ job_id: 'J1' }),
    loadResult: () => mkResult({ job_id: 'J1' }),
    createJob: () => { throw new Error('disk full'); },
    jobExists: () => false,
    saveAutoUnblockState: () => { throw new Error('unreachable — not reached when createJob throws'); },
    appendLog: () => {},
    resolveRepoConfig: () => ({ enabled: true }),
    notifyExhausted: () => {},
  };
  const summary = tickAutoUnblock({ io: failingIo, env: {}, now: NOW });
  assert.strictEqual(summary.retried.length, 0);
  assert.strictEqual(summary.errors.length, 1);
  assert.strictEqual(summary.errors[0].job_id, 'J1');
  assert.ok(/disk full/.test(summary.errors[0].error));
}

{
  // notifyExhausted throws → error recorded but doesn't corrupt state.
  const status = mkStatus({
    job_id: 'J1',
    updated_at: '2025-01-01T00:00:00.000Z',
    autoUnblock: { attempts: 2, history: [] },
  });
  const flakyIo: JobsIo = {
    listBlockedJobs: () => [status],
    loadPacket: () => mkPacket({ job_id: 'J1' }),
    loadResult: () => mkResult({ job_id: 'J1' }),
    createJob: () => ({ jobId: 'n/a' }),
    jobExists: () => false,
    saveAutoUnblockState: () => {},
    appendLog: () => {},
    resolveRepoConfig: () => ({ enabled: true, maxRetries: 2 }),
    notifyExhausted: () => { throw new Error('discord down'); },
  };
  const summary = tickAutoUnblock({ io: flakyIo, env: {}, now: NOW });
  assert.strictEqual(summary.retried.length, 0);
  assert.strictEqual(summary.errors.length, 1);
  assert.ok(/exhausted notify failed/i.test(summary.errors[0].error));
}

// ── All tests passed ──
console.log('auto-unblock.test.ts: all assertions passed');
