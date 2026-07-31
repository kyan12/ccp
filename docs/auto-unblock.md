# Auto-unblock watchdog (legacy compatibility path)

Native Hermes Kanban owns current engineering follow-up and remediation. The CCP
auto-unblock module is a default-off compatibility mechanism for legacy,
non-PR blocked jobs; it is not part of the bounded GitHub drain and must not be
enabled as a PR remediation path.

No current repository mapping opts into `autoUnblock`. Operators should keep it
disabled for PR-backed work.

## Production contract

The bounded PR watcher may only read GitHub status for the two named historical
jobs and merge `status.integrations.prReview`. It never invokes auto-unblock,
creates retry/remediation children, changes top-level state, writes result data,
or pushes a PR branch.

General validation and PR failures record blocker evidence only. Native Hermes
Kanban decides and tracks any follow-up task.

## Retained module behavior

`src/lib/auto-unblock.ts` remains for compatibility with historical local jobs.
When explicitly enabled for a legacy non-PR mapping, it scans blocked jobs,
applies a cooldown and retry cap, and may create a `__autoretry<N>` child while
updating `status.autoUnblock` bookkeeping. The feature defaults off per repo and
has a global `CCP_AUTO_UNBLOCK_ENABLED=false` kill switch.

The legacy suffixes `__valfix`, `__deployfix`, and `__reviewfix` remain in depth
guards and telemetry so old job records are recognized safely. Their presence
is not evidence that current finalization produces those children; the general
validation/PR producers are retired.

## Eligibility and safety rails

For a compatibility-only retry, all of these must hold:

- the global kill switch permits the module;
- an explicitly non-PR legacy mapping sets `autoUnblock.enabled: true`;
- the parent is blocked and has an eligible classified blocker;
- the cooldown elapsed and retry count is below `maxRetries`;
- the job id is not already a remediation/retry child.

The implementation remains bounded and idempotent: child ids are deterministic,
retry counts are capped, malformed state is skipped, and failures in the
watchdog are isolated from supervisor dispatch.

## Configuration retained for compatibility

Historical mappings may contain:

```jsonc
{
  "autoUnblock": {
    "enabled": false,
    "retryAfterSec": 600,
    "maxRetries": 2,
    "eligibleTypes": [
      "validation-failed",
      "smoke-failed",
      "pr-check-failed",
      "ambiguity-transient"
    ],
    "usePlannerRefresh": false
  }
}
```

Do not turn this on for PR-backed work. Create or continue a native Kanban task
instead. The compatibility configuration remains documented only so old records
and tests are understandable until a dedicated deletion migration removes the
module.

## Legacy observability

Historical status files can contain `status.autoUnblock` attempt history, and
telemetry may count old `__autoretry`, `__valfix`, `__deployfix`, or
`__reviewfix` ids. These are read-only compatibility signals. They must not be
used to infer that CCP still owns current PR remediation.

## Ambiguity classification

The retained blocker classifier distinguishes operator input from transient
noise. `ambiguity-operator` is never retry-eligible; `ambiguity-transient` may be
eligible only inside the explicitly enabled non-PR compatibility path. Unknown
legacy ambiguity defaults conservatively to operator input.

## Operational guidance

For any current PR, validation, smoke, review, or check failure:

1. leave the CCP blocker evidence unchanged;
2. create or update the native Hermes Kanban task;
3. perform and review remediation through that task;
4. never use CCP auto-unblock to push the existing PR branch.
