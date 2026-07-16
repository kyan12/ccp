# Hermes Kanban intake

Linear is retired for CCP code-work intake. A spawned Hermes Kanban worker submits or resumes a CCP job directly on the Code Crab Mac mini with the `ccp-hermes-kanban` CLI; no importer may create Kanban cards from Linear issues.

## Submit or resume from a Kanban worker

Create a JSON packet from `kanban_show()` output and send it over SSH:

```bash
ssh crab@Codes-Mac-mini.local \
  'cd /Users/crab/coding-control-plane && CCP_LINEAR_DISABLED=1 node dist/bin/hermes-kanban.js submit --stdin' \
  < kanban-packet.json
```

Minimum packet:

```json
{
  "task_id": "t_184f6437",
  "title": "Kanban card title",
  "body": "Kanban card body",
  "worker_context": "full kanban_show worker_context",
  "repo": "repo key, owner/repo, alias, or local path",
  "acceptance_criteria": ["binary criterion"],
  "verification_steps": ["command or manual check"]
}
```

The CLI builds a normal CCP `JobPacket` and calls existing `createJob`/supervisor machinery. It does not fork the worker harness. It persists `source: hermes-kanban`, `metadata.source_transport: hermes-kanban`, and `metadata.hermes_kanban_task_id` with the exact Kanban task id. Native packets always use deterministic `kanban_<task_id>` job ids, never legacy `linear_<issue>` ids.

## Dedupe behavior

The job id is deterministic: `kanban_<sanitized task_id>`. Re-submitting the same Kanban `task_id` returns the existing job with `created:false` and `existing:true`, so Hermes task respawns do not create duplicate CCP jobs.

## Poll and reconcile

A Kanban worker should poll CCP directly; no cross-host webhook is required:

```bash
ssh crab@Codes-Mac-mini.local \
  'cd /Users/crab/coding-control-plane && node dist/bin/jobs.js show kanban_t_184f6437'
ssh crab@Codes-Mac-mini.local \
  'cd /Users/crab/coding-control-plane && node dist/bin/hermes-kanban.js result kanban_t_184f6437'
```

`result` returns stable JSON containing `status`, `packet`, `result`, and a `handoff` object with an explicit `handoff.action`: `complete`, `block`, or `wait`. Workers should act on `handoff.action`, not on the legacy bare `terminal` flag: use `handoff.summary` plus `handoff.metadata` for `kanban_complete` only when `handoff.action === "complete"`; add the context as a Kanban comment and call `kanban_block` when `handoff.action === "block"`; keep polling/supervising CCP when `handoff.action === "wait"`. `done`, `verified`, and successful terminal `no-op` statuses (`status.state === "no-op"`, `status.exit_code === 0`, no blocker, and no non-zero `result.worker_exit_code`) return `complete`; blocker precedence still makes any blocked no-op return `block`. Intermediate states such as `coded`, PR-pending, running, and deploy-in-progress intentionally return `wait`.

## Linear-disabled operation

Durable defense-in-depth lives in `configs/linear.json`: keep `disabled=true`, `dispatchEnabled=false`, `pollingEnabled=false`, and `syncEnabled=false`. `CCP_LINEAR_DISABLED=1` (or `CCP_DISABLE_LINEAR=1`) may also be set in launchd/runtime env. These switches make Linear dispatch and Linear sync paths no-op before credentials or network access. Hermes Kanban packets (`source: hermes-kanban` or `metadata.source_transport: hermes-kanban`) also skip Linear sync defensively even if the env flag is absent. The supervisor still reconciles/runs jobs, PR watcher, auto-unblock, archiving, and health normally.


## Legacy Linear migration envelopes

Linear history is not task context. `ccp-hermes-kanban submit` rejects old locally migrated cards that contain the exact marker `Imported from Linear for local Hermes execution.` or metadata `created_by`/`source` equal to `linear-migration`. The terminal error tells the board owner to archive/recreate the card natively. Do not copy old `Linear comments` sections into prompts, packets, jobs, or writeback; recreate the current ask as native Kanban prose instead. Native cleanup tasks may still mention the word Linear when the work itself is about retiring Linear paths.
