/* Unit tests for Phase 4 PR C — Playwright smoke orchestrator + dispatcher.
 *
 * Scope: the supervisor-side `runPlaywrightSmoke()` and the `runSmoke()`
 * dispatcher in `smoke.ts`. The actual Playwright child runner is not
 * covered here (it requires a real `playwright` install + a browser
 * binary) — every branch that's reachable from the orchestrator is
 * tested via an injected executor seam.
 */

import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import {
  PLAYWRIGHT_STARTUP_BUFFER_MS,
  DEFAULT_PLAYWRIGHT_BROWSER,
  DEFAULT_PLAYWRIGHT_WAIT_UNTIL,
  DEFAULT_PLAYWRIGHT_VIEWPORT,
  DEFAULT_PLAYWRIGHT_SCREENSHOT_ON_FAILURE,
  resolvePlaywrightConfig,
  parseRunnerStdout,
  runPlaywrightSmoke,
  defaultChildScriptPath,
} from './playwright-smoke';
import type {
  PlaywrightRunnerInput,
  PlaywrightExecutor,
  PlaywrightExecutorResult,
  PlaywrightRunnerOutput,
} from './playwright-smoke';
import type { SmokeConfig, SmokeResult } from '../types';

import { runSmoke } from './smoke';

let asyncPass = 0;
let asyncFail = 0;

async function asyncAssert(cond: unknown, msg: string): Promise<void> {
  if (cond) {
    asyncPass++;
    return;
  }
  asyncFail++;
  console.error(`  FAIL: ${msg}`);
}

function makeExecutor(
  fixed: PlaywrightExecutorResult,
  captured?: { input?: PlaywrightRunnerInput; opts?: { timeoutMs: number } },
): PlaywrightExecutor {
  return (input, opts) => {
    if (captured) {
      captured.input = input;
      captured.opts = opts;
    }
    return fixed;
  };
}

function okPayload(extra: Partial<PlaywrightRunnerOutput> = {}): string {
  const payload: PlaywrightRunnerOutput = {
    ok: true,
    status: 200,
    title: 'Hello',
    ...extra,
  };
  return JSON.stringify(payload);
}

function failPayload(
  failure: NonNullable<PlaywrightRunnerOutput['failure']>,
  extra: Partial<PlaywrightRunnerOutput> = {},
): string {
  const payload: PlaywrightRunnerOutput = {
    ok: false,
    status: null,
    title: null,
    ...extra,
    failure,
  };
  return JSON.stringify(payload);
}

function tempJobsDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ccp-pw-smoke-'));
}

async function run(): Promise<void> {
  // ── resolvePlaywrightConfig ───────────────────────────────────────

  console.log('Test: resolvePlaywrightConfig — empty input yields defaults');
  {
    const r = resolvePlaywrightConfig(undefined);
    await asyncAssert(r.browser === DEFAULT_PLAYWRIGHT_BROWSER, 'browser default');
    await asyncAssert(r.waitUntil === DEFAULT_PLAYWRIGHT_WAIT_UNTIL, 'waitUntil default');
    await asyncAssert(
      r.viewport.width === DEFAULT_PLAYWRIGHT_VIEWPORT.width &&
        r.viewport.height === DEFAULT_PLAYWRIGHT_VIEWPORT.height,
      'viewport default',
    );
    await asyncAssert(r.assertExpression === '', 'assertExpression empty default');
    await asyncAssert(
      r.screenshotOnFailure === DEFAULT_PLAYWRIGHT_SCREENSHOT_ON_FAILURE,
      'screenshotOnFailure default',
    );
  }

  console.log('Test: resolvePlaywrightConfig — partial overrides merged');
  {
    const r = resolvePlaywrightConfig({
      browser: 'firefox',
      waitUntil: 'networkidle',
      viewport: { width: 375, height: 667 },
      assertExpression: 'document.title.length > 0',
      screenshotOnFailure: false,
    });
    await asyncAssert(r.browser === 'firefox', 'browser override');
    await asyncAssert(r.waitUntil === 'networkidle', 'waitUntil override');
    await asyncAssert(
      r.viewport.width === 375 && r.viewport.height === 667,
      'viewport override',
    );
    await asyncAssert(r.assertExpression === 'document.title.length > 0', 'assertExpression override');
    await asyncAssert(r.screenshotOnFailure === false, 'screenshotOnFailure override');
  }

  console.log('Test: resolvePlaywrightConfig — rejects nonsensical browser + viewport');
  {
    const r = resolvePlaywrightConfig({
      browser: 'opera' as 'chromium',
      viewport: { width: -1, height: 0 },
    });
    await asyncAssert(r.browser === DEFAULT_PLAYWRIGHT_BROWSER, 'unknown browser → default');
    await asyncAssert(
      r.viewport.width === DEFAULT_PLAYWRIGHT_VIEWPORT.width,
      'bad viewport → default',
    );
  }

  // ── parseRunnerStdout ─────────────────────────────────────────────

  console.log('Test: parseRunnerStdout — happy path parses clean JSON');
  {
    const o = parseRunnerStdout(okPayload());
    await asyncAssert(!!o && o.ok === true && o.status === 200, 'ok parses');
  }

  console.log('Test: parseRunnerStdout — trims whitespace');
  {
    const o = parseRunnerStdout(`  \n${okPayload()}\n `);
    await asyncAssert(!!o && o.ok === true, 'trimmed ok');
  }

  console.log('Test: parseRunnerStdout — tolerant scan when preamble junk prepends');
  {
    const preamble = 'Playwright: some noisy warning\n';
    const o = parseRunnerStdout(`${preamble}${okPayload({ title: 'Tol' })}`);
    await asyncAssert(!!o && o.ok === true && o.title === 'Tol', 'preamble + json parses');
  }

  console.log('Test: parseRunnerStdout — null on empty / malformed');
  {
    await asyncAssert(parseRunnerStdout('') === null, 'empty → null');
    await asyncAssert(parseRunnerStdout('not json at all') === null, 'garbage → null');
    await asyncAssert(parseRunnerStdout('{"unterminated": ') === null, 'bad json → null');
    // Regression: `lastIndexOf('{', -1)` returns 0 when the string starts
    // with '{', so a naive decrement by `lastIndexOf(ch, i - 1)` from i=0
    // would loop forever. Any string starting with '{' that doesn't parse
    // to a complete object would hang the supervisor watcher cycle.
    await asyncAssert(
      parseRunnerStdout('{only one brace') === null,
      'single-brace-at-start input terminates (infinite-loop regression)',
    );
    await asyncAssert(
      parseRunnerStdout('{{{') === null,
      'multiple-brace prefix terminates (infinite-loop regression)',
    );
  }

  // ── runPlaywrightSmoke: skip branches ─────────────────────────────

  console.log('Test: runPlaywrightSmoke — disabled config returns kind:skipped');
  {
    const r = await runPlaywrightSmoke('https://preview.vercel.app', { enabled: false });
    await asyncAssert(r.ok === false, 'ok=false when disabled');
    await asyncAssert(r.failure?.kind === 'skipped', 'kind=skipped');
    await asyncAssert(r.durationMs === 0, 'durationMs=0 for skip path');
  }

  console.log('Test: runPlaywrightSmoke — no preview URL returns kind:skipped');
  {
    const r = await runPlaywrightSmoke(null, { enabled: true, runner: 'playwright' });
    await asyncAssert(r.ok === false, 'ok=false with null URL');
    await asyncAssert(r.failure?.kind === 'skipped', 'kind=skipped on null URL');
    await asyncAssert(r.url === '', 'empty URL echoed');
  }

  // ── runPlaywrightSmoke: happy path ────────────────────────────────

  console.log('Test: runPlaywrightSmoke — happy path wraps child output into SmokeResult');
  {
    const captured: { input?: PlaywrightRunnerInput; opts?: { timeoutMs: number } } = {};
    const executor = makeExecutor(
      {
        stdout: okPayload({ status: 200, title: 'My App' }),
        stderr: '',
        exitCode: 0,
        timedOut: false,
      },
      captured,
    );
    const r = await runPlaywrightSmoke(
      'https://preview.vercel.app',
      {
        enabled: true,
        runner: 'playwright',
        path: '/health',
        timeoutSec: 20,
        userAgent: 'ccp-pw-test/0.1',
        playwright: { browser: 'firefox', waitUntil: 'domcontentloaded' },
      },
      executor,
    );
    await asyncAssert(r.ok === true, 'happy ok');
    await asyncAssert(r.status === 200, 'status echoed');
    await asyncAssert(r.title === 'My App', 'title echoed');
    await asyncAssert(r.url === 'https://preview.vercel.app/health', 'URL joined correctly');
    await asyncAssert(typeof r.durationMs === 'number' && r.durationMs >= 0, 'durationMs present');
    await asyncAssert(typeof r.finishedAt === 'string' && r.finishedAt.length > 0, 'finishedAt ISO');

    // executor received fully-resolved input
    await asyncAssert(!!captured.input, 'captured input');
    await asyncAssert(captured.input!.playwright.browser === 'firefox', 'browser passed through');
    await asyncAssert(
      captured.input!.playwright.waitUntil === 'domcontentloaded',
      'waitUntil passed through',
    );
    await asyncAssert(captured.input!.timeoutMs === 20_000, 'timeoutMs=timeoutSec*1000');
    await asyncAssert(captured.input!.userAgent === 'ccp-pw-test/0.1', 'userAgent passed through');
    // supervisor adds the startup buffer on top when telling spawnSync when to kill
    await asyncAssert(
      captured.opts!.timeoutMs === 20_000 + PLAYWRIGHT_STARTUP_BUFFER_MS,
      'executor timeout has startup buffer',
    );
  }

  // ── runPlaywrightSmoke: structured failure pass-through ───────────

  console.log('Test: runPlaywrightSmoke — child status failure preserved in SmokeResult');
  {
    const executor = makeExecutor({
      stdout: failPayload(
        { kind: 'status', message: 'got status 503, expected one of 200', bodyExcerpt: '<pre>503</pre>' },
        { status: 503, title: 'Oops' },
      ),
      stderr: '',
      exitCode: 0,
      timedOut: false,
    });
    const r = await runPlaywrightSmoke(
      'https://preview.vercel.app',
      { enabled: true, runner: 'playwright' },
      executor,
    );
    await asyncAssert(r.ok === false, 'status failure ok=false');
    await asyncAssert(r.failure?.kind === 'status', 'kind preserved');
    await asyncAssert(r.status === 503, 'status preserved');
    await asyncAssert(r.title === 'Oops', 'title preserved');
    await asyncAssert(r.failure?.bodyExcerpt === '<pre>503</pre>', 'bodyExcerpt preserved');
  }

  console.log('Test: runPlaywrightSmoke — child title failure preserved');
  {
    const executor = makeExecutor({
      stdout: failPayload(
        { kind: 'title', message: 'title "X" did not match /My App/i' },
        { status: 200, title: 'X' },
      ),
      stderr: '',
      exitCode: 0,
      timedOut: false,
    });
    const r = await runPlaywrightSmoke(
      'https://preview.vercel.app',
      { enabled: true, runner: 'playwright', titleRegex: 'My App' },
      executor,
    );
    await asyncAssert(r.ok === false, 'title failure ok=false');
    await asyncAssert(r.failure?.kind === 'title', 'title kind preserved');
    await asyncAssert(r.status === 200, 'status preserved on title fail');
  }

  // ── runPlaywrightSmoke: infrastructure failures ───────────────────

  console.log('Test: runPlaywrightSmoke — supervisor-side timeout → kind:timeout');
  {
    const executor = makeExecutor({
      stdout: '',
      stderr: '',
      exitCode: null,
      timedOut: true,
    });
    const r = await runPlaywrightSmoke(
      'https://preview.vercel.app',
      { enabled: true, runner: 'playwright', timeoutSec: 5 },
      executor,
    );
    await asyncAssert(r.ok === false, 'ok=false on timeout');
    await asyncAssert(r.failure?.kind === 'timeout', 'kind=timeout');
    await asyncAssert(
      (r.failure?.message || '').includes('5s'),
      'message mentions configured timeout',
    );
  }

  console.log('Test: runPlaywrightSmoke — spawn error → kind:unknown with helpful message');
  {
    const executor = makeExecutor({
      stdout: '',
      stderr: '',
      exitCode: null,
      timedOut: false,
      spawnError: "Error: spawn node ENOENT",
    });
    const r = await runPlaywrightSmoke(
      'https://preview.vercel.app',
      { enabled: true, runner: 'playwright' },
      executor,
    );
    await asyncAssert(r.ok === false, 'spawn error ok=false');
    await asyncAssert(r.failure?.kind === 'unknown', 'kind=unknown on spawn error');
    await asyncAssert(
      (r.failure?.message || '').includes('ENOENT'),
      'spawn error message surfaced',
    );
  }

  console.log('Test: runPlaywrightSmoke — unparseable stdout → kind:unknown + stderr tail');
  {
    const executor = makeExecutor({
      stdout: 'definitely not json',
      stderr: 'Traceback: something broke in the runner\n',
      exitCode: 1,
      timedOut: false,
    });
    const r = await runPlaywrightSmoke(
      'https://preview.vercel.app',
      { enabled: true, runner: 'playwright' },
      executor,
    );
    await asyncAssert(r.ok === false, 'garbage stdout ok=false');
    await asyncAssert(r.failure?.kind === 'unknown', 'kind=unknown on garbage');
    await asyncAssert(
      (r.failure?.message || '').includes('exit=1'),
      'message notes exit code',
    );
    await asyncAssert(
      (r.failure?.message || '').includes('something broke'),
      'message includes stderr tail',
    );
  }

  console.log('Test: runPlaywrightSmoke — executor itself throws → caught to kind:unknown');
  {
    const executor: PlaywrightExecutor = () => {
      throw new Error('executor fault');
    };
    const r = await runPlaywrightSmoke(
      'https://preview.vercel.app',
      { enabled: true, runner: 'playwright' },
      executor,
    );
    await asyncAssert(r.ok === false, 'thrown executor ok=false');
    await asyncAssert(r.failure?.kind === 'unknown', 'kind=unknown on throw');
    await asyncAssert(
      (r.failure?.message || '').includes('executor fault'),
      'thrown error message preserved',
    );
  }

  // ── runPlaywrightSmoke: expectStatus fallback (Devin Review #44 repro) ─
  console.log('Test: runPlaywrightSmoke — all-invalid expectStatus falls back to [200]');
  {
    const captured: { input?: PlaywrightRunnerInput; opts?: { timeoutMs: number } } = {};
    const executor = makeExecutor(
      {
        stdout: okPayload(),
        stderr: '',
        exitCode: 0,
        timedOut: false,
      },
      captured,
    );
    await runPlaywrightSmoke(
      'https://preview.vercel.app',
      {
        enabled: true,
        runner: 'playwright',
        expectStatus: ['200', 'oops', 1.5, null] as unknown as number[],
      },
      executor,
    );
    await asyncAssert(!!captured.input, 'input captured');
    await asyncAssert(
      captured.input!.expectStatus.length === 1 && captured.input!.expectStatus[0] === 200,
      'all-invalid expectStatus → [200]',
    );
  }

  // ── runPlaywrightSmoke: screenshot destination resolution ──────────

  console.log('Test: runPlaywrightSmoke — passes empty screenshotPath when jobId omitted');
  {
    const captured: { input?: PlaywrightRunnerInput; opts?: { timeoutMs: number } } = {};
    const executor = makeExecutor(
      { stdout: okPayload(), stderr: '', exitCode: 0, timedOut: false },
      captured,
    );
    await runPlaywrightSmoke(
      'https://preview.vercel.app',
      { enabled: true, runner: 'playwright', playwright: { screenshotOnFailure: true } },
      executor,
    );
    await asyncAssert(
      captured.input!.screenshotPath === '',
      'no jobId → screenshotPath empty (child skips screenshot)',
    );
  }

  console.log('Test: runPlaywrightSmoke — resolves screenshotPath under jobsDir/jobId');
  {
    const jobsDir = tempJobsDir();
    const jobId = 'job-pw-abc123';
    const captured: { input?: PlaywrightRunnerInput; opts?: { timeoutMs: number } } = {};
    const executor = makeExecutor(
      { stdout: okPayload(), stderr: '', exitCode: 0, timedOut: false },
      captured,
    );
    await runPlaywrightSmoke(
      'https://preview.vercel.app',
      {
        enabled: true,
        runner: 'playwright',
        playwright: { screenshotOnFailure: true },
      },
      executor,
      { jobId, jobsDir },
    );
    const expected = path.join(jobsDir, jobId, 'smoke-failure.png');
    await asyncAssert(
      captured.input!.screenshotPath === expected,
      `screenshotPath resolved to ${expected}`,
    );
    await asyncAssert(
      fs.existsSync(path.join(jobsDir, jobId)),
      'jobs/<id>/ created so child can write the png',
    );
  }

  console.log('Test: runPlaywrightSmoke — screenshotOnFailure=false → empty screenshotPath');
  {
    const captured: { input?: PlaywrightRunnerInput; opts?: { timeoutMs: number } } = {};
    const executor = makeExecutor(
      { stdout: okPayload(), stderr: '', exitCode: 0, timedOut: false },
      captured,
    );
    await runPlaywrightSmoke(
      'https://preview.vercel.app',
      {
        enabled: true,
        runner: 'playwright',
        playwright: { screenshotOnFailure: false },
      },
      executor,
      { jobId: 'job-no-shot', jobsDir: tempJobsDir() },
    );
    await asyncAssert(
      captured.input!.screenshotPath === '',
      'opted-out → screenshotPath empty',
    );
  }

  // ── defaultChildScriptPath ─────────────────────────────────────────
  console.log('Test: defaultChildScriptPath — resolves next to the compiled orchestrator');
  {
    const p = defaultChildScriptPath();
    await asyncAssert(
      p.endsWith(path.join('lib', 'playwright-smoke-runner.js')),
      'child script path ends with lib/playwright-smoke-runner.js',
    );
  }

  // ── runSmoke dispatcher (in smoke.ts) ──────────────────────────────

  console.log('Test: runSmoke — default routes to HTTP runner (no runner field)');
  {
    let httpCalled = 0;
    let pwCalled = 0;
    const httpFetcher = async () => {
      httpCalled++;
      return { status: 200, body: '<html><title>h</title></html>' };
    };
    const pwExecutor: PlaywrightExecutor = () => {
      pwCalled++;
      return { stdout: okPayload(), stderr: '', exitCode: 0, timedOut: false };
    };
    const r: SmokeResult = await runSmoke(
      'https://preview.vercel.app',
      { enabled: true },
      { httpFetcher, playwrightExecutor: pwExecutor },
    );
    await asyncAssert(httpCalled === 1, 'http runner called');
    await asyncAssert(pwCalled === 0, 'playwright runner NOT called');
    await asyncAssert(r.ok === true, 'http smoke ok=true');
  }

  console.log('Test: runSmoke — runner:"http" routes to HTTP runner');
  {
    let httpCalled = 0;
    const httpFetcher = async () => {
      httpCalled++;
      return { status: 200, body: '<html><title>x</title></html>' };
    };
    const pwExecutor: PlaywrightExecutor = () => {
      throw new Error('playwright should not be called');
    };
    await runSmoke(
      'https://preview.vercel.app',
      { enabled: true, runner: 'http' },
      { httpFetcher, playwrightExecutor: pwExecutor },
    );
    await asyncAssert(httpCalled === 1, 'http runner called when runner=http');
  }

  console.log('Test: runSmoke — runner:"playwright" routes to Playwright runner');
  {
    let pwCalled = 0;
    const pwExecutor: PlaywrightExecutor = () => {
      pwCalled++;
      return { stdout: okPayload({ title: 'PW' }), stderr: '', exitCode: 0, timedOut: false };
    };
    const httpFetcher = async () => {
      throw new Error('http should not be called');
    };
    const r = await runSmoke(
      'https://preview.vercel.app',
      { enabled: true, runner: 'playwright' },
      { httpFetcher, playwrightExecutor: pwExecutor },
    );
    await asyncAssert(pwCalled === 1, 'playwright runner called when runner=playwright');
    await asyncAssert(r.ok === true && r.title === 'PW', 'playwright result surfaced');
  }

  console.log('Test: runSmoke — forwards playwrightOptions.jobId to orchestrator');
  {
    const jobsDir = tempJobsDir();
    const captured: { input?: PlaywrightRunnerInput; opts?: { timeoutMs: number } } = {};
    const pwExecutor = makeExecutor(
      { stdout: okPayload(), stderr: '', exitCode: 0, timedOut: false },
      captured,
    );
    await runSmoke(
      'https://preview.vercel.app',
      {
        enabled: true,
        runner: 'playwright',
        playwright: { screenshotOnFailure: true },
      },
      {
        playwrightExecutor: pwExecutor,
        playwrightOptions: { jobId: 'job-dispatch-id', jobsDir },
      },
    );
    await asyncAssert(
      captured.input!.screenshotPath.endsWith(
        path.join('job-dispatch-id', 'smoke-failure.png'),
      ),
      'dispatcher forwards jobId to runPlaywrightSmoke',
    );
  }

  console.log('Test: runSmoke — disabled config returns kind:skipped regardless of runner');
  {
    const pwExecutor: PlaywrightExecutor = () => {
      throw new Error('should not execute child on disabled smoke');
    };
    const r = await runSmoke(
      'https://preview.vercel.app',
      { enabled: false, runner: 'playwright' } as SmokeConfig,
      { playwrightExecutor: pwExecutor },
    );
    await asyncAssert(r.ok === false && r.failure?.kind === 'skipped', 'disabled → skipped');
  }

  // ── Summary ────────────────────────────────────────────────────────
  console.log(
    `\nplaywright-smoke.test: ${asyncPass} passed, ${asyncFail} failed, ${asyncPass + asyncFail} total assertions`,
  );
  if (asyncFail > 0) process.exit(1);
  assert.ok(asyncFail === 0, 'all playwright-smoke tests pass');
}

run().catch((e) => {
  console.error('playwright-smoke.test: top-level error:', e);
  process.exit(1);
});
