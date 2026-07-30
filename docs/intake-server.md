# Intake server

A lightweight local HTTP server receives the remaining authenticated CCP webhooks while their consumers migrate to native Hermes Kanban.

## Endpoints

- `POST /ingest/vercel`
- `POST /ingest/sentry`
- `POST /ingest/manual`
- `POST /webhook/linear` returns `410 Gone`; Linear intake is retired

## Run locally

```bash
node src/bin/intake-server.ts
```

Default port:
- `4318`

Override:

```bash
CCP_INTAKE_PORT=4319 node src/bin/intake-server.ts
```

## Security

Vercel webhook verification uses:
- `configs/vercel.json` -> `webhookSecretEnv`
- the corresponding secret value from environment / 1Password

Current behavior:
- Vercel fails closed when no webhook secret is configured.
- Sentry verifies `sentry-hook-signature` as HMAC-SHA256 over the exact raw request body using `SENTRY_CLIENT_SECRET`.
- Request bodies are capped before authentication at 1 MiB by default (`CCP_INTAKE_MAX_BODY_BYTES` overrides the limit); oversized bodies return `413` and are never buffered in full.
- Authenticated Sentry issue events create a native task on the explicit `proteusx-engineering` board, assigned to `code-crab`. The deterministic key `sentry:<org>:<issue-id>` uses Sentry's stable organization-scoped issue identity and returns the existing non-archived task on webhook retry even if project metadata is absent or renamed.
- Repository placement accepts only exact project slug/key/owner-repo/alias identities from the trusted Sentry project field. Telemetry text cannot influence routing. Unknown mappings still create a visible scratch task instead of dropping the event.
- Task bodies contain only allowlisted Sentry identity/evidence fields. Raw request data, headers, cookies, and customer payloads are not copied.
- Signed issue-like payloads missing `data.issue` return a non-retryable `422` and do not create a task; installation lifecycle events remain acknowledged.
- A successful response returns `taskId`, board, dedupe key, and writeback policy. Kanban completion records the fix/deploy/Sentry disposition; intake never auto-resolves Sentry merely because a task or PR exists.
- Kanban creation failures return a retryable 5xx, so Sentry retries instead of receiving a false-success acknowledgement.
- The intake server can be run persistently under launchd via `src/bin/install-launchd.ts`.

## Sentry upstream and retirement condition

As audited on 2026-07-30, the `proteusx-consulting` internal Sentry app `openclaw-control-plane-edcecd` subscribes to `issue` events and sends them to:

`https://kevins-mac-studio.tail1e86a2.ts.net/ingest/sentry`

Keep `ai.ccp.intake` loaded until the native Kanban path has been deployed, a signed synthetic issue fixture has returned a real task id without creating a duplicate on retry, and the Sentry app webhook destination has either moved to a non-CCP Hermes-owned receiver or been intentionally removed after confirming no issue intake is required. The final retirement lane must also prove all other retained intake routes have migrated or been retired before unloading the shared process.

## App-dispatched fix requests

External applications can submit fix requests via `POST /api/intake`. This endpoint supports HMAC signature verification and webhook callbacks.

### Endpoint

`POST /api/intake`

### Authentication

If `CONTROL_PLANE_SECRET` is set, the server verifies the `X-Signature-256` header using HMAC-SHA256 (same algorithm as outbound webhook callbacks — see [webhook-callback.md](webhook-callback.md)).

### Request body

```json
{
  "fixId": "fix_abc123",
  "title": "Fix broken checkout flow",
  "description": "Users see a 500 error on /checkout after latest deploy",
  "severity": "high",
  "repo": "myorg/my-app",
  "webhookUrl": "https://app.example.com/hooks/ccp",
  "context": { "pageUrl": "/checkout", "errorId": "sentry-123" }
}
```

### Behavior

1. Verifies HMAC signature (if `CONTROL_PLANE_SECRET` is set)
2. Auto-onboards unknown repos via the `onboard-repo` module (see [routing.md](routing.md#auto-onboarding))
3. Legacy app intake still creates a Linear ticket until its separate migration/removal lane completes
4. Optionally auto-dispatches to the job queue
5. Fires webhook callbacks as the job progresses (see [webhook-callback.md](webhook-callback.md))

### Dashboard and API endpoints

The intake server also serves the dashboard and REST API:

- `GET /dashboard` — Web UI
- `GET /api/jobs` — List jobs (supports `?state=X&limit=N`)
- `GET /api/jobs/:id` — Job details with status, packet, result, and log tail
- `GET /api/repos` — Repository config
- `PUT /api/repos/:key` — Update repo settings (autoMerge, mergeMethod, nightly)
- `GET /api/health` — System health check
- `GET /api/stats` — Daily/weekly stats, merge rate, avg duration
- `GET /api/scheduling` — Peak hour and dispatch status (includes rate limit info)
- `GET /api/events` — Server-Sent Events for real-time job updates

## Routing behavior

Incoming Sentry issue payloads route directly to native Hermes Kanban. Other legacy endpoints retain their existing behavior until their separately owned migration/removal lanes complete.

