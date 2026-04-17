/**
 * Agent driver types.
 *
 * Phase 1 (PR A) introduces a pluggable AgentDriver interface so the worker
 * command, preflight check, health probe, and API-error patterns are no longer
 * hardcoded to Claude Code. Only the claude-code driver is registered in this
 * PR — additional drivers (Codex, Aider, etc.) slot in via the registry in
 * follow-up PRs.
 *
 * Design goals:
 *   - buildCommand returns the exact shell command the tmux worker will run,
 *     preserving the existing "stdin from file" pipe shape for Claude Code.
 *   - preflight reports what's missing without throwing, so the caller can
 *     decide to fail the job or fall back to another driver (PR B).
 *   - failurePatterns centralizes outage/rate-limit detection so outage.ts
 *     can delegate to the active driver rather than baking in Claude-specific
 *     regexes.
 */

import type { JobPacket } from '../../types';

export interface AgentBuildContext {
  /** Absolute path to the prompt file the worker writes out. */
  promptPath: string;
  /** Absolute path to the repo checkout the worker will cd into. */
  repoPath: string;
  /** The job packet (agents may customize based on ticket metadata). */
  packet: JobPacket;
  /** Resolved CLI binary on PATH (e.g. from preflight). */
  bin: string;
}

export interface AgentCommand {
  /** Fully-formed shell command string, ready to drop into worker.sh. */
  shellCmd: string;
  /** Optional extra env vars (injected above the command). */
  env?: Record<string, string>;
}

export interface AgentPreflight {
  ok: boolean;
  /** Absolute path / command name of the resolved binary, or '' if missing. */
  bin: string;
  /** Human-readable missing-dependency messages. */
  failures: string[];
  /** Version string, if detected. */
  version?: string;
  /** Raw command-lookup map (for inclusion in status.environment). */
  commands: Record<string, string>;
}

export interface AgentProbeResult {
  ok: boolean;
  detail?: string;
}

export interface AgentFailurePatterns {
  /**
   * Patterns indicating a transient provider API error (5xx, overloaded,
   * connection reset). Matching any of these in worker output contributes to
   * the outage circuit breaker.
   */
  apiError: RegExp[];
  /**
   * Patterns for "you've hit your rate limit, resets at <time>" style
   * messages. The first capture group should be the reset time string.
   */
  rateLimit: RegExp[];
}

export interface AgentDriver {
  /** Stable short identifier used in configs and logs. */
  name: string;
  /** Human-friendly label for dashboard/notifications. */
  label: string;
  /** Build the exact shell command the tmux worker script will execute. */
  buildCommand(ctx: AgentBuildContext): AgentCommand;
  /** Inspect the local environment for required binaries. */
  preflight(): AgentPreflight;
  /** Lightweight health check (used by the outage probe). */
  probe(): AgentProbeResult;
  /** Regex sets for detecting provider API failures. */
  failurePatterns: AgentFailurePatterns;
}
