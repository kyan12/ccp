# GitHub lifecycle retirement and native Kanban ownership

CCP no longer accepts GitHub review, CI, or merge events as engineering intake. New engineering work is created and completed on the native Hermes Kanban board, and each Kanban worker is responsible for running declared tests, obtaining an independent review or PR-check lane, fixing substantive findings, and recording the verified branch/PR handoff before calling `kanban_complete`.

## Authenticated retirement response

`POST /webhook/github` still validates `X-Hub-Signature-256` against the exact raw request body with `GITHUB_WEBHOOK_SECRET`. Invalid or missing signatures receive `403`. Authenticated deliveries receive an explicit non-retryable `410 Gone` response:

- `action: retired`
- `retryable: false`
- `replacement: native-hermes-kanban`

The endpoint does not acknowledge work as queued, create an incident, mutate a CCP job, merge/rebase a branch, or create `__reviewfix`, `__deployfix`, `__valfix`, or `__autoretry<N>` children. Keeping signature validation until the upstream hook is deleted prevents the retirement endpoint from becoming an unauthenticated public behavior probe.

GitHub required checks remain the source of truth for check conclusions. The Kanban task's implementation/review lane owns failures and merge decisions; a webhook event does not create a second task because that would duplicate the already-running Kanban card.

## Temporary historical PR drain

The CCP PR watcher remains only as a status reconciler while these two explicitly migrated historical jobs are resolved by native Kanban:

| Historical CCP job | Native Kanban task |
|---|---|
| `nightly_proteusx-os_2026-07-11` | `t_2c4ef11f` |
| `nightly_papyrx_2026-05-19` | `t_b81a403e` |

During this drain the watcher may observe live GitHub state and mark a historical artifact terminal. It may not auto-merge, force-push/rebase, run legacy preview smoke gates, or enqueue remediation. Those actions belong to the two Kanban workers and their GitHub check/review evidence.

## Drain and shutdown condition

Do not unload `ai.ccp.supervisor` or `ai.ccp.intake` in this change. The final retirement task may remove the unreachable legacy GitHub handler, PR watcher, generated `dist/**` files, and LaunchAgents only after all of the following are true:

1. `t_2c4ef11f` and `t_b81a403e` are complete and both named CCP job artifacts are terminal/no longer watchable.
2. Sentry migration task `t_4c877666` is complete and its native Kanban replacement is verified.
3. No CCP job is queued, preflight, running, coded, or otherwise PR-watchable.
4. A clean build and full test suite pass, and the native Hermes gateway still dispatches Kanban work.
5. The configured GitHub webhook has been deleted or redirected away from `/webhook/github`; until then, authenticated deliveries intentionally receive `410`.

The final fan-in task `t_d7264362` owns that zero-work precheck, clean rebuild, LaunchAgent shutdown, and end-to-end native Kanban verification.
