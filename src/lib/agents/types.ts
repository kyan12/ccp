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

export interface AgentUsageParseContext {
  /** Absolute path to the per-job directory (jobs/<id>). */
  jobDir: string;
  /** Full contents of worker.log at finalize time. */
  workerLog: string;
}

/**
 * Per-job token / cost accounting captured from the agent CLI's own
 * self-report after the worker exits. Phase 6e (per-agent cost
 * accounting) persists this onto `status.usage` and `result.usage` so
 * the telemetry rollup can tally per-agent spend without re-parsing
 * worker logs.
 *
 * Fields are all optional because different CLIs surface different
 * subsets: Claude Code in `--output-format=json` mode emits every
 * field; default text mode emits nothing; Codex in `exec` mode emits
 * token counts but not a dollar cost. A `null` parseUsage() return is
 * the signal for "no usable data in this log" — callers persist that
 * as an absent `usage` field and the telemetry aggregate skips the
 * job from per-agent token / cost sums.
 */
export interface AgentUsage {
  /** Driver name at capture time (e.g. 'claude-code'). */
  agent: string;
  /** Model identifier reported by the CLI, when available. */
  model?: string | null;
  /** Prompt / input tokens for this run. */
  inputTokens?: number;
  /** Completion / output tokens for this run. */
  outputTokens?: number;
  /** Cache-read input tokens (Anthropic / OpenAI prompt-cache hits). */
  cachedInputTokens?: number;
  /** Cache-write input tokens, where the CLI reports it separately. */
  cacheCreationTokens?: number;
  /** Total tokens across every category (input+output+cache). */
  totalTokens?: number;
  /**
   * USD cost as reported by the CLI. Null/absent when the CLI
   * doesn't surface a cost (e.g. Codex's JSONL rollout emits tokens
   * only). Downstream consumers can compute cost from tokens and a
   * pricing table when needed, but that logic lives outside this
   * shape so operators can't conflate "CLI said X" with "our
   * estimate said X".
   */
  costUsd?: number;
  /** ISO timestamp when the parser captured this sample. */
  capturedAt: string;
  /**
   * Optional small opaque provenance string (CLI version, rollout
   * file name, etc.) so support can trace a specific number back to
   * the exact log/file it came from. Keep short — this is persisted
   * on every result.json.
   */
  source?: string;
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
  /**
   * Phase 6e: extract token / cost usage from the worker log (and
   * any driver-specific sidecar files in `ctx.jobDir`). Returns null
   * when the log contains no usable signal — the finalize path then
   * persists no `usage` field. Must be total: never throws on
   * malformed input, never blocks finalize.
   */
  parseUsage?(ctx: AgentUsageParseContext): AgentUsage | null;
}
