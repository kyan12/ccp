/* Unit tests for the CCP agent-browser smoke runner.
 *
 * Scope: supervisor-side orchestration only. These tests use the injected
 * executor seam so they never require a real Chrome install or the Vercel Labs
 * agent-browser binary. The production runner must keep browser work isolated
 * behind short-lived CLI calls and return stable SmokeResult objects for every
 * failure mode.
 */

import type { SmokeConfig } from '../types';
import { buildSmokeBlocker, runSmoke } from './smoke';
import {
  AGENT_BROWSER_STARTUP_BUFFER_MS,
  DEFAULT_AGENT_BROWSER_ARTIFACTS,
  DEFAULT_AGENT_BROWSER_BINARY,
  parseAgentBrowserStdout,
  resolveAgentBrowserConfig,
  runAgentBrowserSmoke,
} from './agent-browser-smoke';
import type {
  AgentBrowserCommandOutput,
  AgentBrowserExecutor,
  AgentBrowserExecutorCall,
} from './agent-browser-smoke';

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
  outputs: AgentBrowserCommandOutput[],
  captured: AgentBrowserExecutorCall[] = [],
): AgentBrowserExecutor {
  let i = 0;
  return (call) => {
    captured.push(call);
    const out = outputs[Math.min(i, outputs.length - 1)];
    i++;
    return out;
  };
}

function ok(stdout: string | object = '{}'): AgentBrowserCommandOutput {
  return {
    stdout: typeof stdout === 'string' ? stdout : JSON.stringify(stdout),
    stderr: '',
    exitCode: 0,
    timedOut: false,
  };
}

function fail(partial: Partial<AgentBrowserCommandOutput>): AgentBrowserCommandOutput {
  return {
    stdout: partial.stdout || '',
    stderr: partial.stderr || '',
    exitCode: partial.exitCode ?? 1,
    timedOut: partial.timedOut || false,
    errorCode: partial.errorCode,
  };
}

async function run(): Promise<void> {
  console.log('Test: resolveAgentBrowserConfig — empty input yields safe defaults');
  {
    const r = resolveAgentBrowserConfig(undefined);
    await asyncAssert(r.binary === DEFAULT_AGENT_BROWSER_BINARY, 'binary default');
    await asyncAssert(r.artifacts.screenshot === DEFAULT_AGENT_BROWSER_ARTIFACTS.screenshot, 'screenshot default');
    await asyncAssert(r.artifacts.console === DEFAULT_AGENT_BROWSER_ARTIFACTS.console, 'console default');
    await asyncAssert(r.artifacts.errors === DEFAULT_AGENT_BROWSER_ARTIFACTS.errors, 'errors default');
    await asyncAssert(r.artifacts.har === DEFAULT_AGENT_BROWSER_ARTIFACTS.har, 'har default');
    await asyncAssert(r.snapshot === true, 'snapshot default');
  }

  console.log('Test: resolveAgentBrowserConfig — partial overrides merged');
  {
    const r = resolveAgentBrowserConfig({
      binary: '/opt/bin/agent-browser',
      snapshot: false,
      artifacts: { screenshot: false, console: true, errors: false, har: true, trace: true },
      extraArgs: ['--no-auto-dialog'],
    });
    await asyncAssert(r.binary === '/opt/bin/agent-browser', 'binary override');
    await asyncAssert(r.snapshot === false, 'snapshot override');
    await asyncAssert(r.artifacts.screenshot === false, 'screenshot override');
    await asyncAssert(r.artifacts.console === true, 'console override');
    await asyncAssert(r.artifacts.errors === false, 'errors override');
    await asyncAssert(r.artifacts.har === true, 'har override');
    await asyncAssert(r.artifacts.trace === true, 'trace override');
    await asyncAssert(r.extraArgs.includes('--no-auto-dialog'), 'extraArgs preserved');
  }

  console.log('Test: parseAgentBrowserStdout — parses JSON despite CLI preamble');
  {
    const parsed = parseAgentBrowserStdout('agent-browser warning\n{"title":"Demo","url":"https://x"}\n');
    await asyncAssert(parsed?.title === 'Demo', 'preamble + json parses');
    await asyncAssert(parseAgentBrowserStdout('') === null, 'empty -> null');
    await asyncAssert(parseAgentBrowserStdout('not json') === null, 'garbage -> null');
    await asyncAssert(parseAgentBrowserStdout('{broken') === null, 'bad brace terminates');
  }

  console.log('Test: runAgentBrowserSmoke — disabled config returns kind:skipped');
  {
    const r = await runAgentBrowserSmoke('https://preview.vercel.app', { enabled: false });
    await asyncAssert(r.ok === false, 'ok=false when disabled');
    await asyncAssert(r.failure?.kind === 'skipped', 'kind=skipped');
    await asyncAssert(r.durationMs === 0, 'durationMs=0');
  }

  console.log('Test: runAgentBrowserSmoke — happy path executes short-lived CLI commands and preserves artifacts');
  {
    const captured: AgentBrowserExecutorCall[] = [];
    const executor = makeExecutor(
      [
        ok({ title: 'Preview App', url: 'https://preview.vercel.app/checkout' }),
        ok({ title: 'Preview App' }),
        ok({ path: '/tmp/ccp-agent-browser/smoke.png' }),
        ok('[]'),
        ok('[]'),
      ],
      captured,
    );
    const r = await runAgentBrowserSmoke(
      'https://preview.vercel.app',
      {
        enabled: true,
        runner: 'agent-browser',
        path: '/checkout',
        timeoutSec: 20,
        userAgent: 'ccp-agent-browser-test/0.1',
        agentBrowser: { artifacts: { screenshot: true, console: true, errors: true } },
      },
      executor,
      { jobId: 'linear_test_123' },
    );
    await asyncAssert(r.ok === true, 'happy ok');
    await asyncAssert(r.url === 'https://preview.vercel.app/checkout', 'URL joined');
    await asyncAssert(r.title === 'Preview App', 'title captured');
    await asyncAssert(r.artifacts?.screenshotPath === '/tmp/ccp-agent-browser/smoke.png', 'screenshot artifact preserved');
    await asyncAssert(r.artifacts?.consolePath?.endsWith('/agent-browser-console.json'), 'console artifact path persisted');
    await asyncAssert(r.artifacts?.errorsPath?.endsWith('/agent-browser-errors.json'), 'errors artifact path persisted');
    await asyncAssert(captured[0].command === 'open', 'first command opens page');
    await asyncAssert(captured[0].args.includes('https://preview.vercel.app/checkout'), 'open URL passed');
    await asyncAssert(captured[0].args.includes('--user-agent'), 'user-agent flag passed');
    await asyncAssert(captured[0].timeoutMs === 20_000 + AGENT_BROWSER_STARTUP_BUFFER_MS, 'executor timeout includes buffer');
  }

  console.log('Test: runAgentBrowserSmoke — HAR and trace artifacts are started before navigation and stopped with explicit paths');
  {
    const captured: AgentBrowserExecutorCall[] = [];
    const executor = makeExecutor(
      [
        ok({ path: '/tmp/trace-start' }),
        ok({ path: '/tmp/har-start' }),
        ok({ title: 'Preview App' }),
        ok({ title: 'Preview App' }),
        ok('[]'),
        ok('[]'),
        ok({ path: '/tmp/ccp-agent-browser/network.har' }),
        ok({ path: '/tmp/ccp-agent-browser/trace.zip' }),
      ],
      captured,
    );
    const r = await runAgentBrowserSmoke(
      'https://preview.vercel.app',
      {
        enabled: true,
        runner: 'agent-browser',
        agentBrowser: { artifacts: { screenshot: false, console: true, errors: true, har: true, trace: true } },
      } as SmokeConfig,
      executor,
      { jobId: 'linear_trace_123' },
    );
    await asyncAssert(r.ok === true, 'har/trace ok');
    await asyncAssert(captured[0].command === 'trace' && captured[0].args[0] === 'start', 'trace starts before navigation');
    await asyncAssert(captured[1].command === 'network' && captured[1].args[0] === 'har' && captured[1].args[1] === 'start', 'HAR starts before navigation');
    await asyncAssert(captured[2].command === 'open', 'open happens after recording starts');
    await asyncAssert(captured.some((c) => c.command === 'network' && c.args[0] === 'har' && c.args[1] === 'stop' && c.args.some((a) => a.endsWith('agent-browser-network.har'))), 'HAR stops with explicit artifact path');
    await asyncAssert(captured.some((c) => c.command === 'trace' && c.args[0] === 'stop' && c.args.some((a) => a.endsWith('agent-browser-trace.zip'))), 'trace stops with explicit artifact path');
    await asyncAssert(r.artifacts?.harPath === '/tmp/ccp-agent-browser/network.har', 'HAR artifact path preserved');
    await asyncAssert(r.artifacts?.tracePath === '/tmp/ccp-agent-browser/trace.zip', 'trace artifact path preserved');
  }

  console.log('Test: runAgentBrowserSmoke — HAR and trace stop do not overwrite CLI-written binary artifacts');
  {
    const executor: AgentBrowserExecutor = async (call) => {
      if (call.command === 'network' && call.args[0] === 'har' && call.args[1] === 'stop') {
        const p = call.args[2];
        require('fs').writeFileSync(p, 'HAR_BYTES');
        return ok({ path: p });
      }
      if (call.command === 'trace' && call.args[0] === 'stop') {
        const p = call.args[1];
        require('fs').writeFileSync(p, 'TRACE_BYTES');
        return ok({ path: p });
      }
      if (call.command === 'open') return ok({ title: 'Preview App' });
      if (call.command === 'snapshot') return ok({ title: 'Preview App' });
      return ok('[]');
    };
    const r = await runAgentBrowserSmoke('https://preview.vercel.app', {
      enabled: true,
      runner: 'agent-browser',
      agentBrowser: { artifacts: { screenshot: false, console: false, errors: false, har: true, trace: true } },
    }, executor, { jobId: 'linear_binary_artifacts_123' });
    asyncAssert(r.ok, 'binary artifact run succeeds');
    asyncAssert(require('fs').readFileSync(r.artifacts?.harPath || '', 'utf8') === 'HAR_BYTES', 'HAR file content is preserved');
    asyncAssert(require('fs').readFileSync(r.artifacts?.tracePath || '', 'utf8') === 'TRACE_BYTES', 'trace file content is preserved');
  }

  console.log('Test: runAgentBrowserSmoke — unsupported optional artifact commands fail verbosely');
  {
    const r = await runAgentBrowserSmoke('https://preview.vercel.app', {
      enabled: true,
      runner: 'agent-browser',
      agentBrowser: { artifacts: { screenshot: false, console: false, errors: false, har: true, trace: false } },
    }, makeExecutor([
      ok({ path: '/tmp/har-start' }),
      ok({ title: 'Preview App' }),
      ok({ title: 'Preview App' }),
      fail({ exitCode: 1, stderr: 'unknown command: har' }),
    ]), { jobId: 'linear_unsupported_har_123' });
    await asyncAssert(r.ok === false, 'unsupported artifact command fails the smoke run');
    await asyncAssert(r.failure?.kind === 'unknown', 'unsupported artifact command kind unknown');
    await asyncAssert((r.failure?.message || '').includes('HAR capture is version-dependent'), 'unsupported HAR message explains version dependency');
    await asyncAssert((r.failure?.message || '').includes('disable smoke.agentBrowser.artifacts.har'), 'unsupported HAR message gives operator action');
  }

  console.log('Test: runSmoke dispatcher routes runner:agent-browser via injected executor');
  {
    const captured: AgentBrowserExecutorCall[] = [];
    const r = await runSmoke(
      'https://preview.vercel.app',
      { enabled: true, runner: 'agent-browser' } as SmokeConfig,
      { agentBrowserExecutor: makeExecutor([ok({ title: 'AB' })], captured) },
    );
    await asyncAssert(r.ok === true, 'dispatcher result ok');
    await asyncAssert(captured.length >= 1 && captured[0].command === 'open', 'agent-browser executor used');
  }

  console.log('Test: runAgentBrowserSmoke — missing binary returns verbose non-crashing failure');
  {
    const r = await runAgentBrowserSmoke(
      'https://preview.vercel.app',
      { enabled: true, runner: 'agent-browser' } as SmokeConfig,
      makeExecutor([fail({ errorCode: 'ENOENT', stderr: 'spawn agent-browser ENOENT' })]),
    );
    await asyncAssert(r.ok === false, 'missing binary fails');
    await asyncAssert(r.failure?.kind === 'unknown', 'missing binary kind unknown');
    await asyncAssert((r.failure?.message || '').includes('agent-browser binary was not found'), 'verbose missing binary message');
    await asyncAssert((r.failure?.message || '').includes('npm install -D agent-browser'), 'install guidance included');
  }

  console.log('Test: runAgentBrowserSmoke — timeout/nonzero/garbage output become stable failures');
  {
    const timeout = await runAgentBrowserSmoke(
      'https://preview.vercel.app',
      { enabled: true, runner: 'agent-browser', timeoutSec: 1 } as SmokeConfig,
      makeExecutor([fail({ timedOut: true, stderr: 'timed out' })]),
    );
    await asyncAssert(timeout.failure?.kind === 'timeout', 'timeout kind');
    await asyncAssert((timeout.failure?.message || '').includes('timed out after 1s'), 'timeout message');

    const nonzero = await runAgentBrowserSmoke(
      'https://preview.vercel.app',
      { enabled: true, runner: 'agent-browser' } as SmokeConfig,
      makeExecutor([fail({ exitCode: 2, stderr: 'Chrome launch failed' })]),
    );
    await asyncAssert(nonzero.failure?.kind === 'unknown', 'nonzero kind');
    await asyncAssert((nonzero.failure?.message || '').includes('Chrome launch failed'), 'stderr included');

    const garbage = await runAgentBrowserSmoke(
      'https://preview.vercel.app',
      { enabled: true, runner: 'agent-browser' } as SmokeConfig,
      makeExecutor([ok('not json, but command succeeded')]),
    );
    await asyncAssert(garbage.ok === true, 'garbage stdout is not fatal when command exits 0');
    await asyncAssert(garbage.title === null, 'garbage stdout title null');
  }

  console.log('Test: buildSmokeBlocker — includes agent-browser evidence artifacts in feedback');
  {
    const blocker = buildSmokeBlocker({
      ok: false,
      url: 'https://preview.vercel.app',
      durationMs: 100,
      finishedAt: new Date().toISOString(),
      failure: {
        kind: 'unknown',
        message: 'agent-browser smoke failed',
        screenshotPath: '/tmp/smoke.png',
      },
      artifacts: {
        screenshotPath: '/tmp/smoke.png',
        consolePath: '/tmp/console.json',
        errorsPath: '/tmp/errors.json',
        harPath: '/tmp/network.har',
        tracePath: '/tmp/trace.zip',
      },
    });
    const text = blocker.feedback.join('\n');
    await asyncAssert(text.includes('/tmp/smoke.png'), 'screenshot in feedback');
    await asyncAssert(text.includes('/tmp/console.json'), 'console artifact in feedback');
    await asyncAssert(text.includes('/tmp/errors.json'), 'errors artifact in feedback');
    await asyncAssert(text.includes('/tmp/network.har'), 'HAR artifact in feedback');
    await asyncAssert(text.includes('/tmp/trace.zip'), 'trace artifact in feedback');
  }

  if (asyncFail > 0) {
    throw new Error(`${asyncFail} async assertions failed (${asyncPass} passed)`);
  }
  console.log(`All agent-browser smoke tests passed (${asyncPass} assertions).`);
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
