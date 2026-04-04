# Intake server

A lightweight local HTTP server can normalize incoming incident payloads into routed YourOrg Linear issues.

## Endpoints

- `POST /ingest/vercel`
- `POST /ingest/sentry`
- `POST /ingest/manual`

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
- if no Vercel webhook secret is configured, verification is effectively disabled
- Sentry route is currently trust-based and should be put behind a private ingress or a signature check later
- the intake server can be run persistently under launchd via `src/bin/install-launchd.ts`

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
3. Creates a Linear ticket with `webhookUrl` and `fixId` stored in metadata
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

Incoming payloads are normalized and routed:
- control-plane work -> `Control Plane`
- Sentry / Vercel / deploy / runtime / regression -> `Reliability / Incidents`
- manual / planned work -> `Product / Delivery`

