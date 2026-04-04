# Linear setup

## Current YourOrg structure

Organization:
- `YourOrg`

Team:
- `YourOrg` (`PRO`)

Projects created for the coding ecosystem:
- `Control Plane`
- `Reliability / Incidents`
- `Product / Delivery`

## Why this structure

- `Control Plane` holds work on the automation/runtime itself.
- `Reliability / Incidents` is the landing zone for Sentry, Vercel, deploy, regression, and incident-driven bug intake.
- `Product / Delivery` is for planned engineering work and human-requested tasks.

This avoids organizing by repo, which breaks down for cross-repo work and for auto-created incident intake.

## Required config

The repo is now configured for the YourOrg team in `configs/linear.json`.

Fields:
- `apiKeyEnv`: environment variable containing the Linear API key
- `teamId`: Linear team id
- `teamKey`: human-readable team key
- `defaultStates`: workflow state mapping
- `projects`: project ids used for routing

Current team workflow on this machine:
- `Backlog`
- `Todo`
- `In Progress`
- `Done`

So the control-plane maps richer lifecycle states onto that simpler workflow.

## Smoke test

```bash
node src/bin/linear-sync.ts <job_id>
```

## Current behavior

- if a job has no cached Linear link, the sync step creates an issue
- then it updates the issue state based on job/result lifecycle
- then it posts a compact comment packet

Cached issue links are stored in:
- `supervisor/linear/job-links.json`
