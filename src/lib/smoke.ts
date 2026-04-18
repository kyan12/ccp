/**
 * Phase 4 (PR B): HTTP smoke-test runner for a PR's preview deployment URL.
 *
 * What this module does:
 *   1. Resolves the repo's `smoke` config (or applies defaults) and
 *      produces a final, merged `SmokeConfig` for the runner.
 *   2. Joins the preview URL with the configured path and performs a
 *      single HTTP GET with an AbortController-based timeout.
 *   3. Asserts the response status is in `expectStatus` and, when
 *      configured, that the HTML `<title>` matches `titleRegex`.
 *   4. Returns a `SmokeResult` shape that is stable across future
 *      runners (Playwright in PR C will produce the same shape).
 *
 * What this module does NOT do:
 *   - Gate the job state machine. Callers that want gating check
 *     `result.ok === false` themselves; Phase 4 PR D wires the gate.
 *   - Run from inside a browser. This is a pure HTTP fetch — good
 *     enough for "is the index route serving 200s" and "does the page
 *     title still mention the app". Phase 4 PR C replaces the fetch
 *     with Playwright for real browser behavior (JS eval, auth flows).
 *
 * Testing seam:
 *   - `runHttpSmoke()` accepts an `HttpFetcher` param; tests inject a
 *     synthetic fetcher so we never hit the real network. Production
 *     code uses `defaultFetcher` which wraps Node 20's built-in
 *     `fetch()` + `AbortSignal.timeout()`.
 *
 * Size note: the module is intentionally dependency-free. It uses
 * Node's native fetch (requires >= 20, matches package.json engines).
 */

import type { SmokeConfig, SmokeResult } from '../types';

// Defaults — exported for tests and downstream consumers.
export const DEFAULT_SMOKE_PATH = '/';
export const DEFAULT_SMOKE_STATUS = [200];
export const DEFAULT_SMOKE_TIMEOUT_SEC = 15;
export const DEFAULT_SMOKE_USER_AGENT = 'ccp-smoke/0.1';
// Cap body excerpts to keep result.json lean. Smoke failures surface in
// dashboards / Discord, not as raw HTML dumps — a couple of KB is plenty
// to see "404 Not Found" or "<title>ReferenceError</title>" without
// blowing up the per-job result file.
export const MAX_BODY_EXCERPT_BYTES = 2 * 1024;

/**
 * Internal response shape produced by the `HttpFetcher` seam. Kept
 * minimal so tests can synthesize responses without mocking the whole
 * Fetch API.
 */
export interface SmokeHttpResponse {
  status: number;
  body: string;
  timedOut?: boolean;
  networkError?: string;
}

export type HttpFetcher = (
  url: string,
  opts: { timeoutMs: number; userAgent: string },
) => Promise<SmokeHttpResponse>;

/**
 * Merge a (possibly-undefined) per-repo smoke config with defaults.
 * Pure function — exported for unit tests and for callers that need
 * the resolved shape (e.g. dashboards).
 */
export function resolveSmokeConfig(config: SmokeConfig | undefined): Required<SmokeConfig> {
  const c = config || {};
  const resolved: Required<SmokeConfig> = {
    enabled: c.enabled === true,
    path: typeof c.path === 'string' && c.path.length ? c.path : DEFAULT_SMOKE_PATH,
    expectStatus:
      Array.isArray(c.expectStatus) && c.expectStatus.length
        ? c.expectStatus.filter((n) => Number.isInteger(n))
        : DEFAULT_SMOKE_STATUS,
    titleRegex: typeof c.titleRegex === 'string' ? c.titleRegex : '',
    timeoutSec:
      typeof c.timeoutSec === 'number' && c.timeoutSec > 0
        ? c.timeoutSec
        : DEFAULT_SMOKE_TIMEOUT_SEC,
    userAgent:
      typeof c.userAgent === 'string' && c.userAgent.length
        ? c.userAgent
        : DEFAULT_SMOKE_USER_AGENT,
  };
  return resolved;
}

/**
 * Join a base URL (preview) with a configured path, handling the
 * common cases operators get wrong:
 *   - base = "https://app.vercel.app",     path = "/"        → "https://app.vercel.app/"
 *   - base = "https://app.vercel.app/",    path = "/api"     → "https://app.vercel.app/api"
 *   - base = "https://app.vercel.app/api", path = "/health"  → "https://app.vercel.app/api/health"
 *   - base = "https://app.vercel.app",     path = "api"      → "https://app.vercel.app/api"
 *   - base = "https://app.vercel.app",     path = ""         → "https://app.vercel.app/"
 *
 * We deliberately do NOT use `new URL(path, base)` because that would
 * resolve absolute paths against the base host, discarding any
 * base-path prefix (e.g. joining "/api" onto "https://x/prefix" would
 * drop "/prefix"). Operators who set a base path expect it preserved.
 */
export function joinPreviewUrl(baseUrl: string, path: string): string {
  const trimmedBase = baseUrl.replace(/\/+$/, '');
  const normalizedPath = path.startsWith('/') ? path : `/${path}`;
  if (normalizedPath === '/') return `${trimmedBase}/`;
  return `${trimmedBase}${normalizedPath}`;
}

/**
 * Extract the contents of the first `<title>` element, if any.
 * Intentionally lenient — HTML parsing in a regex is wrong in the
 * general case but the only failure modes here produce `null`, which
 * callers handle by returning a `title` failure kind.
 */
export function extractTitle(body: string): string | null {
  const m = body.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  if (!m || !m[1]) return null;
  // Collapse whitespace + trim. `</title>` bodies often span lines.
  return m[1].replace(/\s+/g, ' ').trim() || null;
}

/**
 * Truncate a body for diagnostic display. Returns a marker when the
 * body exceeds the cap, so operators know the excerpt is incomplete.
 */
export function truncateBodyExcerpt(body: string, maxBytes = MAX_BODY_EXCERPT_BYTES): string {
  if (!body) return '';
  // Byte-count via UTF-8; string.length is code units, not bytes.
  const buf = Buffer.from(body, 'utf8');
  if (buf.byteLength <= maxBytes) return body;
  const truncated = buf.subarray(0, maxBytes).toString('utf8');
  return `${truncated}\n\n[... truncated, ${buf.byteLength - maxBytes} more bytes ...]`;
}

function nowIso(): string {
  return new Date().toISOString();
}

/**
 * Default HTTP fetcher using Node 20+ built-in `fetch` + AbortSignal
 * timeouts. Not tested directly — all tests inject their own fetcher.
 */
export const defaultFetcher: HttpFetcher = async (url, opts) => {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), opts.timeoutMs);
  try {
    const res = await fetch(url, {
      method: 'GET',
      signal: controller.signal,
      headers: { 'User-Agent': opts.userAgent, Accept: 'text/html,*/*' },
      redirect: 'manual',
    });
    // Read up to MAX_BODY_EXCERPT_BYTES + some slack so the title regex
    // has room if the title is after a big head blob. Reading the whole
    // body is wasteful on large sites and unnecessary for a smoke test.
    const MAX_READ = MAX_BODY_EXCERPT_BYTES * 8;
    const reader = res.body?.getReader();
    let body = '';
    if (reader) {
      const decoder = new TextDecoder('utf-8', { fatal: false });
      let read = 0;
      while (read < MAX_READ) {
        const chunk = await reader.read();
        if (chunk.done) break;
        body += decoder.decode(chunk.value, { stream: true });
        read += chunk.value.byteLength;
      }
      body += decoder.decode();
      // Cancel the underlying stream so we don't hold the connection.
      try { await reader.cancel(); } catch {}
    }
    return { status: res.status, body };
  } catch (e) {
    const err = e as Error & { name?: string };
    if (err.name === 'AbortError') {
      return { status: 0, body: '', timedOut: true };
    }
    return { status: 0, body: '', networkError: err.message || String(err) };
  } finally {
    clearTimeout(t);
  }
};

/**
 * Run a single HTTP smoke check against a preview URL.
 *
 * @param previewUrl   The PR's preview deployment URL (from pr-review's
 *                     extractPreviewUrl). If null/empty, returns a
 *                     `kind: 'skipped'` result immediately.
 * @param rawConfig    Per-repo smoke config (pre-resolution).
 * @param fetcher      Injected HTTP fetcher — defaults to Node fetch.
 */
export async function runHttpSmoke(
  previewUrl: string | null | undefined,
  rawConfig: SmokeConfig | undefined,
  fetcher: HttpFetcher = defaultFetcher,
): Promise<SmokeResult> {
  const cfg = resolveSmokeConfig(rawConfig);
  const started = Date.now();

  if (!cfg.enabled) {
    return {
      ok: false,
      url: previewUrl || '',
      durationMs: 0,
      finishedAt: nowIso(),
      failure: { kind: 'skipped', message: 'smoke disabled for this repo' },
    };
  }
  if (!previewUrl) {
    return {
      ok: false,
      url: '',
      durationMs: 0,
      finishedAt: nowIso(),
      failure: { kind: 'skipped', message: 'no preview URL detected yet' },
    };
  }

  const url = joinPreviewUrl(previewUrl, cfg.path);

  let response: SmokeHttpResponse;
  try {
    response = await fetcher(url, {
      timeoutMs: cfg.timeoutSec * 1000,
      userAgent: cfg.userAgent,
    });
  } catch (e) {
    const err = e as Error;
    return {
      ok: false,
      url,
      durationMs: Date.now() - started,
      finishedAt: nowIso(),
      failure: { kind: 'unknown', message: err.message || String(err) },
    };
  }

  const durationMs = Date.now() - started;

  if (response.timedOut) {
    return {
      ok: false,
      url,
      durationMs,
      finishedAt: nowIso(),
      failure: {
        kind: 'timeout',
        message: `GET ${url} timed out after ${cfg.timeoutSec}s`,
      },
    };
  }
  if (response.networkError) {
    return {
      ok: false,
      url,
      durationMs,
      finishedAt: nowIso(),
      failure: {
        kind: 'network',
        message: response.networkError,
      },
    };
  }

  const statusOk = cfg.expectStatus.includes(response.status);
  const title = extractTitle(response.body);

  if (!statusOk) {
    return {
      ok: false,
      url,
      status: response.status,
      title,
      durationMs,
      finishedAt: nowIso(),
      failure: {
        kind: 'status',
        message: `got status ${response.status}, expected one of ${cfg.expectStatus.join(', ')}`,
        bodyExcerpt: truncateBodyExcerpt(response.body),
      },
    };
  }

  if (cfg.titleRegex) {
    const re = new RegExp(cfg.titleRegex, 'i');
    if (!title || !re.test(title)) {
      return {
        ok: false,
        url,
        status: response.status,
        title,
        durationMs,
        finishedAt: nowIso(),
        failure: {
          kind: 'title',
          message: title
            ? `title "${title}" did not match /${cfg.titleRegex}/i`
            : `response body had no <title> to match /${cfg.titleRegex}/i`,
          bodyExcerpt: truncateBodyExcerpt(response.body),
        },
      };
    }
  }

  return {
    ok: true,
    url,
    status: response.status,
    title,
    durationMs,
    finishedAt: nowIso(),
  };
}

module.exports = {
  DEFAULT_SMOKE_PATH,
  DEFAULT_SMOKE_STATUS,
  DEFAULT_SMOKE_TIMEOUT_SEC,
  DEFAULT_SMOKE_USER_AGENT,
  MAX_BODY_EXCERPT_BYTES,
  resolveSmokeConfig,
  joinPreviewUrl,
  extractTitle,
  truncateBodyExcerpt,
  runHttpSmoke,
  defaultFetcher,
};
