# Per-job git worktrees (Phase 3)

Opt-in isolation for jobs that target the same repository. When enabled,
every job runs in its own `git worktree` instead of sharing the canonical
`localPath` checkout.

## Why

Before Phase 3, only one job could run per repo at a time — enforced by a
per-repo "busy" gate in `runCycle`. The gate was there for safety: two
workers sharing a single checkout would stomp on each other's branch,
working tree, and index.

Worktrees lift that constraint. Each job gets its own independent
checkout rooted at `origin/main`. The worker's `git checkout -b …`,
`git commit`, `git push`, dirty-tree cleanup, and post-worker validation
all happen inside that isolated directory, so concurrent jobs can run
against the same repo without colliding.

Secondary benefit: a crashed or killed worker can't leave the canonical
checkout in a dirty state. Cleanup is bounded to the worktree, which
gets torn down when the job finalises.

## How to enable

`configs/repos.json` per-repo:

```json
{
  "key": "my-app",
  "localPath": "/home/user/repos/my-app",
  "worktree": true,
  "parallelJobs": 3
}
```

| Field          | Default | Effect |
| -------------- | ------- | ------ |
| `worktree`     | `false` | When `true`, every job gets a fresh worktree under `<CCP_ROOT>/worktrees/<key>/<job_id>`. |
| `parallelJobs` | `1`     | Max concurrent jobs allowed against this repo. Values > 1 require `worktree: true` — otherwise silently clamped to 1. |

Leaving both fields unset preserves pre-Phase-3 behavior: the job `cd`s
directly into `localPath` and the per-repo serial gate keeps
concurrency at 1.

## Lifecycle

1. **Acquire** — `startTmuxWorker` calls `acquireWorktree(mapping,
   jobId)` which:
   - fetches `origin/main` into the canonical checkout (so the new
     worktree starts at the latest base branch)
   - runs `git worktree add --detach <path> origin/main`
   - records the resolved path on `JobStatus.workdir`
2. **Run** — the tmux worker `cd`s into `workdir` instead of
   `packet.repo`. Everything the worker does (checkout, commit, push,
   etc.) happens inside the worktree. The agent driver's
   `buildCommand` also receives the worktree as `repoPath`.
3. **Finalize** — `finalizeJob` reads `status.workdir` and uses it for
   `inspectRepoProof`, `cleanRepoIfDirty`, `resolveOwnerRepo` (PR URL
   recovery), and the post-worker validator's `repoPath`. Only after
   notifications + Linear sync complete does it call
   `releaseWorktree(status.workdir, packet.repo)`, which runs
   `git worktree remove --force <path>` and prunes the admin entry.
4. **Recovery** — if the supervisor restarts mid-job,
   `JobStatus.workdir` persists on disk so the next `reconcileJob`
   still finds the right working tree. If `acquireWorktree` is called
   again for the same job (e.g. after a tmux kill), it short-circuits
   with `reused: true` instead of erroring.

## Failure modes

- **Worktree allocation fails** (disk full, git error, etc.) —
  `startTmuxWorker` logs the error to `worker.log` and falls back to
  `packet.repo`. The per-repo serial gate still applies, so the job
  runs safely but without parallelism.
- **Release fails** — logged but does not change the job's outcome.
  Falls back to `rm -rf <worktreePath>` + `git worktree prune` to keep
  disk state consistent. If the source repo is gone entirely, goes
  straight to `rm -rf`.
- **Dirty worktree at release time** — `--force` handles it. No
  operator intervention needed.

## Dispatch gate

The per-repo busy check in `runCycle` is count-based. For each queued
job:

```
repoLimit = getParallelJobLimit(mapping)   // 1 unless worktree + parallelJobs
running   = busyRepoCounts[packet.repo]    // running jobs against this repo
if running >= repoLimit:
  skip with reason "repo busy: <basename> (N/M)"
```

`packet.repo` is always the canonical `localPath` (never the worktree
path), so the count is stable across worktree-enabled and non-enabled
repos.

## Operator visibility

- `worker.log` logs acquisition, reuse, and release:
  ```
  [timestamp] worktree acquired: /.../worktrees/my-app/job_20260417_050301_abcdef
  …
  [timestamp] worktree release: ok — removed /.../worktrees/my-app/job_20260417_050301_abcdef
  ```
- `JobStatus.workdir` is included in `status.json` for running jobs so
  operators can inspect the live working tree directly.
- Skip reasons in the supervisor cycle summary include the current
  per-repo running/limit counts when the limit is > 1
  (`repo busy: my-app (3/3)`).

## Rolling this out

Land this PR with defaults preserved (no repo has `worktree: true`
until you flip it). Then flip one repo at a time:

1. Set `worktree: true` (no `parallelJobs` yet).
2. Confirm jobs still run end-to-end and the worktree directory is
   cleaned up on finalize.
3. Raise `parallelJobs` to 2, submit two overlapping jobs, and verify
   both run concurrently.
