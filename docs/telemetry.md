# Blocker telemetry

**Phase 6d.** Point-in-time snapshot of how the supervisor is actually
performing, derived from existing per-job JSON artifacts. Answers:

- Which `blocker_type` is driving the bulk of stuck work right now?
- What fraction of Phase 6a watchdog auto-retries actually recover vs.
  churn and re-block?
- How many attempts is the average job burning before recovery or
  exhaustion?

No new persistence is introduced — each invocation re-derives the
snapshot from `jobs/<id>/status.json` and `jobs/<id>/result.json`, so
there is no stale cache to worry about and no new state file to
corrupt.

## CLI

```bash
# Human-readable table, default 7-day rolling window:
ccp-jobs telemetry

# Custom window:
ccp-jobs telemetry --days 30

# JSON (for piping to jq / dashboards / cron-log collectors):
ccp-jobs telemetry --json
ccp-jobs telemetry --days 1 --json | jq '.autoUnblock.recoveryRate'
```

### Example output

```
Blocker telemetry (last 7d)
  window: 2026-04-10T19:37:00.000Z → 2026-04-17T19:37:00.000Z
  jobs in window: 42

State distribution:
  done             18
  verified         12
  blocked           8
  running           4

Blocker types:
  currently blocked: 8
  classified total:  10
  ambiguity-transient       4
  validation-failed         3
  smoke-failed              2
  ambiguity-operator        1

Auto-unblock (Phase 6a/6b watchdog):
  parents with retries: 9
  total attempts:       14
  recovered:            6
  still blocked:        2 (1 exhausted)
  pending:              1
  recovery rate:        66.7%
  attempt stats:
    avg=1.56  p50=1  p95=3  max=3
  by prior blocker_type:
    ambiguity-transient       attempted=7 recovered=3 stillBlocked=0 rate=75.0%
    validation-failed         attempted=5 recovered=1 stillBlocked=2 rate=33.3%
    smoke-failed              attempted=2 recovered=2 stillBlocked=0 rate=100.0%
```

## JSON schema

```ts
interface TelemetrySummary {
  generatedAt: string;         // ISO — when the snapshot was computed
  window: { from: string; to: string; days: number };
  totalJobs: number;           // jobs whose updated_at is in [from, to]
  byState: Record<string, number>;
  blockers: {
    blockedTotal: number;      // state === 'blocked' right now
    classifiedTotal: number;   // result.blocker_type ≠ null && ≠ 'none'
    byType: { type: string; count: number }[];  // desc by count, asc by type
  };
  autoUnblock: {
    parentCount: number;       // parents with at least one attempt
    attempted: number;         // sum of autoUnblock.attempts
    recovered: number;         // parent.state ∈ {done, verified} OR last child recovered
    stillBlocked: number;      // parent.state === 'blocked'
    exhausted: number;         // subset of stillBlocked whose watchdog hit maxRetries
    pending: number;           // parent in any other state (running, queued, etc.)
    recoveryRate: number | null;  // recovered / parentCount, null when parentCount === 0
    byPriorBlockerType: {
      priorBlockerType: string;
      attempted: number;
      recovered: number;
      stillBlocked: number;
      pending: number;
      // recovered / (recovered + stillBlocked + pending) — i.e. share of
      // parents in this bucket that recovered. Null when the bucket has
      // no parents. Uses parent count (not attempt count) as the
      // denominator, consistent with the top-level recoveryRate.
      recoveryRate: number | null;
    }[];
    attemptStats: {
      parentCount: number;
      totalAttempts: number;
      avgAttempts: number;
      p50Attempts: number;     // nearest-rank method
      p95Attempts: number;
      maxAttempts: number;
    };
  };
}
```

## Semantics

### Window

The window is `[now - days, now]` based on `status.updated_at` (lexical
ISO-8601 compare — fast and stable). Jobs whose `updated_at` falls
outside the window are ignored end-to-end: they don't contribute to
`totalJobs`, `byState`, `blockers`, or `autoUnblock`.

Default window is 7 days. Pass `--days N` to override (integer, positive).

### Blocker distribution

`blockedTotal` is the number of jobs currently in `state === 'blocked'`.

`classifiedTotal` counts every job in the window whose
`result.blocker_type` is a non-null, non-`'none'` string — which
includes jobs that have moved out of `blocked` but still carry the
bucket on their result (e.g. a `done` job whose last attempt recorded
a `smoke-failed` blocker). Operators use this to spot jobs that
"escaped" the blocker state without actually resolving the underlying
issue.

Jobs in `blocked` with no classified type (missing `result.json`, or
`blocker_type === 'none'`) fall into the `<unknown>` bucket so they
still show up in the distribution. Once Phase 6b's classifier is fully
wired you should see this bucket drain over time; legacy jobs from
earlier phases may linger indefinitely.

### Auto-unblock (Phase 6a/6b watchdog)

A **parent** is any job whose id does NOT match
`__(valfix|deployfix|reviewfix|autoretry\d*)` AND whose
`status.autoUnblock.attempts` is a positive number.

Each parent is bucketed by current state:

- **recovered** — parent's current `state` is `done` or `verified`, OR
  the parent is still `blocked` but its most recent auto-retry child
  (`autoUnblock.history[last].childJobId`) has already landed `done` /
  `verified`. The second case credits the watchdog during the cycle
  before the supervisor reconciles the parent state, so the recovery
  rate doesn't lag behind reality.
- **blocked** — parent's current `state` is `blocked` and no recent
  child has recovered.
  - **exhausted** is the subset where `autoUnblock.exhausted === true`
    (watchdog hit `maxRetries` and gave up).
- **pending** — parent is in any other state (e.g. `running`, `queued`,
  `cleaned`). Tracked separately so ratios don't drift while a retry
  is mid-flight.

`byPriorBlockerType` rolls the same buckets by the most recent
`autoUnblock.history[].priorBlockerType` on each parent. Reading this
table is how you decide whether to add a type to `autoUnblock.eligibleTypes`:
if `validation-failed` has a 20 % recovery rate but `ambiguity-transient`
has 85 %, the watchdog is paying its way on transient noise and losing
money on deep validation failures.

### Attempt stats

`attemptStats` reports the distribution of per-parent retry counts
(not per-child, not per-attempt). `p50` / `p95` use the nearest-rank
method — simple, stable, and accurate enough for the small N (< 1000)
this supervisor will ever see in practice. `maxAttempts` is capped by
the per-repo `autoUnblock.maxRetries` setting (default `2`, so a
parent tops out at 2).

### Robustness

- Malformed `result.json` / `status.json` files are silently treated
  as missing — one corrupt job never poisons the whole summary.
- `listJobs()` throwing (e.g. the jobs directory was deleted mid-scan)
  returns an empty summary instead of crashing.
- Non-string `state` / missing `updated_at` / `state === ''` fall back
  to `<unknown>` / filtered out so the aggregator stays total.

## Operator workflow

1. Run `ccp-jobs telemetry --days 7` at the end of a working week to
   see where the supervisor is spending its retries.
2. If a specific `priorBlockerType` shows a persistently low recovery
   rate (< 25 %), drop it from `autoUnblock.eligibleTypes` for affected
   repos — the retries are burning tokens without helping.
3. If a blocker type shows up in `classifiedTotal` but never in
   `blockedTotal`, your jobs are quietly escaping the blocker state
   with a stale classification. Inspect the jobs whose
   `state !== 'blocked'` but `result.blocker_type` is set via
   `ccp-jobs list | jq '.[] | select(.state != "blocked") | .job_id'`
   and work backwards to see what transition missed clearing the bucket.
4. Cron the JSON form (`ccp-jobs telemetry --json`) into an external
   store (S3, Grafana, etc.) if you want time-series instead of
   point-in-time — the file shape is stable and append-safe.

## Not in scope (deferred)

- **Per-agent breakdown** (Claude vs Codex). Punted to a separate
  Phase-1 PR so telemetry stays agent-agnostic.
- **Alerts / thresholds**. The command prints raw numbers; external
  systems decide what "bad" means.
- **Time-series persistence**. Derive on demand; cron the JSON form
  if you want a historical series.
- **Dashboard HTTP endpoint**. Would be a 10-line follow-up that
  wraps `buildTelemetryIo() + collectTelemetry()`; opt in when the
  first consumer lands.
