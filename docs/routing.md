# Routing model

## Team

All coding work lands in the single Linear team:
- `YourOrg` (`PRO`)

## Projects

### Control Plane
Use for:
- supervisor / queue / tmux runtime work
- Discord / Linear / automation integrations
- coding-machine infrastructure
- control-plane bugs and enhancements

### Reliability / Incidents
Use for:
- Sentry runtime issues
- Vercel build/deploy failures
- regressions
- incident-driven bugfixes
- auto-created error intake

### Product / Delivery
Use for:
- planned features
- product improvements
- scoped manual engineering tasks
- normal backlog work across repos

## Repo tracking

Do not use one project per repo.

Track repo at the issue level via labels or issue body, for example:
- `repo:control-plane`
- `repo:yourorg-web`
- `repo:api`
- `repo:redwood`

## Source tracking

Use source labels for how work entered the system:
- `source:sentry`
- `source:vercel`
- `source:manual`
- `source:discord`
- `source:cron`

## Auto-onboarding

When a fix request references a repo not yet in `configs/repos.json`, the `onboard-repo` module (`src/lib/onboard-repo.ts`) automatically onboards it:

1. **Verify** — Checks the repo exists on GitHub via `gh api`
2. **Clone** — Clones to `$CCP_REPOS_DIR/<name>` (or `~/repos/<name>` by default)
3. **Register** — Adds the repo to `configs/repos.json` with `autoMerge: false`
4. **GitHub lifecycle** — Makes no repository-setting or webhook changes; native Hermes Kanban workers and GitHub required checks own review, CI, and merge behavior

If the repo is already onboarded, the module returns immediately with the existing config.

Auto-onboarding is triggered by the `/api/intake` endpoint when it receives a request for an unknown repo. It can also be triggered via `src/bin/add-repo.ts`.

See [github-kanban-retirement.md](github-kanban-retirement.md) for the authenticated `410` retirement contract and historical PR drain conditions.

## Workflow mapping

The YourOrg team currently uses:
- `Backlog`
- `Todo`
- `In Progress`
- `Done`

Control-plane mapping:
- new incident / inbox item -> `Backlog`
- ready-to-run work -> `Todo`
- active coding job -> `In Progress`
- coded / verified -> `Done`
