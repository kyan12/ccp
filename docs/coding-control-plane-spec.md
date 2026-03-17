# Coding Control Plane Spec

_Last updated: 2026-03-11_

## Purpose

This spec defines a dedicated coding-only OpenClaw system whose job is to turn well-scoped engineering tasks into reliable code changes with clear status, observability, error intake, and verification.

This machine is separate from the main business/ops OpenClaw. Its purpose is to reduce context pollution, improve coding quality, and create a reliable execution loop around Claude Code on Opus.

---

## 1. Goals

The coding system should let the operator:

1. Write down what needs to be accomplished in detail
2. Have that task converted into a tracked job/ticket
3. Run Claude Code on Opus as the actual coding worker
4. Get reliable START / RUNNING / DONE / FAIL / BLOCKED status
5. See logs and recent output when needed
6. Catch build/runtime/deploy failures and route them back into the coding queue
7. Avoid silent failures, lost tasks, and half-finished work

---

## 2. Non-goals

This machine should **not** be responsible for:

- household reminders
- general assistant chat
- iMessage / personal messaging
- business operations routing
- long-term personal memory
- non-technical coordination except as needed for coding jobs

This is an engineering runtime, not a general-purpose assistant.

---

## 3. Core principles

1. **Claude Code Opus writes the code**
   - OpenClaw manages and observes jobs
   - Claude Code performs the actual repo edits/build/test work

2. **Every coding task is a ticket**
   - no orphan tasks living only in chat
   - no hidden background work

3. **Every coding run is a job**
   - every job has a status, logs, timestamps, and result packet

4. **Done means verified, not intended**
   - completion must include commit/deploy/verification state

5. **Failure should create clarity, not silence**
   - failed jobs must return actionable error packets

---

## 4. Architecture overview

The system has 5 layers:

### Layer 1 — Intake / Ticketing
- Linear is the source of truth for tasks
- Tickets may be created manually by the operator or auto-created from failure intake

### Layer 2 — Coding Agent / Orchestrator
- OpenClaw coding agent monitors tickets and manages jobs
- It does not do the coding itself
- It prepares task packets and supervises worker execution

### Layer 3 — Job Supervisor
- Custom supervisor process launches and tracks coding jobs
- Uses tmux as process substrate
- Maintains logs, status files, and reporting hooks

### Layer 4 — Coding Worker
- Claude Code on Opus (`claude-opus`) runs in repo and performs edits/tests/builds

### Layer 5 — Error Ingestion
- Vercel build failures
- runtime errors (e.g. Sentry)
- manual bug reports
- cron/runtime failures
- all route into Linear as issues or update existing tickets

---

## 5. Required components

### A. Ticket system
**Choice:** Linear

Why:
- persistent source of truth
- API-friendly
- fast enough for daily use
- good status model
- suitable for both manual and auto-created issues

### B. Coding worker
**Choice:** Claude Code on Opus via `claude-opus`

Requirements:
- runs on local machine, not OpenClaw API coding path
- uses Claude Max subscription / approved auth
- all code execution goes through this path

### C. Process substrate
**Choice:** tmux

Why:
- reliable long-running sessions
- observable pane output
- can interrupt/inspect/restart
- lightweight and proven

### D. Supervisor
**Choice:** custom local supervisor (CLI + daemon)

This is the most important missing piece.

### E. Error monitoring
**Choices:**
- Vercel deployment/build logs for CI/deploy failures
- Sentry for runtime exceptions
- lightweight manual error intake format for user reports

---

## 6. Linear workflow

### Recommended teams / scopes
Create one Linear team for coding operations, or one shared engineering team with project labels.

### Recommended states
- **Inbox** — new task, not yet normalized
- **Ready** — ready to run
- **Running** — active coding job in progress
- **Blocked** — waiting on human/env/credentials/clarification
- **Review** — coded, needs validation/review
- **Verified** — confirmed working
- **Closed** — completed and done

### Recommended labels
- `bug`
- `feature`
- `deploy`
- `runtime`
- `regression`
- `autocreated`
- `urgent`

### Rule
Every coding job must map to exactly one ticket.

---

## 7. Job lifecycle

Each coding execution is a **job**.

### States
- `queued`
- `preflight`
- `running`
- `waiting_input`
- `retrying`
- `failed`
- `blocked`
- `done`
- `verified`

### Lifecycle
1. Ticket enters `Ready`
2. Coding agent creates job packet
3. Supervisor runs preflight checks
4. tmux session starts Claude Code worker
5. Logs stream to file and status store
6. On exit:
   - success → Review/Verified depending on validation
   - failure → Failed or Blocked with error packet
7. Completion packet sent to the operator / control channel

---

## 8. Job packet schema

Each job should be normalized into a structured packet.

```json
{
  "job_id": "job_20260311_abc123",
  "ticket_id": "ENG-142",
  "repo": "/home/user/repos/my-app",
  "base_branch": "main",
  "working_branch": "claude/eng-142-fix-meta-flow",
  "goal": "Fix broken Meta page selection flow and verify deploy",
  "constraints": [
    "Use existing patterns",
    "Do not rewrite unrelated settings pages"
  ],
  "acceptance_criteria": [
    "User can select a Facebook Page after connect",
    "Selection persists server-side",
    "Typecheck passes",
    "Vercel build passes"
  ],
  "verification_steps": [
    "Run typecheck",
    "Run targeted test if present",
    "Verify preview or deployed flow"
  ],
  "priority": "high",
  "created_at": "2026-03-11T15:00:00Z"
}
```

---

## 9. Supervisor responsibilities

The supervisor is responsible for:

1. Creating job IDs
2. Creating tmux session/window per job
3. Launching `claude-opus`
4. Streaming output to log file
5. Updating status JSON
6. Reporting START / FAIL / DONE
7. Providing recent-output snapshots
8. Allowing interrupt / retry / tail
9. Recording exit code and elapsed time
10. Packaging result summary for the coding agent

### Recommended interfaces
CLI commands like:

- `jobs enqueue <packet.json>`
- `jobs start <job_id>`
- `jobs list`
- `jobs show <job_id>`
- `jobs tail <job_id>`
- `jobs interrupt <job_id>`
- `jobs retry <job_id>`
- `jobs result <job_id>`

---

## 10. Preflight checks before job start

Every job should validate:

1. repo exists
2. git working tree is clean or intentionally handled
3. correct base branch is available
4. auth is valid for Claude Code
5. required env vars are present
6. package manager/dependencies are installed
7. deploy target or test environment is reachable if needed

If preflight fails, do **not** burn Claude quota. Mark job `blocked` or `failed_preflight`.

---

## 11. Observability requirements

Minimum observability per job:

### Files
- `jobs/<job_id>/packet.json`
- `jobs/<job_id>/status.json`
- `jobs/<job_id>/worker.log`
- `jobs/<job_id>/result.json`

### status.json fields
- job_id
- ticket_id
- repo
- state
- started_at
- updated_at
- elapsed_sec
- tmux_session
- last_heartbeat_at
- last_output_excerpt
- exit_code

### Required commands
- view active jobs
- tail logs
- inspect last output
- interrupt job
- retry job

Optional later:
- tiny local web dashboard
- Discord slash-style controls
- recent failures board

---

## 12. Completion contract

A job is **not** “done” based only on coding intent.

Every result packet must include:

- **State:** coded / deployed / verified / blocked
- **Commit:** hash or `none`
- **Prod:** yes/no
- **Verified:** exact test or `not yet`
- **Blocker:** only if blocked

### Examples

#### Good
- State: verified
- Commit: `abc1234`
- Prod: yes
- Verified: connected Meta Page selection works in preview and production callback path

#### Bad
- “I think it’s fixed”
- “The agent completed successfully”
- “Done” with no commit or verification

---

## 13. Error ingestion design

The system must catch 3 types of failures.

### A. Build/deploy failures
Sources:
- Vercel build logs
- CI failures
- failed deploy commands

Behavior:
- create or update Linear ticket
- attach branch / commit / deploy URL / error excerpt
- mark `deploy` label

### B. Runtime exceptions
Source:
- Sentry

Use Sentry for:
- frontend crashes
- backend uncaught exceptions
- release-linked regressions
- frequency/severity tracking

Behavior:
- create/update Linear issue on threshold
- include route, stack, user impact, release version

### C. Manual/user-reported bugs
Source:
- the operator message
- business agent handoff
- structured issue form

Behavior:
- normalize into ticket packet
- route to Linear Inbox

---

## 14. Auto-fix loop policy

Not every error should auto-trigger coding.

### Auto-create ticket
Yes for:
- failed deploys
- repeated runtime exceptions
- clear regressions with logs

### Auto-run fix attempt
Only for:
- known/repeatable low-risk failures
- previously seen deploy/build issues
- explicit opt-in categories

### Human review required first
For:
- schema/migration risk
- production data correction
- ambiguous product behavior
- anything with unclear acceptance criteria

---

## 15. Quota management

Claude Max quota is limited, so the scheduler should:

1. cap concurrent heavy jobs (default: 1)
2. prioritize urgent/high-value tasks during daytime
3. defer low-priority/refactor jobs to off-hours
4. avoid retry storms
5. preserve quota for bugfixes and deploy blockers

### Suggested queue classes
- `urgent`
- `high`
- `normal`
- `background`

### Suggested policy
- urgent can preempt background
- background jobs only run in low-usage windows
- one long-running job at a time by default

---

## 16. Communication back to the operator

the operator should get compact, reliable updates.

### Start message
- ticket
- repo
- branch
- short goal

### Done message
- State
- Commit
- Prod
- Verified
- URL/log if relevant

### Fail message
- failure type
- exact blocker
- whether retry is safe
- whether human input is required

No silent completions.

---

## 17. Recommended directory structure on the coding machine

```text
~/coding-control-plane/
  jobs/
    job_*/
      packet.json
      status.json
      worker.log
      result.json
  supervisor/
    cli/
    daemon/
  configs/
    linear.json
    routing.json
    quotas.json
  docs/
    coding-control-plane-spec.md
```

---

## 18. MVP build plan

Build this in 4 phases.

### Phase 1 — Basic job runner
- tmux-backed runner
- enqueue/start/list/tail/interrupt
- logs + status files
- reliable DONE/FAIL callback

### Phase 2 — Linear integration
- pull Ready tickets
- push Running/Blocked/Review updates
- attach result packets to tickets

### Phase 3 — Error ingestion
- Vercel failure ingestion
- Sentry-to-ticket routing
- manual bug normalization

### Phase 4 — Dashboard and retry logic
- lightweight local dashboard
- queue visualization
- retry policy
- auto-escalation for repeated failures

---

## 19. Suggested success criteria for the new machine

This system is successful if the operator can:

1. create a task once
2. see that it entered the queue
3. observe when work starts
4. get a reliable completion/failure report
5. inspect logs if needed
6. trust that failed deploys/runtime regressions become tickets automatically

The system fails if:
- tasks disappear
- jobs complete silently
- coding happens outside tracked tickets
- failures are not surfaced clearly
- Claude quota is burned on preventable setup issues

---

## 20. Final recommendation

Build a dedicated coding-only OpenClaw machine with:

- Linear for tickets
- Claude Code Opus for execution
- tmux-based custom supervisor for control/observability
- Sentry + Vercel log ingestion for errors
- strict completion packets with verification state

This machine should be treated as an engineering runtime, not a general assistant.
