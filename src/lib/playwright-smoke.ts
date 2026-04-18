/**
 * Phase 4 (PR C): Playwright smoke-test orchestrator.
 *
 * The supervisor daemon must not host a browser: leaking a Playwright
 * context, a Chromium process, or an event-loop timer in the long-running
 * daemon would destabilize every other job on the host. So we run
 * Playwright in a short-lived Node child process (`playwright-smoke-
 * runner.js`) and talk to it via JSON-on-stdio.
 *
 * This module provides two things:
 *
 *   1. `runPlaywrightSmoke(previewUrl, rawConfig, executor?)` — returns a
 *      stable `SmokeResult` regardless of whether the child crashed,
 *      timed out, printed garbage, or exited cleanly with a structured
 *      payload. The shape matches `runHttpSmoke()` exactly so callers
 *      (pr-watcher, dashboards) don't care which runner produced the
 *      result.
 *
 *   2. `defaultPlaywrightExecutor` — a `spawnSync`-based executor that
 *      runs the compiled child runner script. Tests inject their own
 *      executor, so `spawnSync` is never called from tests.
 *
 * Design notes:
 *   - The child reads its input from stdin (JSON), not argv, to avoid
 *     shell-quoting pitfalls on large configs.
 *   - The child writes exactly one JSON object on stdout. Any other
 *     stdout content is treated as corruption.
 *   - Playwright itself is an OPTIONAL dependency. The child detects
 *     missing `playwright` and emits a structured error — the supervisor
 *     does not need playwright installed for tests to run.
 *   - The supervisor adds a fixed wall-clock buffer on top of the
 *     per-request `timeoutSec` to give the browser startup room, then
 *     kills the child via spawnSync's own timeout. Any timeout from the
 *     supervisor's side becomes `kind: 'timeout'`; a timeout inside
 *     Playwright becomes whatever the child reports.
 */

import fs = require('fs');
import path = require('path');
import { spawnSync } from 'child_process';
import type { SmokeConfig, SmokeResult, PlaywrightSmokeConfig } from '../types';

// Buffer on top of the user-configured timeoutSec, for browser startup.
// If the browser can't even launch within this window, we fail the whole
// smoke with kind: 'timeout' from the supervisor side.
export const PLAYWRIGHT_STARTUP_BUFFER_MS = 10_000;
// Cap on the stdout/stderr buffers from the child. Matches validator.ts.
export const PLAYWRIGHT_MAX_BUFFER_BYTES = 32 * 1024 * 1024;
// Cap on body excerpts emitted by the child.
export const PLAYWRIGHT_BODY_EXCERPT_BYTES = 2 * 1024;

// Defaults for the Playwright-specific sub-config. Exported for tests
// and downstream consumers (dashboards, docs).
export const DEFAULT_PLAYWRIGHT_BROWSER: PlaywrightSmokeConfig['browser'] = 'chromium';
export const DEFAULT_PLAYWRIGHT_WAIT_UNTIL: PlaywrightSmokeConfig['waitUntil'] = 'load';
export const DEFAULT_PLAYWRIGHT_VIEWPORT = { width: 1280, height: 800 };
export const DEFAULT_PLAYWRIGHT_SCREENSHOT_ON_FAILURE = true;

/**
 * Merged Playwright sub-config with all defaults resolved. Exported for
 * tests; also used by the child runner so there's one source of truth.
 */
export function resolvePlaywrightConfig(c: PlaywrightSmokeConfig | undefined): Required<PlaywrightSmokeConfig> {
  const raw = c || {};
  const browser = raw.browser === 'firefox' || raw.browser === 'webkit' ? raw.browser : DEFAULT_PLAYWRIGHT_BROWSER;
  const waitUntil = (
    raw.waitUntil === 'domcontentloaded' || raw.waitUntil === 'networkidle' || raw.waitUntil === 'commit'
      ? raw.waitUntil
      : DEFAULT_PLAYWRIGHT_WAIT_UNTIL
  );
  const viewport =
    raw.viewport &&
    typeof raw.viewport.width === 'number' &&
    typeof raw.viewport.height === 'number' &&
    raw.viewport.width > 0 &&
    raw.viewport.height > 0
      ? { width: raw.viewport.width, height: raw.viewport.height }
      : DEFAULT_PLAYWRIGHT_VIEWPORT;
  return {
    browser: browser || DEFAULT_PLAYWRIGHT_BROWSER,
    waitUntil: waitUntil || DEFAULT_PLAYWRIGHT_WAIT_UNTIL,
    viewport,
    assertExpression: typeof raw.assertExpression === 'string' ? raw.assertExpression : '',
    screenshotOnFailure:
      typeof raw.screenshotOnFailure === 'boolean'
        ? raw.screenshotOnFailure
        : DEFAULT_PLAYWRIGHT_SCREENSHOT_ON_FAILURE,
  } as Required<PlaywrightSmokeConfig>;
}

function nowIso(): string {
  return new Date().toISOString();
}

/**
 * Input handed to the child runner. JSON-encoded and piped over stdin.
 */
export interface PlaywrightRunnerInput {
  previewUrl: string;
  path: string;
  expectStatus: number[];
  titleRegex: string;
  timeoutMs: number;
  userAgent: string;
  playwright: Required<PlaywrightSmokeConfig>;
  /**
   * Absolute path where the child should write `smoke-failure.png` on
   * failure (when `screenshotOnFailure` is true). When empty, the child
   * skips the screenshot. The supervisor resolves this to
   * `jobs/<id>/smoke-failure.png` when a jobId is provided; otherwise
   * the screenshot is skipped.
   */
  screenshotPath: string;
}

/**
 * JSON shape produced by the child runner on stdout. NOT a `SmokeResult`
 * directly — the orchestrator adds `url`, `durationMs`, `finishedAt`
 * after wrapping. Keeping the shapes separate means the child can stay
 * pure (no wall-clock timestamps, no URL joining).
 */
export interface PlaywrightRunnerOutput {
  ok: boolean;
  status: number | null;
  title: string | null;
  failure?: {
    kind: SmokeResult['failure'] extends infer F
      ? F extends { kind: infer K }
        ? K
        : never
      : never;
    message: string;
    bodyExcerpt?: string;
  };
  screenshotPath?: string;
}

/**
 * Raw output from the subprocess executor. The orchestrator translates
 * this into a `SmokeResult`.
 */
export interface PlaywrightExecutorResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  /** True when spawnSync killed the child due to its own `timeout` option. */
  timedOut: boolean;
  /** Non-timeout spawn error (e.g. ENOENT when `node` is missing). */
  spawnError?: string;
}

export type PlaywrightExecutor = (
  input: PlaywrightRunnerInput,
  opts: { timeoutMs: number },
) => PlaywrightExecutorResult;

/**
 * Resolve the path to the compiled child runner script. The supervisor
 * is always run from the compiled `dist/` tree (see `bin/` entries), so
 * this file's `__dirname` is `dist/lib/`. The runner script sits next
 * to it as `playwright-smoke-runner.js`.
 */
export function defaultChildScriptPath(): string {
  return path.join(__dirname, 'playwright-smoke-runner.js');
}

/**
 * Default executor: spawns the compiled child runner via `node`. Never
 * called from unit tests — tests inject their own executor.
 */
export const defaultPlaywrightExecutor: PlaywrightExecutor = (input, opts) => {
  const scriptPath = defaultChildScriptPath();
  const result = spawnSync('node', [scriptPath], {
    input: JSON.stringify(input),
    encoding: 'utf8',
    timeout: opts.timeoutMs,
    maxBuffer: PLAYWRIGHT_MAX_BUFFER_BYTES,
    killSignal: 'SIGTERM',
  });
  const timedOut =
    result.error !== null &&
    result.error !== undefined &&
    (result.error as NodeJS.ErrnoException).code === 'ETIMEDOUT';
  return {
    stdout: typeof result.stdout === 'string' ? result.stdout : '',
    stderr: typeof result.stderr === 'string' ? result.stderr : '',
    exitCode: typeof result.status === 'number' ? result.status : null,
    timedOut,
    spawnError: result.error && !timedOut ? String(result.error) : undefined,
  };
};

/**
 * Robustly extract the runner's JSON payload from stdout. The child
 * prints exactly one JSON object; but a noisy dependency (like a
 * browser binary printing warnings) could prepend junk. We take the
 * LAST complete top-level JSON object in the stream.
 */
export function parseRunnerStdout(stdout: string): PlaywrightRunnerOutput | null {
  if (!stdout) return null;
  // Fast path: whole stdout is the JSON object.
  const trimmed = stdout.trim();
  if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
    try {
      return JSON.parse(trimmed) as PlaywrightRunnerOutput;
    } catch {
      // fall through to tolerant scan
    }
  }
  // Tolerant scan: walk backwards from the last '{', trying progressively
  // earlier candidates. `String#lastIndexOf(ch, -1)` returns 0 (not -1) —
  // per spec, negative fromIndex is clamped to 0 — so we must decrement
  // `i` strictly to avoid an infinite loop on input that starts with `{`.
  let i = stdout.lastIndexOf('{');
  while (i >= 0) {
    const candidate = stdout.slice(i).trim();
    if (candidate.endsWith('}')) {
      try {
        return JSON.parse(candidate) as PlaywrightRunnerOutput;
      } catch {
        // fall through to the next-earlier brace
      }
    }
    if (i === 0) break;
    i = stdout.lastIndexOf('{', i - 1);
  }
  return null;
}

/**
 * Path joining that preserves base-path prefixes. Identical semantics to
 * `joinPreviewUrl` in `smoke.ts` — duplicated here to avoid a circular
 * require during module load (pr-watcher → smoke → playwright-smoke).
 */
function joinUrl(baseUrl: string, p: string): string {
  const trimmedBase = baseUrl.replace(/\/+$/, '');
  const normalizedPath = p.startsWith('/') ? p : `/${p}`;
  if (normalizedPath === '/') return `${trimmedBase}/`;
  return `${trimmedBase}${normalizedPath}`;
}

export interface RunPlaywrightSmokeOptions {
  /**
   * Per-job ID for screenshot destination. When omitted, `screenshotPath`
   * is empty and the child skips the screenshot. Most callers should
   * pass the job ID so operators can diagnose failures visually.
   */
  jobId?: string;
  /**
   * Base directory for the jobs tree. Defaults to `process.env.CCP_ROOT`
   * / `jobs/`, matching the rest of the supervisor. Exposed for tests.
   */
  jobsDir?: string;
}

/**
 * Run a single Playwright-backed smoke check against a preview URL.
 *
 * @param previewUrl   PR's preview URL (from extractPreviewUrl). Falsy
 *                     → `kind: 'skipped'` result immediately.
 * @param rawConfig    Per-repo smoke config (pre-resolution). The
 *                     `runner` field must be `playwright` or this
 *                     function's behavior is the same as if it were.
 * @param executor     Injected subprocess executor. Tests override this.
 * @param opts         Per-call options (jobId for screenshots, etc.).
 */
export async function runPlaywrightSmoke(
  previewUrl: string | null | undefined,
  rawConfig: SmokeConfig | undefined,
  executor: PlaywrightExecutor = defaultPlaywrightExecutor,
  opts: RunPlaywrightSmokeOptions = {},
): Promise<SmokeResult> {
  const c = rawConfig || {};
  const started = Date.now();

  if (!c.enabled) {
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

  const reqPath = typeof c.path === 'string' && c.path.length ? c.path : '/';
  const expectStatus =
    Array.isArray(c.expectStatus) && c.expectStatus.length
      ? (() => {
          const filtered = c.expectStatus!.filter((n) => Number.isInteger(n));
          return filtered.length ? filtered : [200];
        })()
      : [200];
  const timeoutSec = typeof c.timeoutSec === 'number' && c.timeoutSec > 0 ? c.timeoutSec : 15;
  const timeoutMs = timeoutSec * 1000;
  const userAgent = typeof c.userAgent === 'string' && c.userAgent.length ? c.userAgent : 'ccp-smoke/0.1';
  const pw = resolvePlaywrightConfig(c.playwright);

  const url = joinUrl(previewUrl, reqPath);

  // Resolve screenshot destination when a jobId is available and the
  // user opted into screenshots. Otherwise we pass an empty string so
  // the child skips that step.
  let screenshotPath = '';
  if (opts.jobId && pw.screenshotOnFailure) {
    const jobsDir =
      opts.jobsDir ||
      path.resolve(process.env.CCP_ROOT || path.join(__dirname, '..', '..'), 'jobs');
    try {
      const jobDir = path.join(jobsDir, opts.jobId);
      if (!fs.existsSync(jobDir)) fs.mkdirSync(jobDir, { recursive: true });
      screenshotPath = path.join(jobDir, 'smoke-failure.png');
    } catch (e) {
      // Best-effort; if we can't mkdir we just skip the screenshot.
      screenshotPath = '';
    }
  }

  const input: PlaywrightRunnerInput = {
    previewUrl,
    path: reqPath,
    expectStatus,
    titleRegex: typeof c.titleRegex === 'string' ? c.titleRegex : '',
    timeoutMs,
    userAgent,
    playwright: pw,
    screenshotPath,
  };

  let exec: PlaywrightExecutorResult;
  try {
    exec = executor(input, { timeoutMs: timeoutMs + PLAYWRIGHT_STARTUP_BUFFER_MS });
  } catch (e) {
    return {
      ok: false,
      url,
      durationMs: Date.now() - started,
      finishedAt: nowIso(),
      failure: { kind: 'unknown', message: (e as Error).message || String(e) },
    };
  }

  const durationMs = Date.now() - started;

  if (exec.timedOut) {
    return {
      ok: false,
      url,
      durationMs,
      finishedAt: nowIso(),
      failure: {
        kind: 'timeout',
        message: `playwright runner timed out after ${timeoutSec}s (+${PLAYWRIGHT_STARTUP_BUFFER_MS / 1000}s startup buffer)`,
      },
    };
  }

  if (exec.spawnError) {
    return {
      ok: false,
      url,
      durationMs,
      finishedAt: nowIso(),
      failure: {
        kind: 'unknown',
        message: `failed to spawn playwright runner: ${exec.spawnError}`,
      },
    };
  }

  const parsed = parseRunnerStdout(exec.stdout);
  if (!parsed) {
    const stderrTail = exec.stderr.slice(-512);
    return {
      ok: false,
      url,
      durationMs,
      finishedAt: nowIso(),
      failure: {
        kind: 'unknown',
        message:
          `playwright runner produced no parseable JSON on stdout (exit=${exec.exitCode ?? 'null'})` +
          (stderrTail ? `: ${stderrTail.trim()}` : ''),
      },
    };
  }

  // Wrap the child's structured result into a SmokeResult.
  if (parsed.ok) {
    return {
      ok: true,
      url,
      status: parsed.status ?? undefined,
      title: parsed.title ?? null,
      durationMs,
      finishedAt: nowIso(),
    };
  }

  const failure = parsed.failure || { kind: 'unknown' as const, message: 'unknown playwright failure' };
  return {
    ok: false,
    url,
    status: parsed.status ?? undefined,
    title: parsed.title ?? null,
    durationMs,
    finishedAt: nowIso(),
    failure: {
      kind: failure.kind as SmokeResult['failure'] extends { kind: infer K } ? K : 'unknown',
      message: failure.message,
      ...(failure.bodyExcerpt ? { bodyExcerpt: failure.bodyExcerpt } : {}),
    },
  };
}

module.exports = {
  PLAYWRIGHT_STARTUP_BUFFER_MS,
  PLAYWRIGHT_MAX_BUFFER_BYTES,
  PLAYWRIGHT_BODY_EXCERPT_BYTES,
  DEFAULT_PLAYWRIGHT_BROWSER,
  DEFAULT_PLAYWRIGHT_WAIT_UNTIL,
  DEFAULT_PLAYWRIGHT_VIEWPORT,
  DEFAULT_PLAYWRIGHT_SCREENSHOT_ON_FAILURE,
  resolvePlaywrightConfig,
  parseRunnerStdout,
  defaultChildScriptPath,
  defaultPlaywrightExecutor,
  runPlaywrightSmoke,
};
