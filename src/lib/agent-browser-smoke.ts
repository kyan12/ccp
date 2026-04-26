/**
 * Vercel Labs agent-browser smoke-test orchestrator.
 *
 * This runner is intentionally supervisor-side only: it shells out to the
 * `agent-browser` CLI for each browser action and converts every failure mode
 * (missing binary, timeout, non-zero exit, garbage output) into a stable
 * SmokeResult. That keeps browser processes out of the long-running CCP daemon
 * while still preserving agent-readable evidence artifacts.
 */

import fs = require('fs');
import os = require('os');
import path = require('path');
import { spawnSync } from 'child_process';
import type { AgentBrowserSmokeConfig, SmokeConfig, SmokeResult, SmokeArtifacts } from '../types';
import { joinPreviewUrl, resolveSmokeConfig } from './smoke';

export const AGENT_BROWSER_STARTUP_BUFFER_MS = 10_000;
export const AGENT_BROWSER_MAX_BUFFER_BYTES = 32 * 1024 * 1024;
export const DEFAULT_AGENT_BROWSER_BINARY = 'agent-browser';

export const DEFAULT_AGENT_BROWSER_ARTIFACTS: Required<NonNullable<AgentBrowserSmokeConfig['artifacts']>> = {
  screenshot: true,
  console: true,
  errors: true,
  har: false,
  trace: false,
};

export interface ResolvedAgentBrowserConfig {
  binary: string;
  snapshot: boolean;
  artifacts: Required<NonNullable<AgentBrowserSmokeConfig['artifacts']>>;
  extraArgs: string[];
}

export interface AgentBrowserExecutorCall {
  binary: string;
  command: string;
  args: string[];
  timeoutMs: number;
  cwd?: string;
}

export interface AgentBrowserCommandOutput {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  timedOut: boolean;
  errorCode?: string;
}

export type AgentBrowserExecutor = (
  call: AgentBrowserExecutorCall,
) => AgentBrowserCommandOutput | Promise<AgentBrowserCommandOutput>;

function nowIso(): string {
  return new Date().toISOString();
}

function safeString(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

export function resolveAgentBrowserConfig(c: AgentBrowserSmokeConfig | undefined): ResolvedAgentBrowserConfig {
  const raw = c || {};
  return {
    binary: typeof raw.binary === 'string' && raw.binary.length ? raw.binary : DEFAULT_AGENT_BROWSER_BINARY,
    snapshot: typeof raw.snapshot === 'boolean' ? raw.snapshot : true,
    artifacts: {
      ...DEFAULT_AGENT_BROWSER_ARTIFACTS,
      ...(raw.artifacts || {}),
    },
    extraArgs: Array.isArray(raw.extraArgs) ? raw.extraArgs.filter((a): a is string => typeof a === 'string') : [],
  };
}

/** Parse the first JSON object/array present in CLI stdout, tolerating preambles. */
export function parseAgentBrowserStdout(stdout: string): any | null {
  const text = (stdout || '').trim();
  if (!text) return null;
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    try { return JSON.parse(lines[i]); } catch {}
  }
  const starts = [text.indexOf('{'), text.indexOf('[')].filter((n) => n >= 0).sort((a, b) => a - b);
  if (!starts.length) return null;
  const start = starts[0];
  for (let end = text.length; end > start; end--) {
    try { return JSON.parse(text.slice(start, end)); } catch {}
  }
  return null;
}

export const defaultAgentBrowserExecutor: AgentBrowserExecutor = (call) => {
  const res = spawnSync(call.binary, [call.command, ...call.args, '--json'], {
    cwd: call.cwd,
    encoding: 'utf8',
    timeout: call.timeoutMs,
    maxBuffer: AGENT_BROWSER_MAX_BUFFER_BYTES,
  });
  const err = res.error as (Error & { code?: string }) | undefined;
  return {
    stdout: typeof res.stdout === 'string' ? res.stdout : String(res.stdout || ''),
    stderr: typeof res.stderr === 'string' ? res.stderr : String(res.stderr || ''),
    exitCode: typeof res.status === 'number' ? res.status : null,
    timedOut: !!(err && err.code === 'ETIMEDOUT'),
    errorCode: err?.code,
  };
};

function artifactDir(jobId?: string): string {
  const dir = path.join(os.tmpdir(), 'ccp-agent-browser', jobId || `smoke-${process.pid}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function writeArtifact(filePath: string, contents: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, contents || '', 'utf8');
}

function failureResult(url: string, started: number, kind: NonNullable<SmokeResult['failure']>['kind'], message: string, artifacts?: SmokeArtifacts): SmokeResult {
  return { ok: false, url, durationMs: Date.now() - started, finishedAt: nowIso(), failure: { kind, message }, artifacts };
}

function commandFailureMessage(command: string, out: AgentBrowserCommandOutput, timeoutSec: number): { kind: NonNullable<SmokeResult['failure']>['kind']; message: string } {
  const stderr = safeString(out.stderr).trim();
  const stdout = safeString(out.stdout).trim();
  if (out.timedOut) {
    return { kind: 'timeout', message: `agent-browser ${command} timed out after ${timeoutSec}s` };
  }
  if (out.errorCode === 'ENOENT') {
    return {
      kind: 'unknown',
      message:
        'agent-browser binary was not found. Install it on the CCP supervisor host with `npm install -D agent-browser` (or configure smoke.agentBrowser.binary), then run `npx agent-browser install` so Chrome for Testing is available.',
    };
  }
  return {
    kind: 'unknown',
    message: `agent-browser ${command} exited ${out.exitCode ?? 'without a status'}${stderr ? `: ${stderr}` : stdout ? `: ${stdout}` : ''}`,
  };
}

export interface RunAgentBrowserSmokeOptions {
  jobId?: string;
}

export async function runAgentBrowserSmoke(
  previewUrl: string | null | undefined,
  rawConfig: SmokeConfig | undefined,
  executor: AgentBrowserExecutor = defaultAgentBrowserExecutor,
  options: RunAgentBrowserSmokeOptions = {},
): Promise<SmokeResult> {
  const smokeCfg = resolveSmokeConfig(rawConfig);
  const cfg = resolveAgentBrowserConfig(rawConfig?.agentBrowser);
  const started = Date.now();

  if (!smokeCfg.enabled) {
    return { ok: false, url: previewUrl || '', durationMs: 0, finishedAt: nowIso(), failure: { kind: 'skipped', message: 'smoke disabled for this repo' } };
  }
  if (!previewUrl) {
    return { ok: false, url: '', durationMs: 0, finishedAt: nowIso(), failure: { kind: 'skipped', message: 'no preview URL detected yet' } };
  }

  const url = joinPreviewUrl(previewUrl, smokeCfg.path);
  const timeoutMs = smokeCfg.timeoutSec * 1000 + AGENT_BROWSER_STARTUP_BUFFER_MS;
  const dir = artifactDir(options.jobId);
  const artifacts: SmokeArtifacts = {};

  const run = async (command: string, args: string[]): Promise<AgentBrowserCommandOutput> => {
    return await Promise.resolve(executor({ binary: cfg.binary, command, args: [...args, ...cfg.extraArgs], timeoutMs }));
  };

  if (cfg.artifacts.trace) {
    const traceStart = await run('trace', ['start']);
    if (traceStart.timedOut || traceStart.exitCode !== 0 || traceStart.errorCode) {
      const f = commandFailureMessage('trace start', traceStart, smokeCfg.timeoutSec);
      return failureResult(url, started, f.kind, `${f.message}. Trace capture requires an agent-browser version with \`trace start/stop\` support; disable smoke.agentBrowser.artifacts.trace if this host has an older CLI.`, artifacts);
    }
  }
  if (cfg.artifacts.har) {
    const harStart = await run('network', ['har', 'start']);
    if (harStart.timedOut || harStart.exitCode !== 0 || harStart.errorCode) {
      const f = commandFailureMessage('network har start', harStart, smokeCfg.timeoutSec);
      return failureResult(url, started, f.kind, `${f.message}. HAR capture is version-dependent in agent-browser; upgrade the CLI or disable smoke.agentBrowser.artifacts.har.`, artifacts);
    }
  }

  const openArgs = [url];
  if (smokeCfg.userAgent) openArgs.push('--user-agent', smokeCfg.userAgent);
  const opened = await run('open', openArgs);
  if (opened.timedOut || opened.exitCode !== 0 || opened.errorCode) {
    const f = commandFailureMessage('open', opened, smokeCfg.timeoutSec);
    return failureResult(url, started, f.kind, f.message, artifacts);
  }

  const parsed = parseAgentBrowserStdout(opened.stdout);
  let title: string | null = typeof parsed?.title === 'string' ? parsed.title : null;

  if (cfg.snapshot) {
    const snap = await run('snapshot', []);
    if (snap.exitCode === 0 && !snap.timedOut && !snap.errorCode) {
      const p = parseAgentBrowserStdout(snap.stdout);
      if (!title && typeof p?.title === 'string') title = p.title;
      const snapshotPath = path.join(dir, 'agent-browser-snapshot.json');
      writeArtifact(snapshotPath, snap.stdout || JSON.stringify(p ?? null));
      artifacts.snapshotPath = snapshotPath;
    }
  }

  if (cfg.artifacts.screenshot) {
    const shot = await run('screenshot', []);
    if (shot.exitCode === 0 && !shot.timedOut && !shot.errorCode) {
      const p = parseAgentBrowserStdout(shot.stdout);
      const screenshotPath = typeof p?.path === 'string' ? p.path : path.join(dir, 'agent-browser-screenshot.png');
      artifacts.screenshotPath = screenshotPath;
    }
  }
  if (cfg.artifacts.console) {
    const out = await run('console', []);
    const consolePath = path.join(dir, 'agent-browser-console.json');
    writeArtifact(consolePath, out.stdout || '[]');
    artifacts.consolePath = consolePath;
  }
  if (cfg.artifacts.errors) {
    const out = await run('errors', []);
    const errorsPath = path.join(dir, 'agent-browser-errors.json');
    writeArtifact(errorsPath, out.stdout || '[]');
    artifacts.errorsPath = errorsPath;
  }
  if (cfg.artifacts.har) {
    const requestedHarPath = path.join(dir, 'agent-browser-network.har');
    const out = await run('network', ['har', 'stop', requestedHarPath]);
    if (out.timedOut || out.exitCode !== 0 || out.errorCode) {
      const f = commandFailureMessage('network har stop', out, smokeCfg.timeoutSec);
      return failureResult(url, started, f.kind, `${f.message}. HAR capture is version-dependent in agent-browser; upgrade the CLI or disable smoke.agentBrowser.artifacts.har.`, artifacts);
    }
    const p = parseAgentBrowserStdout(out.stdout);
    const harPath = typeof p?.path === 'string' ? p.path : requestedHarPath;
    // Do not overwrite the HAR file if the CLI already wrote binary artifact bytes to disk.
    // The command's stdout is usually JSON metadata, not the artifact payload itself.
    if (!fs.existsSync(harPath) && out.stdout && !p) writeArtifact(harPath, out.stdout);
    artifacts.harPath = harPath;
  }
  if (cfg.artifacts.trace) {
    const requestedTracePath = path.join(dir, 'agent-browser-trace.zip');
    const out = await run('trace', ['stop', requestedTracePath]);
    if (out.timedOut || out.exitCode !== 0 || out.errorCode) {
      const f = commandFailureMessage('trace stop', out, smokeCfg.timeoutSec);
      return failureResult(url, started, f.kind, `${f.message}. Trace capture requires an agent-browser version with \`trace start/stop\` support; disable smoke.agentBrowser.artifacts.trace if this host has an older CLI.`, artifacts);
    }
    const p = parseAgentBrowserStdout(out.stdout);
    const tracePath = typeof p?.path === 'string' ? p.path : requestedTracePath;
    // Do not overwrite the trace archive if the CLI already wrote binary artifact bytes to disk.
    if (!fs.existsSync(tracePath) && out.stdout && !p) writeArtifact(tracePath, out.stdout);
    artifacts.tracePath = tracePath;
  }

  if (smokeCfg.titleRegex) {
    let re: RegExp;
    try { re = new RegExp(smokeCfg.titleRegex, 'i'); }
    catch (e) { return failureResult(url, started, 'unknown', `invalid titleRegex /${smokeCfg.titleRegex}/: ${(e as Error).message}`, artifacts); }
    if (!title || !re.test(title)) {
      return { ok: false, url, title, durationMs: Date.now() - started, finishedAt: nowIso(), artifacts, failure: { kind: 'title', message: title ? `title "${title}" did not match /${smokeCfg.titleRegex}/i` : `agent-browser did not return a page title to match /${smokeCfg.titleRegex}/i`, screenshotPath: artifacts.screenshotPath } };
    }
  }

  return { ok: true, url, title, durationMs: Date.now() - started, finishedAt: nowIso(), artifacts };
}

module.exports = {
  AGENT_BROWSER_STARTUP_BUFFER_MS,
  AGENT_BROWSER_MAX_BUFFER_BYTES,
  DEFAULT_AGENT_BROWSER_BINARY,
  DEFAULT_AGENT_BROWSER_ARTIFACTS,
  resolveAgentBrowserConfig,
  parseAgentBrowserStdout,
  defaultAgentBrowserExecutor,
  runAgentBrowserSmoke,
};
