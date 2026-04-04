# Linear auto-dispatch

This layer watches selected YourOrg Linear issues and turns them into queued coding jobs automatically.

## Current behavior

- scans the YourOrg team for issues in `Backlog` or `Todo`
- skips issues already dispatched before
- resolves repo mapping from issue title/description
- only queues work when the repo is mapped and exists locally
- moves dispatched issues to `In Progress`

## Run manually

```bash
node src/bin/linear-dispatch.ts
```

## Persistent behavior

The launchd-managed supervisor now calls this dispatch step automatically during each supervisor cycle before it starts queued jobs.

## State tracking

Dispatch state is stored at:
- `supervisor/linear-dispatch/state.json`

## Safety

This is intentionally conservative:
- unmapped repos are skipped
- missing local repos are skipped
- duplicate dispatch is prevented by stored state

This makes it suitable as the first auto-grab layer for Linear.
