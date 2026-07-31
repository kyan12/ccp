# PR Policy (bounded historical drain)

Native Hermes Kanban owns all new PR review, remediation, merge, and completion
decisions. CCP retains only a read-only watcher for exactly:

- `nightly_proteusx-os_2026-07-11`
- `nightly_papyrx_2026-05-19`

The watcher reads PR state with `reviewPr({ autoMerge: false })`/`gh pr view` and
reconciles only `status.integrations.prReview`. It never changes top-level job
state or result data; reviews, approves, merges, or rebases; creates
`__valfix`, `__reviewfix`, or `__deployfix` work; runs preview smoke; fires
callbacks; or sends lifecycle notifications.

## Legacy settings

`src/lib/pr-policy.ts` still parses old policy fields so archived records and
isolated compatibility tests remain readable:

- per-repository `autoMerge` and `mergeMethod`
- `CCP_PR_REVIEW_ENABLED`
- `CCP_PR_AUTOMERGE`
- `CCP_PR_MERGE_METHOD`

These are historical metadata inputs, not current operational controls.
`autoMerge` is forced off in the bounded watcher, and `mergeMethod` never causes
a GitHub merge. Do not add these settings for new work; configure PR policy in
the native Hermes/GitHub workflow instead.
