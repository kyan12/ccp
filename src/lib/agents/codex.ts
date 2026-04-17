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
} from './types';

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
    // Cheapest possible "is the CLI usable" check. A full round-trip via
    // `codex exec` would pull the default model and consume real quota —
    // not worth it for a circuit-breaker recovery probe that runs every
    // supervisor cycle. `codex --version` exits non-zero when the binary
    // is missing or the install is corrupt, which is all we need here.
    //
    // Future work: once `codex login status` stabilizes its non-zero
    // exit codes, layer an auth check on top.
    const { bin } = resolveCodexBinary();
    const probeBin = bin || 'codex';
    const result = spawnSync(probeBin, ['--version'], {
      encoding: 'utf8',
      timeout: 30000,
    });
    const ok = result.status === 0 && !!(result.stdout || '').trim();
    return {
      ok,
      detail: ok
        ? undefined
        : (result.stderr || result.stdout || 'codex --version failed').slice(0, 200),
    };
  },

  failurePatterns: {
    apiError: CODEX_API_ERROR_PATTERNS,
    rateLimit: CODEX_RATE_LIMIT_PATTERNS,
  },
};
