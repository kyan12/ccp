# Nightly Compound Automation

## Overview

Nightly compound runs review recent work across repos, extract learnings, and implement the highest-priority item overnight. Results are available for morning review.

## Architecture

```
OpenClaw cron (10:30 PM ET daily)
  → nightly-compound.ts reads repos.json (nightly.enabled=true)
    → creates a CCP job per repo
      → supervisor queues and runs them sequentially (max-concurrent=1)
        → tmux worker runs Claude Code
          → Discord notifications on start/done/fail
```

## Configuration

### repos.json

Add `nightly` config to any repo:

```json
{
  "key": "my-repo",
  "localPath": "/Users/crab/repos/my-repo",
  "nightly": {
    "enabled": true,
    "branch": "main",
    "timeoutSec": 1200
  }
}
```

Fields:
- `enabled` — whether to include in nightly dispatch
- `branch` — branch to pull and work from
- `timeoutSec` — max runtime for the worker (default 900)

### Enable/Disable a repo

Edit `configs/repos.json` and toggle `nightly.enabled`.

## Commands

```bash
# List nightly-eligible repos
node src/bin/nightly-compound.ts --list

# Dry run (show what would be dispatched)
node src/bin/nightly-compound.ts --dry-run

# Dispatch all enabled repos now
node src/bin/nightly-compound.ts

# Dispatch a single repo
node src/bin/nightly-compound.ts --repo papyrx
```

## Cron Schedule

The dispatch runs at **10:30 PM ET daily** via OpenClaw cron.

Cron job name: `nightly-compound-dispatch`

The supervisor handles execution order. Jobs are queued and run one at a time.

## Job Lifecycle

1. **Dispatch** — `nightly-compound.ts` creates jobs with IDs like `nightly_papyrx_2026-03-14`
2. **Queue** — supervisor picks them up in order
3. **Run** — tmux worker runs Claude Code with the compound prompt
4. **Notify** — Discord notifications on start and completion
5. **Result** — `result.json` contains state, commit hash, learning summary

## Compound Prompt Phases

Each nightly run follows 4 phases:

1. **Sync & Orientation** — git pull, read project docs, review recent commits
2. **Learning Extraction** — identify patterns, mistakes, incomplete work → write to LEARNINGS.md
3. **Implementation** — pick single highest-impact item, implement on feature branch
4. **Ship** — push branch, create draft PR

## Duplicate Prevention

Jobs are named with the date (`nightly_<repo>_<YYYY-MM-DD>`). If a job for today already exists, it's skipped.

## Morning Review

Check results:
```bash
# List nightly results
node src/bin/jobs.ts list --source nightly

# Check a specific run
node src/bin/jobs.ts show nightly_papyrx_2026-03-14
node src/bin/jobs.ts result nightly_papyrx_2026-03-14
```

Or check the `#coding-runs` Discord channel for notifications.
