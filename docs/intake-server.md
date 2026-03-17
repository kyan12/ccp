# Intake server

A lightweight local HTTP server can normalize incoming incident payloads into routed YourOrg Linear issues.

## Endpoints

- `POST /ingest/vercel`
- `POST /ingest/sentry`
- `POST /ingest/manual`

## Run locally

```bash
node src/bin/intake-server.js
```

Default port:
- `4318`

Override:

```bash
CCP_INTAKE_PORT=4319 node src/bin/intake-server.js
```

## Security

Vercel webhook verification uses:
- `configs/vercel.json` -> `webhookSecretEnv`
- the corresponding secret value from environment / 1Password

Current behavior:
- if no Vercel webhook secret is configured, verification is effectively disabled
- Sentry route is currently trust-based and should be put behind a private ingress or a signature check later
- the intake server can be run persistently under launchd via `src/bin/install-launchd.js`

## Behavior

Incoming payloads are normalized and routed:
- control-plane work -> `Control Plane`
- Sentry / Vercel / deploy / runtime / regression -> `Reliability / Incidents`
- manual / planned work -> `Product / Delivery`

