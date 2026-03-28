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
