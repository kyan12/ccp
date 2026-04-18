# Preview-URL Smoke Tests (Phase 4 PR B)

After the [preview-URL extractor](./preview-url.md) detects a PR's Vercel
deployment URL, the supervisor can run a lightweight HTTP smoke test
against it. Failures are persisted and logged but — in this PR — do
**not** gate the job state. Phase 4 PR D will promote this to a gate.

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
  later PR — typically not needed until Playwright (PR C) lands.
- No auth. If the preview requires Vercel SSO or a Vercel bypass secret
  (`vercel-automation-bypass-secret`), the smoke will hit the login
  wall. Header support is a PR C follow-up.
- Body is read with a cap of ~16KB — enough for the `<title>` regex but
  not for full-body assertions.

## Rollout

1. Land this PR (gate off — safe to merge; no repo automatically gains
   smoke since `enabled` defaults to false).
2. Flip `smoke.enabled: true` on one repo in `configs/repos.json`.
3. Watch `worker.log` for `pr-watcher: smoke …` lines on the next
   cycle. Confirm pass/fail accuracy against your repo's expected
   behavior.
4. Repeat for additional repos. Land PR C (Playwright) when HTTP
   checks become insufficient.
