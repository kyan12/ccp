# PR Policy

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

## Auto-merge flow

When `autoMerge` is `true` for a repo, the PR watcher cycle (`pr-watcher.ts`) handles the merge:

1. Collects all jobs in `coded`, `done`, or `blocked` state that have PR URLs
2. Reviews each PR via `pr-review.ts` (checks CI status, mergeable state, conflicts)
3. If CI passes and the PR is mergeable, merges using the configured `mergeMethod`
4. If there are merge conflicts, attempts an auto-rebase with `--force-with-lease`
5. If CI fails, spawns a remediation job with the failure logs
6. Fires a webhook callback (if configured) with the resulting status

## Environment variables

| Variable | Default | Description |
|----------|---------|-------------|
| `CCP_PR_REVIEW_ENABLED` | `true` | Enable/disable the PR review cycle |
| `CCP_PR_AUTOMERGE` | `false` | Global auto-merge default (per-repo overrides this) |
| `CCP_PR_MERGE_METHOD` | `squash` | Global merge method default (per-repo overrides this) |
