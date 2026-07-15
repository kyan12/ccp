# Hermes Kanban intake

Linear is no longer required for CCP code-work intake. A spawned Hermes Kanban worker can submit or resume a CCP job directly on the Code Crab Mac mini with the `ccp-hermes-kanban` CLI.

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

The CLI builds a normal CCP `JobPacket` and calls existing `createJob`/supervisor machinery. It does not fork the worker harness. It persists `source: hermes-kanban`, `metadata.source_transport: hermes-kanban`, and `metadata.hermes_kanban_task_id` with the exact Kanban task id.

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

`result` returns stable JSON containing `status`, `packet`, `result`, and a `handoff` object. Use `handoff.summary` plus `handoff.metadata` for `kanban_complete` when terminal and successful. If `handoff.block_reason` is present or CCP is blocked, add the context as a Kanban comment and call `kanban_block` with one precise human ask.

## Linear-disabled operation

Set `CCP_LINEAR_DISABLED=1` (or `CCP_DISABLE_LINEAR=1`) in launchd/runtime env to make `dispatchLinearIssues()` a no-op. The supervisor still reconciles/runs jobs, PR watcher, auto-unblock, archiving, and health normally.
