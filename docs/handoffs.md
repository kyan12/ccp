# Business Crab → Code Crab handoffs

This document defines the structured handoff contract between the business/operator agent and the coding/control-plane agent.

## Purpose

Keep **knowledge**, **workflow**, and **agent runtime state** separate:

- durable shared knowledge → brain + gbrain
- explicit work state → CCP / Linear / callbacks
- agent-local runtime state → local to Business Crab and Code Crab

A handoff message is **not** the system of record. The structured packet and callback are.

## Required fields

Every serious coding handoff should include these fields.

```text
TASK_ID: PX-2026-04-17-001
REQUESTOR: Kevin
ORIGIN: discord:#business-code-handoff
OBJECTIVE: Implement X
WHY_IT_MATTERS: Business/client impact
EXACT_DELIVERABLE: Concrete output expected from Code Crab
CONTEXT_REFS:
- brain://projects/shared-brain
- linear://PRO-600
DONE_WHEN:
- acceptance criterion 1
- acceptance criterion 2
CONSTRAINTS:
- scope guard 1
- scope guard 2
VERIFICATION_STEPS:
- run test command
- validate user-facing behavior
CALLBACK_REQUIRED: yes
COMPLETION_ROUTING: direct | relay
WRITEBACK_REQUIRED:
- update project page if architecture changed
- record postmortem if durable root cause found
```

## Completion routing

`COMPLETION_ROUTING` is an **explicit enum**, never inferred:

| Value | Meaning | Callback behaviour |
|---|---|---|
| `direct` | CCP fires callback straight to the origin/requestor endpoint. Code Crab is not in the return path. | Hermes receives the structured payload and posts directly to the origin thread. |
| `relay` | CCP returns to Code Crab, who composes a human-readable message and relays it to the requestor. | Callback payload includes `target_audience` and `relay_message` fields. |

When `completion_routing` is omitted from the intake, CCP logs a warning and defaults to `direct`.

## Mapping into CCP

These fields map into CCP manual intake like this:

- `TASK_ID` → `ticket_id` when a stable external task identifier already exists
- `REQUESTOR` → `requestor`
- `ORIGIN` → `origin`
- `OBJECTIVE` → `goal`
- `WHY_IT_MATTERS` → `why_it_matters`
- `EXACT_DELIVERABLE` → `exact_deliverable`
- `CONTEXT_REFS` → `context_refs[]`
- `DONE_WHEN` → `acceptance_criteria[]`
- `CONSTRAINTS` → `constraints[]`
- `VERIFICATION_STEPS` → `verification_steps[]`
- `CALLBACK_REQUIRED` → `callback_required`
- `COMPLETION_ROUTING` → `completion_routing` (`direct` | `relay`)
- `WRITEBACK_REQUIRED` → `writeback_required[]`

## Intake validation

When `handoff_id` is present, CCP checks for:

- `completion_routing` — how the result should be returned
- `exact_deliverable` — what the requestor expects
- `verification_steps` — how to confirm the deliverable
- `callback_required` or `callback_url` — where to send the result

Missing fields generate a warning attached to `metadata.handoff_warnings` (visible in the Linear ticket and job logs). The job still proceeds — hard-blocking on optional fields would break existing manual intake paths.

## Example: direct-report handoff

The requestor wants the result posted straight back to the origin thread.

```json
{
  "title": "Fix login regression on staging",
  "description": "Login flow is broken after the session middleware swap.",
  "repo": "ProteusX-Consulting/proteusx-labs",
  "kind": "bug",
  "handoff_id": "hc_20260426_001",
  "origin": "discord:#business-code-handoff",
  "requestor": "Kevin",
  "why_it_matters": "Staging demo to client is Monday.",
  "exact_deliverable": "Merged fix with passing CI.",
  "context_refs": ["linear://PRO-580"],
  "acceptance_criteria": ["Login flow works on staging", "No session token regressions"],
  "verification_steps": ["npm test", "curl the login endpoint on staging"],
  "callback_required": true,
  "completion_routing": "direct",
  "writeback_required": ["Record postmortem if root cause is non-obvious"]
}
```

CCP fires the completion callback directly to Hermes, which posts the result to `discord:#business-code-handoff`.

## Example: Code-Crab-relay handoff

The requestor wants Code Crab to compose a human-readable summary before it goes back.

```json
{
  "title": "Implement token cost dashboard",
  "description": "Add a dashboard page showing per-agent token costs.",
  "repo": "ProteusX-Consulting/proteusx-labs",
  "kind": "feature",
  "handoff_id": "hc_20260426_002",
  "origin": "discord:#business-code-handoff",
  "requestor": "Kevin",
  "why_it_matters": "Need cost visibility before scaling agent fleet.",
  "exact_deliverable": "PR with dashboard page + screenshot.",
  "context_refs": ["brain://projects/cost-accounting", "linear://PRO-590"],
  "acceptance_criteria": ["Dashboard renders per-agent costs", "Data refreshes on page load"],
  "verification_steps": ["npm test", "Start dev server and verify dashboard"],
  "callback_required": true,
  "completion_routing": "relay",
  "writeback_required": ["Update cost-accounting project page with new dashboard URL"]
}
```

CCP's completion callback includes `target_audience` (Kevin) and `relay_message` (a human-readable summary composed by Code Crab). Code Crab then relays that message to the origin channel.

## Callback payload

The structured completion callback includes:

| Field | Type | Description |
|---|---|---|
| `handoff_id` | string | Echoed from the intake |
| `status` | `done` / `blocked` / `failed` | Terminal state |
| `completion_routing` | `direct` / `relay` | Echoed from intake |
| `summary` | string | What happened |
| `artifacts.pr` | string | PR URL if any |
| `artifacts.commit` | string | Commit hash |
| `artifacts.branch` | string | Branch name |
| `verification.commands` | string[] | What was run |
| `verification.results` | string | Output summary |
| `blockers` | string[] | Why it's blocked/failed (empty when done) |
| `writeback_notes` | string[] | Durable notes to persist |
| `needs_kevin` | boolean | Escalation flag |
| `next_recommended_action` | string | Suggestion for what to do next |
| `target_audience` | string? | Only present when `relay` — who to address |
| `relay_message` | string? | Only present when `relay` — human-readable message |

## Field preservation

Structured handoff fields survive the full pipeline:

```
intake payload → buildIncidentPacket → JobPacket
  → normalizeJobToLinearIssue → Linear description (## Handoff / ## Context References / ## Writeback Required)
  → issueToPacket (parses sections back) → JobPacket
  → buildPrompt (--- BEGIN HANDOFF --- section) → worker prompt
  → finalizeJob → fireHandoffCallback → structured callback payload
```

### Stale-worker reconciliation (PRO-583)

A worker that gets interrupted (operator kill, hung tmux session) jumps
straight to `state=blocked` via `interruptJob` and never reaches
`finalizeJob`, so the handoff callback never fires inline. If the PR
that worker pushed is later merged anyway, `pr-watcher` reconciles the
gap by firing the deferred handoff callback once the merge is observed:

```
interruptJob → state=blocked, notifications.final=false  (no callback yet)
  → operator merges PR
  → pr-watcher cycle detects merged=true
  → maybeFireMergeHandoffCallback (handoff-callback.ts)
  → state→done, notifications.final=true,
    integrations.handoffCallback={fired,via:'pr-watcher'}
```

Idempotency: both `finalizeJob` and `pr-watcher` stamp
`integrations.handoffCallback.fired=true` after a successful fire, and
`maybeFireMergeHandoffCallback` short-circuits on that flag — so the
callback is delivered exactly once even when both paths race or when
the watcher runs many cycles against the same merged PR.

## Writeback expectations

`writeback_required` should only trigger **durable** technical writeback:

Examples:
- architecture decisions that will matter later
- implementation constraints discovered during execution
- bug postmortems with root cause + fix
- project-page updates after material system changes

Non-examples:
- raw shell logs
- temporary TODOs
- branch chatter
- transient debugging notes
