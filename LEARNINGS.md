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

### Code Health Observations

- `prReviewPolicy()` is duplicated identically in `jobs.ts` and `pr-watcher.ts`.
  Should be extracted to a shared module to prevent drift.
- Webhook callback logic (HMAC signing + HTTP POST) is duplicated between
  `finalizeJob()` in `jobs.ts` and `runPrWatcherCycle()` in `pr-watcher.ts`.
- `scheduling.ts` reads `outage.json` directly from disk instead of using
  `getOutageStatus()` from `outage.ts` — minor duplication risk.
