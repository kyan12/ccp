# Routing model (retired CCP intake)

Native Hermes Kanban on the `proteusx-engineering` board is the sole source of
truth for new engineering work. Linear teams, projects, labels, workflow states,
and source labels described by earlier versions of this document are historical
provenance only. Do not create, route, poll, or synchronize new work through
Linear or CCP.

## Current routing

- Create native Hermes Kanban cards assigned to the appropriate profile.
- Record repository, source, tenant, dependency, and acceptance information on
  the card or linked Hermes project.
- Use isolated Git worktrees for independent code-changing cards.
- Keep dependent cards serialized through native Kanban parent links.

## Historical labels

Old CCP artifacts may contain values such as `repo:*`, `source:*`, and former
Linear workflow names. They may be read when reconciling archived evidence, but
no active dispatcher consumes them.

## Repository onboarding

Automatic CCP repository onboarding is retired. The authenticated
`/api/onboard` compatibility endpoint returns terminal `410 Gone` and performs
no GitHub, filesystem, webhook, or repository-config mutation. Register
repositories through the native Hermes project/operator workflow.
