# Operations

## Manual checks

```bash
node src/bin/jobs.ts doctor /path/to/repo
node src/bin/jobs.ts status
node src/bin/supervisor.ts --once
```

## Human decision requests

When a worker pauses with `blocker_type: operator-decision`, answer it from an operator shell with:

```bash
ccp-jobs decide <job_id> <option-id> [note]
```

Discord/Hermes bridges can answer the same request without shell access by POSTing JSON to the intake server:

```bash
curl -X POST http://localhost:${CCP_INTAKE_PORT:-4318}/api/decide \
  -H 'content-type: application/json' \
  -H "authorization: Bearer $CCP_DECISION_API_TOKEN" \
  -d '{"jobId":"<job_id>","choice":"<option-id>","note":"optional note"}'
```

The decision POST route requires `CCP_DECISION_API_TOKEN` (or `CONTROL_PLANE_SECRET`) so arbitrary Discord/web clients cannot answer decisions.

Operator decisions are opt-in (`decisionMode: ask|hybrid` or repo/env policy); the default mode is `auto`, so normal CCP jobs run through without requiring a human decision.

This queues a continuation job with the selected answer. See [decisions.md](./decisions.md) for policy modes and config.

## Long-running supervisor

```bash
node src/bin/supervisor.ts --interval=15000 --max-concurrent=1
```

## Long-running intake server

```bash
node src/bin/intake-server.ts
```

## launchd install

```bash
node src/bin/install-launchd.ts
launchctl load ~/Library/LaunchAgents/ai.openclaw.coding-control-plane.plist
launchctl start ai.openclaw.coding-control-plane
launchctl load ~/Library/LaunchAgents/ai.openclaw.coding-control-plane.intake.plist
launchctl start ai.openclaw.coding-control-plane.intake
```

The generated plists inject a PATH that includes Homebrew binaries so `tmux`, `node`, `openclaw`, `claude`, and `op` are available under launchd. The intake service defaults to port `4318`.

Note: if macOS prompts that `node` wants access to another app during first live intake handling, allow it. That permission was required on this machine before launchd-managed intake requests would complete.

## Outage detection

The supervisor includes a circuit breaker for Anthropic API outages (`src/lib/outage.ts`).

### How it works

Worker logs are scanned for API error patterns after each job completes:
- `API Error: 5xx` responses
- `overloaded_error`, `529` status codes
- `ECONNRESET`, `ETIMEDOUT`, `ECONNREFUSED`
- `anthropic.*unavailable`, `service.*unavailable`

When **2 consecutive** API failures are detected, the supervisor enters **outage mode** and pauses all new job dispatch.

### State file

Outage state is persisted at `configs/outage.json`:

```json
{
  "outage": true,
  "consecutiveApiFailures": 2,
  "lastFailureAt": "2026-04-01T03:15:00.000Z",
  "outageSince": "2026-04-01T03:15:00.000Z",
  "lastProbeAt": "2026-04-01T03:20:00.000Z",
  "lastProbeResult": "fail",
  "rateLimitResetAt": null,
  "rateLimitReason": null
}
```

### Recovery probes

While in outage mode, the supervisor runs a probe each cycle using `claude --print` with a minimal request. When the probe succeeds:
1. Outage flag is cleared
2. Consecutive failure counter resets to 0
3. Discord notification is sent
4. Job dispatch resumes automatically

### Manual override

To clear outage mode manually (e.g. after confirming the API is back), call `clearOutage()` from `src/lib/outage.ts`. This resets the outage flag, failure counter, and `outageSince` timestamp.

## Rate limit pausing

Separate from outage detection, the supervisor detects Claude rate limit messages in worker logs.

### Detection

Rate limit patterns are matched against log output:
- `hit your limit...resets 2pm`
- `rate limit...reset...3:00 PM`
- `usage limit...reset...14:00`

The reset time is parsed from the human-readable string, converted to an ISO timestamp (accounting for timezone, defaults to `America/New_York`), and stored in `configs/outage.json` as `rateLimitResetAt`.

### Behavior during pause

While `rateLimitResetAt` is in the future:
- The supervisor skips starting new jobs
- Running jobs are not interrupted
- The supervisor continues its normal cycle (monitoring running jobs, PR watching)
- Once `Date.now() >= rateLimitResetAt`, the rate limit clears automatically and dispatch resumes

### Checking rate limit status

The `isRateLimited()` function returns the current pause state and reset time. The dashboard `/api/scheduling` endpoint also surfaces this information.

## Runtime artifacts

- `jobs/<job_id>/packet.json`
- `jobs/<job_id>/status.json`
- `jobs/<job_id>/worker.log`
- `jobs/<job_id>/result.json`
- `supervisor/daemon/heartbeat.json`
- `supervisor/daemon/launchd.stdout.log`
- `supervisor/daemon/launchd.stderr.log`
- `supervisor/daemon/intake.stdout.log`
- `supervisor/daemon/intake.stderr.log`
