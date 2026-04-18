# Preview deployment URL detection

**Phase 4 (PR A) — informational only in this PR.** Later Phase 4 PRs feed
this URL into a browser smoke runner.

## What it does

When `pr-watcher` polls a PR-backed job, it now asks `gh pr view` for the
PR's comment thread in addition to the status-check rollup it was already
fetching. From those two sources it tries to extract the PR's live
preview deployment URL and persists it to:

- `status.integrations.prReview.previewUrl` (per-watch cycle)
- `result.preview_url` (stable per-job record, mirrored once on change)
- `worker.log` — single line `pr-watcher: preview URL detected — <url>`

Nothing in this PR acts on the URL beyond persisting it. Existing
state-machine behavior is unchanged.

## Where the URL comes from

Two sources, in preference order:

1. **Vercel bot PR comments** — Vercel posts a comment with the exact
   preview URL once the deployment is ready (e.g.
   `Preview: https://my-app-abc.vercel.app`). We scan comments
   newest-first so redeploys pick up the latest URL.
2. **Vercel-named check URLs** — as a fallback, any check whose `name`
   matches `/vercel/i` and whose `detailsUrl` points to a `*.vercel.app`
   host (dashboard URLs like `https://vercel.com/...` are filtered out).

## Known limitations

Intentionally kept narrow for this PR to reduce risk:

- **Custom domains** — a preview served at `my-app.example.com` instead
  of `my-app-abc.vercel.app` won't be auto-detected. Future PRs will let
  repos override the regex per `configs/repos.json`.
- **Non-Vercel providers** — Netlify, Cloudflare Pages, Railway, Render,
  etc. aren't supported yet. Same future-PR story.
- **Empty comment threads** — if the Vercel bot hasn't posted yet (early
  in the PR lifecycle), `previewUrl` is null. The watcher will pick it up
  on the next cycle.

## Consuming the URL

For local inspection:

```bash
cat "$CCP_ROOT/jobs/<job_id>/result.json" | jq .preview_url
```

For downstream code:

```ts
import type { JobResult } from '../types';
const result: JobResult = readJson(resultPath(jobId));
if (result.preview_url) {
  // ... do something with the preview URL
}
```

## Testing

`src/lib/pr-review.test.ts` covers the `extractPreviewUrl` pure function
with synthetic `checks` / `comments` fixtures (no network, no `gh`
shell-outs). End-to-end the only way to verify is to point the
supervisor at a PR with a Vercel preview and watch the `pr-watcher` log.
