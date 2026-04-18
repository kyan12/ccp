/**
 * Phase 4 (PR C): Playwright smoke-test child runner.
 *
 * This file is executed in a SHORT-LIVED Node subprocess spawned by
 * `playwright-smoke.ts`. It reads one JSON object on stdin, runs a
 * Playwright-based smoke check, and writes EXACTLY ONE JSON object on
 * stdout (the `PlaywrightRunnerOutput` shape).
 *
 * It MUST NOT:
 *   - Be imported by any long-running part of the supervisor.
 *   - Print anything other than the final JSON object to stdout.
 *   - Call `process.exit(non-zero)` for expected failures — structured
 *     failures are communicated via the JSON payload with `ok: false`.
 *
 * Playwright is an OPTIONAL dependency. When the package is missing,
 * this runner emits a structured `kind: 'unknown'` result with a clear
 * install-instructions message. The supervisor does not require
 * Playwright for `npm install` / `npm test` to work.
 */

import fs = require('fs');
import type { PlaywrightRunnerInput, PlaywrightRunnerOutput } from './playwright-smoke';

// Minimal structural types for the subset of the Playwright API we use.
// Declared locally so we don't need `@types/playwright` in devDependencies
// and the supervisor compiles with or without playwright installed.
interface PwBrowser {
  newContext(opts?: {
    viewport?: { width: number; height: number } | null;
    userAgent?: string;
  }): Promise<PwContext>;
  close(): Promise<void>;
}
interface PwContext {
  newPage(): Promise<PwPage>;
  close(): Promise<void>;
}
interface PwResponse {
  status(): number;
}
interface PwPage {
  setDefaultTimeout(ms: number): void;
  goto(
    url: string,
    opts?: { waitUntil?: 'load' | 'domcontentloaded' | 'networkidle' | 'commit'; timeout?: number },
  ): Promise<PwResponse | null>;
  title(): Promise<string>;
  content(): Promise<string>;
  evaluate<T>(expr: string): Promise<T>;
  screenshot(opts: { path: string; fullPage?: boolean }): Promise<Buffer>;
}
interface PwBrowserType {
  launch(opts?: { headless?: boolean }): Promise<PwBrowser>;
}
interface PwModule {
  chromium: PwBrowserType;
  firefox: PwBrowserType;
  webkit: PwBrowserType;
}

const MAX_BODY_EXCERPT_BYTES = 2 * 1024;

function truncate(body: string, maxBytes = MAX_BODY_EXCERPT_BYTES): string {
  if (!body) return '';
  const buf = Buffer.from(body, 'utf8');
  if (buf.byteLength <= maxBytes) return body;
  const head = buf.subarray(0, maxBytes).toString('utf8');
  return `${head}\n\n[... truncated, ${buf.byteLength - maxBytes} more bytes ...]`;
}

function extractTitle(body: string): string | null {
  const m = body.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  if (!m || !m[1]) return null;
  return m[1].replace(/\s+/g, ' ').trim() || null;
}

function emit(out: PlaywrightRunnerOutput): void {
  // Single JSON line on stdout — the parent does a tolerant scan, but
  // we keep it clean so normal runs are one object with no preamble.
  process.stdout.write(JSON.stringify(out));
}

function readStdinSync(): string {
  // fd=0 is stdin. We read synchronously so we don't need a pump.
  try {
    return fs.readFileSync(0, 'utf8');
  } catch (e) {
    return '';
  }
}

async function safeScreenshot(page: PwPage | null, destPath: string): Promise<boolean> {
  if (!page || !destPath) return false;
  try {
    await page.screenshot({ path: destPath, fullPage: true });
    return true;
  } catch {
    return false;
  }
}

async function main(): Promise<void> {
  let input: PlaywrightRunnerInput;
  try {
    input = JSON.parse(readStdinSync()) as PlaywrightRunnerInput;
  } catch (e) {
    emit({
      ok: false,
      status: null,
      title: null,
      failure: {
        kind: 'unknown',
        message: `playwright runner: failed to parse stdin JSON: ${(e as Error).message}`,
      },
    });
    return;
  }

  // Load playwright lazily. The require path is a *runtime* string so
  // TypeScript doesn't complain about missing types and we can catch
  // MODULE_NOT_FOUND cleanly.
  let pw: PwModule;
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    pw = require('playwright') as PwModule;
  } catch (e) {
    const err = e as NodeJS.ErrnoException;
    if (err.code === 'MODULE_NOT_FOUND') {
      emit({
        ok: false,
        status: null,
        title: null,
        failure: {
          kind: 'unknown',
          message:
            'playwright package not installed — run `npm i -D playwright` on the supervisor host and ' +
            '`npx playwright install ' +
            (input.playwright.browser || 'chromium') +
            '`. See docs/smoke.md.',
        },
      });
      return;
    }
    emit({
      ok: false,
      status: null,
      title: null,
      failure: {
        kind: 'unknown',
        message: `playwright runner: require('playwright') threw: ${err.message}`,
      },
    });
    return;
  }

  const browserType = pw[input.playwright.browser] as PwBrowserType | undefined;
  if (!browserType) {
    emit({
      ok: false,
      status: null,
      title: null,
      failure: {
        kind: 'unknown',
        message: `playwright runner: unknown browser '${input.playwright.browser}'`,
      },
    });
    return;
  }

  // Target URL: same joining rules as the HTTP runner (base-path preserving).
  const base = input.previewUrl.replace(/\/+$/, '');
  const reqPath = input.path.startsWith('/') ? input.path : `/${input.path}`;
  const url = reqPath === '/' ? `${base}/` : `${base}${reqPath}`;

  let browser: PwBrowser | null = null;
  let context: PwContext | null = null;
  let page: PwPage | null = null;

  try {
    browser = await browserType.launch({ headless: true });
    context = await browser.newContext({
      viewport: input.playwright.viewport,
      userAgent: input.userAgent,
    });
    page = await context.newPage();
    page.setDefaultTimeout(input.timeoutMs);

    let response: PwResponse | null;
    try {
      response = await page.goto(url, {
        waitUntil: input.playwright.waitUntil,
        timeout: input.timeoutMs,
      });
    } catch (e) {
      const msg = (e as Error).message || String(e);
      const isTimeout = /timeout/i.test(msg);
      await safeScreenshot(page, input.screenshotPath);
      emit({
        ok: false,
        status: null,
        title: null,
        failure: {
          kind: isTimeout ? 'timeout' : 'network',
          message: msg,
        },
        ...(input.screenshotPath ? { screenshotPath: input.screenshotPath } : {}),
      });
      return;
    }

    if (!response) {
      await safeScreenshot(page, input.screenshotPath);
      emit({
        ok: false,
        status: null,
        title: null,
        failure: {
          kind: 'network',
          message: `playwright: page.goto returned null for ${url}`,
        },
        ...(input.screenshotPath ? { screenshotPath: input.screenshotPath } : {}),
      });
      return;
    }

    const status = response.status();
    const title = (await page.title().catch(() => '')) || null;
    const body = await page.content().catch(() => '');

    if (!input.expectStatus.includes(status)) {
      await safeScreenshot(page, input.screenshotPath);
      emit({
        ok: false,
        status,
        title: title ?? extractTitle(body),
        failure: {
          kind: 'status',
          message: `got status ${status}, expected one of ${input.expectStatus.join(', ')}`,
          bodyExcerpt: truncate(body),
        },
        ...(input.screenshotPath ? { screenshotPath: input.screenshotPath } : {}),
      });
      return;
    }

    if (input.titleRegex) {
      let re: RegExp;
      try {
        re = new RegExp(input.titleRegex, 'i');
      } catch (e) {
        await safeScreenshot(page, input.screenshotPath);
        emit({
          ok: false,
          status,
          title,
          failure: {
            kind: 'unknown',
            message: `invalid titleRegex /${input.titleRegex}/: ${(e as Error).message}`,
            bodyExcerpt: truncate(body),
          },
          ...(input.screenshotPath ? { screenshotPath: input.screenshotPath } : {}),
        });
        return;
      }
      if (!title || !re.test(title)) {
        await safeScreenshot(page, input.screenshotPath);
        emit({
          ok: false,
          status,
          title,
          failure: {
            kind: 'title',
            message: title
              ? `title "${title}" did not match /${input.titleRegex}/i`
              : `page had no <title> to match /${input.titleRegex}/i`,
            bodyExcerpt: truncate(body),
          },
          ...(input.screenshotPath ? { screenshotPath: input.screenshotPath } : {}),
        });
        return;
      }
    }

    if (input.playwright.assertExpression) {
      let assertionOk: boolean;
      try {
        const v = await page.evaluate<unknown>(input.playwright.assertExpression);
        assertionOk = Boolean(v);
      } catch (e) {
        await safeScreenshot(page, input.screenshotPath);
        emit({
          ok: false,
          status,
          title,
          failure: {
            kind: 'unknown',
            message: `assertExpression evaluation threw: ${(e as Error).message}`,
            bodyExcerpt: truncate(body),
          },
          ...(input.screenshotPath ? { screenshotPath: input.screenshotPath } : {}),
        });
        return;
      }
      if (!assertionOk) {
        await safeScreenshot(page, input.screenshotPath);
        emit({
          ok: false,
          status,
          title,
          failure: {
            // Reuse 'title' kind for assertion failures so the
            // SmokeResult.failure.kind enum doesn't churn this PR. A
            // future PR can add a dedicated 'assertion' kind once
            // consumers (dashboards, PR D's gate) are updated.
            kind: 'title',
            message: `assertExpression returned falsy: ${input.playwright.assertExpression}`,
            bodyExcerpt: truncate(body),
          },
          ...(input.screenshotPath ? { screenshotPath: input.screenshotPath } : {}),
        });
        return;
      }
    }

    emit({
      ok: true,
      status,
      title,
    });
  } catch (e) {
    await safeScreenshot(page, input.screenshotPath);
    emit({
      ok: false,
      status: null,
      title: null,
      failure: {
        kind: 'unknown',
        message: `playwright runner threw: ${(e as Error).message || String(e)}`,
      },
      ...(input.screenshotPath ? { screenshotPath: input.screenshotPath } : {}),
    });
  } finally {
    try { if (context) await context.close(); } catch {}
    try { if (browser) await browser.close(); } catch {}
  }
}

// Top-level catch for synchronous failures before main() is awaited.
main().catch((e) => {
  try {
    emit({
      ok: false,
      status: null,
      title: null,
      failure: {
        kind: 'unknown',
        message: `playwright runner top-level catch: ${(e as Error).message || String(e)}`,
      },
    });
  } catch {
    // Last resort — let the parent detect the crash via exit code.
    process.exitCode = 1;
  }
});
