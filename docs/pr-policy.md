# PR Policy

> **Retirement status.** Native Hermes Kanban owns new PR review, remediation,
> and merge decisions. CCP's watcher is a read-only drain for exactly
> `nightly_proteusx-os_2026-07-11` and `nightly_papyrx_2026-05-19`.
> It always calls `reviewPr` with `autoMerge: false`; configured auto-merge,
> rebase, remediation, smoke, callbacks, and notifications are not production
> watcher behavior.

Legacy PR policy settings are parsed by `src/lib/pr-policy.ts`. Only the bounded
historical watcher consumes them now; general job finalization performs no
GitHub PR review or remediation.

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

## Current drain flow

The watcher collects only the two named historical jobs, reads their GitHub PR
state, and reconciles only its owned `status.integrations.prReview` field. It
never changes top-level job state or result data, and never reviews, approves,
merges, rebases, creates remediation work, runs preview smoke, or fires
callbacks.

## Environment variables

| Variable | Default | Description |
|----------|---------|-------------|
| `CCP_PR_REVIEW_ENABLED` | `true` | Enable/disable the PR review cycle |
| `CCP_PR_AUTOMERGE` | `false` | Legacy policy input; ignored by the read-only drain watcher |
| `CCP_PR_MERGE_METHOD` | `squash` | Legacy review metadata input; no merge is executed |
