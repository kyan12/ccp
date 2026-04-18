# Per-agent cost accounting (Phase 6e)

Backend-only supervisor plumbing that captures token / cost usage
from the agent CLI's own self-report at finalize time, persists it
onto `status.usage` + `result.usage`, and rolls it up per-agent in
the `ccp-jobs telemetry` output.

No new state machine transitions, no new files, no new cron. The
data is derived on demand from existing `jobs/<id>/{status,result}.json`
records. Purely observational — this phase does NOT enforce budgets
or abort-on-overspend.

## What gets captured

`AgentDriver.parseUsage(ctx)` is called by `finalizeJob` after the
worker's log is read. Drivers return an `AgentUsage` sample or
`null`. Return values are persisted on BOTH:

- `status.usage` — so the supervisor's in-memory job list has cost
  without a result.json round-trip
- `result.usage` — the stable per-job record used by telemetry and
  any downstream consumer

Shape (see `src/lib/agents/types.ts`):

```ts
interface AgentUsage {
  agent: string;              // driver name ('claude-code', 'codex')
  model?: string | null;      // CLI-reported model id when available
  inputTokens?: number;
  outputTokens?: number;
  cachedInputTokens?: number; // cache-read hits
  cacheCreationTokens?: number;
  totalTokens?: number;
  costUsd?: number;           // absent for drivers that don't self-report USD
  capturedAt: string;         // ISO timestamp
  source?: string;            // e.g. 'claude-code:json', 'codex:turn.completed'
}
```

## Per-driver contracts

### Claude Code

`parseUsage` extracts the final `total_cost_usd` + `usage` block from
the worker log. Two shapes are supported:

- **Single JSON object** (`claude --print --output-format=json`) —
  the log is (or ends with) one JSON object carrying the session
  totals.
- **NDJSON stream** (`--output-format=stream-json`) — the last
  `{"type":"result", ...}` event wins. Intermediate
  `{"type":"assistant", ...}` events are ignored because
  `result.total_cost_usd` is cumulative.

**Claude's default text `--print` mode emits no usage data.** Jobs
run in that mode will have no `usage` field; the telemetry rollup
counts them in `jobCount` but excludes them from token / cost sums
and per-job averages.

To opt in, switch the worker command to `--output-format=json`:

```json
// configs/repos.json (per-repo)
{
  "agentArgs": ["--output-format=json"]
}
```

(Supervisor's buildCommand already forwards `agentArgs`; check your
repo mapping for the canonical key.)

### Codex (OpenAI `openai/codex` CLI)

`parseUsage` extracts the last `{"type":"turn.completed", ...}` or
rollout-file `token_count` event from the log. Both carry a
cumulative `{input_tokens, output_tokens, cached_input_tokens}`
block. **Codex does NOT self-report a dollar cost.** Downstream
consumers that want USD apply a pricing table to the persisted
token counts.

Fallback: if no JSONL events are found, the parser tolerates plain
text summaries like `tokens used: N in / M out (cached X)` produced
by wrapper scripts.

## Telemetry rollup

`TelemetrySummary.cost` (see `src/lib/telemetry.ts`):

```ts
interface CostTelemetry {
  jobsWithUsage: number;      // denominator for per-job averages
  totalTokens: number;        // window-wide sum
  totalCostUsd: number;       // window-wide sum (drivers with costUsd only)
  jobsWithCost: number;
  byAgent: AgentCostRow[];    // sorted desc by totalCostUsd then totalTokens
}

interface AgentCostRow {
  agent: string;
  jobCount: number;           // all jobs for this agent in the window
  jobsWithUsage: number;      // jobs where parseUsage returned a sample
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCachedInputTokens: number;
  totalTokens: number;
  totalCostUsd: number;
  jobsWithCost: number;
  avgCostPerJob: number | null;  // null when no jobs in bucket reported cost
}
```

Window defaults to the same 7-day rolling window as Phase 6d blocker
telemetry (`--days N` to override). Aggregation is point-in-time and
re-derived on every invocation — no persistent state.

## CLI

```
ccp-jobs telemetry             # human-readable banner
ccp-jobs telemetry --json      # raw TelemetrySummary JSON
ccp-jobs telemetry --days 14   # wider rolling window
```

The human banner adds a `Cost (Phase 6e per-agent accounting):`
section with the `byAgent` table. Example:

```
Cost (Phase 6e per-agent accounting):
  jobs with usage:   18 / 24
  total tokens:      1,243,567
  jobs with cost:    12
  total cost:        $1.2430
  by agent:
    claude-code      jobs=14 withUsage=12 in=120000 out=45000 cache=900000 total=1065000 cost=$1.2430 avg/job=$0.1036
    codex            jobs=10 withUsage=6  in=80000  out=15000 cache=0      total=95000   cost=$0.0000 avg/job=n/a
```

## worker.log marker

When `parseUsage` returns a hit, `finalizeJob` writes a single
`agent usage: …` line to `worker.log` so operators can grep spend
without shelling out to the telemetry CLI:

```
[2026-04-17T05:00:00.000Z] agent usage: agent=claude-code model=claude-sonnet-4-5 in=1250 out=780 cache_read=14000 cache_write=200 total=16230 cost=$0.0432 source=claude-code:json
```

## Safety rails

- `parseUsage` is contractually **total** — it never throws and
  never blocks finalize. A driver bug that threw would be caught
  by the `try/catch` wrapper in `finalizeJob` and logged as
  `parseUsage threw (non-fatal): …`.
- A `null` return leaves the job without a `usage` field. The
  telemetry rollup skips such jobs from sums + averages (but still
  counts them in `jobCount` so operators can see the denominator).
- Corrupt JSON inside the log is swallowed — the parser falls back
  through the next shape (NDJSON → single object → text summary)
  and ultimately returns `null` rather than throwing.
- Out-of-window jobs are filtered by lexical ISO-8601 compare on
  `status.updated_at`, same as Phase 6d — one bad date on disk
  can't skew the aggregate.

## Not in scope

- No per-model granularity (deferred to follow-up). Model is
  persisted on `AgentUsage.model` for future use.
- No per-repo or per-ticket breakdown (per-agent + per-job only).
- No in-flight budget caps or abort-on-overspend (measurement only).
- No HTTP dashboard endpoint (CLI + JSON only; the dashboard reads
  the same status.json files).
