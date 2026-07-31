# Preview-URL smoke modules (retired production path)

Native Hermes Kanban owns new PR verification and remediation. The bounded CCP
historical drain does not run smoke checks, apply smoke gates, write smoke
results, mutate job state, or create `__deployfix` work. No operator should
expect `smoke` configuration to affect the current PR watcher.

This document records the retained library surface for compatibility and tests.
It is not a production rollout guide.

## Production contract

The only live CCP PR watcher scope is the two named historical drain jobs. For
those jobs it may read GitHub status and merge its owned
`status.integrations.prReview` field. It must not:

- run HTTP, Playwright, or agent-browser smoke checks;
- write `result.smoke`, `status.integrations.smoke`, or top-level job state;
- create remediation jobs or push an existing PR branch;
- review, approve, merge, rebase, comment, call back, or notify Discord.

General PR verification and any follow-up work belong on native Hermes Kanban.

## Retained historical modules

The following modules remain because other code and regression tests still
exercise their pure/configuration behavior:

- `src/lib/smoke.ts`: HTTP smoke primitives and blocker formatting;
- `src/lib/playwright-smoke.ts` and the short-lived Playwright runner;
- `src/lib/agent-browser-smoke.ts`: optional agent-browser evidence capture;
- `src/lib/smoke-remediation.test.ts`: historical remediation contract tests.

Their presence does not make them reachable from the bounded PR watcher.

## Historical runner shapes

The retired implementation supported three runner values:

- `http`: bounded fetch with expected-status and optional title checks;
- `playwright`: isolated browser navigation with optional expression checks and
  failure screenshots;
- `agent-browser`: isolated CLI evidence capture such as screenshots,
  accessibility snapshots, console output, errors, HAR, and trace files.

The historical `SmokeResult.failure.kind` values are `timeout`, `network`,
`status`, `title`, `skipped`, and `unknown`. Browser dependencies remain
optional and are loaded only by their dedicated modules.

## Historical configuration reference

Repository mappings may still contain a `smoke` object with fields such as
`enabled`, `runner`, `path`, `expectStatus`, `titleRegex`, `timeoutSec`,
`userAgent`, `playwright`, `agentBrowser`, and `gate`. These fields are retained
for schema/backward compatibility. They are not consumed by the bounded drain.

In particular, `smoke.gate` must not be interpreted as permission for the
watcher to block a job, mutate a result, or enqueue remediation. Native Kanban
is the source of truth for current PR verification.

## Tests

The retained test suites cover runner parsing, timeout/error normalization,
configuration defaults, URL joining, title extraction, blocker formatting, and
artifact handling with injected/fake I/O. Retirement regressions separately
assert that the bounded watcher never calls these modules or writes their
outputs.

## Operational guidance

Do not enable or roll out CCP smoke configuration for new PRs. Put health checks,
browser verification, evidence, and remediation in the relevant native Hermes
Kanban task. Treat existing smoke fields and historical result records as
read-only compatibility data until a separate removal migration deletes the
retained modules and types.
