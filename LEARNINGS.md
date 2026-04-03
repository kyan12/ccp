# CCP Learnings

Operational insights from nightly reviews. Each entry includes the date, what was found, and the action taken.

## 2026-03-26 — Nightly Review

### Bug Fixed: Overly broad regex in outage detection

The `API_ERROR_PATTERNS` in `outage.ts` used `/529/` (no word boundaries) to detect
Anthropic 529 errors. This matched any occurrence of "529" in worker logs — including
timestamps (e.g. "15:29"), line numbers, port numbers, etc. A false positive triggers
outage mode, which **pauses all job dispatch** until a probe succeeds.

**Fix:** Changed to `/\b529\b/` (word boundary) so only standalone "529" tokens match.
Also fixed `/API Error: 5\d\d /i` (trailing space) → `/API Error: 5\d\d\b/i` (word
boundary) so the pattern matches API errors at end-of-line.

### Patterns Worth Reinforcing

- **Per-repo concurrency** (d17827f): Prevents two workers from stomping on the same
  repo checkout. Well-implemented via `busyRepos` set in `runSupervisorCycle`.
- **Worker starts from fresh main** (939bffa): `git reset --hard origin/main` before
  each worker prevents stale branch cascading failures.
- **Rate limit auto-pause** (08e06c2): Parses human-readable reset times from Claude
  rate limit messages and pauses dispatch automatically. Reduces wasted API calls.
- **Auto-onboarding** (426d945): Unknown repos referenced in intake get auto-cloned
  and registered. Reduces manual config overhead.

### Code Health Observations (resolved 2026-03-28)

- ~~`prReviewPolicy()` duplicated in `jobs.ts` and `pr-watcher.ts`~~ → extracted to `pr-policy.ts`
- ~~Webhook callback logic duplicated between `finalizeJob()` and `runPrWatcherCycle()`~~ → extracted to `webhook-callback.ts`
- ~~`scheduling.ts` reads `outage.json` directly~~ → now uses `getOutageStatus()` from `outage.ts`

## 2026-03-28 — Nightly Review

### Refactor: Extract shared PR policy and webhook callback modules

Three code health issues from the previous review were resolved:

1. **`prReviewPolicy()` extracted to `pr-policy.ts`** — Was duplicated identically in `jobs.ts`
   and `pr-watcher.ts`. Now both import from a single source of truth. Prevents policy drift.

2. **Webhook callback extracted to `webhook-callback.ts`** — HMAC signing + HTTP POST logic was
   duplicated between `finalizeJob()` in `jobs.ts` and `runPrWatcherCycle()` in `pr-watcher.ts`.
   Shared module handles metadata extraction (including nested metadata), HMAC signing, and HTTP
   dispatch. Both callers now use `fireWebhookCallback()`.

3. **`scheduling.ts` now uses `getOutageStatus()`** — Was reading `configs/outage.json` directly
   from disk, bypassing the `outage.ts` module. Now uses the canonical `getOutageStatus()` function,
   ensuring consistent state parsing and reducing coupling to file format.

### Patterns Worth Reinforcing

- **Human-input routing** (03e6e0c): Jobs that need human input are routed to `#human-tasks`
  instead of `#coding-errors`. Good separation of concerns — operator attention goes to the
  right channel.
- **Non-interactive constraints** (c2e25dd): Worker prompt explicitly states it's running
  non-interactively, preventing the agent from asking clarifying questions that no one will answer.

## 2026-03-29 — Nightly Review

### Bug Fixed: Unhandled JSON.parse in config.ts

`readJsonIfExists` in `config.ts` called `JSON.parse` without error handling. A corrupted
config file (partial write, manual edit mistake, disk issue) would throw an unhandled exception,
crashing the entire supervisor or intake server. Since `loadConfig` chains
`primary || example || fallback`, the correct behavior on parse failure is to return null and
fall through to the next source — which is what the fix does.

### Code Health Observations

- **Webhook callback fire-and-forget** (`webhook-callback.ts`): `fireWebhookCallback` uses
  `http.request` without awaiting the response or handling `error` events on the request object.
  The try-catch only catches synchronous errors (e.g. invalid URL), not network failures.
  The `whReq.on('error', ...)` handler is missing.
- **Advisory lock in `saveStatus`** (`jobs.ts:118-152`): Lock file uses a sleep-polling loop
  with `spawnSync('sleep', ['0.05'])` and proceeds anyway on timeout. This is advisory at best.
  Consider atomic rename pattern for safer concurrent writes.
- **Silent catch blocks** (`jobs.ts:126,133,150`): Three `catch (_) {}` blocks swallow errors
  during lock file operations. Should log to stderr for debuggability.

### Patterns Worth Reinforcing

- **Refactor follow-through** (87d3172): Previous nightly identified three duplication issues;
  the next review resolved all three. Good cadence of identify → fix → verify.
- **Test coverage expanding** (jobs.test.ts): Tests now cover non-interactive constraints,
  ambiguous ticket handling, and blocker scenarios. Coverage is growing with each feature.

## 2026-03-30 — Nightly Review

### Bug Fixed: Webhook callback missing error handler + silent catch blocks

Two code health issues from the 2026-03-29 review were resolved:

1. **`fireWebhookCallback` missing `whReq.on('error', ...)`** — Node.js `http.request` emits
   an `error` event on network failures (DNS resolution, connection refused, timeout). Without
   a handler, this becomes an unhandled `error` event that crashes the process. Added an error
   handler that logs to stderr. The function remains fire-and-forget by design, but network
   errors are now visible in logs instead of crashing the supervisor.

2. **Silent `catch (_) {}` blocks in `saveStatus`** — Three catch blocks in the advisory lock
   logic swallowed all errors silently, making lock contention or filesystem issues invisible.
   Added `console.error` logging to all three: stale lock removal, lock acquisition contention,
   and lock release. Errors are now debuggable in production logs.

### Code Health Observations

- **Advisory lock pattern** (`jobs.ts:118-152`): The sleep-polling advisory lock still proceeds
  on timeout. An atomic rename pattern (write to temp, rename over target) would be safer for
  concurrent writes. Lower priority since CCP typically runs single-instance.
- **No tests for webhook callback** (`webhook-callback.ts`): The module has no test file.
  Adding tests for error handling, HMAC signing, and nested metadata extraction would prevent
  regressions.

### Patterns Worth Reinforcing

- **Nightly review cadence**: Three consecutive reviews (3/26, 3/28, 3/29, 3/30) each identified
  issues and the following review resolved them. The identify → fix → verify loop is working well.
- **Graceful degradation** (52691ec): Corrupted JSON config files now return null and fall through
  to the next config source, rather than crashing. Good resilience pattern.

## 2026-03-31 — Nightly Review

### Bug Fixed: Unguarded JSON.parse in supervisor-critical paths

The corrupted JSON fix from 52691ec (config.ts) was not applied to other state/cache files.
Three locations used `JSON.parse(fs.readFileSync(...))` without error handling, meaning a
single corrupted file would crash the entire supervisor process:

1. **`linear.ts:readLinks()`** — Corrupted `job-links.json` crashes supervisor on any
   Linear sync attempt. Fixed: returns `{}` on parse error (links are a cache, not source
   of truth).

2. **`linear-dispatch.ts:readState()`** — Corrupted `state.json` crashes Linear dispatch.
   Fixed: returns default empty state on parse error (worst case: re-dispatches an already-
   dispatched issue, which is idempotent).

3. **`jobs.ts:runSupervisorCycle()`** — Two unprotected `readJson(packetPath(...))` calls
   in the supervisor cycle. A single corrupted job packet crashes the entire cycle, preventing
   all other jobs from being dispatched. Fixed: wrapped in try/catch so a corrupted job is
   skipped with an error log, and remaining jobs continue processing.

### Code Health Observations

- **Advisory lock pattern** (`jobs.ts:118-152`): Still uses sleep-polling advisory lock.
  Lower priority since CCP typically runs single-instance.
- **No tests for webhook callback** (`webhook-callback.ts`): Still no test file. Tests for
  HMAC signing and nested metadata extraction would prevent regressions.
- **Duplicated `lifecycleMap`** (`linear.ts`): The job-state-to-Linear-state mapping is
  defined identically in both `syncJobToLinear` (line 403) and `syncLinearIssueState`
  (line 478). Should be extracted to a module-level constant.

### Patterns Worth Reinforcing

- **Consistent error handling pattern**: `config.ts`, `outage.ts`, and `scheduling.ts` all
  use try/catch with `console.error` + fallback return. This is now the established pattern
  for all state file reads in CCP.

## 2026-04-01 — Nightly Review

### Refactor: Extract duplicated `lifecycleMap` to module-level constant

The `lifecycleMap` object (maps CCP job states like `queued`/`running`/`coded` to Linear
workflow state categories like `in_progress`/`in_review`/`done`) was defined identically in
both `syncJobToLinear` (line ~408) and `syncLinearIssueState` (line ~483). If one copy were
updated without the other, jobs would transition to incorrect Linear states silently.

**Fix:** Extracted to a module-level `JOB_TO_LINEAR_STATE` constant. Both functions now
reference the single source of truth.

### Tests: webhook-callback.ts coverage

Added `webhook-callback.test.ts` with 14 tests covering:
- `extractWebhookMeta`: null metadata, top-level extraction, nested metadata extraction,
  top-level precedence over nested
- `fireWebhookCallback`: no-op when no webhook metadata, log message on successful send,
  graceful handling of invalid URLs

Updated `package.json` test script to run all three test files (`jobs`, `config`,
`webhook-callback`).

### Code Health Observations

- **Advisory lock pattern** (`jobs.ts:118-152`): Still uses sleep-polling advisory lock.
  Lower priority since CCP typically runs single-instance.

### Patterns Worth Reinforcing

- **Nightly review cadence**: Five consecutive reviews have each identified issues and
  resolved them in subsequent sessions. The identify → fix → verify loop continues.
- **Test script should run all test files**: Previously only `jobs.test.js` was in the
  test script; `config.test.js` was not being run by `npm test`. Now all test files are
  included.

## 2026-04-02 — Nightly Review

### Bug Fixed: Silent catch blocks in intake-server.ts and unguarded JSON.parse in add-repo.ts

1. **`intake-server.ts` silent catches** — Four `catch (_) {}` blocks in the dashboard API
   handlers (`handleGetJobs`, `handleGetJob`) swallowed errors when reading job packets,
   results, or worker logs. Dashboard would silently show incomplete data with no indication
   of failure. Fixed: added `console.error` logging to all four, matching the pattern
   established in `jobs.ts` (d352d3b).

2. **`add-repo.ts` unguarded `JSON.parse`** — `JSON.parse(r.stdout).id` on line 180 parsed
   the GitHub API response without error handling. If the response is malformed or truncated
   (network issue, API change), the entire `add-repo` command crashes mid-execution. Fixed:
   wrapped in try/catch with a degraded success message.

### Code Health Observations

- **Open PR #9** covers duplicated `lifecycleMap` extraction and webhook-callback tests —
  two items flagged in previous reviews. Should be merged to close those items.
- **Advisory lock pattern** (`jobs.ts:118-152`): Still uses sleep-polling advisory lock.
  Lower priority since CCP typically runs single-instance.
- **`ensureLabels` in `linear.ts`**: Uses `Promise.race` with a timeout but doesn't catch
  rejections from `ensureLabel()`. If the API call rejects, the unhandled rejection propagates.
- **`attemptAutoRebase` in `pr-watcher.ts`**: Git operations don't clean up on partial failure,
  potentially leaving the repo in an inconsistent state for subsequent jobs.

### Patterns Worth Reinforcing

- **Nightly review cadence**: Five consecutive reviews have each identified and resolved issues.
  The identify → fix → verify loop remains effective.
- **Silent catch blocks**: All known silent catches in the codebase are now resolved. Future
  code should always log in catch blocks, even for non-critical paths.

## 2026-04-03 — Nightly Review

### Bug Fixed: Unhandled Promise.race rejection in ensureLabels

`ensureLabels` in `linear.ts` called `Promise.race([ensureLabel(name, orgKey), timeout])`
without catching rejections from `ensureLabel`. While `ensureLabel` has an internal try-catch,
the `linearConfig(orgKey)` call at line 235 is **outside** that try-catch. If `loadConfig`
throws (e.g., corrupted linear config file), the rejection propagates through `Promise.race`
unhandled, crashing the entire `createIssueFromJob` flow. This means a single corrupted config
file could prevent all Linear issue creation.

**Fix:** Added `.catch(() => null)` to the `ensureLabel` call inside `Promise.race`, matching
the function's existing graceful degradation pattern (return null on failure, skip that label).

### Bug Fixed: Silent catch blocks in new notification code

Commit b351eb7 (Discord lifecycle + SSE) introduced two new silent catch blocks that
contradicted the project convention established in 58af809:

1. **SSE polling interval** (`intake-server.ts:296`): `catch { /* ignore */ }` swallowed
   errors from `listJobs()` during SSE broadcasting. Fixed: logs error to stderr.

2. **PR merge ticket matching** (`intake-server.ts:589`): `catch { /* best-effort */ }`
   swallowed errors when reading job packets for ticket matching. Fixed: logs error to stderr.

### Code Health Observations

- **Advisory lock pattern** (`jobs.ts:118-152`): Still uses sleep-polling advisory lock.
  Lower priority since CCP typically runs single-instance.
- **`attemptAutoRebase` in `pr-watcher.ts`**: Reviewed — git operations properly clean up
  on partial failure (rebase --abort, return to base branch). No action needed.

### Patterns Worth Reinforcing

- **New feature code should follow established conventions**: The Discord notification and SSE
  code in b351eb7 was well-structured but introduced silent catches that had been systematically
  eliminated in previous reviews. New code should follow the existing error logging pattern.
- **Promise.race needs rejection handling**: When racing async operations against timeouts,
  always add `.catch()` to the async operation to prevent unhandled rejections.
