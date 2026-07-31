# Incident-to-job flow (retired)

The former CCP commands that filed Linear issues or enqueued CCP jobs are
historical compatibility material. Do not use `intake-linear.ts`,
`intake-dispatch.ts`, or `intake-job.ts` for new incidents.

## Current flow

- Sentry intake submits native Hermes Kanban work through the bounded native
  integration.
- Manual incidents become native cards on `proteusx-engineering`.
- Dependencies, review, remediation, and completion remain in native Kanban.
- No current path creates or updates Linear issues or new CCP jobs.

Historical job and ticket artifacts remain available for read-only
reconciliation during the drain; their presence is not authorization to restart
retired producers.
