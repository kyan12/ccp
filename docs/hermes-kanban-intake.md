# Hermes Kanban intake implementation note

Native entry point: `ccp-hermes-kanban submit [packet.json|--stdin]` accepts a structured Kanban packet and enqueues a normal CCP job without creating, polling, or syncing a Linear issue. Linear is retired: no importer may create Kanban cards from Linear issues, and Linear history/comments are not task context.

Changed files:
- `src/lib/hermes-kanban.ts` — builds the Kanban packet through `buildIncidentPacket('manual', ...)`, stamps `source_transport: "hermes-kanban"` and `hermes_kanban_task_id`, uses deterministic job ids (`kanban_<task_id>`), rejects legacy Linear migration envelopes, strips legacy `Linear comments` sections, and serializes terminal evidence for Kanban completion/blocking.
- `src/lib/jobs.ts` — adds `createJobIfAbsent` so deterministic retries atomically return/resume the existing job instead of overwriting it.
- `src/lib/linear-disabled.ts`, `src/types.ts`, `.env.example`, `README.md` — documents/configures Linear-off operation while keeping local intake and supervisor jobs active.

Configuration:
- Keep `configs/linear.json` set to `disabled=true`, `dispatchEnabled=false`, `pollingEnabled=false`, and `syncEnabled=false`; `CCP_LINEAR_DISABLED=true` or `CCP_DISABLE_LINEAR=true` are optional runtime belt-and-suspenders switches.
- This disables Linear dispatch/polling/sync paths but leaves `ccp-hermes-kanban`, `ccp-intake`, and `ccp-supervisor` usable for native jobs.

Proposed Kanban invocation:

```bash
cat > /tmp/kanban-packet.json <<'JSON'
{
  "task_id": "t_abc123",
  "title": "Fix checkout totals",
  "body": "Full Kanban body or worker_context",
  "repoKey": "my-repo",
  "acceptance_criteria": ["Totals update correctly"],
  "verification_steps": ["Run the repo test suite"]
}
JSON

CCP_LINEAR_DISABLED=true ccp-hermes-kanban submit /tmp/kanban-packet.json
ccp-supervisor --once
ccp-hermes-kanban result kanban_t_abc123
```

Rejected legacy envelopes: cards containing `Imported from Linear for local Hermes execution.` or metadata `created_by`/`source` equal to `linear-migration` must be archived and recreated natively before CCP will run them.
