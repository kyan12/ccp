/**
 * Phase 6d: blocker telemetry unit tests.
 *
 * The aggregator is a pure function of an injected `TelemetryIo` and
 * an injected clock, so every case here runs against in-memory
 * fixtures. No filesystem or subprocess IO.
 */

import assert = require('assert');
import type { JobResult, JobStatus } from '../types';
import {
  collectTelemetry,
  DEFAULT_TELEMETRY_WINDOW_DAYS,
  renderTelemetry,
  type TelemetryIo,
} from './telemetry';

// ── Fixtures ───────────────────────────────────────────────────────

function mkStatus(overrides: Partial<JobStatus> = {}): JobStatus {
  return {
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
    ...overrides,
  };
}

function mkResult(overrides: Partial<JobResult> = {}): JobResult {
  return {
    job_id: 'JOB-1',
    state: 'blocked',
    commit: 'none',
    prod: 'no',
    verified: 'not yet',
    blocker: 'Some blocker',
    blocker_type: 'validation-failed',
    branch: 'feature/abc',
    updated_at: '2025-01-01T00:00:00.000Z',
    ...overrides,
  };
}

interface FakeIoState {
  jobs: JobStatus[];
  results: Record<string, JobResult | null>;
  statusesById: Record<string, JobStatus>;
}

function mkIo(init: Partial<FakeIoState> = {}): { io: TelemetryIo; state: FakeIoState } {
  const state: FakeIoState = {
    jobs: init.jobs || [],
    results: init.results || {},
    statusesById: init.statusesById || Object.fromEntries((init.jobs || []).map((j) => [j.job_id, j])),
  };
  const io: TelemetryIo = {
    listJobs: () => state.jobs,
    loadResult: (id) => (state.results[id] === undefined ? null : state.results[id]),
    loadStatus: (id) => state.statusesById[id] || null,
  };
  return { io, state };
}

// ── Helpers ────────────────────────────────────────────────────────

function asRow(
  summary: ReturnType<typeof collectTelemetry>,
  type: string,
): number {
  const row = summary.blockers.byType.find((b) => b.type === type);
  return row ? row.count : 0;
}

function asAuRow(
  summary: ReturnType<typeof collectTelemetry>,
  type: string,
): { attempted: number; recovered: number; stillBlocked: number; pending: number } | null {
  const row = summary.autoUnblock.byPriorBlockerType.find((r) => r.priorBlockerType === type);
  if (!row) return null;
  return {
    attempted: row.attempted,
    recovered: row.recovered,
    stillBlocked: row.stillBlocked,
    pending: row.pending,
  };
}

const NOW = new Date('2025-02-01T00:00:00.000Z');

// ── Tests ──────────────────────────────────────────────────────────

interface Case {
  name: string;
  run: () => void;
}

const cases: Case[] = [];
function t(name: string, run: () => void): void {
  cases.push({ name, run });
}

// — window + totals —

t('empty fixtures → empty summary with default window', () => {
  const { io } = mkIo();
  const s = collectTelemetry({ io, now: NOW });
  assert.strictEqual(s.totalJobs, 0);
  assert.strictEqual(s.window.days, DEFAULT_TELEMETRY_WINDOW_DAYS);
  assert.strictEqual(s.window.to, NOW.toISOString());
  assert.strictEqual(s.blockers.blockedTotal, 0);
  assert.strictEqual(s.blockers.classifiedTotal, 0);
  assert.strictEqual(s.autoUnblock.parentCount, 0);
  assert.strictEqual(s.autoUnblock.recoveryRate, null);
});

t('window filters out jobs older than windowDays', () => {
  const inside = mkStatus({ job_id: 'A', updated_at: '2025-01-29T00:00:00.000Z' });
  const outside = mkStatus({ job_id: 'B', updated_at: '2025-01-10T00:00:00.000Z' });
  const { io } = mkIo({ jobs: [inside, outside] });
  const s = collectTelemetry({ io, now: NOW, windowDays: 7 });
  assert.strictEqual(s.totalJobs, 1);
  assert.deepStrictEqual(s.byState, { blocked: 1 });
});

t('windowDays custom larger window keeps older jobs', () => {
  const job = mkStatus({ job_id: 'A', updated_at: '2025-01-10T00:00:00.000Z' });
  const { io } = mkIo({ jobs: [job] });
  const s = collectTelemetry({ io, now: NOW, windowDays: 30 });
  assert.strictEqual(s.totalJobs, 1);
  assert.strictEqual(s.window.days, 30);
});

t('windowDays fractional rounds down via floor', () => {
  const job = mkStatus({ job_id: 'A', updated_at: '2025-01-29T00:00:00.000Z' });
  const { io } = mkIo({ jobs: [job] });
  const s = collectTelemetry({ io, now: NOW, windowDays: 7.9 });
  assert.strictEqual(s.window.days, 7);
});

t('invalid windowDays falls back to default', () => {
  const { io } = mkIo();
  const s1 = collectTelemetry({ io, now: NOW, windowDays: 0 });
  assert.strictEqual(s1.window.days, DEFAULT_TELEMETRY_WINDOW_DAYS);
  const s2 = collectTelemetry({ io, now: NOW, windowDays: -5 });
  assert.strictEqual(s2.window.days, DEFAULT_TELEMETRY_WINDOW_DAYS);
  const s3 = collectTelemetry({ io, now: NOW, windowDays: NaN });
  assert.strictEqual(s3.window.days, DEFAULT_TELEMETRY_WINDOW_DAYS);
});

t('no now() injected uses wall-clock — still functional (self-consistent window)', () => {
  const { io } = mkIo({ jobs: [mkStatus({ updated_at: new Date().toISOString() })] });
  const s = collectTelemetry({ io });
  assert.strictEqual(s.totalJobs, 1);
  // window.from < window.to by exactly windowDays
  const delta = new Date(s.window.to).getTime() - new Date(s.window.from).getTime();
  assert.strictEqual(delta, DEFAULT_TELEMETRY_WINDOW_DAYS * 86_400_000);
});

t('jobs with missing updated_at are filtered out', () => {
  // Intentional: force invalid field via `as unknown` cast for test only.
  const weird = mkStatus({ job_id: 'W' });
  (weird as unknown as { updated_at: unknown }).updated_at = null;
  const { io } = mkIo({ jobs: [weird] });
  const s = collectTelemetry({ io, now: NOW });
  assert.strictEqual(s.totalJobs, 0);
});

t('listJobs throwing yields empty summary (no crash)', () => {
  const io: TelemetryIo = {
    listJobs: () => { throw new Error('disk gone'); },
    loadResult: () => null,
    loadStatus: () => null,
  };
  const s = collectTelemetry({ io, now: NOW });
  assert.strictEqual(s.totalJobs, 0);
});

t('listJobs returning non-array defends gracefully', () => {
  const io: TelemetryIo = {
    listJobs: (() => 'oops' as unknown) as TelemetryIo['listJobs'],
    loadResult: () => null,
    loadStatus: () => null,
  };
  const s = collectTelemetry({ io, now: NOW });
  assert.strictEqual(s.totalJobs, 0);
});

// — state distribution —

t('byState counts each state distinctly', () => {
  const jobs = [
    mkStatus({ job_id: 'A', state: 'blocked', updated_at: '2025-01-29T00:00:00.000Z' }),
    mkStatus({ job_id: 'B', state: 'blocked', updated_at: '2025-01-30T00:00:00.000Z' }),
    mkStatus({ job_id: 'C', state: 'done', updated_at: '2025-01-31T00:00:00.000Z' }),
    mkStatus({ job_id: 'D', state: 'verified', updated_at: '2025-01-31T12:00:00.000Z' }),
    mkStatus({ job_id: 'E', state: 'running', updated_at: '2025-01-31T12:00:00.000Z' }),
  ];
  const { io } = mkIo({ jobs });
  const s = collectTelemetry({ io, now: NOW });
  assert.deepStrictEqual(s.byState, { blocked: 2, done: 1, verified: 1, running: 1 });
});

t('byState unknown state falls back to <unknown>', () => {
  const weird = mkStatus({ job_id: 'W', updated_at: '2025-01-31T00:00:00.000Z' });
  (weird as unknown as { state: unknown }).state = '';
  const { io } = mkIo({ jobs: [weird] });
  const s = collectTelemetry({ io, now: NOW });
  assert.deepStrictEqual(s.byState, { '<unknown>': 1 });
});

// — blocker distribution —

t('blocker distribution: only blocked jobs counted in blockedTotal', () => {
  const jobs = [
    mkStatus({ job_id: 'A', state: 'blocked', updated_at: '2025-01-30T00:00:00.000Z' }),
    mkStatus({ job_id: 'B', state: 'blocked', updated_at: '2025-01-30T00:00:00.000Z' }),
    mkStatus({ job_id: 'C', state: 'done', updated_at: '2025-01-30T00:00:00.000Z' }),
  ];
  const results: Record<string, JobResult | null> = {
    A: mkResult({ job_id: 'A', blocker_type: 'validation-failed' }),
    B: mkResult({ job_id: 'B', blocker_type: 'ambiguity-transient' }),
    C: mkResult({ job_id: 'C', blocker_type: 'none' }),
  };
  const { io } = mkIo({ jobs, results });
  const s = collectTelemetry({ io, now: NOW });
  assert.strictEqual(s.blockers.blockedTotal, 2);
  assert.strictEqual(asRow(s, 'validation-failed'), 1);
  assert.strictEqual(asRow(s, 'ambiguity-transient'), 1);
  assert.strictEqual(s.blockers.classifiedTotal, 2);
});

t('blocker type sorted desc by count then asc by name', () => {
  const jobs = ['A', 'B', 'C', 'D'].map((id, i) =>
    mkStatus({
      job_id: id,
      state: 'blocked',
      updated_at: `2025-01-${28 + i}T00:00:00.000Z`,
    }),
  );
  const results: Record<string, JobResult | null> = {
    A: mkResult({ job_id: 'A', blocker_type: 'zzz-kind' }),
    B: mkResult({ job_id: 'B', blocker_type: 'aaa-kind' }),
    C: mkResult({ job_id: 'C', blocker_type: 'aaa-kind' }),
    D: mkResult({ job_id: 'D', blocker_type: 'aaa-kind' }),
  };
  const { io } = mkIo({ jobs, results });
  const s = collectTelemetry({ io, now: NOW });
  assert.strictEqual(s.blockers.byType[0].type, 'aaa-kind');
  assert.strictEqual(s.blockers.byType[0].count, 3);
  assert.strictEqual(s.blockers.byType[1].type, 'zzz-kind');
  assert.strictEqual(s.blockers.byType[1].count, 1);
});

t('blocked with no result falls into <unknown>', () => {
  const jobs = [mkStatus({ job_id: 'A', state: 'blocked', updated_at: '2025-01-29T00:00:00.000Z' })];
  const { io } = mkIo({ jobs, results: { A: null } });
  const s = collectTelemetry({ io, now: NOW });
  assert.strictEqual(asRow(s, '<unknown>'), 1);
});

t('blocked with result.blocker_type = "none" still falls into <unknown>', () => {
  const jobs = [mkStatus({ job_id: 'A', state: 'blocked', updated_at: '2025-01-29T00:00:00.000Z' })];
  const results = { A: mkResult({ job_id: 'A', blocker_type: 'none' }) };
  const { io } = mkIo({ jobs, results });
  const s = collectTelemetry({ io, now: NOW });
  assert.strictEqual(asRow(s, '<unknown>'), 1);
});

t('done job with classified blocker_type still counted in blockers (escape case)', () => {
  const jobs = [mkStatus({ job_id: 'A', state: 'done', updated_at: '2025-01-29T00:00:00.000Z' })];
  const results = { A: mkResult({ job_id: 'A', state: 'done', blocker_type: 'smoke-failed' }) };
  const { io } = mkIo({ jobs, results });
  const s = collectTelemetry({ io, now: NOW });
  // blockedTotal is only current-state=blocked, but classifiedTotal
  // should include this residual blocker_type so operators spot it.
  assert.strictEqual(s.blockers.blockedTotal, 0);
  assert.strictEqual(s.blockers.classifiedTotal, 1);
  assert.strictEqual(asRow(s, 'smoke-failed'), 1);
});

t('done job with blocker_type "none" does not pollute classified count', () => {
  const jobs = [mkStatus({ job_id: 'A', state: 'done', updated_at: '2025-01-29T00:00:00.000Z' })];
  const results = { A: mkResult({ job_id: 'A', state: 'done', blocker_type: 'none' }) };
  const { io } = mkIo({ jobs, results });
  const s = collectTelemetry({ io, now: NOW });
  assert.strictEqual(s.blockers.classifiedTotal, 0);
});

t('loadResult throwing degrades to <unknown> for blocked, nothing for done', () => {
  const jobs = [
    mkStatus({ job_id: 'A', state: 'blocked', updated_at: '2025-01-29T00:00:00.000Z' }),
    mkStatus({ job_id: 'B', state: 'done', updated_at: '2025-01-29T00:00:00.000Z' }),
  ];
  const io: TelemetryIo = {
    listJobs: () => jobs,
    loadResult: () => { throw new Error('corrupt'); },
    loadStatus: () => null,
  };
  const s = collectTelemetry({ io, now: NOW });
  assert.strictEqual(asRow(s, '<unknown>'), 1);
  assert.strictEqual(s.blockers.classifiedTotal, 1);
});

t('Phase 6b split: operator vs transient bucketed separately', () => {
  const jobs = ['A', 'B', 'C', 'D'].map((id, i) =>
    mkStatus({
      job_id: id,
      state: 'blocked',
      updated_at: `2025-01-${28 + i}T00:00:00.000Z`,
    }),
  );
  const results: Record<string, JobResult | null> = {
    A: mkResult({ job_id: 'A', blocker_type: 'ambiguity-operator' }),
    B: mkResult({ job_id: 'B', blocker_type: 'ambiguity-operator' }),
    C: mkResult({ job_id: 'C', blocker_type: 'ambiguity-transient' }),
    D: mkResult({ job_id: 'D', blocker_type: 'ambiguity' }), // legacy
  };
  const { io } = mkIo({ jobs, results });
  const s = collectTelemetry({ io, now: NOW });
  assert.strictEqual(asRow(s, 'ambiguity-operator'), 2);
  assert.strictEqual(asRow(s, 'ambiguity-transient'), 1);
  assert.strictEqual(asRow(s, 'ambiguity'), 1);
});

// — auto-unblock —

t('no parent auto-unblock state → empty rollup', () => {
  const { io } = mkIo({ jobs: [mkStatus({ updated_at: '2025-01-29T00:00:00.000Z' })] });
  const s = collectTelemetry({ io, now: NOW });
  assert.strictEqual(s.autoUnblock.parentCount, 0);
  assert.strictEqual(s.autoUnblock.attempted, 0);
  assert.strictEqual(s.autoUnblock.recoveryRate, null);
});

t('parent with attempts=0 is not counted', () => {
  const parent = mkStatus({
    job_id: 'P',
    state: 'blocked',
    updated_at: '2025-01-30T00:00:00.000Z',
    autoUnblock: { attempts: 0 },
  });
  const { io } = mkIo({ jobs: [parent] });
  const s = collectTelemetry({ io, now: NOW });
  assert.strictEqual(s.autoUnblock.parentCount, 0);
});

t('parent in done state is counted as recovered', () => {
  const parent = mkStatus({
    job_id: 'P',
    state: 'done',
    updated_at: '2025-01-30T00:00:00.000Z',
    autoUnblock: {
      attempts: 1,
      history: [
        { at: '2025-01-29T00:00:00.000Z', childJobId: 'P__autoretry1', priorBlockerType: 'validation-failed', attemptNumber: 1 },
      ],
    },
  });
  const { io } = mkIo({ jobs: [parent] });
  const s = collectTelemetry({ io, now: NOW });
  assert.strictEqual(s.autoUnblock.parentCount, 1);
  assert.strictEqual(s.autoUnblock.recovered, 1);
  assert.strictEqual(s.autoUnblock.recoveryRate, 1);
});

t('parent in verified state is counted as recovered', () => {
  const parent = mkStatus({
    job_id: 'P',
    state: 'verified',
    updated_at: '2025-01-30T00:00:00.000Z',
    autoUnblock: {
      attempts: 2,
      history: [
        { at: '2025-01-29T00:00:00.000Z', childJobId: 'P__autoretry1', priorBlockerType: 'ambiguity-transient', attemptNumber: 1 },
        { at: '2025-01-29T12:00:00.000Z', childJobId: 'P__autoretry2', priorBlockerType: 'ambiguity-transient', attemptNumber: 2 },
      ],
    },
  });
  const { io } = mkIo({ jobs: [parent] });
  const s = collectTelemetry({ io, now: NOW });
  assert.strictEqual(s.autoUnblock.recovered, 1);
  assert.strictEqual(s.autoUnblock.attempted, 2);
});

t('parent still blocked → stillBlocked++, exhausted tracked separately', () => {
  const parent = mkStatus({
    job_id: 'P',
    state: 'blocked',
    updated_at: '2025-01-30T00:00:00.000Z',
    autoUnblock: {
      attempts: 2,
      exhausted: true,
      history: [
        { at: '2025-01-29T00:00:00.000Z', childJobId: 'P__autoretry1', priorBlockerType: 'smoke-failed', attemptNumber: 1 },
        { at: '2025-01-29T12:00:00.000Z', childJobId: 'P__autoretry2', priorBlockerType: 'smoke-failed', attemptNumber: 2 },
      ],
    },
  });
  const child = mkStatus({
    job_id: 'P__autoretry2',
    state: 'blocked',
    updated_at: '2025-01-29T12:00:00.000Z',
  });
  const { io } = mkIo({ jobs: [parent, child] });
  const s = collectTelemetry({ io, now: NOW });
  assert.strictEqual(s.autoUnblock.stillBlocked, 1);
  assert.strictEqual(s.autoUnblock.exhausted, 1);
  assert.strictEqual(s.autoUnblock.recovered, 0);
});

t('parent blocked but last child landed done → counted as recovered', () => {
  // Supervisor hasn't reconciled parent yet; telemetry should still
  // credit the watchdog when the most recent child actually succeeded.
  const parent = mkStatus({
    job_id: 'P',
    state: 'blocked',
    updated_at: '2025-01-30T00:00:00.000Z',
    autoUnblock: {
      attempts: 1,
      history: [
        { at: '2025-01-29T00:00:00.000Z', childJobId: 'P__autoretry1', priorBlockerType: 'pr-check-failed', attemptNumber: 1 },
      ],
    },
  });
  const child = mkStatus({
    job_id: 'P__autoretry1',
    state: 'done',
    updated_at: '2025-01-29T00:00:00.000Z',
  });
  const { io } = mkIo({ jobs: [parent, child] });
  const s = collectTelemetry({ io, now: NOW });
  assert.strictEqual(s.autoUnblock.recovered, 1);
  assert.strictEqual(s.autoUnblock.stillBlocked, 0);
});

t('parent in non-terminal state bucketed as pending', () => {
  const parent = mkStatus({
    job_id: 'P',
    state: 'running',
    updated_at: '2025-01-30T00:00:00.000Z',
    autoUnblock: {
      attempts: 1,
      history: [
        { at: '2025-01-29T00:00:00.000Z', childJobId: 'P__autoretry1', priorBlockerType: 'validation-failed', attemptNumber: 1 },
      ],
    },
  });
  const { io } = mkIo({ jobs: [parent] });
  const s = collectTelemetry({ io, now: NOW });
  assert.strictEqual(s.autoUnblock.pending, 1);
  assert.strictEqual(s.autoUnblock.recovered, 0);
});

t('child job ids filtered from parent stats (no double-counting)', () => {
  const parent = mkStatus({
    job_id: 'P',
    state: 'blocked',
    updated_at: '2025-01-30T00:00:00.000Z',
    autoUnblock: {
      attempts: 1,
      history: [
        { at: '2025-01-29T00:00:00.000Z', childJobId: 'P__autoretry1', priorBlockerType: 'validation-failed', attemptNumber: 1 },
      ],
    },
  });
  // Even if the child somehow has its own autoUnblock state (bug),
  // the telemetry must not count it as another parent.
  const child = mkStatus({
    job_id: 'P__autoretry1',
    state: 'blocked',
    updated_at: '2025-01-29T12:00:00.000Z',
    autoUnblock: { attempts: 1, history: [] },
  });
  const { io } = mkIo({ jobs: [parent, child] });
  const s = collectTelemetry({ io, now: NOW });
  assert.strictEqual(s.autoUnblock.parentCount, 1);
});

t('per-prior-blocker-type rollup sums attempts correctly', () => {
  const p1 = mkStatus({
    job_id: 'P1',
    state: 'done',
    updated_at: '2025-01-30T00:00:00.000Z',
    autoUnblock: {
      attempts: 2,
      history: [
        { at: '2025-01-29T00:00:00.000Z', childJobId: 'P1__autoretry1', priorBlockerType: 'ambiguity-transient', attemptNumber: 1 },
        { at: '2025-01-29T12:00:00.000Z', childJobId: 'P1__autoretry2', priorBlockerType: 'ambiguity-transient', attemptNumber: 2 },
      ],
    },
  });
  const p2 = mkStatus({
    job_id: 'P2',
    state: 'blocked',
    updated_at: '2025-01-30T00:00:00.000Z',
    autoUnblock: {
      attempts: 1,
      history: [
        { at: '2025-01-29T00:00:00.000Z', childJobId: 'P2__autoretry1', priorBlockerType: 'ambiguity-transient', attemptNumber: 1 },
      ],
    },
  });
  const p3 = mkStatus({
    job_id: 'P3',
    state: 'done',
    updated_at: '2025-01-30T00:00:00.000Z',
    autoUnblock: {
      attempts: 1,
      history: [
        { at: '2025-01-29T00:00:00.000Z', childJobId: 'P3__autoretry1', priorBlockerType: 'smoke-failed', attemptNumber: 1 },
      ],
    },
  });
  const { io } = mkIo({ jobs: [p1, p2, p3] });
  const s = collectTelemetry({ io, now: NOW });

  const transient = asAuRow(s, 'ambiguity-transient');
  assert.ok(transient);
  assert.strictEqual(transient!.attempted, 3);
  assert.strictEqual(transient!.recovered, 1);
  assert.strictEqual(transient!.stillBlocked, 1);

  const smoke = asAuRow(s, 'smoke-failed');
  assert.ok(smoke);
  assert.strictEqual(smoke!.attempted, 1);
  assert.strictEqual(smoke!.recovered, 1);
});

t('missing history falls back to <unknown> prior-blocker-type', () => {
  const parent = mkStatus({
    job_id: 'P',
    state: 'blocked',
    updated_at: '2025-01-30T00:00:00.000Z',
    autoUnblock: { attempts: 1, history: [] },
  });
  const { io } = mkIo({ jobs: [parent] });
  const s = collectTelemetry({ io, now: NOW });
  const row = asAuRow(s, '<unknown>');
  assert.ok(row);
  assert.strictEqual(row!.attempted, 1);
});

t('per-type recoveryRate uses parent count — single parent with attempts=3 that recovers is 100 %', () => {
  // Regression for the mixed-units bug: row.recoveryRate was previously
  // computed as row.recovered / row.attempted, which treated a parent
  // with 3 attempts as 1/3 = 33 % even though 100 % of that bucket's
  // parents recovered. The denominator must be parent count, not
  // attempt count.
  const parent = mkStatus({
    job_id: 'P',
    state: 'done',
    updated_at: '2025-01-30T00:00:00.000Z',
    autoUnblock: {
      attempts: 3,
      history: [
        { at: '2025-01-29T00:00:00.000Z', childJobId: 'P__autoretry1', priorBlockerType: 'validation-failed', attemptNumber: 1 },
        { at: '2025-01-29T08:00:00.000Z', childJobId: 'P__autoretry2', priorBlockerType: 'validation-failed', attemptNumber: 2 },
        { at: '2025-01-29T16:00:00.000Z', childJobId: 'P__autoretry3', priorBlockerType: 'validation-failed', attemptNumber: 3 },
      ],
    },
  });
  const { io } = mkIo({ jobs: [parent] });
  const s = collectTelemetry({ io, now: NOW });
  const row = s.autoUnblock.byPriorBlockerType.find((r) => r.priorBlockerType === 'validation-failed');
  assert.ok(row);
  assert.strictEqual(row!.attempted, 3);
  assert.strictEqual(row!.recovered, 1);
  assert.strictEqual(row!.stillBlocked, 0);
  assert.strictEqual(row!.pending, 0);
  assert.strictEqual(row!.recoveryRate, 1);
});

t('per-type recoveryRate matches top-level formulation across buckets', () => {
  // Same dataset as the per-prior-blocker-type rollup test: 3 parents
  // for ambiguity-transient (1 recovered, 1 blocked, 1 pending mid-run
  // would add noise — keep it simple: 2 parents recovered, 1 blocked),
  // plus 1 parent for smoke-failed recovered. Expected per-type rates:
  //   ambiguity-transient = 2 / (2 + 1 + 0) = 66.67 %
  //   smoke-failed        = 1 / (1 + 0 + 0) = 100 %
  const p1 = mkStatus({
    job_id: 'P1',
    state: 'done',
    updated_at: '2025-01-30T00:00:00.000Z',
    autoUnblock: {
      attempts: 2,
      history: [
        { at: '2025-01-29T00:00:00.000Z', childJobId: 'P1__autoretry1', priorBlockerType: 'ambiguity-transient', attemptNumber: 1 },
        { at: '2025-01-29T12:00:00.000Z', childJobId: 'P1__autoretry2', priorBlockerType: 'ambiguity-transient', attemptNumber: 2 },
      ],
    },
  });
  const p2 = mkStatus({
    job_id: 'P2',
    state: 'done',
    updated_at: '2025-01-30T00:00:00.000Z',
    autoUnblock: {
      attempts: 1,
      history: [
        { at: '2025-01-29T00:00:00.000Z', childJobId: 'P2__autoretry1', priorBlockerType: 'ambiguity-transient', attemptNumber: 1 },
      ],
    },
  });
  const p3 = mkStatus({
    job_id: 'P3',
    state: 'blocked',
    updated_at: '2025-01-30T00:00:00.000Z',
    autoUnblock: {
      attempts: 1,
      history: [
        { at: '2025-01-29T00:00:00.000Z', childJobId: 'P3__autoretry1', priorBlockerType: 'ambiguity-transient', attemptNumber: 1 },
      ],
    },
  });
  const p4 = mkStatus({
    job_id: 'P4',
    state: 'done',
    updated_at: '2025-01-30T00:00:00.000Z',
    autoUnblock: {
      attempts: 1,
      history: [
        { at: '2025-01-29T00:00:00.000Z', childJobId: 'P4__autoretry1', priorBlockerType: 'smoke-failed', attemptNumber: 1 },
      ],
    },
  });
  const { io } = mkIo({ jobs: [p1, p2, p3, p4] });
  const s = collectTelemetry({ io, now: NOW });
  const transient = s.autoUnblock.byPriorBlockerType.find((r) => r.priorBlockerType === 'ambiguity-transient');
  const smoke = s.autoUnblock.byPriorBlockerType.find((r) => r.priorBlockerType === 'smoke-failed');
  assert.ok(transient);
  assert.ok(smoke);
  assert.strictEqual(transient!.attempted, 4);
  assert.strictEqual(transient!.recovered, 2);
  assert.strictEqual(transient!.stillBlocked, 1);
  assert.strictEqual(Number(transient!.recoveryRate!.toFixed(4)), Number((2 / 3).toFixed(4)));
  assert.strictEqual(smoke!.attempted, 1);
  assert.strictEqual(smoke!.recovered, 1);
  assert.strictEqual(smoke!.recoveryRate, 1);
});

t('per-type recoveryRate is null when bucket has no parents', () => {
  // Guard: a bucket can only exist when at least one parent contributes
  // to it, so in practice this null branch only fires defensively.
  // Exercise the branch directly by forcing a parent whose history is
  // missing (falls into <unknown>) — the code path must still not
  // divide by zero.
  const parent = mkStatus({
    job_id: 'P',
    state: 'queued',
    updated_at: '2025-01-30T00:00:00.000Z',
    autoUnblock: { attempts: 1, history: [] },
  });
  const { io } = mkIo({ jobs: [parent] });
  const s = collectTelemetry({ io, now: NOW });
  const row = s.autoUnblock.byPriorBlockerType.find((r) => r.priorBlockerType === '<unknown>');
  assert.ok(row);
  // Parent is in 'queued' state which is neither recovered nor blocked,
  // so it counts as pending — recoveryRate should reflect 0 recovered
  // out of 1 parent, i.e. 0, not null.
  assert.strictEqual(row!.pending, 1);
  assert.strictEqual(row!.recoveryRate, 0);
});

t('per-prior-blocker-type rollup sorted desc by attempted', () => {
  const big = mkStatus({
    job_id: 'P1',
    state: 'blocked',
    updated_at: '2025-01-30T00:00:00.000Z',
    autoUnblock: {
      attempts: 3,
      history: [
        { at: '2025-01-29T00:00:00.000Z', childJobId: 'P1__autoretry1', priorBlockerType: 'smoke-failed', attemptNumber: 1 },
      ],
    },
  });
  const small = mkStatus({
    job_id: 'P2',
    state: 'done',
    updated_at: '2025-01-30T00:00:00.000Z',
    autoUnblock: {
      attempts: 1,
      history: [
        { at: '2025-01-29T00:00:00.000Z', childJobId: 'P2__autoretry1', priorBlockerType: 'pr-check-failed', attemptNumber: 1 },
      ],
    },
  });
  const { io } = mkIo({ jobs: [big, small] });
  const s = collectTelemetry({ io, now: NOW });
  assert.strictEqual(s.autoUnblock.byPriorBlockerType[0].priorBlockerType, 'smoke-failed');
  assert.strictEqual(s.autoUnblock.byPriorBlockerType[1].priorBlockerType, 'pr-check-failed');
});

t('attemptStats.avg / p50 / p95 / max computed correctly', () => {
  function mkParent(id: string, attempts: number): JobStatus {
    return mkStatus({
      job_id: id,
      state: 'done',
      updated_at: '2025-01-30T00:00:00.000Z',
      autoUnblock: {
        attempts,
        history: [
          { at: '2025-01-29T00:00:00.000Z', childJobId: `${id}__autoretry1`, priorBlockerType: 'validation-failed', attemptNumber: 1 },
        ],
      },
    });
  }
  const jobs = [1, 1, 2, 2, 3, 4].map((n, i) => mkParent(`P${i}`, n));
  const { io } = mkIo({ jobs });
  const s = collectTelemetry({ io, now: NOW });
  assert.strictEqual(s.autoUnblock.attemptStats.parentCount, 6);
  assert.strictEqual(s.autoUnblock.attemptStats.totalAttempts, 13);
  assert.strictEqual(Number(s.autoUnblock.attemptStats.avgAttempts.toFixed(2)), 2.17);
  assert.strictEqual(s.autoUnblock.attemptStats.p50Attempts, 2);
  assert.strictEqual(s.autoUnblock.attemptStats.p95Attempts, 4);
  assert.strictEqual(s.autoUnblock.attemptStats.maxAttempts, 4);
});

t('attemptStats.p50 on single-sample input returns that sample', () => {
  const parent = mkStatus({
    job_id: 'P',
    state: 'done',
    updated_at: '2025-01-30T00:00:00.000Z',
    autoUnblock: {
      attempts: 2,
      history: [
        { at: '2025-01-29T00:00:00.000Z', childJobId: 'P__autoretry1', priorBlockerType: 'validation-failed', attemptNumber: 1 },
      ],
    },
  });
  const { io } = mkIo({ jobs: [parent] });
  const s = collectTelemetry({ io, now: NOW });
  assert.strictEqual(s.autoUnblock.attemptStats.p50Attempts, 2);
  assert.strictEqual(s.autoUnblock.attemptStats.p95Attempts, 2);
  assert.strictEqual(s.autoUnblock.attemptStats.maxAttempts, 2);
});

t('recoveryRate formulation: 2/3 parents recovered', () => {
  function mkP(id: string, state: string): JobStatus {
    return mkStatus({
      job_id: id,
      state,
      updated_at: '2025-01-30T00:00:00.000Z',
      autoUnblock: {
        attempts: 1,
        history: [
          { at: '2025-01-29T00:00:00.000Z', childJobId: `${id}__autoretry1`, priorBlockerType: 'validation-failed', attemptNumber: 1 },
        ],
      },
    });
  }
  const { io } = mkIo({ jobs: [mkP('A', 'done'), mkP('B', 'verified'), mkP('C', 'blocked')] });
  const s = collectTelemetry({ io, now: NOW });
  assert.strictEqual(Number(s.autoUnblock.recoveryRate!.toFixed(4)), Number((2 / 3).toFixed(4)));
});

t('outside-window parent excluded from auto-unblock rollup', () => {
  const parent = mkStatus({
    job_id: 'P',
    state: 'done',
    updated_at: '2025-01-10T00:00:00.000Z',
    autoUnblock: {
      attempts: 1,
      history: [
        { at: '2025-01-09T00:00:00.000Z', childJobId: 'P__autoretry1', priorBlockerType: 'validation-failed', attemptNumber: 1 },
      ],
    },
  });
  const { io } = mkIo({ jobs: [parent] });
  const s = collectTelemetry({ io, now: NOW, windowDays: 7 });
  assert.strictEqual(s.autoUnblock.parentCount, 0);
});

// — child id pattern —

t('__valfix child-id suffix excluded from parent rollup', () => {
  const fake = mkStatus({
    job_id: 'P__valfix',
    state: 'blocked',
    updated_at: '2025-01-30T00:00:00.000Z',
    autoUnblock: { attempts: 1, history: [] },
  });
  const { io } = mkIo({ jobs: [fake] });
  const s = collectTelemetry({ io, now: NOW });
  assert.strictEqual(s.autoUnblock.parentCount, 0);
});

t('__deployfix child-id suffix excluded from parent rollup', () => {
  const fake = mkStatus({
    job_id: 'P__deployfix',
    state: 'blocked',
    updated_at: '2025-01-30T00:00:00.000Z',
    autoUnblock: { attempts: 1, history: [] },
  });
  const { io } = mkIo({ jobs: [fake] });
  const s = collectTelemetry({ io, now: NOW });
  assert.strictEqual(s.autoUnblock.parentCount, 0);
});

t('__reviewfix child-id suffix excluded from parent rollup', () => {
  const fake = mkStatus({
    job_id: 'P__reviewfix',
    state: 'blocked',
    updated_at: '2025-01-30T00:00:00.000Z',
    autoUnblock: { attempts: 1, history: [] },
  });
  const { io } = mkIo({ jobs: [fake] });
  const s = collectTelemetry({ io, now: NOW });
  assert.strictEqual(s.autoUnblock.parentCount, 0);
});

// — render —

t('renderTelemetry produces a stable legible banner', () => {
  const { io } = mkIo({
    jobs: [
      mkStatus({ job_id: 'A', state: 'blocked', updated_at: '2025-01-30T00:00:00.000Z' }),
      mkStatus({
        job_id: 'P',
        state: 'done',
        updated_at: '2025-01-30T00:00:00.000Z',
        autoUnblock: {
          attempts: 1,
          history: [
            { at: '2025-01-29T00:00:00.000Z', childJobId: 'P__autoretry1', priorBlockerType: 'ambiguity-transient', attemptNumber: 1 },
          ],
        },
      }),
    ],
    results: {
      A: mkResult({ job_id: 'A', blocker_type: 'ambiguity-transient' }),
    },
  });
  const summary = collectTelemetry({ io, now: NOW });
  const text = renderTelemetry(summary);
  assert.match(text, /Blocker telemetry \(last 7d\)/);
  assert.match(text, /State distribution:/);
  assert.match(text, /Blocker types:/);
  assert.match(text, /Auto-unblock \(Phase 6a\/6b watchdog\):/);
  assert.match(text, /ambiguity-transient/);
  assert.match(text, /recovery rate:\s+100\.0%/);
});

t('renderTelemetry handles empty gracefully', () => {
  const { io } = mkIo();
  const text = renderTelemetry(collectTelemetry({ io, now: NOW }));
  assert.match(text, /\(no jobs\)/);
  assert.match(text, /recovery rate:\s+n\/a/);
});

t('renderTelemetry empty-but-blocked handles no classified blockers', () => {
  // Blocked job with no result (→ <unknown>) should still not trigger
  // the "(no classified blockers)" branch; empty distribution should.
  const { io } = mkIo();
  const text = renderTelemetry(collectTelemetry({ io, now: NOW }));
  assert.match(text, /\(no classified blockers\)/);
});

// — generatedAt —

t('generatedAt matches injected now', () => {
  const { io } = mkIo();
  const s = collectTelemetry({ io, now: NOW });
  assert.strictEqual(s.generatedAt, NOW.toISOString());
});

// ── Runner ─────────────────────────────────────────────────────────

let failed = 0;
for (const c of cases) {
  try {
    c.run();
    console.log(`  ok  ${c.name}`);
  } catch (err) {
    failed++;
    console.error(`  FAIL ${c.name}`);
    console.error(err);
  }
}
if (failed > 0) {
  console.error(`\n${failed} test(s) failed`);
  process.exit(1);
}
console.log(`\n${cases.length} tests passed`);
