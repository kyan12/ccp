# Preview-URL Smoke Tests (Phase 4 PRs B–D)

After the [preview-URL extractor](./preview-url.md) detects a PR's Vercel
deployment URL, the supervisor can run a lightweight smoke test against
it. Three runners are supported:

- `http` (default, from PR B) — a dependency-free `fetch` that checks
  status + optional `<title>` regex.
- `playwright` (PR C) — launches a real headless browser (Chromium /
  Firefox / WebKit), navigates to the preview URL, and optionally
  evaluates a JS expression inside the page.
- `agent-browser` — shells out to Vercel Labs `agent-browser` for
  agent-readable browser evidence: screenshots, accessibility snapshots,
  console/errors, and optional trace/HAR artifacts.

**Phase 4 PR D** additionally lets failures gate the job state and
auto-spawn a `__deployfix` remediation. Gating is **opt-in** per repo
(`smoke.gate: true`) and defaults off, so upgrading to PR D is
backwards-compatible — every repo stays informational-only until you
explicitly flip the flag.

## What it does

For every watchable job with `result.pr_url` set, the pr-watcher cycle:

1. Runs `reviewPr(prUrl)` and extracts the preview URL.
2. If the repo's `smoke.enabled` is true, sends `GET <previewUrl><path>`
   with `AbortSignal.timeout(timeoutSec)`.
3. Asserts:
   - Response status is in `expectStatus` (default `[200]`).
   - If `titleRegex` is set, the body's `<title>` matches it
     case-insensitively.
4. Persists the `SmokeResult` to:
   - `status.integrations.smoke`
   - `result.smoke`
5. Appends a line to `worker.log`:
   ```
   pr-watcher: smoke https://app-abc.vercel.app/ — ok (status=200, 427ms)
   ```

## Configuration

Opt in per repo via `configs/repos.json`:

```json
{
  "mappings": [
    {
      "key": "my-app",
      "ownerRepo": "acme/my-app",
      "localPath": "/srv/repos/my-app",
      "smoke": {
        "enabled": true,
        "runner": "http",
        "path": "/api/health",
        "expectStatus": [200, 204],
        "titleRegex": "My App",
        "timeoutSec": 10,
        "userAgent": "ccp-smoke/0.1"
      }
    }
  ]
}
```

| Field          | Default          | Notes                                                      |
| -------------- | ---------------- | ---------------------------------------------------------- |
| `enabled`      | `false`          | Master switch. Smoke is skipped unless true.               |
| `path`         | `/`              | Joined to the preview URL, preserving any base-path prefix. |
| `expectStatus` | `[200]`          | Status codes treated as success.                           |
| `titleRegex`   | *(none)*         | Optional; applied to first `<title>` element, case-insensitive. |
| `timeoutSec`   | `15`             | Wall clock, enforced via `AbortController`.                |
| `userAgent`    | `ccp-smoke/0.1`  | Forwarded as `User-Agent` header.                          |
| `runner`       | `http`           | `http`, `playwright`, or `agent-browser`. See below for browser runners. |
| `playwright`   | `{}`             | Sub-config passed to the Playwright runner when `runner:'playwright'`. |
| `agentBrowser` | `{}`             | Sub-config passed to the Vercel Labs `agent-browser` runner when `runner:'agent-browser'`. |
| `gate`         | `false`          | Phase 4 PR D — when true, a failing smoke result blocks the job and spawns `__deployfix`. See [Gating](#gating-phase-4-pr-d). |

## Playwright runner (PR C)

When `runner: "playwright"`, the supervisor spawns a short-lived Node
subprocess (`dist/lib/playwright-smoke-runner.js`) that:

1. `require('playwright')` lazily (the package is optional — see
   [Installing Playwright](#installing-playwright) below).
2. Launches the configured browser engine.
3. Creates a page with the configured viewport + `User-Agent`.
4. `page.goto(previewUrl+path, { waitUntil })` within
   `timeoutSec * 1000` ms.
5. Asserts `response.status()` is in `expectStatus`.
6. Extracts `page.title()` and applies the optional `titleRegex`.
7. Optionally evaluates `assertExpression` inside `page.evaluate()`.
   A falsy return value is recorded as a `kind: 'title'` failure
   (reused so the `SmokeResult.failure.kind` enum stays stable).
8. On any failure, if `screenshotOnFailure` is true (default) and the
   supervisor provided `playwrightOptions.jobId`, saves a PNG to
   `jobs/<jobId>/smoke-failure.png` and populates
   `SmokeResult.failure.screenshotPath`.

Config shape:

```json
{
  "smoke": {
    "enabled": true,
    "runner": "playwright",
    "path": "/",
    "expectStatus": [200],
    "titleRegex": "My App",
    "timeoutSec": 30,
    "userAgent": "ccp-smoke/0.1 (+playwright)",
    "playwright": {
      "browser": "chromium",
      "waitUntil": "load",
      "viewport": { "width": 1280, "height": 800 },
      "assertExpression": "!document.body.innerText.includes('Application error')",
      "screenshotOnFailure": true
    }
  }
}
```

| `playwright.*` field   | Default              | Notes                                                             |
| ---------------------- | -------------------- | ----------------------------------------------------------------- |
| `browser`              | `chromium`           | One of `chromium`, `firefox`, `webkit`.                           |
| `waitUntil`            | `load`               | Playwright's page-goto wait strategy.                             |
| `viewport`             | `{1280,800}`         | Width/height in CSS pixels.                                       |
| `assertExpression`     | *(none)*             | JS expression evaluated inside `page.evaluate()`; must be truthy. |
| `screenshotOnFailure`  | `true`               | Saves `jobs/<jobId>/smoke-failure.png` on any failure.            |

### Installing Playwright

Playwright is **opt-in**; the supervisor compiles and runs fine without
it. If you flip a repo to `runner: "playwright"` without installing the
package, the first cycle will emit a `kind: 'unknown'` failure with an
actionable message. To install:

```bash
# in the CCP supervisor checkout
npm i playwright
npx playwright install chromium
```

You only need the browser engine(s) you reference in `playwright.browser`.

### Isolation

Playwright runs in a short-lived subprocess spawned per smoke check and
exits after emitting a single JSON object on stdout. The supervisor
never imports `playwright` or holds a browser context between cycles,
so a misbehaving renderer can't leak into the long-running daemon.



## Agent-browser runner

When `runner: "agent-browser"`, the supervisor uses the optional Vercel Labs
`agent-browser` CLI as an evidence-oriented browser smoke runner. It follows the
same isolation principle as the Playwright runner: CCP does not host a browser in
the long-running supervisor process. Each browser action is a bounded, short-lived
CLI call with a JSON/stdout boundary, so missing binaries, timeouts, non-zero
exits, and malformed output become stable `SmokeResult` failures instead of
leaking browser state into the daemon.

Use this runner when the operator needs artifacts that help an agent or human
understand what happened on a new preview, not just whether a health endpoint
returned 200.

Config shape:

```json
{
  "smoke": {
    "enabled": true,
    "runner": "agent-browser",
    "path": "/",
    "expectStatus": [200],
    "titleRegex": "My App",
    "timeoutSec": 30,
    "userAgent": "ccp-smoke/0.1 (+agent-browser)",
    "agentBrowser": {
      "binary": "agent-browser",
      "snapshot": true,
      "artifacts": {
        "screenshot": true,
        "console": true,
        "errors": true,
        "har": false,
        "trace": false
      }
    }
  }
}
```

| `agentBrowser.*` field | Default | Notes |
| ---------------------- | ------- | ----- |
| `binary`               | `agent-browser` | CLI binary or absolute path. |
| `snapshot`             | `true`  | Captures an accessibility snapshot to `agent-browser-snapshot.json`. |
| `artifacts.screenshot` | `true`  | Records the screenshot path returned by the CLI. |
| `artifacts.console`    | `true`  | Saves console output to `agent-browser-console.json`. |
| `artifacts.errors`     | `true`  | Saves browser errors to `agent-browser-errors.json`. |
| `artifacts.har`        | `false` | Starts/stops `network har` and records `agent-browser-network.har`. This is version-dependent; enable only on hosts with a compatible/latest `agent-browser`. |
| `artifacts.trace`      | `false` | Starts/stops `trace` and records `agent-browser-trace.zip` when supported. |
| `extraArgs`            | `[]`    | Extra CLI args appended to each `agent-browser` call. |

### Installing agent-browser

`agent-browser` is **opt-in**; CCP compiles and runs without it. If a repo is set
to `runner: "agent-browser"` but the binary is missing, smoke returns a verbose
`kind: 'unknown'` failure telling the operator to install/configure the binary
rather than crashing supervisor startup.

```bash
# in the CCP supervisor checkout
npm i -D agent-browser
npx agent-browser install
```

The package is published by Vercel Labs. Keep it pinned/rolled out deliberately:
older local versions may support screenshots/traces but not `network har`, while
newer versions expose additional evidence commands. HAR is therefore default-off
and should be enabled per host after a CLI capability check.

### Evidence in blockers

When gated `agent-browser` smoke fails, `buildSmokeBlocker()` includes artifact
paths in the remediation feedback when present:

- browser screenshot
- accessibility snapshot
- browser console
- browser errors
- network HAR
- browser trace

Do not assume video recording is available from this runner until the installed
`agent-browser` CLI on the supervisor host exposes a stable record/video command.

## Failure kinds

`SmokeResult.failure.kind` is one of:

| Kind       | Meaning                                                              |
| ---------- | -------------------------------------------------------------------- |
| `timeout`  | Request exceeded `timeoutSec`.                                       |
| `network`  | DNS / TCP / TLS error before a response arrived.                     |
| `status`   | HTTP status was not in `expectStatus`.                               |
| `title`    | Response body had no `<title>` or didn't match `titleRegex`.         |
| `skipped`  | `smoke.enabled` is false or no preview URL has been detected yet.    |
| `unknown`  | Catch-all for unexpected exceptions from the fetcher.                |

## Gating (Phase 4 PR D)

When `smoke.gate: true` (per repo) **and** a failing `SmokeResult` is
produced (`ok: false` and `failure.kind !== 'skipped'`), the pr-watcher
cycle:

1. Sets `result.state = 'blocked'`,
   `result.blocker_type = 'smoke-failed'`, `result.prod = 'no'`, and
   appends a `smoke:<kind>` entry to `result.failed_checks` (deduped
   against any existing failing-check names from PR-review).
2. Writes a human-readable `result.blocker` with the failure kind, URL,
   status, title, and duration.
3. If `CCP_PR_REMEDIATE_ENABLED` is not `false`, spawns a
   `__deployfix` remediation job on the **existing PR branch** with the
   full smoke failure context in `review_feedback`. The remediation's
   agent is instructed to push fixes to the same branch, not open a new
   PR.

The remediation depth-guard (`__deployfix|__reviewfix|__valfix` in the
job ID) prevents a smoke-failed remediation from re-spawning another
`__deployfix` — one layer of auto-remediation per original ticket.

### Global override

Set `CCP_SMOKE_GATE=true` on the supervisor process to force gating on
across every repo (useful for a fleet-wide canary), or `=false` to
hard-disable it regardless of per-repo config. Any ambiguous value
(`maybe`, `null`, `""`, unset) falls through to the per-repo flag.

### Operator workflow for `blocker_type: 'smoke-failed'`

1. The dashboard surfaces the blocker message and the `smoke:<kind>`
   failed check, along with the preview URL.
2. The spawned `__deployfix` job picks up the existing branch and its
   agent tries to fix the runtime issue — typically a missing env var, a
   runtime error, or a broken build output.
3. When `__deployfix` pushes, the next watcher cycle re-runs smoke
   against the redeployed preview. If it passes, the original job's PR
   can be merged normally; the `smoke-failed` blocker never auto-clears
   on its own, so operators explicitly transition the parent job back to
   `coded`/`done` once the remediation lands and they've re-verified.
4. If the root cause is external (Vercel outage, third-party API), the
   remediation agent should leave a precise blocker note rather than
   flail indefinitely.

## How to consume

Downstream tools (dashboard, Discord bot, remediation) should read
`result.smoke` (the stable per-job record) rather than re-running the
smoke themselves. Always check `smoke.ok` and `smoke.failure?.kind`
before acting.

Example, in JS/TS:

```ts
const result = JSON.parse(fs.readFileSync(resultPath(jobId), 'utf8'));
if (result.smoke && result.smoke.ok === false) {
  console.warn(`smoke failed for ${jobId}: ${result.smoke.failure?.message}`);
}
```

## Testing

`src/lib/smoke.test.ts` covers:

- `resolveSmokeConfig` — defaults, overrides, invalid-value filtering.
- `joinPreviewUrl` — trailing slashes, base paths, missing leading slash.
- `extractTitle` — case-insensitive, whitespace collapse, attributes.
- `truncateBodyExcerpt` — byte-accurate, short bodies untouched.
- `runHttpSmoke`:
  - Skipped when disabled / preview URL missing.
  - Happy path (status + title match).
  - Each failure kind: `status`, `title` (mismatch), `title` (missing),
    `timeout`, `network`, `unknown`.
  - Custom `expectStatus`, `timeoutSec` (ms forwarding), `titleRegex`
    case-insensitivity.
- All HTTP is faked via an injected `HttpFetcher`; no real network.

## Known limitations

- Only supports a **single URL** per repo. Multi-URL checks arrive in a
  later PR.
- No auth. If the preview requires Vercel SSO or a Vercel bypass secret
  (`vercel-automation-bypass-secret`), the smoke will hit the login
  wall. Header support is a PR D follow-up.
- The HTTP runner reads the body with a cap of ~16KB — enough for the
  `<title>` regex but not for full-body assertions. The Playwright
  runner has no such cap since assertions run inside the browser.
- `agent-browser` HAR capture is version-dependent and default-off. On older
  CLI versions, enable screenshots/snapshots/console/errors first and leave
  `smoke.agentBrowser.artifacts.har` disabled until `agent-browser network har`
  is supported on the supervisor host.
- CCP does not promise video recording from smoke runs yet; add it only after
  verifying the installed `agent-browser` CLI exposes stable record/video commands.

## Rollout

1. Land PR B (HTTP runner) — gate off; no repo automatically gains
   smoke since `enabled` defaults to false.
2. Flip `smoke.enabled: true` (and optionally `runner: "playwright"` or
   `runner: "agent-browser"`) on one low-risk repo in `configs/repos.json`.
3. Watch `worker.log` for `pr-watcher: smoke …` lines on the next
   cycle. Confirm pass/fail accuracy against your repo's expected
   behavior.
4. Land PR D (gate + `__deployfix` remediation). Gate stays **off**
   (`smoke.gate: false` by default) so nothing changes for existing
   repos.
5. When smoke results are trusted on a repo, flip `smoke.gate: true`
   for that repo and redeploy the supervisor. The next failing smoke
   on that repo will transition its job to
   `blocked (blocker_type: smoke-failed)` and spawn a `__deployfix`
   remediation job on the existing PR branch.
6. (Optional) Set `CCP_SMOKE_GATE=true` globally once every repo is
   healthy enough to tolerate gating. This is equivalent to setting
   `smoke.gate: true` on every mapping; `CCP_SMOKE_GATE=false`
   hard-disables gating fleet-wide and overrides per-repo `gate: true`
   — useful for a quick kill-switch during provider outages.
