# CCP — Coding Control Plane

> **Runtime status:** retirement in progress on Kevin's Mac Studio. Native Hermes Kanban (`proteusx-engineering`) owns all new engineering intake, isolated worktrees, execution, review, callbacks, and completion.

CCP is no longer an intake or dispatch system for new work. This repository is retained temporarily to:

- preserve historical job evidence;
- reconcile the remaining PR-backed jobs;
- keep the dashboard and authenticated GitHub merge/review handling available during migration;
- provide a controlled path for removing the final LaunchAgents.

Do not submit new CCP jobs, create Linear tickets through CCP, or add new CCP producers.

## Canonical workflow

New engineering work must be created directly on native Hermes Kanban:

```bash
hermes kanban --board proteusx-engineering create "Task title" \
  --body "Acceptance criteria and verification" \
  --assignee code-crab \
  --workspace worktree:/absolute/path/to/repo
```

The former Business Crab handoff contract, Kanban→CCP adapter, Linear polling/dispatch, and Linear result synchronization have been removed.

## Temporary drain runtime

The following components remain only while historical PRs and webhook consumers are migrated:

- `src/bin/supervisor.ts` — reconciles existing jobs and PR-backed work;
- `src/bin/intake-server.ts` — serves the dashboard and authenticated legacy webhook endpoints;
- `src/lib/pr-watcher.ts` — watches already-tracked PR-backed jobs;
- `src/bin/jobs.ts` — inspects historical job state.

The intake server does not create new CCP or Linear work:

- `/webhook/linear` returns an authenticated `410 Gone` retirement response;
- manual and app intake return `410 Gone`;
- Sentry, Vercel, and untracked GitHub CI intake return explicit `503 Service Unavailable` responses with `Retry-After` while their native-Kanban replacements are completed;
- already-tracked GitHub PR review/merge events continue to reconcile historical jobs.

## Build and verification

```bash
npm install
npm run build
npm test
```

Both build and test clean `dist/` before TypeScript compilation so deleted executable modules cannot survive as stale generated JavaScript.

## Historical job inspection

```bash
node dist/bin/jobs.js status
node dist/bin/jobs.js show <job-id>
node dist/bin/pr-watcher.js --once
```

Do not use job creation or dispatch commands for new work.

## Runtime retirement checklist

Before unloading `ai.ccp.supervisor` and `ai.ccp.intake`:

1. Resolve or migrate every remaining `coded`, `running`, `preflight`, and `queued` CCP job.
2. Verify GitHub PR merge/review handling has a native Hermes replacement or is no longer needed.
3. Verify Sentry and other external webhook destinations point at their native-Kanban replacement.
4. Preserve the historical `jobs/` evidence.
5. Run a clean build and the full test suite.
6. Unload and remove the two LaunchAgents.
7. Confirm native Hermes Kanban can create, dispatch, review, and complete an isolated-worktree task.

## Configuration

- `configs/repos.json` remains authoritative only for historical job and PR reconciliation.
- `configs/linear.json` remains disabled for historical compatibility and must not be re-enabled.
- Secrets remain in the active profile environment or 1Password; never commit them.

## License

MIT.
