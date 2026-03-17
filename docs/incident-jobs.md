# Incident to job flow

The control plane can now do two different things with normalized incident intake:

## 1. File only
Create a routed Linear issue without queueing code work:

```bash
node src/bin/intake-linear.js sentry sample-sentry.json
```

## 2. File + enqueue job
Create the Linear issue and immediately enqueue a coding job linked to the new ticket:

```bash
node src/bin/intake-dispatch.js sentry sample-sentry.json --enqueue-job
```

## 3. Job only
Queue a coding job from a normalized incident payload without creating Linear first:

```bash
node src/bin/intake-job.js sentry sample-sentry.json
```

## Recommended policy

Default to **file only** for external incident intake until confidence is high.

Then selectively enable **file + enqueue job** for:
- well-understood repos
- low-risk incident classes
- deploy/runtime failures with predictable remediation

That keeps the system safe while still supporting full automation later.
