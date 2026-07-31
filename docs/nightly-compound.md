# Nightly Compound Automation (retired CCP producer)

The CCP nightly compound producer, cron dispatch, per-repository enablement, tmux
worker launch, Discord lifecycle messages, and automatic PR shipping described
by earlier versions of this document are retired. Do not run
`nightly-compound.ts` to create new CCP jobs and do not configure a
`ccp-nightly-compound-dispatch` cron.

## Current ownership

Scheduled engineering work is created directly as native Hermes Kanban cards
with explicit repository/worktree, assignee, dependencies, acceptance criteria,
and review requirements. Native Kanban owns execution and completion.

## Historical drain exception

The bounded CCP PR watcher may read GitHub state for exactly these archived jobs:

- `nightly_proteusx-os_2026-07-11`
- `nightly_papyrx_2026-05-19`

For those records it writes only `status.integrations.prReview`. It never creates
nightly work, starts workers, changes top-level job state/result, merges or
rebases PRs, creates remediation children, runs smoke tests, fires callbacks, or
sends Discord lifecycle messages.

Historical `nightly` fields and result files may be inspected for provenance but
must not be treated as active operator configuration.
