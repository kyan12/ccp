/**
 * Devin terminal bridge agent driver.
 *
 * This is intentionally a dormant scaffold: registering the driver makes CCP
 * capable of routing a job to Devin when explicitly selected (`agent:devin`,
 * repo.agent, or CCP_AGENT=devin), but the built-in default remains
 * claude-code and no repo config is changed here.
 *
 * Devin's terminal product is still evolving, so the invocation is
 * configurable through CCP_DEVIN_COMMAND. The default assumes a future/simple
 * terminal-style CLI shape:
 *
 *   cat <promptFile> | devin terminal run --cwd <repoPath>
 *
 * If the local CLI shape differs, set:
 *
 *   CCP_DEVIN_BIN=/path/to/devin
 *   CCP_DEVIN_COMMAND='devin terminal run --cwd {repoPath} --prompt-file {promptPath}'
 *
 * Supported template tokens are {bin}, {repoPath}, {promptPath}, and {jobId};
 * all replacements are shell-quoted. If the template starts with the literal
 * word `devin`, it is replaced with {bin} so operators can write natural
 * templates without hardcoding a path.
 */

import { spawnSync } from 'child_process';
import { commandExists, shellQuote, run } from '../shell';
import type {
  AgentBuildContext,
  AgentCommand,
  AgentDriver,
  AgentPreflight,
  AgentProbeResult,
} from './types';

const DEVIN_API_ERROR_PATTERNS: RegExp[] = [
  /devin.*API\s*Error:\s*5\d\d\b/i,
  /devin.*\b5\d\d\b.*(bad gateway|service unavailable|gateway timeout|error)/i,
  /devin.*terminal.*(failed|unavailable|disconnected|timed out)/i,
  /devin.*temporar(?:ily)? unavailable/i,
  /service.*unavailable/i,
  /ECONNRESET|ETIMEDOUT|ECONNREFUSED|EAI_AGAIN/,
];

const DEVIN_RATE_LIMIT_PATTERNS: RegExp[] = [
  /devin.*rate[_ ]?limit.*reset.*?(\d{1,2}(?::\d{2})?\s*(?:am|pm)?)/i,
  /devin.*rate[_ ]?limit.*try again in\s+(\d+)\s*(?:s|sec|seconds?)/i,
  /devin.*quota.*reset.*?(\d{1,2}(?::\d{2})?\s*(?:am|pm)?)/i,
];

function resolveDevinBinary(): { bin: string; commands: Record<string, string> } {
  const configured = (process.env.CCP_DEVIN_BIN || '').trim();
  const devin = configured || commandExists('devin');
  const devinAi = commandExists('devin-ai');
  return {
    bin: devin || devinAi || '',
    commands: {
      devin: devin || '',
      devin_ai: devinAi || '',
    },
  };
}

function normalizeTemplate(template: string): string {
  const trimmed = template.trim();
  if (!trimmed) return '{bin} terminal run --cwd {repoPath}';
  if (trimmed.includes('{bin}')) return trimmed;
  // Let operators write "devin terminal ..." while still using the resolved
  // binary path from preflight, which may be /opt/.../devin or CCP_DEVIN_BIN.
  return trimmed.replace(/^devin\b/, '{bin}');
}

function renderTemplate(template: string, ctx: AgentBuildContext): string {
  const replacements: Record<string, string> = {
    bin: shellQuote(ctx.bin),
    repoPath: shellQuote(ctx.repoPath),
    promptPath: shellQuote(ctx.promptPath),
    jobId: shellQuote(ctx.packet.job_id || ''),
  };
  return normalizeTemplate(template).replace(/\{(bin|repoPath|promptPath|jobId)\}/g, (_m, key: string) => replacements[key]);
}

function defaultCommand(ctx: AgentBuildContext): string {
  return renderTemplate('{bin} terminal run --cwd {repoPath}', ctx);
}

export const devinDriver: AgentDriver = {
  name: 'devin',
  label: 'Devin',

  buildCommand(ctx: AgentBuildContext): AgentCommand {
    const template = process.env.CCP_DEVIN_COMMAND || '';
    const rendered = template ? renderTemplate(template, ctx) : defaultCommand(ctx);
    return {
      shellCmd: `cat ${shellQuote(ctx.promptPath)} | ${rendered}`,
    };
  },

  preflight(): AgentPreflight {
    const { bin, commands } = resolveDevinBinary();
    if (!bin) {
      return {
        ok: false,
        bin: '',
        failures: [
          'devin not found/configured — install the Devin terminal CLI on PATH, ' +
            'or set CCP_DEVIN_BIN plus CCP_DEVIN_COMMAND before selecting agent=devin',
        ],
        commands,
      };
    }

    const out = run(bin, ['--version']);
    if (out.status !== 0) {
      const configured = (process.env.CCP_DEVIN_BIN || '').trim();
      const hint = configured
        ? `configured CCP_DEVIN_BIN '${configured}' could not run --version`
        : `devin binary '${bin}' could not run --version`;
      const detail = (out.stderr || out.stdout || '').trim();
      return {
        ok: false,
        bin,
        failures: [detail ? `${hint}: ${detail.slice(0, 200)}` : hint],
        commands,
      };
    }
    const version = (out.stdout || '').trim() || undefined;
    return { ok: true, bin, failures: [], version, commands };
  },

  probe(): AgentProbeResult {
    const probeCommand = (process.env.CCP_DEVIN_PROBE_COMMAND || '').trim();
    if (probeCommand) {
      const result = spawnSync('sh', ['-lc', probeCommand], { encoding: 'utf8', timeout: 30000 });
      const stdout = result.stdout || '';
      const stderr = result.stderr || '';
      const ok = result.status === 0 && /PONG|OK/i.test(stdout + stderr);
      return {
        ok,
        detail: ok ? undefined : (stderr || stdout || 'devin probe failed').slice(0, 200),
      };
    }

    const { bin } = resolveDevinBinary();
    if (!bin) {
      return { ok: false, detail: 'devin not found/configured — set CCP_DEVIN_BIN or install a devin CLI' };
    }

    // Until Devin exposes a stable non-interactive health probe, version is
    // the safest non-destructive readiness signal. A real terminal/API probe
    // can be supplied via CCP_DEVIN_PROBE_COMMAND without code changes.
    const result = run(bin, ['--version']);
    return {
      ok: result.status === 0,
      detail: result.status === 0 ? undefined : (result.stderr || result.stdout || 'devin --version failed').slice(0, 200),
    };
  },

  failurePatterns: {
    apiError: DEVIN_API_ERROR_PATTERNS,
    rateLimit: DEVIN_RATE_LIMIT_PATTERNS,
  },
};
