# Per-job Git worktrees (historical CCP implementation)

This document records how legacy CCP jobs used isolated Git worktrees. CCP no
longer creates new engineering jobs, and the bounded two-job PR drain does not
allocate, modify, validate, or release worktrees.

## Historical behavior

When a legacy repository mapping enabled `worktree: true`, CCP allocated a
detached checkout under its worktree directory and recorded the path in the
archived job status. `parallelJobs` was effective only with worktree isolation.
The tmux worker performed its branch, commit, push, and validation work inside
that checkout rather than the canonical repository.

Legacy reconciliation may still read a recorded `status.workdir` to inspect
local evidence. General finalization performs no remote Git/GitHub lookup, PR
URL recovery, Linear synchronization, or new remediation. The bounded watcher
reads GitHub state only for its exact historical allowlist and writes only
`status.integrations.prReview`.

## Current behavior

Native Hermes Kanban owns code-changing worktrees. New cards should use a
Hermes `worktree`, `worktree:<repo>`, or project-backed workspace; continuations
may reuse `dir:<existing-worktree>` only after the previous writer has stopped.
Independent reviews should use detached, no-edit worktrees bound to an exact
commit SHA.

Archived CCP worktree metadata can be pruned after its associated historical
record and PR have been reconciled.
