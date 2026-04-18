/**
 * Unit tests for smoke.ts — Phase 4 (PR B).
 *
 * All HTTP is faked via injected `HttpFetcher`s; the tests never hit
 * the real network. Run: `npm test`.
 */

import type { SmokeConfig, SmokeResult } from '../types';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const smoke = require('./smoke');

const {
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
  shouldGateOnSmoke,
  buildSmokeBlocker,
} = smoke;

// Helper: build a passing SmokeResult for gate-tests.
function mkOkResult(overrides: Partial<SmokeResult> = {}): SmokeResult {
  return {
    ok: true,
    url: 'https://app.vercel.app/',
    status: 200,
    title: 'My App',
    durationMs: 120,
    finishedAt: '2025-01-01T00:00:00.000Z',
    ...overrides,
  };
}

// Helper: build a failing SmokeResult for gate-tests.
function mkFailResult(
  kind: NonNullable<SmokeResult['failure']>['kind'] = 'status',
  overrides: Partial<SmokeResult> = {},
): SmokeResult {
  return {
    ok: false,
    url: 'https://app.vercel.app/',
    status: 500,
    durationMs: 180,
    finishedAt: '2025-01-01T00:00:00.000Z',
    failure: {
      kind,
      message: `example ${kind} failure`,
    },
    ...overrides,
  };
}

let passed = 0;
let failed = 0;

function assert(cond: unknown, label: string): void {
  if (cond) {
    passed += 1;
    console.log(`  PASS: ${label}`);
  } else {
    failed += 1;
    console.log(`  FAIL: ${label}`);
  }
}

async function asyncAssert(cond: unknown, label: string): Promise<void> {
  assert(cond, label);
}

// --------------------------------------------------------------------
// resolveSmokeConfig
// --------------------------------------------------------------------
console.log('Test: resolveSmokeConfig — defaults for undefined / empty config');
{
  const r1 = resolveSmokeConfig(undefined);
  assert(r1.enabled === false, 'undefined → enabled=false');
  assert(r1.path === DEFAULT_SMOKE_PATH, 'undefined → default path');
  assert(
    Array.isArray(r1.expectStatus) && r1.expectStatus[0] === 200,
    'undefined → default expectStatus',
  );
  assert(r1.timeoutSec === DEFAULT_SMOKE_TIMEOUT_SEC, 'undefined → default timeout');
  assert(r1.userAgent === DEFAULT_SMOKE_USER_AGENT, 'undefined → default UA');
  assert(r1.titleRegex === '', 'undefined → titleRegex empty');

  const r2 = resolveSmokeConfig({});
  assert(r2.enabled === false, 'empty obj → enabled=false');
}

console.log('Test: resolveSmokeConfig — honours explicit values');
{
  const r = resolveSmokeConfig({
    enabled: true,
    path: '/api/health',
    expectStatus: [200, 204],
    titleRegex: 'My App',
    timeoutSec: 30,
    userAgent: 'custom/1',
  });
  assert(r.enabled === true, 'enabled true');
  assert(r.path === '/api/health', 'custom path');
  assert(r.expectStatus.length === 2 && r.expectStatus[1] === 204, 'custom status list');
  assert(r.titleRegex === 'My App', 'custom title regex');
  assert(r.timeoutSec === 30, 'custom timeout');
  assert(r.userAgent === 'custom/1', 'custom UA');
}

console.log('Test: resolveSmokeConfig — rejects invalid fields gracefully');
{
  const r = resolveSmokeConfig({
    enabled: true,
    path: '',
    // Cast to any — we deliberately pass non-integers to prove the
    // resolver filters them out.
    expectStatus: [200, 'oops', 204, 1.5] as unknown as number[],
    timeoutSec: -1,
    userAgent: '',
  });
  assert(r.path === DEFAULT_SMOKE_PATH, 'empty path → default');
  assert(
    r.expectStatus.length === 2 && r.expectStatus[0] === 200 && r.expectStatus[1] === 204,
    'non-integers filtered out',
  );
  assert(r.timeoutSec === DEFAULT_SMOKE_TIMEOUT_SEC, 'negative timeout → default');
  assert(r.userAgent === DEFAULT_SMOKE_USER_AGENT, 'empty UA → default');
}

console.log('Test: resolveSmokeConfig — all-invalid expectStatus falls back to default (Devin Review #44)');
{
  // Every entry is invalid — this used to resolve to [] and make every
  // HTTP response fail with a `kind: 'status'` and empty message.
  const r = resolveSmokeConfig({
    enabled: true,
    expectStatus: ['200', 'oops', 1.5, null] as unknown as number[],
  });
  assert(
    r.expectStatus.length === 1 && r.expectStatus[0] === 200,
    'all-invalid expectStatus → DEFAULT_SMOKE_STATUS',
  );
}

// --------------------------------------------------------------------
// joinPreviewUrl
// --------------------------------------------------------------------
console.log('Test: joinPreviewUrl — common path join variants');
{
  assert(
    joinPreviewUrl('https://app.vercel.app', '/') === 'https://app.vercel.app/',
    'base + "/" → base/',
  );
  assert(
    joinPreviewUrl('https://app.vercel.app/', '/api') === 'https://app.vercel.app/api',
    'trailing slash on base is stripped',
  );
  assert(
    joinPreviewUrl('https://app.vercel.app', 'api/health') ===
      'https://app.vercel.app/api/health',
    'leading slash on path is added when missing',
  );
  assert(
    joinPreviewUrl('https://app.vercel.app/prefix', '/api') ===
      'https://app.vercel.app/prefix/api',
    'base-path prefix preserved (new URL() would lose it)',
  );
  assert(
    joinPreviewUrl('https://app.vercel.app//', '/') === 'https://app.vercel.app/',
    'double trailing slash collapsed',
  );
}

// --------------------------------------------------------------------
// extractTitle
// --------------------------------------------------------------------
console.log('Test: extractTitle — common HTML variants');
{
  assert(extractTitle('<title>My App</title>') === 'My App', 'plain title');
  assert(
    extractTitle('<html><head><title>\n  My App\n</title></head></html>') === 'My App',
    'whitespace collapsed',
  );
  assert(
    extractTitle('<TITLE>Upper</TITLE>') === 'Upper',
    'case-insensitive tag',
  );
  assert(
    extractTitle('<title lang="en">Localized</title>') === 'Localized',
    'title with attributes',
  );
  assert(extractTitle('<html></html>') === null, 'no title → null');
  assert(extractTitle('<title></title>') === null, 'empty title → null');
}

// --------------------------------------------------------------------
// truncateBodyExcerpt
// --------------------------------------------------------------------
console.log('Test: truncateBodyExcerpt — byte-accurate truncation');
{
  const short = 'hello';
  assert(truncateBodyExcerpt(short) === short, 'short body returned unchanged');

  const long = 'A'.repeat(MAX_BODY_EXCERPT_BYTES + 500);
  const trunc = truncateBodyExcerpt(long);
  assert(trunc.length < long.length, 'long body truncated');
  assert(trunc.includes('truncated'), 'truncated marker present');
  assert(trunc.startsWith('A'.repeat(100)), 'head preserved');

  assert(truncateBodyExcerpt('') === '', 'empty body → empty');
}

// --------------------------------------------------------------------
// runHttpSmoke — happy path + every failure kind
// --------------------------------------------------------------------

function makeFetcher(response: {
  status?: number;
  body?: string;
  timedOut?: boolean;
  networkError?: string;
  throws?: Error;
}): {
  fetcher: (
    url: string,
    opts: { timeoutMs: number; userAgent: string },
  ) => Promise<{ status: number; body: string; timedOut?: boolean; networkError?: string }>;
  calls: Array<{ url: string; opts: { timeoutMs: number; userAgent: string } }>;
} {
  const calls: Array<{ url: string; opts: { timeoutMs: number; userAgent: string } }> = [];
  return {
    fetcher: async (url, opts) => {
      calls.push({ url, opts });
      if (response.throws) throw response.throws;
      return {
        status: response.status ?? 200,
        body: response.body ?? '',
        timedOut: response.timedOut,
        networkError: response.networkError,
      };
    },
    calls,
  };
}

async function runAll(): Promise<void> {
  console.log('Test: runHttpSmoke — skipped when disabled');
  {
    const r: SmokeResult = await runHttpSmoke(
      'https://app.vercel.app',
      { enabled: false },
      makeFetcher({ status: 200 }).fetcher,
    );
    await asyncAssert(r.ok === false, 'ok=false');
    await asyncAssert(r.failure?.kind === 'skipped', 'skipped kind');
  }

  console.log('Test: runHttpSmoke — skipped when preview URL missing');
  {
    const r: SmokeResult = await runHttpSmoke(
      null,
      { enabled: true },
      makeFetcher({ status: 200 }).fetcher,
    );
    await asyncAssert(r.ok === false, 'ok=false');
    await asyncAssert(r.failure?.kind === 'skipped', 'kind=skipped');
    await asyncAssert(
      (r.failure?.message || '').includes('no preview URL'),
      'mentions missing URL',
    );
  }

  console.log('Test: runHttpSmoke — happy path (200, title matches)');
  {
    const m = makeFetcher({
      status: 200,
      body: '<html><head><title>My App</title></head><body>hi</body></html>',
    });
    const cfg: SmokeConfig = { enabled: true, titleRegex: 'My App' };
    const r: SmokeResult = await runHttpSmoke('https://app.vercel.app', cfg, m.fetcher);
    await asyncAssert(r.ok === true, 'ok=true');
    await asyncAssert(r.status === 200, 'status echoed');
    await asyncAssert(r.title === 'My App', 'title extracted');
    await asyncAssert(r.failure === undefined, 'no failure on success');
    await asyncAssert(m.calls.length === 1, 'fetcher called once');
    await asyncAssert(
      m.calls[0].url === 'https://app.vercel.app/',
      'URL joined with default path',
    );
    await asyncAssert(
      m.calls[0].opts.timeoutMs === DEFAULT_SMOKE_TIMEOUT_SEC * 1000,
      'default timeout forwarded as ms',
    );
    await asyncAssert(
      m.calls[0].opts.userAgent === DEFAULT_SMOKE_USER_AGENT,
      'default UA forwarded',
    );
  }

  console.log('Test: runHttpSmoke — custom path + expectStatus [200,302]');
  {
    const m = makeFetcher({ status: 302, body: '' });
    const cfg: SmokeConfig = {
      enabled: true,
      path: '/api/health',
      expectStatus: [200, 302],
    };
    const r: SmokeResult = await runHttpSmoke('https://app.vercel.app', cfg, m.fetcher);
    await asyncAssert(r.ok === true, 'ok=true for 302');
    await asyncAssert(
      m.calls[0].url === 'https://app.vercel.app/api/health',
      'custom path joined',
    );
  }

  console.log('Test: runHttpSmoke — status failure');
  {
    const m = makeFetcher({
      status: 500,
      body: '<html><title>Internal Error</title><body>oops</body></html>',
    });
    const r: SmokeResult = await runHttpSmoke(
      'https://app.vercel.app',
      { enabled: true },
      m.fetcher,
    );
    await asyncAssert(r.ok === false, 'ok=false');
    await asyncAssert(r.failure?.kind === 'status', 'kind=status');
    await asyncAssert(r.status === 500, 'status echoed on failure');
    await asyncAssert(
      (r.failure?.message || '').includes('500'),
      'failure message includes status',
    );
    await asyncAssert(
      (r.failure?.bodyExcerpt || '').includes('Internal Error'),
      'body excerpt preserved',
    );
  }

  console.log('Test: runHttpSmoke — title failure (regex mismatch)');
  {
    const m = makeFetcher({
      status: 200,
      body: '<html><title>Unrelated</title></html>',
    });
    const r: SmokeResult = await runHttpSmoke(
      'https://app.vercel.app',
      { enabled: true, titleRegex: 'My App' },
      m.fetcher,
    );
    await asyncAssert(r.ok === false, 'ok=false');
    await asyncAssert(r.failure?.kind === 'title', 'kind=title');
    await asyncAssert(r.title === 'Unrelated', 'title echoed on mismatch');
    await asyncAssert(
      (r.failure?.message || '').includes('My App'),
      'mentions configured regex',
    );
  }

  console.log('Test: runHttpSmoke — title failure (no title at all)');
  {
    const m = makeFetcher({ status: 200, body: '<html><body>no head</body></html>' });
    const r: SmokeResult = await runHttpSmoke(
      'https://app.vercel.app',
      { enabled: true, titleRegex: '.+' },
      m.fetcher,
    );
    await asyncAssert(r.ok === false, 'ok=false');
    await asyncAssert(r.failure?.kind === 'title', 'kind=title');
    await asyncAssert(r.title === null, 'title=null when absent');
    await asyncAssert(
      (r.failure?.message || '').includes('no <title>'),
      'message explains missing title',
    );
  }

  console.log('Test: runHttpSmoke — timeout failure');
  {
    const m = makeFetcher({ timedOut: true });
    const r: SmokeResult = await runHttpSmoke(
      'https://app.vercel.app',
      { enabled: true, timeoutSec: 2 },
      m.fetcher,
    );
    await asyncAssert(r.ok === false, 'ok=false');
    await asyncAssert(r.failure?.kind === 'timeout', 'kind=timeout');
    await asyncAssert(
      (r.failure?.message || '').includes('2s'),
      'message includes configured timeout',
    );
  }

  console.log('Test: runHttpSmoke — network failure');
  {
    const m = makeFetcher({ networkError: 'ENOTFOUND app.example.com' });
    const r: SmokeResult = await runHttpSmoke(
      'https://app.example.com',
      { enabled: true },
      m.fetcher,
    );
    await asyncAssert(r.ok === false, 'ok=false');
    await asyncAssert(r.failure?.kind === 'network', 'kind=network');
    await asyncAssert(
      (r.failure?.message || '').includes('ENOTFOUND'),
      'error message preserved',
    );
  }

  console.log('Test: runHttpSmoke — unknown error (fetcher throws)');
  {
    const m = makeFetcher({ throws: new Error('unexpected') });
    const r: SmokeResult = await runHttpSmoke(
      'https://app.vercel.app',
      { enabled: true },
      m.fetcher,
    );
    await asyncAssert(r.ok === false, 'ok=false');
    await asyncAssert(r.failure?.kind === 'unknown', 'kind=unknown');
    await asyncAssert(
      (r.failure?.message || '').includes('unexpected'),
      'thrown message preserved',
    );
  }

  console.log('Test: runHttpSmoke — invalid titleRegex maps to failure (Devin Review #44)');
  {
    const m = makeFetcher({ status: 200, body: '<html><title>ok</title></html>' });
    // '[' is an unterminated character class — SyntaxError from new RegExp.
    // Previously propagated out of runHttpSmoke; now should be mapped to
    // a SmokeResult with failure kind `unknown`.
    const r: SmokeResult = await runHttpSmoke(
      'https://app.vercel.app',
      { enabled: true, titleRegex: '[' },
      m.fetcher,
    );
    await asyncAssert(r.ok === false, 'ok=false on invalid regex');
    await asyncAssert(r.failure?.kind === 'unknown', 'kind=unknown');
    await asyncAssert(
      (r.failure?.message || '').includes('invalid titleRegex'),
      'message labels the cause',
    );
    await asyncAssert(r.status === 200, 'status still echoed on regex failure');
  }

  console.log('Test: runHttpSmoke — case-insensitive title regex');
  {
    const m = makeFetcher({
      status: 200,
      body: '<html><title>my app dashboard</title></html>',
    });
    const r: SmokeResult = await runHttpSmoke(
      'https://app.vercel.app',
      { enabled: true, titleRegex: 'MY APP' },
      m.fetcher,
    );
    await asyncAssert(r.ok === true, 'lowercase title matches uppercase regex');
  }

  console.log('Test: runHttpSmoke — custom timeoutSec forwarded as ms');
  {
    const m = makeFetcher({ status: 200 });
    await runHttpSmoke(
      'https://app.vercel.app',
      { enabled: true, timeoutSec: 45 },
      m.fetcher,
    );
    await asyncAssert(m.calls[0].opts.timeoutMs === 45_000, '45s → 45000ms');
  }

  // --------------------------------------------------------------------
  // shouldGateOnSmoke (Phase 4 PR D)
  // --------------------------------------------------------------------
  console.log('Test: shouldGateOnSmoke — passing result never gates');
  {
    const saved = process.env.CCP_SMOKE_GATE;
    delete process.env.CCP_SMOKE_GATE;
    assert(
      shouldGateOnSmoke({ enabled: true, gate: true }, mkOkResult()) === false,
      'ok=true does not gate even with gate=true',
    );
    if (saved !== undefined) process.env.CCP_SMOKE_GATE = saved;
  }

  console.log('Test: shouldGateOnSmoke — null/undefined result never gates');
  {
    const saved = process.env.CCP_SMOKE_GATE;
    delete process.env.CCP_SMOKE_GATE;
    assert(shouldGateOnSmoke({ enabled: true, gate: true }, null) === false, 'null result');
    assert(shouldGateOnSmoke({ enabled: true, gate: true }, undefined) === false, 'undefined result');
    if (saved !== undefined) process.env.CCP_SMOKE_GATE = saved;
  }

  console.log('Test: shouldGateOnSmoke — skipped failure never gates');
  {
    const saved = process.env.CCP_SMOKE_GATE;
    delete process.env.CCP_SMOKE_GATE;
    const skipped = mkFailResult('skipped');
    assert(
      shouldGateOnSmoke({ enabled: true, gate: true }, skipped) === false,
      'kind:skipped does not gate even with gate=true',
    );
    process.env.CCP_SMOKE_GATE = 'true';
    assert(
      shouldGateOnSmoke({ enabled: true, gate: true }, skipped) === false,
      'CCP_SMOKE_GATE=true does not override kind:skipped',
    );
    if (saved !== undefined) process.env.CCP_SMOKE_GATE = saved;
    else delete process.env.CCP_SMOKE_GATE;
  }

  console.log('Test: shouldGateOnSmoke — per-repo gate triggers on failure');
  {
    const saved = process.env.CCP_SMOKE_GATE;
    delete process.env.CCP_SMOKE_GATE;
    const fail = mkFailResult('status');
    assert(shouldGateOnSmoke({ enabled: true, gate: true }, fail) === true, 'gate=true + failing');
    assert(shouldGateOnSmoke({ enabled: true, gate: false }, fail) === false, 'gate=false + failing');
    assert(shouldGateOnSmoke({ enabled: true }, fail) === false, 'missing gate defaults to false');
    assert(shouldGateOnSmoke(null, fail) === false, 'null config does not trigger');
    assert(shouldGateOnSmoke(undefined, fail) === false, 'undefined config does not trigger');
    if (saved !== undefined) process.env.CCP_SMOKE_GATE = saved;
  }

  console.log('Test: shouldGateOnSmoke — global CCP_SMOKE_GATE override');
  {
    const saved = process.env.CCP_SMOKE_GATE;
    const fail = mkFailResult('timeout');
    process.env.CCP_SMOKE_GATE = 'true';
    assert(
      shouldGateOnSmoke({ enabled: true, gate: false }, fail) === true,
      'CCP_SMOKE_GATE=true overrides per-repo false',
    );
    assert(shouldGateOnSmoke(null, fail) === true, 'CCP_SMOKE_GATE=true works with null config');
    process.env.CCP_SMOKE_GATE = 'false';
    assert(
      shouldGateOnSmoke({ enabled: true, gate: true }, fail) === false,
      'CCP_SMOKE_GATE=false overrides per-repo true',
    );
    process.env.CCP_SMOKE_GATE = '1';
    assert(shouldGateOnSmoke(null, fail) === true, '"1" parses as true');
    process.env.CCP_SMOKE_GATE = '0';
    assert(
      shouldGateOnSmoke({ enabled: true, gate: true }, fail) === false,
      '"0" parses as false',
    );
    process.env.CCP_SMOKE_GATE = 'off';
    assert(
      shouldGateOnSmoke({ enabled: true, gate: true }, fail) === false,
      '"off" parses as false',
    );
    process.env.CCP_SMOKE_GATE = 'on';
    assert(shouldGateOnSmoke(null, fail) === true, '"on" parses as true');
    process.env.CCP_SMOKE_GATE = 'maybe';
    assert(
      shouldGateOnSmoke({ enabled: true, gate: true }, fail) === true,
      'unknown env value falls back to per-repo (true)',
    );
    assert(
      shouldGateOnSmoke({ enabled: true, gate: false }, fail) === false,
      'unknown env value falls back to per-repo (false)',
    );
    if (saved !== undefined) process.env.CCP_SMOKE_GATE = saved;
    else delete process.env.CCP_SMOKE_GATE;
  }

  console.log('Test: shouldGateOnSmoke — resolveSmokeConfig gate defaulting');
  {
    const r1 = resolveSmokeConfig({ enabled: true });
    assert(r1.gate === false, 'missing gate resolves to false');
    const r2 = resolveSmokeConfig({ enabled: true, gate: true });
    assert(r2.gate === true, 'gate=true resolves to true');
    const r3 = resolveSmokeConfig({ enabled: true, gate: false });
    assert(r3.gate === false, 'gate=false resolves to false');
    // Non-boolean gate values must not silently enable gating — only strict
    // `true` resolves to true. This guards against a stringified config
    // ("gate": "yes") flipping gating on accidentally.
    const r4 = resolveSmokeConfig({ enabled: true, gate: 'yes' as unknown as boolean });
    assert(r4.gate === false, 'stringy gate:"yes" resolves to false (not silently enabled)');
  }

  // --------------------------------------------------------------------
  // buildSmokeBlocker (Phase 4 PR D)
  // --------------------------------------------------------------------
  console.log('Test: buildSmokeBlocker — status failure carries kind + status + url');
  {
    const r = mkFailResult('status', {
      status: 502,
      failure: { kind: 'status', message: 'expected one of 200,302 but got 502' },
    });
    const b = buildSmokeBlocker(r);
    assert(/smoke test failed on preview deployment \(status\)/.test(b.message), 'message header includes kind');
    assert(/expected one of 200,302 but got 502/.test(b.message), 'message carries runner message');
    assert(/status=502/.test(b.message), 'status=502 rendered');
    assert(b.failedChecks.length === 1, 'one failed_check entry');
    assert(b.failedChecks[0].name === 'smoke:status', 'check name encodes kind');
    assert(b.failedChecks[0].state === 'FAILURE', 'non-timeout kinds render as FAILURE');
    assert(b.failedChecks[0].url === r.url, 'failed_check carries the URL');
    assert(b.feedback.some((l: string) => /Preview-URL smoke test failed against/.test(l)), 'feedback starts with banner');
    assert(b.feedback.some((l: string) => /Failure kind: `status`/.test(l)), 'feedback includes backticked kind');
    assert(b.feedback.some((l: string) => /Observed HTTP status: 502/.test(l)), 'feedback carries observed status');
    assert(
      b.feedback.some((l: string) => /Push fixes to the existing PR branch/.test(l)),
      'feedback ends with actionable instruction',
    );
  }

  console.log('Test: buildSmokeBlocker — timeout renders as TIMED_OUT');
  {
    const r = mkFailResult('timeout', {
      failure: { kind: 'timeout', message: 'request exceeded 15s' },
    });
    const b = buildSmokeBlocker(r);
    assert(b.failedChecks[0].state === 'TIMED_OUT', 'timeout → TIMED_OUT state');
    assert(b.failedChecks[0].name === 'smoke:timeout', 'timeout check name');
  }

  console.log('Test: buildSmokeBlocker — bodyExcerpt forwarded to feedback when present');
  {
    const r = mkFailResult('status', {
      failure: {
        kind: 'status',
        message: 'expected one of 200 but got 404',
        bodyExcerpt: '<html><body>Not Found</body></html>',
      },
    });
    const b = buildSmokeBlocker(r);
    assert(
      b.feedback.some((l: string) => /Response body excerpt:/.test(l) && /Not Found/.test(l)),
      'feedback carries body excerpt',
    );
  }

  console.log('Test: buildSmokeBlocker — blank bodyExcerpt omitted from feedback');
  {
    const r = mkFailResult('status', {
      failure: { kind: 'status', message: 'failure', bodyExcerpt: '   \n  ' },
    });
    const b = buildSmokeBlocker(r);
    assert(!b.feedback.some((l: string) => /Response body excerpt:/.test(l)), 'blank excerpt omitted');
  }

  console.log('Test: buildSmokeBlocker — screenshotPath surfaced when Playwright populates it');
  {
    const r = mkFailResult('title', {
      title: 'ReferenceError',
      failure: {
        kind: 'title',
        message: 'title did not match /My App/i',
        screenshotPath: '/jobs/abc123/smoke-failure.png',
      },
    });
    const b = buildSmokeBlocker(r);
    assert(
      b.feedback.some((l: string) => /Screenshot captured at \/jobs\/abc123\/smoke-failure\.png/.test(l)),
      'feedback references the screenshot path',
    );
    assert(
      b.feedback.some((l: string) => /Observed <title>: "ReferenceError"/.test(l)),
      'feedback carries observed title',
    );
  }

  console.log('Test: buildSmokeBlocker — missing failure field falls back to kind:unknown');
  {
    // Defensive: the runner contract says failure is always set on ok=false,
    // but a malformed persisted result.json shouldn't crash the builder.
    const r: SmokeResult = {
      ok: false,
      url: 'https://app.vercel.app/',
      durationMs: 0,
      finishedAt: '2025-01-01T00:00:00.000Z',
    };
    const b = buildSmokeBlocker(r);
    assert(/\(unknown\): smoke check failed/.test(b.message), 'message falls back to unknown kind + default msg');
    assert(b.failedChecks[0].name === 'smoke:unknown', 'check name falls back to smoke:unknown');
    assert(b.failedChecks[0].state === 'FAILURE', 'unknown kind renders as FAILURE (not TIMED_OUT)');
  }

  console.log('Test: buildSmokeBlocker — empty url placeholder + missing status/title omitted');
  {
    const r: SmokeResult = {
      ok: false,
      url: '',
      durationMs: 0,
      finishedAt: '2025-01-01T00:00:00.000Z',
      failure: { kind: 'network', message: 'ECONNREFUSED' },
    };
    const b = buildSmokeBlocker(r);
    assert(/\(unknown preview URL\)/.test(b.message), 'empty URL renders as placeholder');
    assert(!/status=/.test(b.message), 'missing status omitted from message');
    assert(!/title=/.test(b.message), 'missing title omitted from message');
    assert(b.failedChecks[0].url === null, 'failed_check URL is null when smoke URL was empty');
    assert(!b.feedback.some((l: string) => /Observed HTTP status/.test(l)), 'no status feedback line when status missing');
    assert(!b.feedback.some((l: string) => /Observed <title>/.test(l)), 'no title feedback line when title missing');
  }

  console.log(`smoke.test: ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

runAll().catch((e) => {
  console.log(`  FAIL: async harness — ${(e as Error).message}`);
  process.exit(1);
});
