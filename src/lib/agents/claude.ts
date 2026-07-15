/**
 * Claude Code agent driver.
 *
 * Wraps the existing Claude Code invocation shape so behavior is unchanged
 * when this is the resolved driver:
 *
 *   cat <promptFile> | <claude> --print --permission-mode bypassPermissions
 *
 * Do not pass --model here. CCP should inherit Claude Code's configured default
 * model (for example the user-level `model: opus` alias), so Claude Code can
 * advance to the latest Opus release without a CCP code change.
 *
 * Preflight uses the default `claude` binary. A legacy `claude-opus` symlink is
 * still reported for diagnostics, but not selected; model choice belongs in
 * Claude Code settings, not CCP shell aliases.
 *
 * failurePatterns are lifted directly from the pre-refactor outage.ts module
 * so detection parity is preserved.
 */

import { spawnSync } from 'child_process';
import { commandExists, shellQuote, run } from '../shell';
import type {
  AgentBuildContext,
  AgentCommand,
  AgentDriver,
  AgentPreflight,
  AgentProbeResult,
  AgentUsage,
  AgentUsageParseContext,
} from './types';
import { parseClaudeUsage } from './usage';

const CLAUDE_API_ERROR_PATTERNS: RegExp[] = [
  /API Error: 5\d\d\b/i,
  /api_error.*internal server error/i,
  /"type":"api_error"/i,
  /overloaded_error/i,
  /\b529\b/,
  /ECONNRESET|ETIMEDOUT|ECONNREFUSED/,
  /anthropic.*unavailable/i,
  /service.*unavailable/i,
];

const CLAUDE_RATE_LIMIT_PATTERNS: RegExp[] = [
  /hit your limit.*resets?\s+(?:at\s+)?(\d{1,2}(?::\d{2})?\s*(?:am|pm)?)\s*(?:\(([^)]+)\))?/i,
  /rate.?limit.*reset.*?(\d{1,2}(?::\d{2})?\s*(?:am|pm)?)/i,
  /usage.*limit.*reset.*?(\d{1,2}(?::\d{2})?\s*(?:am|pm)?)/i,
];

function resolveClaudeBinary(): { bin: string; commands: Record<string, string> } {
  const claudeOpus = commandExists('claude-opus');
  const claude = commandExists('claude');
  return {
    bin: claude || claudeOpus || '',
    commands: { claude_opus: claudeOpus, claude },
  };
}

export const claudeCodeDriver: AgentDriver = {
  name: 'claude-code',
  label: 'Claude Code',

  buildCommand(ctx: AgentBuildContext): AgentCommand {
    // Pipe prompt via stdin to avoid OS ARG_MAX limits on large prompts.
    const shellCmd =
      `cat ${shellQuote(ctx.promptPath)} | ` +
      `${shellQuote(ctx.bin)} --print --permission-mode bypassPermissions`;
    return { shellCmd };
  },

  preflight(): AgentPreflight {
    const { bin, commands } = resolveClaudeBinary();
    if (!bin) {
      return {
        ok: false,
        bin: '',
        failures: ['claude-opus/claude not found on PATH'],
        commands,
      };
    }
    const out = run(bin, ['--version']);
    const version = out.status === 0 ? (out.stdout || '').trim() : undefined;
    return { ok: true, bin, failures: [], version, commands };
  },

  probe(): AgentProbeResult {
    // Minimal "am I up?" check — mirrors the pre-refactor probeAnthropicApi().
    // Resolve the binary the same way preflight() does. Falls back to the
    // literal `claude` string only if nothing is resolvable.
    const { bin } = resolveClaudeBinary();
    const probeBin = bin || 'claude';
    const result = spawnSync(
      probeBin,
      ['--print', '--model', 'claude-haiku-4-5', 'Reply with the word PONG only.'],
      { encoding: 'utf8', timeout: 30000 },
    );
    const ok = result.status === 0 && /PONG/i.test(result.stdout || '');
    return { ok, detail: ok ? undefined : (result.stderr || result.stdout || 'probe failed').slice(0, 200) };
  },

  failurePatterns: {
    apiError: CLAUDE_API_ERROR_PATTERNS,
    rateLimit: CLAUDE_RATE_LIMIT_PATTERNS,
  },

  parseUsage(ctx: AgentUsageParseContext): AgentUsage | null {
    // Claude's default `--print` text output does not include cost
    // information. Operators who want per-job cost must switch the
    // worker command to `--output-format=json` (or `stream-json`);
    // when that output is present in the log, this parser extracts
    // the canonical `total_cost_usd` + `usage` block. Default text
    // mode returns null — see docs/cost-accounting.md.
    try {
      return parseClaudeUsage(ctx.workerLog, 'claude-code');
    } catch {
      return null;
    }
  },
};
