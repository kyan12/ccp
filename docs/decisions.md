# Human decision policy

CCP can now make Devin-style operator decision requests without letting workers ask free-form questions in chat.

## Modes

Decision policy resolves in this order:

1. `CCP_DECISION_MODE` env override
2. `JobPacket.decisionMode`
3. `JobPacket.decisionPolicy.mode`
4. `RepoMapping.decisionPolicy.mode`
5. default: `hybrid`

Supported modes:

- `hybrid` — default. Worker makes low-risk calls, but pauses for configured high-impact triggers or confidence below threshold.
- `ask` — worker pauses for any important ambiguous decision before high-impact changes.
- `auto` — worker always makes its best judgment and logs rationale.
- `never-block` — same non-blocking posture as `auto`, useful as a hard override when throughput matters more than human gating.

## Repo config

`configs/repos.json`:

```json
{
  "mappings": [
    {
      "key": "my-app",
      "localPath": "/Users/me/repos/my-app",
      "decisionPolicy": {
        "mode": "hybrid",
        "promptOn": [
          "production_risk",
          "destructive_action",
          "architecture_choice",
          "scope_expansion",
          "low_confidence",
          "data_migration",
          "auth_or_billing",
          "secrets_or_credentials"
        ],
        "confidenceThreshold": 0.75,
        "timeoutMinutes": 60,
        "defaultTimeoutAction": "recommended"
      }
    }
  ]
}
```

## Per-job override

```json
{
  "ticket_id": "PRO-123",
  "decisionMode": "ask"
}
```

or:

```json
{
  "ticket_id": "PRO-123",
  "decisionMode": "auto"
}
```

## Global override

```bash
export CCP_DECISION_MODE=auto
export CCP_DECISION_CONFIDENCE_THRESHOLD=0.8
export CCP_DECISION_TIMEOUT_MINUTES=120
```

## Worker protocol

When the policy says to ask, the worker must stop and emit a single-line JSON block:

```text
DecisionRequest: {"question":"Patch or refactor?","options":[{"id":"A","label":"Patch","tradeoff":"smaller diff"},{"id":"B","label":"Refactor","tradeoff":"cleaner long-term, touches more files"}],"recommended":"A","risk":"medium","confidence":0.62,"reason":"shared auth helper affects multiple flows"}
State: blocked
Blocker: Decision needed: Patch or refactor?
```

CCP captures this into `status.integrations.decision`, marks the result as `blocker_type: operator-decision`, and posts a Discord message with a command.

## Answering a decision

Use:

```bash
ccp-jobs decide <job_id> <option-id> [note]
```

Example:

```bash
ccp-jobs decide job_20260430_120000_abc123 A "prefer the small patch"
```

CCP creates a continuation job named:

```text
<parent_job_id>__decision_<option-id>
```

The continuation inherits the original packet and branch context, adds the human decision as `review_feedback`, and sets `decisionMode: auto` so the worker does not ask the same question again.

## Notes

- This is an auditable stop/resume loop, not free-form chat with the worker.
- Discord buttons are not required; text command routing keeps the MVP deterministic.
- `defaultTimeoutAction` is persisted in the prompt contract for workers, but automatic timeout execution is not implemented yet.
