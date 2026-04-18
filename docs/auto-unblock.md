# Auto-unblock watchdog (Phase 6a)

Jobs that land in `blocked` historically recover only via operator action
(Discord `/ccp retry`, dashboard retry, manual edit) or a single one-shot
remediation spawn (`__valfix` / `__deployfix` / `__reviewfix`) that runs
immediately at finalize time and gives up if it too lands in `blocked`.

The **auto-unblock watchdog** adds a bounded, configurable second-chance
loop: every supervisor cycle, scan blocked jobs, and for those with a
retry-eligible `blocker_type` whose cool-down has elapsed, spawn a
`__autoretry<N>` child on the same PR branch with a refined prompt.

## When it runs

- **Trigger**: runs on every `runSupervisorCycle()` invocation, right
  after the outage probe and before new-job dispatch. Scheduling /
  outage gates do NOT block the watchdog — spawning a queued job is
  cheap, and the dispatch gate will still decide when it actually
  executes.
- **Scope**: jobs in `blocked` state only. Running / queued / failed
  / coded / done / verified jobs are untouched.
- **Cadence**: tied to the supervisor poll interval (default 15s).
  Cool-downs are measured in wall-clock seconds against the parent
  status's `updated_at` (first attempt) or the prior attempt's
  `lastAttemptAt`, not against cycle count.

## Eligibility

A blocked job is retried only when **all** of the following are true:

| Gate | Check |
|------|-------|
| Global kill-switch | `CCP_AUTO_UNBLOCK_ENABLED !== 'false'` (unset or any non-`false` value allows) |
| Per-repo enabled | `mapping.autoUnblock.enabled === true` |
| State is blocked | `status.state === 'blocked'` |
| Not a remediation child | job id does NOT match `/__valfix\|__deployfix\|__reviewfix\|__autoretry/` |
| Has a classified blocker | `result.blocker_type` is set |
| Blocker type is eligible | `blocker_type` ∈ `mapping.autoUnblock.eligibleTypes` |
| Cool-down elapsed | `now - max(lastAttemptAt, status.updated_at) ≥ retryAfterSec` |
| Under retry cap | `status.autoUnblock.attempts < maxRetries` |

The depth guard is critical: failing `__valfix` / `__deployfix` /
`__reviewfix` jobs are themselves the one-shot remediation, and the
signal of a *repeatedly* failing remediation is "human needed", not
"try again". Similarly, a `__autoretry1` child that fails does NOT
spawn a `__autoretry1__autoretry1` — only the **parent** job accrues
watchdog attempts.

## Refined prompt

The child packet inherits the parent's goal, acceptance criteria,
verification steps, and working branch, then appends a retry footer
to `review_feedback` with:

- the retry attempt number (`1/2`, `2/2`)
- the prior `blocker_type`
- a clipped copy of the prior `blocker` detail (≤2 KB so a noisy stderr
  tail doesn't crowd the prompt)
- the prior `failed_checks` list (name + state + URL if present)
- explicit instructions: treat this as a second chance, fix on the
  existing branch, do not open a new PR, and leave a precise blocker
  note if the same symptom reproduces

`reviewComments` is **explicitly cleared** on the child packet —
otherwise `buildPrompt` would instruct the agent to also address PR
review threads that don't exist on a retry task. Acceptance criteria
get one extra line ("Resolve the prior \"<blocker_type>\" blocker; do
not create a new PR."), and verification steps get "Re-run the check
that originally failed before declaring done."

## Safety rails

1. **Bounded depth**: the remediation/retry suffix regex includes
   `__autoretry`, so none of `maybeEnqueueValidationRemediation`,
   `maybeEnqueueSmokeRemediation`, or `maybeEnqueueReviewRemediation`
   cascades from a watchdog retry. The watchdog ALSO refuses to retry
   any job whose id matches that pattern, so the one-shot remediations
   don't double-fire via the watchdog.
2. **Bounded count**: `maxRetries` (default 2) limits total watchdog
   spawns per parent to 2, i.e. 3 total attempts including the original
   worker run. Once `attempts === maxRetries`, the job stays `blocked`
   and the watchdog stops touching it.
3. **Idempotent spawn**: if a target child id (`<parent>__autoretryN`)
   already exists on disk, the watchdog skips `createJob` but still
   advances the parent's `autoUnblock.attempts` counter, so a
   supervisor crash between spawn and state-save doesn't trap the job
   in a retry loop.
4. **Error isolation**: `tickAutoUnblock()` is wrapped in try/catch in
   `runSupervisorCycle()`. A bug in the watchdog never blocks dispatch
   — errors are collected into `summary.autoUnblock.errors` and visible
   in the cycle snapshot.
5. **No cascade from PR checks**: `pr-check-failed` is eligible on the
   original parent, but its `__autoretry1` child is blocked from
   spawning another retry by the depth guard even if it also
   produces `pr-check-failed`.

## Notifications

- On each **spawn**, the watchdog appends a line to the parent's
  `worker.log`:
  `auto-unblock queued JOB-123__autoretry1 (attempt 1/2, blocker_type=validation-failed)`
- On **exhaustion transition** (attempts == maxRetries, first time
  seen), the watchdog sends ONE Discord message to the errors channel
  and sets `status.autoUnblock.exhausted = true`. Subsequent cycles see
  the flag and do not re-notify. This prevents the errors channel from
  being spammed every 15s with the same job.
- The cycle summary's `autoUnblock` field enumerates every scanned,
  retried, and skipped job with the skip reason, and every recorded
  error. Operators can inspect this via `ccp-jobs cycle --verbose`.

## Configuration

Per repo in `configs/repos.json`:

```jsonc
{
  "autoUnblock": {
    "enabled": false,                // flip to true to opt in
    "retryAfterSec": 600,            // 10 min cool-down; tune higher
                                     // for repos where the one-shot
                                     // remediation is slow to finish
    "maxRetries": 2,                 // 3 total attempts per parent
    "eligibleTypes": [               // which blocker_type values are
      "validation-failed",           // auto-retried. See the Phase 6b
      "smoke-failed",                // "Ambiguity split" section for
      "pr-check-failed",             // why `ambiguity-transient` is in
      "ambiguity-transient"          // and `ambiguity-operator` is not.
    ],                               // Also excludes "agent-outage"/
                                     // "rate-limited" (outage circuit
                                     // owns those).
    "usePlannerRefresh": false       // advisory metadata for jobs.ts;
                                     // when true AND Phase 5b planner
                                     // is enabled for the repo, the
                                     // retry triggers a fresh planner
                                     // pass with the blocker context.
  }
}
```

Global override: `CCP_AUTO_UNBLOCK_ENABLED=false` disables the watchdog
fleet-wide without touching any repo mapping. Any other value
(unset, `true`, `0`, anything) defers to per-repo `enabled`.

## Operator workflows

### Enable per-repo

1. Edit `configs/repos.json` for the target repo and set
   `autoUnblock.enabled: true`.
2. Tune `retryAfterSec` / `maxRetries` if the default 10-min / 2-retry
   shape isn't right for your build cadence.
3. Reload the supervisor (`launchctl kickstart -k gui/$(id -u)/ai.openclaw.coding-control-plane`)
   or wait for the config watcher.

### Disable fleet-wide (incident response)

Set `CCP_AUTO_UNBLOCK_ENABLED=false` in the supervisor's environment
and reload. Existing `__autoretry<N>` children that are already queued
will still run — the kill-switch only prevents NEW spawns.

### Inspect watchdog state for a single job

```bash
cat $CCP_ROOT/jobs/<JOB_ID>/status.json | jq .autoUnblock
# {
#   "attempts": 1,
#   "lastAttemptAt": "2025-05-01T12:00:00.000Z",
#   "history": [
#     {
#       "at": "2025-05-01T12:00:00.000Z",
#       "childJobId": "JOB-123__autoretry1",
#       "priorBlockerType": "validation-failed",
#       "priorBlockerDetail": "typecheck failed: error TS2345",
#       "attemptNumber": 1
#     }
#   ]
# }
```

### Inspect watchdog activity across the last cycle

```bash
ccp-jobs cycle --verbose | jq .autoUnblock
# {
#   "scanned": 5,
#   "retried": [
#     { "parent": "JOB-123", "child": "JOB-123__autoretry1", "attempt": 1, "blockerType": "validation-failed" }
#   ],
#   "skipped": [
#     { "job_id": "JOB-99__valfix", "reason": "depth guard: …" },
#     { "job_id": "JOB-201", "reason": "cool-down: blocked for 300s, need 600s" }
#   ],
#   "errors": []
# }
```

### Force-stop auto-unblock for one job

The cleanest way is to move the job out of `blocked` manually (e.g.
mark `failed` via `ccp-jobs mark <id> failed`), or add an exhaustion
flag:

```bash
jq '.autoUnblock = (.autoUnblock // {attempts: 0}) + {attempts: 99, exhausted: true}' \
   $CCP_ROOT/jobs/<JOB_ID>/status.json > /tmp/s && \
   mv /tmp/s $CCP_ROOT/jobs/<JOB_ID>/status.json
```

The watchdog will see `attempts >= maxRetries` and skip with reason
`max retries reached`, and won't re-fire the exhausted notification
because `exhausted: true` is already set.

## Relationship to one-shot remediations

Watchdog retries are a **fallback**, not a replacement, for the
existing remediation spawns. The event flow for a flaky validation
failure is:

1. Worker finishes → `finalizeJob` → validation fails → job transitions
   to `blocked (validation-failed)` → `maybeEnqueueValidationRemediation`
   spawns `__valfix` child immediately.
2. If `__valfix` succeeds → PR lands, job chain completes.
3. If `__valfix` itself fails and lands in `blocked (validation-failed)`,
   the watchdog **skips** it (depth guard).
4. The **parent** job is still blocked. After `retryAfterSec` elapses,
   the watchdog spawns `<parent>__autoretry1` with the refined prompt.
5. If that also fails in `blocked`, after another `retryAfterSec` the
   watchdog spawns `__autoretry2`.
6. After `__autoretry2` (or whatever hits `maxRetries`), the watchdog
   gives up, flips `exhausted: true`, and pings Discord exactly once.

This keeps the cost bounded (≤ maxRetries + 1 extra worker runs per
genuinely stuck job) while recovering from the flaky middle — "the
staging deploy hadn't finished", "the test suite happened to catch a
transient DB state", "the pull request CI hadn't propagated yet".

## Ambiguity split (Phase 6b)

The original ambiguity bucket was a catch-all for "worker gave up for a
reason that isn't validation/smoke/pr-check". In practice that bucket
lumped together two very different signals:

1. **Operator input required** — the worker asked a human for a design
   decision, credential, clarification on an acceptance criterion, or
   similar. Retrying the same prompt without answering the question
   burns tokens and may push a low-quality guess.
2. **Transient environmental noise** — a rate-limited API call, a
   network hiccup, a git lock held by another process, a 503 from a
   third-party, a preview deploy that hadn't finished propagating.
   Re-running the same prompt a few minutes later almost always
   succeeds.

Phase 6b splits them at finalize time via
[`src/lib/blocker-classifier.ts`](../src/lib/blocker-classifier.ts).
When `finalizeJob` lands in `blocked` and no more-specific gate
(validation / smoke / pr-review) has already set a `blocker_type`, the
classifier scans the resolved blocker text:

| Classifier output     | Meaning                                          | Watchdog-eligible? |
|-----------------------|--------------------------------------------------|--------------------|
| `ambiguity-operator`  | Operator phrase matched (e.g. "please clarify", "missing API key", "HTTP 401", "waiting for input") | **No** — needs a human |
| `ambiguity-transient` | Transient phrase matched (e.g. "rate limit", "ETIMEDOUT", "HTTP 503", "index.lock", "too many requests") | **Yes** — watchdog retries |
| _uncertain_           | Neither pattern matched                           | **No** — safely defaults to `ambiguity-operator` |

**Tie-breaker**: if BOTH an operator phrase AND a transient phrase are
present in the same blocker text, operator wins. Better to bother the
human than silently retry on a real question.

The default `eligibleTypes` list therefore includes
`ambiguity-transient`. `ambiguity-operator` is NOT in the default list
and should never be — by definition the worker needs a human to answer
something, and an auto-retry cannot produce that answer.

### Back-compat

Older result.json files whose `blocker_type` is literal `'ambiguity'`
(no suffix) are treated as operator-ambiguity by the watchdog
(conservative — they predate the split and nobody can retro-actively
reclassify the underlying text). New blocked jobs finalize with a
specific suffix. Operators don't need to do anything to migrate.

### Tuning the classifier

The pattern list is in `src/lib/blocker-classifier.ts` and is covered
by hermetic unit tests in `src/lib/blocker-classifier.test.ts`. If a
blocker repeatedly misclassifies (e.g. a new provider's rate-limit
message isn't caught), add the regex to `TRANSIENT_PATTERNS` or
`OPERATOR_PATTERNS` and a matching test case to the fixtures. The
classifier is pure, synchronous, and has no external dependencies.
