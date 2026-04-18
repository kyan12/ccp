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
} = smoke;

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

  console.log(`smoke.test: ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

runAll().catch((e) => {
  console.log(`  FAIL: async harness — ${(e as Error).message}`);
  process.exit(1);
});
