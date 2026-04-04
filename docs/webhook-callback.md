# Webhook Callbacks

When an external app dispatches a fix request via `/api/intake`, it can include a `webhookUrl` and `fixId` in the request metadata. CCP will POST status updates back to that URL as the job progresses through its lifecycle.

Implementation: `src/lib/webhook-callback.ts`

## Metadata fields

| Field | Location | Description |
|-------|----------|-------------|
| `webhookUrl` | `metadata.webhookUrl` | HTTPS endpoint to receive callbacks |
| `fixId` | `metadata.fixId` | Caller-provided identifier linking the callback to the original fix request |

Both fields must be present for callbacks to fire. If either is missing, the callback is silently skipped.

### Nested metadata support

The intake normalizer may wrap the original payload, resulting in nested metadata:

```
packet.metadata.metadata.webhookUrl
packet.metadata.metadata.fixId
```

`extractWebhookMeta(packet)` checks both levels. Top-level metadata takes precedence over nested values.

## HMAC signing

If `CONTROL_PLANE_SECRET` is set, each callback POST includes an HMAC signature:

- **Algorithm:** HMAC-SHA256
- **Secret:** Value of `CONTROL_PLANE_SECRET` environment variable
- **Signed data:** The raw JSON request body
- **Header:** `X-Signature-256: sha256=<hex-digest>`

If `CONTROL_PLANE_SECRET` is not set, the signature header is omitted.

### Verification example

```js
const crypto = require('crypto');

function verifySignature(body, secret, signatureHeader) {
  const expected = 'sha256=' + crypto
    .createHmac('sha256', secret)
    .update(body)
    .digest('hex');
  return crypto.timingSafeEqual(
    Buffer.from(expected),
    Buffer.from(signatureHeader)
  );
}
```

## Payload structure

```json
{
  "fixId": "fix_abc123",
  "requestId": "ENG-142",
  "status": "pr_open",
  "prUrl": "https://github.com/org/repo/pull/42",
  "linearTicketId": "ENG-142",
  "error": null
}
```

| Field | Type | Description |
|-------|------|-------------|
| `fixId` | `string` | The caller-provided fix identifier from the original request |
| `requestId` | `string` | The CCP ticket/job ID (falls back to `jobId` if no ticket) |
| `status` | `string` | Current job status (see below) |
| `prUrl` | `string \| null` | GitHub PR URL if a PR was created |
| `linearTicketId` | `string \| null` | Linear issue ID if a ticket was created |
| `error` | `string \| null` | Error message (present only when `status` is `failed`) |

## Status values

| Status | When sent | Meaning |
|--------|-----------|---------|
| `pr_open` | Job finishes with state `coded` | PR created, awaiting CI/review |
| `merged` | PR watcher detects merge | PR merged successfully |
| `verified` | Job reaches `verified` state | Change verified in production |
| `failed` | Job reaches `blocked` or `failed` | Job failed with error |

## When callbacks fire

Callbacks are triggered at two points in the lifecycle:

1. **Job finalization** (`finalizeJob()` in `jobs.ts`) — After a worker completes, fires with `pr_open` or `failed` based on job outcome.
2. **PR watcher cycle** (`runPrWatcherCycle()` in `pr-watcher.ts`) — Fires `merged`, `verified`, or `failed` as PRs progress through review and merge.

Callbacks are fire-and-forget. Network errors are logged to stderr but do not affect job processing.

## Environment variables

| Variable | Required | Description |
|----------|----------|-------------|
| `CONTROL_PLANE_SECRET` | No | Shared secret for HMAC signing of both inbound `/api/intake` requests and outbound webhook callbacks |
