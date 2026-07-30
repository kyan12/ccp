# Preview deployment URL detection

> **Historical behavior.** The current bounded CCP drain may retain the latest
> detected URL in `status.integrations.prReview.previewUrl` for its two named
> jobs, but it no longer mirrors that value into `result.preview_url` or invokes
> a browser smoke runner. Native Hermes Kanban owns new PR verification.

## What it does

When the historical `pr-watcher` polls one of its two named drain jobs, it asks `gh pr view` for the
PR's comment thread in addition to the status-check rollup it was already
fetching. From those two sources it may extract the PR's live
preview deployment URL and persist it to:

- `status.integrations.prReview.previewUrl` (per-watch cycle)

The drain does not act on the URL beyond that status reconciliation.

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

For local inspection of a named drain job:

```bash
cat "$CCP_ROOT/jobs/<job_id>/status.json" | jq .integrations.prReview.previewUrl
```

## Testing

`src/lib/pr-review.test.ts` covers the `extractPreviewUrl` pure function
with synthetic `checks` / `comments` fixtures (no network, no `gh`
shell-outs). Do not point the production watcher at unrelated jobs to test it;
the drain cohort is intentionally fixed.
