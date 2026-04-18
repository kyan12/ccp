# Pre-worker planner (Phase 5b)

Before dispatching the main worker, CCP can run the resolved agent
through a short **planning-only** prompt and inject the resulting plan
into the worker's prompt. The planner pass is synchronous and lives
entirely on the supervisor host — its output ends up in
`jobs/<id>/plan.md` and between `--- BEGIN PLAN ---` / `--- END PLAN ---`
markers in the worker's prompt.

Think of it as "skim the ticket, write 10 lines of pseudo-code, hand
that to the actual implementer." The worker is free to deviate if the
plan is wrong once it reads the code — the plan is framed as a strong
suggestion, not a mandate.

## Why opt-in?

The planner costs one extra round-trip per dispatched job (~1 planning
prompt + 1 completion through whichever agent is resolved for that
repo). For repos where jobs are consistently simple or self-explanatory
the pass is wasted tokens. Operators should flip `planner.enabled: true`
per repo after measuring dispatch success on that repo.

## Enabling the planner

`configs/repos.json`:

```json
{
  "mappings": [
    {
      "key": "my-app",
      "localPath": "/home/user/repos/my-app",
      "planner": {
        "enabled": true,
        "timeoutSec": 300
      }
    }
  ]
}
```

- `enabled` — default `false`. When false or omitted, no planner pass
  is run and `buildPrompt` produces the exact same prompt as before
  Phase 5b.
- `timeoutSec` — default `300` (5 minutes). Non-finite / zero / negative
  values fall back to the default. The planner runs synchronously on
  the supervisor host, so a badly-sized timeout will stall the dispatch
  loop — keep it tight.

## Automatic skip conditions

Even when `enabled: true`, the planner is **automatically skipped** for:

1. **Remediation jobs** — `__valfix`, `__reviewfix`, `__deployfix`.
   These already have explicit failing-step or review-comment feedback;
   a planner pass would dilute that context.
2. **Continuation jobs** — `packet.working_branch` set. The agent is
   picking up mid-stream on a branch; re-planning is confusing.
3. **Repo without a mapping** — nowhere to read `planner.enabled` from.

Each skip is logged to `worker.log`, e.g.:

```
[2026-04-17T05:03:00.000Z] planner: skipped — remediation job — planner skipped (feedback already supplied)
```

Non-zero exit codes, empty stdout, timeouts, and spawn failures are
**also treated as skips** — the worker runs without a plan rather than
the entire job failing because of a flaky planning pass. The worker log
captures the reason so operators can notice and disable the planner on
repos where it isn't working.

## Prompt structure

The planner prompt asks for a structured, concise plan:

```
## Files to touch
- <path> — <why>

## Approach
<2-5 sentences>

## Tests
- <test case>

## Risks
- <risk or edge case>

## Confidence
<low|medium|high> — <1 sentence justification>
```

The worker then sees this structure verbatim in its own prompt, between
`--- BEGIN PLAN ---` / `--- END PLAN ---` markers, after the
repository-memory section and before the ticket goal. Byte cap is 16KB
(`MAX_PLAN_BYTES`) — anything longer is truncated with a visible marker.

## Agent selection

The planner uses the **same** resolved agent driver the worker will
run with. If a repo is configured for `codex` (or falls back to
`codex` via `agentFallback` due to a Claude outage), the planner will
also run against Codex. This keeps the plan's style and assumptions
consistent with the implementer.

## On-disk artifacts

Each planner pass writes two files into `jobs/<id>/`:

- `plan.prompt.txt` — the exact prompt sent to the planner (including
  any repository memory).
- `plan.md` — the plan captured from the agent's stdout, possibly
  truncated.

Both are persisted regardless of whether the planner succeeded, so
post-mortem triage on a weird plan is straightforward.

## Rollout recommendation

1. Leave `planner.enabled: false` on every repo to confirm the refactor
   is behavior-neutral (it should be — all injection paths are gated
   on the resolved config).
2. Flip `planner.enabled: true` on one low-stakes repo. Watch
   `worker.log` for `planner: ok` / `planner: skipped` lines and spot-
   check a few generated `plan.md` files for quality.
3. Only after that, roll out to more repos. If the plan quality is
   poor for a specific agent, disable the planner on repos using that
   agent rather than patching the prompt — prompt iteration is cheap
   once the plumbing is validated.
