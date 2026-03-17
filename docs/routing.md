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
