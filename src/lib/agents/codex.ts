/**
 * OpenAI Codex CLI agent driver (openai/codex).
 *
 * Upstream: https://github.com/openai/codex — the Rust binary installed via
 * `npm i -g @openai/codex` (or Homebrew / GitHub release tarballs).
 *
 * Non-interactive invocation shape used here:
 *
 *   cat <promptFile> | codex exec --color never --sandbox workspace-write --skip-git-repo-check
 *
 * Notes on the flags:
 *   - `exec` is the documented headless entrypoint (equivalent to
 *     Claude Code's `--print`).
 *   - `--color never` strips ANSI so worker.log is readable.
 *   - `--sandbox workspace-write` grants write access only within the cwd
 *     (the per-job repo checkout), matching how the supervisor shells
 *     Claude with `--permission-mode bypassPermissions` inside its cwd.
 *   - `--skip-git-repo-check` prevents Codex from refusing to operate
 *     because the working directory isn't exactly the git root Codex
 *     would expect.
 *   - Prompt is piped on stdin to avoid OS ARG_MAX on large prompts.
 *
 * Auth expectations: the supervisor box is pre-authenticated via
 * `codex login` (ChatGPT OAuth) or an `OPENAI_API_KEY` env var. The
 * driver does not touch credentials itself — it assumes the CLI has
 * already been logged in on the host, same as the Claude Code driver
 * assumes `claude` has a valid session.
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
import { parseCodexUsage } from './usage';

// Patterns in worker logs that indicate a transient OpenAI API error
// (not a code bug in the repo). These are conservative — we don't want
// a legitimate 500 from user code to trip the circuit breaker.
const CODEX_API_ERROR_PATTERNS: RegExp[] = [
  // OpenAI SDK "APIError: 500 Internal Server Error" / 502 / 503 / 504.
  /APIError:\s*5\d\d\b/i,
  // Generic OpenAI 5xx surfaced by the CLI.
  /openai.*\b5\d\d\b.*(error|unavailable|internal)/i,
  // Server overload phrasing.
  /server_error.*(overloaded|temporar)/i,
  // Upstream connection problems — same family as the Claude driver's
  // ECONNRESET bucket; shared because they're network-layer, not
  // provider-specific.
  /ECONNRESET|ETIMEDOUT|ECONNREFUSED|EAI_AGAIN/,
  // OpenAI outage / scheduled-maintenance phrasing seen in the wild.
  /openai.*unavailable/i,
  /service.*unavailable/i,
  // Upstream Cloudflare / gateway issues that bubble up through the SDK.
  /\b(502|503|504)\s*(bad gateway|service unavailable|gateway timeout)/i,
];

// OpenAI rate-limit surface differs from Anthropic's — reset is usually
// expressed in seconds/ms rather than a wall-clock "resets 2pm" string.
// We still try to pull a wall-clock hint if present, falling back to a
// relative "try again in N seconds" capture for downstream translation.
const CODEX_RATE_LIMIT_PATTERNS: RegExp[] = [
  /rate[_ ]?limit.*reset.*?(\d{1,2}(?::\d{2})?\s*(?:am|pm)?)/i,
  /quota.*reset.*?(\d{1,2}(?::\d{2})?\s*(?:am|pm)?)/i,
  /rate[_ ]?limit.*try again in\s+(\d+)\s*(?:s|sec|seconds?)/i,
  /insufficient_quota/i,
];

function resolveCodexBinary(): { bin: string; commands: Record<string, string> } {
  const codex = commandExists('codex');
  return {
    bin: codex || '',
    commands: { codex },
  };
}

export const codexDriver: AgentDriver = {
  name: 'codex',
  label: 'OpenAI Codex',

  buildCommand(ctx: AgentBuildContext): AgentCommand {
    // Mirror the Claude driver's "cat prompt | binary" shape so the two
    // drivers behave identically from the supervisor's tmux-worker view.
    const shellCmd =
      `cat ${shellQuote(ctx.promptPath)} | ` +
      `${shellQuote(ctx.bin)} exec --color never --sandbox workspace-write --skip-git-repo-check`;
    return { shellCmd };
  },

  preflight(): AgentPreflight {
    const { bin, commands } = resolveCodexBinary();
    if (!bin) {
      return {
        ok: false,
        bin: '',
        failures: [
          'codex not found on PATH — install via `npm i -g @openai/codex` ' +
            'or `brew install --cask codex`, then run `codex login`',
        ],
        commands,
      };
    }
    const out = run(bin, ['--version']);
    const version = out.status === 0 ? (out.stdout || '').trim() : undefined;
    return { ok: true, bin, failures: [], version, commands };
  },

  probe(): AgentProbeResult {
    // Real API round-trip, mirroring the claude-code driver. `--version`
    // alone is useless here — the binary being installed tells us nothing
    // about whether the OpenAI API is reachable, so a version-only probe
    // would clear the circuit on every cycle during an actual OpenAI
    // outage and oscillate the "recovered" alert.
    //
    // We pipe a 6-token prompt ("Reply with the word PONG only.") into
    // `codex exec` and grep the output for PONG, same pattern as the
    // claude driver. This does consume real quota (~1 completion per
    // supervisor cycle while the circuit is open) but that's the cost of
    // an honest recovery signal. An outage probe that can never see
    // outages is worse than one that costs a few pennies to run.
    //
    // First check the binary exists so we emit a useful detail message
    // for install problems rather than surfacing whatever spawnSync
    // reports when the executable is absent.
    const { bin } = resolveCodexBinary();
    if (!bin) {
      return {
        ok: false,
        detail: 'codex not found on PATH — install via `npm i -g @openai/codex`',
      };
    }
    const result = spawnSync(
      bin,
      ['exec', '--color', 'never', '--skip-git-repo-check', 'Reply with the word PONG only.'],
      { encoding: 'utf8', timeout: 30000 },
    );
    const stdout = result.stdout || '';
    const stderr = result.stderr || '';
    const ok = result.status === 0 && /PONG/i.test(stdout);
    return {
      ok,
      detail: ok
        ? undefined
        : (stderr || stdout || 'codex probe failed').slice(0, 200),
    };
  },

  failurePatterns: {
    apiError: CODEX_API_ERROR_PATTERNS,
    rateLimit: CODEX_RATE_LIMIT_PATTERNS,
  },

  parseUsage(ctx: AgentUsageParseContext): AgentUsage | null {
    // Codex's `exec` mode emits either JSONL `turn.completed` events
    // or a plain-text token summary depending on how the worker was
    // invoked. Current releases do NOT surface a dollar cost, so the
    // returned AgentUsage carries token counts only — downstream
    // consumers that want USD apply a pricing table to the persisted
    // counts. See docs/cost-accounting.md.
    try {
      return parseCodexUsage(ctx.workerLog, 'codex');
    } catch {
      return null;
    }
  },
};
