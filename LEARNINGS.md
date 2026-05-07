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

## 2026-04-04 — Nightly Review

### Bug Fixed: `attemptAutoRebase` unchecked git cleanup operations

`attemptAutoRebase` in `pr-watcher.ts` ran several git operations (reset, rebase --abort,
checkout) without checking their return codes. If any cleanup operation failed — especially
`rebase --abort` or `checkout baseBranch` — the repo would be left in an inconsistent state
(mid-rebase, detached HEAD, or on the wrong branch). Subsequent jobs dispatched to that repo
would inherit the broken state and fail.

**Fix:** Extracted `ensureOnBranch()` helper that verifies checkout succeeds with fallback
strategies (abort lingering rebase, detached HEAD at origin). All error paths now use this
helper. Added return-code check for `git reset --hard` and logged `rebase --abort` failures.

### Code Health Observations

- **Advisory lock pattern** (`jobs.ts:118-152`): Still uses sleep-polling advisory lock.
  Lower priority since CCP typically runs single-instance.

### Patterns Worth Reinforcing

- **Nightly review cadence**: Eight consecutive reviews, each identifying and resolving issues.
  The identify → fix → verify loop continues to work effectively.
- **Git cleanup safety**: Any function that switches branches or modifies git state should
  verify cleanup succeeds, especially in error paths. A helper like `ensureOnBranch` prevents
  cascading failures across jobs sharing a repo checkout.

## 2026-04-05 — Nightly Review

### Bug Fixed: Supervisor cycle overlap — concurrent cycles cause race conditions

`supervisor.ts` used `setInterval` to schedule supervisor cycles, firing every `intervalMs`
(default 15s) regardless of whether the previous cycle had completed. If a cycle took
longer than `intervalMs` (e.g. during network-slow Linear dispatch, multiple PR reviews,
or outage probing), a second cycle would start concurrently.

**Impact:** Two concurrent cycles could both see the same running job's tmux session as
dead and both call `finalizeJob()`, leading to:
- Double notification sends (duplicate Discord messages)
- Double Linear sync attempts (race condition on issue state)
- Double PR reviews and potential double remediation job creation
- Status file corruption from concurrent read-modify-write in `saveStatus`

Two cycles could also both see the same queued job and both call `startJob()`, launching
two tmux workers for the same job on the same repo.

**Fix:** Replaced `setInterval` with a sequential `setTimeout` loop where the next cycle
is only scheduled after the current cycle completes. Total period becomes
`cycle_duration + intervalMs`, which is slightly longer but eliminates all overlap risk.
Error handling preserved: first-cycle errors still exit the process; subsequent cycle
errors are logged to stderr and the loop continues.

### Code Health Observations

- **Advisory lock pattern** (`jobs.ts:118-152`): Still uses sleep-polling advisory lock.
  Lower priority since CCP typically runs single-instance and cycle overlap is now fixed.
### Patterns Worth Reinforcing

- **Sequential scheduling for daemon loops**: `setInterval` is dangerous for async work
  because it fires at fixed intervals regardless of execution time. Always use sequential
  `setTimeout` scheduling (schedule-after-completion) for daemon-style loops.

## 2026-04-07 — Nightly Review

### Bug Fixed: Silent catch blocks in linear-dispatch.ts and linear.ts, unguarded JSON.parse in nightly-compound.ts

Three issues found and fixed:

1. **`linear-dispatch.ts:92` silent catch** — `listDispatchCandidates()` iterated over Linear
   orgs and swallowed all errors with `catch (_err) { // skip orgs that fail }`. If a Linear
   org's API was misconfigured or returning errors, the failure was completely invisible. Fixed:
   logs error to stderr with the org key, matching the project convention from 58af809.

2. **`linear.ts:272` silent catch** — `ensureLabel()` swallowed label creation failures with
   `catch (_error) { return null; }`. If the Linear API was down or permissions changed, label
   creation would silently fail with no trace in logs. Fixed: logs error to stderr with the
   label name.

3. **`nightly-compound.ts:14` unguarded `JSON.parse`** — `loadRepos()` parsed `repos.json`
   without error handling. A corrupted or partially-written repos file would crash the entire
   nightly dispatch process, preventing all nightly jobs from running. Fixed: returns
   `{ mappings: [] }` on parse error with a log message, matching the resilience pattern from
   config.ts (52691ec).

### Code Health Observations

- **Advisory lock pattern** (`jobs.ts:118-152`): Still uses sleep-polling advisory lock.
  Lower priority since CCP typically runs single-instance and cycle overlap is now fixed.
- **Open PRs**: PR #18 (harden ghJson + pr-watcher silent catches), PR #19 (repo context
  enrichment), PR #21 (worktree isolation + priority queue) are all open and mergeable.
  Consider merging #18 first as it's a small bug fix.

### Patterns Worth Reinforcing

- **Nightly review cadence**: Ten consecutive reviews, each identifying and resolving issues.
  The identify → fix → verify loop continues to work effectively.
- **Silent catch elimination is ongoing**: New code (notifications, Linear dispatch) continues
  to introduce silent catches. Every review should scan for `catch` blocks without logging.

## 2026-04-08 — Nightly Review

### Bug Fixed: Silent catch blocks in pr-watcher.ts Discord notifications and linear.ts comment posting

Seven silent catch blocks that swallowed errors without logging:

1. **`pr-watcher.ts` — 6 Discord notification catches** — The Discord lifecycle feature (b351eb7)
   introduced 6 `catch { /* best-effort */ }` blocks around `sendDiscordMessage` calls for merge
   notifications, auto-rebase messages, remediation status, thread status updates, and lifecycle
   channel updates. If Discord integration breaks (bad channel ID, network issue, CLI failure),
   all failures are completely invisible. Fixed: all 6 now log to stderr with `[pr-watcher]` prefix.

2. **`linear.ts:412` — `postCompletionComment` silent catch** — When posting a job result comment
   to a Linear issue fails (API down, permissions changed, issue deleted), the function returns
   `false` but logs nothing. Caller sees failure but has no diagnostic info. Fixed: logs error
   to stderr with the issue ID.

### Code Health Observations

- **Advisory lock pattern** (`jobs.ts:118-152`): Still uses sleep-polling advisory lock.
  Lower priority since CCP typically runs single-instance and cycle overlap is now fixed.
- **`collectPrReviewFeedback` uses `spawnSync`** (`intake-server.ts:131-159`): The function
  calls `gh api` synchronously 3 times inside an HTTP request handler, blocking the event loop
  for potentially seconds. Should be refactored to use async `child_process.exec` or cached.
- **Remaining silent catches**: ~15 `catch { }` blocks remain in the codebase. Most are
  acceptable (fallback parsing, optional module loading, loop-skip patterns). The Discord and
  Linear notification catches were the highest priority since they hide integration failures.

### Patterns Worth Reinforcing

- **Nightly review cadence**: Eleven consecutive reviews, each identifying and resolving issues.
- **Silent catch convention**: All notification/integration catches should log. Loop-skip catches
  (`catch { continue; }` for scanning job packets) are acceptable when the loop is best-effort.

## 2026-04-10 — Nightly Review

### Bug Fixed: Silent catch blocks in scheduling.ts hide outage and rate-limit state

`canDispatchJobs()` in `scheduling.ts` had two `catch { /* ignore */ }` blocks wrapping calls
to `isRateLimited()` and `getOutageStatus()` from the outage module. If either function throws
(e.g., corrupted `outage.json`, module load error), the check is silently skipped and the
supervisor proceeds to dispatch jobs into a broken API — the exact scenario the outage and
rate-limit systems are designed to prevent.

Additionally, `loadConfig()` used a bare `catch { return null; }` that swallowed parse errors
for `scheduling.json`. A corrupted scheduling config file would silently disable scheduling
rather than alerting operators.

**Fix:** All three catch blocks now log to stderr with `[scheduling]` prefix, matching the
project convention from 58af809. `loadConfig` also gained an `existsSync` guard to distinguish
"file doesn't exist" (normal, no log) from "file exists but is corrupted" (logged).

### Code Health Observations

- **Open PR #28**: Fixes `prUrl` passthrough for webhook-triggered review remediation. Reviewed
  by Devin, CI passed. Should be merged.
- **Advisory lock pattern** (`jobs.ts:118-152`): Still uses sleep-polling advisory lock.
  Lower priority since CCP typically runs single-instance and cycle overlap is now fixed.

### Patterns Worth Reinforcing

- **Nightly review cadence**: Twelve consecutive reviews, each identifying and resolving issues.
- **Outage-critical paths must not silently swallow errors**: The scheduling module is a
  safety gate — if it can't determine outage/rate-limit status, it should err toward caution
  (or at minimum, make the failure visible in logs).

## 2026-04-11 — Nightly Review

### Bug Fixed: isNoOpOutcome misclassifies failed remediation as no-op

`isNoOpOutcome` in `jobs.ts` returned `true` whenever `addressedComments` was non-empty,
regardless of the fix status of individual comments. A remediation worker that reports all
comments as `not_fixed` or `partial` (making no code changes) would be classified as `no-op`
instead of falling through to `blocked` classification. This caused failed remediations to
be silently routed to the status channel instead of the errors channel, making them invisible
to operators.

**Fix:** Changed the check from `hasAddressedComments` (any non-empty array) to
`allCommentsAlreadyFixed` (every comment has `status: 'fixed'`). Only truly resolved
remediations (all comments already fixed, nothing to change) are classified as no-op.

Also logged `parseSummary` AddressedComments JSON parse failures instead of silently
swallowing them, matching the project convention from 58af809.

### Code Health Observations

- **Open PR #28**: Fixes `prUrl` passthrough for webhook-triggered review remediation.
  Should be merged.
- **Advisory lock pattern** (`jobs.ts:118-152`): Still uses sleep-polling advisory lock.
  Lower priority since CCP typically runs single-instance and cycle overlap is now fixed.
- **`collectPrReviewFeedback` uses `spawnSync`** (`intake-server.ts:131-159`): Calls `gh api`
  synchronously 3 times inside an HTTP request handler, blocking the event loop. Should be
  refactored to use async `child_process.exec` or cached.

### Patterns Worth Reinforcing

- **Nightly review cadence**: Thirteen consecutive reviews, each identifying and resolving issues.
- **Classification logic must be precise**: Boolean checks on collections (`hasX` vs `allX`)
  must match the semantic intent. The no-op classifier needs to distinguish "already resolved"
  from "failed to resolve" — presence of data is not evidence of success.

## 2026-04-13 — Nightly Review

### Bug Fixed: outage.ts loadState() silent catch hides corrupted state file

`loadState()` in `outage.ts` used a bare `catch {}` that didn't distinguish "file doesn't
exist" (normal startup) from "file exists but is corrupted" (dangerous). If `outage.json`
was corrupted during an active outage (e.g., partial write from concurrent `saveState`,
disk issue), `loadState()` would silently return `{outage: false}`, effectively clearing
the circuit breaker. The supervisor would then dispatch jobs into a broken API — the exact
scenario the outage system is designed to prevent.

**Fix:** Added `fs.existsSync` guard to distinguish missing file (return defaults, no log)
from corrupted file (log error, then return defaults). Matches the pattern established in
`scheduling.ts` (d290eff). Extracted `DEFAULT_STATE` constant to avoid repeating the
default object literal.

### Code Health Observations

- **Open PRs #28 and #31**: Both fix webhook-triggered remediation review issues. #31 is
  more recent (2026-04-12) and may supersede #28. Consider merging or closing #28.
- **Open PR #18**: Hardens `ghJson` parse and pr-watcher silent catches. Open since
  2026-04-06 — should be reviewed and merged.
- **`collectPrReviewFeedback` uses `spawnSync`** (`intake-server.ts:131-159`): Calls `gh api`
  synchronously 3 times inside an HTTP request handler, blocking the event loop. Should be
  refactored to use async `child_process.exec` or cached.
- **Advisory lock pattern** (`jobs.ts:118-152`): Still uses sleep-polling advisory lock.
  Lower priority since CCP typically runs single-instance and cycle overlap is now fixed.
- **Duplicated utility functions**: `parsePrUrl`, `commandExists`, and `run` are defined
  identically in `pr-review.ts`, `pr-comments.ts`, and `jobs.ts`. Should be extracted to
  a shared module to prevent drift.

### Patterns Worth Reinforcing

- **Nightly review cadence**: Fourteen consecutive reviews, each identifying and resolving issues.
- **Safety-critical modules need robust error handling**: The outage module is a safety gate.
  Silent error swallowing in safety gates is worse than in regular code — it silently disables
  the safety mechanism. The `existsSync` + try/catch + log pattern should be mandatory for
  all state-file reads in safety-critical paths.

## 2026-04-14 — Nightly Review

### Refactor: Extract duplicated shell utilities to `shell.ts`

`run`, `commandExists`, and `parsePrUrl` were independently defined in `pr-review.ts`,
`pr-comments.ts`, and `jobs.ts` (also `shellQuote` in `jobs.ts`). The `commandExists`
implementations had already drifted: `jobs.ts` added a cache (`_commandExistsCache`) that
the other two files lacked, meaning every `commandExists` call in PR review/comment code
spawned a subprocess even for previously-checked commands.

**Fix:** Extracted all four functions to `src/lib/shell.ts`. All consumers now import from
the shared module. The cached `commandExists` from `jobs.ts` is the canonical version.

### Code Health Observations

- **`collectPrReviewFeedback` uses `spawnSync`** (`intake-server.ts:120-159`): Calls `gh api`
  synchronously 3 times inside an HTTP request handler, blocking the event loop. Should be
  refactored to use async `child_process.exec` or cached. Flagged in two prior reviews.
- **Advisory lock pattern** (`jobs.ts:103-137`): Still uses sleep-polling advisory lock.
  Lower priority since CCP typically runs single-instance and cycle overlap is now fixed.
- **Open PRs #28 and #31**: Both fix webhook-triggered remediation review issues. #31
  supersedes #28 (adds `headRefName`/`baseRefName` in addition to `prUrl`). #28 can be
  closed in favor of #31.
- **Open PR #18**: Hardens `ghJson` parse and pr-watcher silent catches. Open since
  2026-04-06, should be reviewed and merged.

### Patterns Worth Reinforcing

- **Nightly review cadence**: Fifteen consecutive reviews, each identifying and resolving issues.
- **Shared utility modules**: Duplicated utility functions should be extracted early. The
  `commandExists` cache drift illustrates how independent copies diverge over time — one
  file gets the improvement, others don't.

## 2026-04-15 — Nightly Review

### Fix: `collectPrReviewFeedback` blocks event loop with synchronous `gh api` calls

`collectPrReviewFeedback` in `intake-server.ts` called `ghApiJson` three times sequentially,
and `ghApiJson` used `spawnSync` to run `gh api`. Each call blocks the Node.js event loop
for the duration of the GitHub API round-trip (typically 0.5–3s each). With three sequential
calls, the webhook server could be blocked for 1.5–9 seconds, during which no other HTTP
requests (webhooks, dashboard, SSE) are served.

**Impact:** GitHub retries webhooks after 10s of no response. Under load or with slow API
responses, the server could miss webhooks entirely, causing missed remediation triggers.

**Fix:** Converted `ghApiJson` from `spawnSync` to async `execFile` (promisified). Converted
`collectPrReviewFeedback` to async. The three GitHub API calls now run in parallel via
`Promise.all`, reducing total wall time from ~3× a single call to ~1× while also unblocking
the event loop for other requests. Removed unused `spawnSync` import.

### Code Health Observations

- **Open PR #31**: Fixes `headRefName`/`baseRefName` missing from webhook-triggered
  remediation review objects. Should be merged — remediation workers currently start from
  main instead of the PR's feature branch.
- **Open PR #28**: Superseded by #31. Can be closed.
- **Open PR #18**: Hardens `ghJson` parse and pr-watcher silent catches. Open since
  2026-04-06, should be reviewed and merged.
- **Advisory lock pattern** (`jobs.ts:103-137`): Still uses sleep-polling advisory lock.
  Lower priority since CCP typically runs single-instance and cycle overlap is now fixed.

### Patterns Worth Reinforcing

- **Nightly review cadence**: Sixteen consecutive reviews, each identifying and resolving issues.
- **Async I/O in HTTP handlers**: Never use `spawnSync` or other blocking operations inside
  HTTP request handlers. Node.js is single-threaded — blocking the event loop prevents all
  concurrent request processing. Use `execFile`/`exec` with promises for subprocess calls.
- **`Promise.all` for independent I/O**: When making multiple independent API calls, use
  `Promise.all` to run them concurrently rather than sequentially.

## 2026-05-06 — Nightly Review

### Tests: auto-remediation.ts coverage (53 cases)

`auto-remediation.ts` was added in d7b5fa7 with 249 lines of pure disposition logic
(PRO-598) but no test file. The module explicitly states it's designed for testability
("so tests can exercise the dispositions without any filesystem state"). Added
`auto-remediation.test.ts` covering:
- `isRemediationJobId`: suffix matching for `__reviewfix/__valfix/__deployfix/__autoretry`
- `summarizeAutoRemediation`: all 7 disposition paths, priority ordering (superseded > disabled >
  depth-limit > queued > existing > pending-watcher > not-applicable), edge cases
- `formatAutoRemediationLine`: rendering for each disposition type
- `downgradeWebhookStatus` / `downgradeHandoffStatus`: status downgrade when superseding

Updated `package.json` test script to include the new test file.

### Code Health Observations

- **Advisory lock pattern** (`jobs.ts:103-137`): Still uses sleep-polling advisory lock.
  Lower priority since CCP typically runs single-instance and cycle overlap is now fixed.
- **No open PRs**: All previously flagged PRs have been merged or closed.

### Patterns Worth Reinforcing

- **New pure-function modules need same-day test coverage**: `auto-remediation.ts` was
  explicitly designed for testability but shipped without tests. Pure function modules
  should have tests from day one — they're the easiest code to test.
- **Nightly review cadence**: Seventeen consecutive reviews, each identifying and resolving issues.

