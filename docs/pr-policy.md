# Historical PR Policy

> **Retired for new work.** Native Hermes Kanban workers and GitHub required
> checks own review, remediation, and merge decisions. The CCP watcher is
> temporarily retained only to reconcile two named historical job artifacts;
> see [github-kanban-retirement.md](github-kanban-retirement.md).

PR review and auto-merge behavior is controlled by `src/lib/pr-policy.ts`. Both the job finalizer (`jobs.ts`) and the PR watcher (`pr-watcher.ts`) import from this shared module to prevent policy drift.

## `prReviewPolicy(repoPath?)`

Returns the resolved policy for a given repo:

```ts
{ enabled: boolean; autoMerge: boolean; mergeMethod: string }
```

## Resolution logic

Policy values are resolved in order of precedence (highest wins):

1. **Per-repo config** — `autoMerge` and `mergeMethod` fields in `configs/repos.json`
2. **Global environment variables** — `CCP_PR_AUTOMERGE` and `CCP_PR_MERGE_METHOD`
3. **Defaults** — `autoMerge: false`, `mergeMethod: "squash"`

Additionally, `CCP_PR_REVIEW_ENABLED` controls whether the PR review/watch cycle runs at all (default: `true`).

### Example: per-repo config in `repos.json`

```json
{
  "key": "my-app",
  "ownerRepo": "myorg/my-app",
  "localPath": "/home/user/repos/my-app",
  "autoMerge": true,
  "mergeMethod": "squash"
}
```

### Example: global defaults via environment

```bash
CCP_PR_AUTOMERGE=false        # default — no auto-merge unless repo opts in
CCP_PR_MERGE_METHOD=squash    # default merge strategy
CCP_PR_REVIEW_ENABLED=true    # default — PR review cycle is active
```

## mergeMethod options

The `mergeMethod` field maps directly to GitHub's merge strategies:

| Value | GitHub behavior |
|-------|----------------|
| `squash` | Squash and merge (default) — all commits combined into one |
| `merge` | Create a merge commit |
| `rebase` | Rebase and merge — linear history, no merge commit |

## Retired auto-merge flow

The policy resolver remains readable for historical config compatibility, but
the drain watcher always calls `reviewPr` with `autoMerge: false`. It may read
GitHub state and mark an already-merged historical artifact terminal. It does
not approve, merge, rebase/force-push, run legacy preview smoke gates, enqueue
remediation, or fire app callbacks.

Do not use `autoMerge`, `CCP_PR_AUTOMERGE`, or `CCP_PR_MERGE_METHOD` to control
new engineering work. Those settings are inert in the retained watcher and are
removed by the final retirement task after the historical drain completes.

## Environment variables

| Variable | Default | Description |
|----------|---------|-------------|
| `CCP_PR_REVIEW_ENABLED` | `true` | Enable/disable the PR review cycle |
| `CCP_PR_AUTOMERGE` | `false` | Global auto-merge default (per-repo overrides this) |
| `CCP_PR_MERGE_METHOD` | `squash` | Global merge method default (per-repo overrides this) |
