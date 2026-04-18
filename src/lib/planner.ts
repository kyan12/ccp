/**
 * Pre-worker planner pass (Phase 5b).
 *
 * Runs the resolved agent CLI synchronously with a short planning-only
 * prompt before the main worker is dispatched. The plan is written to
 * `jobs/<id>/plan.md` and injected into the worker's prompt so the
 * worker starts with a scaffolded approach instead of re-thinking from
 * scratch.
 *
 * Design goals:
 *   - **Opt-in** per repo (`repoMapping.planner.enabled`). Default off so
 *     existing flows are behavior-neutral.
 *   - **Best-effort** — any failure (timeout, non-zero exit, empty output)
 *     results in a skipped-with-reason result. Worker runs without a plan
 *     rather than blocking the job.
 *   - **Agent-agnostic** — reuses the resolved AgentDriver's `buildCommand`
 *     so planner works with every driver without new shape-specific
 *     methods. The buildCommand already pipes the prompt file through
 *     stdin to avoid ARG_MAX.
 *   - **Capped** — plan output is byte-capped and timeout-bounded so a
 *     runaway agent can't fill the context window or stall the dispatch
 *     loop.
 *
 * Skip conditions (planner is NOT run):
 *   1. Per-repo config `planner.enabled !== true` (default).
 *   2. Remediation jobs — `__valfix`, `__reviewfix`, `__deployfix` already
 *      have explicit failing-step or review-comment feedback; a plan
 *      would dilute that context.
 *   3. Continuation jobs — `packet.working_branch` set (the agent is
 *      picking up mid-stream on a branch; re-planning is confusing).
 *   4. The AgentDriver reports preflight failure — we wouldn't be able
 *      to invoke it anyway.
 */

import fs = require('fs');
import { spawnSync } from 'child_process';
import type { JobPacket, RepoMapping } from '../types';
import type { AgentDriver } from './agents/types';

/**
 * Hard cap on plan bytes injected into the worker prompt. Picked to
 * match `MAX_MEMORY_BYTES` from memory.ts — both are pre-prompt context
 * and the combined budget needs to stay well below any provider's
 * context-window ceiling. Truncation is visible so operators notice.
 */
export const MAX_PLAN_BYTES = 16 * 1024;

/** Default planner timeout — 5 minutes. Operators can override per repo. */
export const DEFAULT_PLANNER_TIMEOUT_SEC = 300;

const TRUNCATION_MARKER =
  '\n\n[... plan truncated at 16KB; planner output exceeded the context budget ...]';

export interface PlannerResult {
  /** True iff a plan was produced and is safe to inject. */
  ok: boolean;
  /** Trimmed + possibly-truncated plan body. Empty string when skipped. */
  plan: string;
  /** When true, no invocation was attempted (see `reason`). */
  skipped: boolean;
  /** Human-readable explanation — logged to worker.log. */
  reason: string;
  /** Wall-clock duration of the planner invocation, or 0 when skipped. */
  durationMs: number;
  /** True iff the raw output exceeded MAX_PLAN_BYTES. */
  truncated: boolean;
  /** True iff the subprocess was killed by the timeout. */
  timedOut: boolean;
}

/**
 * Build the one-shot prompt the planner sends to the agent. The prompt
 * asks for a structured, concise plan — matching the shape the worker
 * prompt expects so the injected plan reads naturally alongside the
 * ticket goal and memory. Format is deliberately simple (headers, no
 * JSON) because agents are more reliable producing prose structure than
 * strict machine-readable formats for a planning task.
 */
export function buildPlannerPrompt(packet: JobPacket, memory?: string | null): string {
  const bits: string[] = [];
  bits.push(
    'You are a senior engineer. Read the ticket below and output a SHORT implementation plan.',
  );
  bits.push(
    'Do NOT write any code or modify any files. Only produce the plan as markdown.',
  );
  if (memory && memory.trim()) {
    bits.push(
      [
        'Repository context (persistent memory — use this to avoid re-learning project conventions):',
        '--- BEGIN REPOSITORY MEMORY ---',
        memory.trim(),
        '--- END REPOSITORY MEMORY ---',
      ].join('\n'),
    );
  }
  bits.push(`Ticket: ${packet.ticket_id || 'UNTRACKED'}`);
  bits.push(`Goal: ${packet.goal || 'No goal provided'}`);
  if (packet.constraints?.length) {
    bits.push(`Constraints:\n- ${packet.constraints.join('\n- ')}`);
  }
  if (packet.acceptance_criteria?.length) {
    bits.push(
      `Acceptance criteria:\n- ${packet.acceptance_criteria.join('\n- ')}`,
    );
  }
  bits.push(
    [
      'Output ONLY the following markdown structure — no preamble, no code, no file contents:',
      '',
      '## Files to touch',
      '- <path> — <why>',
      '',
      '## Approach',
      '<2-5 sentences describing the approach>',
      '',
      '## Tests',
      '- <test case or validation step>',
      '',
      '## Risks',
      '- <risk or edge case>',
      '',
      '## Confidence',
      '<low|medium|high> — <1 sentence justification>',
    ].join('\n'),
  );
  bits.push(
    'Keep the entire plan under 1500 words. Stop after the Confidence section; do not continue with implementation.',
  );
  return bits.join('\n\n');
}

export interface RunPlannerOptions {
  jobId: string;
  packet: JobPacket;
  /**
   * Repo mapping resolved from `packet.repo`. When null, the planner is
   * skipped — without a mapping we can't read planner config.
   */
  mapping: RepoMapping | null;
  /** The resolved agent driver (same driver the worker will use). */
  agent: AgentDriver;
  /** Resolved CLI binary from preflight (`pf.claude`). */
  bin: string;
  /** Working directory — matches the worker's cd target. */
  workdir: string;
  /**
   * Path to write the planning prompt file to. Caller is responsible for
   * the prompt file being inside the job's scratch dir so it gets
   * archived alongside `worker.log` / `prompt.txt`.
   */
  planPromptPath: string;
  /**
   * Path to write the captured plan to. `jobs/<id>/plan.md` by
   * convention.
   */
  planOutPath: string;
  /** Resolved per-repo memory contents (from loadRepoMemory). */
  memory?: string | null;
  /**
   * If the job id matches `__valfix`, `__reviewfix`, or `__deployfix`
   * we skip the planner. Injected rather than hardcoded so tests can
   * exercise the skip logic without touching real filesystem state.
   */
  remediationPattern?: RegExp;
}

const DEFAULT_REMEDIATION_PATTERN = /__valfix|__reviewfix|__deployfix/;

/**
 * Resolve effective planner config for a repo mapping. Returns null if
 * planner is disabled (or mapping is null) so callers can check once
 * instead of drilling into defaults. Exposed separately so the doctor
 * CLI can report which repos have planner enabled without executing it.
 */
export function resolvePlannerConfig(
  mapping: RepoMapping | null,
): { enabled: true; timeoutSec: number } | null {
  if (!mapping?.planner?.enabled) return null;
  const raw = mapping.planner.timeoutSec;
  const timeoutSec =
    typeof raw === 'number' && Number.isFinite(raw) && raw > 0
      ? Math.floor(raw)
      : DEFAULT_PLANNER_TIMEOUT_SEC;
  return { enabled: true, timeoutSec };
}

/**
 * Decide whether the planner step should be skipped for a given job.
 * Returns `{ skipped: true, reason }` when skipped, or null when the
 * caller should proceed to invoke the agent.
 */
export function shouldSkipPlanner(opts: {
  jobId: string;
  packet: JobPacket;
  mapping: RepoMapping | null;
  remediationPattern?: RegExp;
}): { skipped: true; reason: string } | null {
  const pattern = opts.remediationPattern || DEFAULT_REMEDIATION_PATTERN;
  if (pattern.test(opts.jobId)) {
    return { skipped: true, reason: 'remediation job — planner skipped (feedback already supplied)' };
  }
  if (opts.packet.working_branch) {
    return {
      skipped: true,
      reason: `continuation job on ${opts.packet.working_branch} — planner skipped`,
    };
  }
  const cfg = resolvePlannerConfig(opts.mapping);
  if (!cfg) return { skipped: true, reason: 'planner disabled for this repo' };
  return null;
}

/**
 * Run the planner. Synchronous: the dispatch loop blocks on this
 * intentionally so startTmuxWorker is serialised around the planning
 * pass. A badly-sized timeout here can stall dispatch, which is why
 * the default is tight.
 */
export function runPlanner(opts: RunPlannerOptions): PlannerResult {
  const start = Date.now();
  const skip = shouldSkipPlanner({
    jobId: opts.jobId,
    packet: opts.packet,
    mapping: opts.mapping,
    remediationPattern: opts.remediationPattern,
  });
  if (skip) {
    return {
      ok: false,
      plan: '',
      skipped: true,
      reason: skip.reason,
      durationMs: 0,
      truncated: false,
      timedOut: false,
    };
  }
  const cfg = resolvePlannerConfig(opts.mapping)!;
  // Persist the prompt on disk — (a) it's what the agent reads via
  // stdin, (b) it's useful post-mortem if the plan output is weird.
  try {
    fs.writeFileSync(opts.planPromptPath, buildPlannerPrompt(opts.packet, opts.memory));
  } catch (err) {
    return {
      ok: false,
      plan: '',
      skipped: true,
      reason: `planner prompt write failed: ${(err as Error).message}`,
      durationMs: Date.now() - start,
      truncated: false,
      timedOut: false,
    };
  }
  // Reuse the driver's buildCommand. We pass the planner prompt path as
  // `promptPath` and the workdir as `repoPath`; the resulting shellCmd
  // already pipes the prompt via stdin, which is exactly what we want
  // for a one-shot synchronous invocation.
  let shellCmd: string;
  let extraEnv: Record<string, string>;
  try {
    const built = opts.agent.buildCommand({
      promptPath: opts.planPromptPath,
      repoPath: opts.workdir,
      packet: opts.packet,
      bin: opts.bin,
    });
    shellCmd = built.shellCmd;
    extraEnv = built.env || {};
  } catch (err) {
    return {
      ok: false,
      plan: '',
      skipped: true,
      reason: `planner buildCommand failed: ${(err as Error).message}`,
      durationMs: Date.now() - start,
      truncated: false,
      timedOut: false,
    };
  }
  const timeoutMs = cfg.timeoutSec * 1000;
  const result = spawnSync('bash', ['-lc', shellCmd], {
    cwd: opts.workdir,
    env: { ...process.env, ...extraEnv },
    timeout: timeoutMs,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024, // 64MB — plenty of head-room, hard cap comes from MAX_PLAN_BYTES below
  });
  const durationMs = Date.now() - start;
  // Node spawnSync timeouts surface as error.code === 'ETIMEDOUT' (name is always 'Error');
  // SIGTERM covers the default-kill path but we also need the code check for processes that trap
  // SIGTERM and exit with their own status — matches the pattern in validator.ts.
  const timedOut =
    result.signal === 'SIGTERM' ||
    (result.error as NodeJS.ErrnoException | undefined)?.code === 'ETIMEDOUT' ||
    (result.status === null && result.signal != null);
  if (timedOut) {
    return {
      ok: false,
      plan: '',
      skipped: true,
      reason: `planner timed out after ${cfg.timeoutSec}s`,
      durationMs,
      truncated: false,
      timedOut: true,
    };
  }
  if (result.error) {
    return {
      ok: false,
      plan: '',
      skipped: true,
      reason: `planner spawn failed: ${result.error.message}`,
      durationMs,
      truncated: false,
      timedOut: false,
    };
  }
  if (result.status !== 0) {
    const stderr = (result.stderr || '').trim().slice(-400);
    return {
      ok: false,
      plan: '',
      skipped: true,
      reason: `planner exited ${result.status}${stderr ? `: ${stderr}` : ''}`,
      durationMs,
      truncated: false,
      timedOut: false,
    };
  }
  const raw = (result.stdout || '').trim();
  if (!raw) {
    return {
      ok: false,
      plan: '',
      skipped: true,
      reason: 'planner produced empty output',
      durationMs,
      truncated: false,
      timedOut: false,
    };
  }
  const bytes = Buffer.byteLength(raw, 'utf8');
  let finalPlan: string;
  let truncated = false;
  if (bytes <= MAX_PLAN_BYTES) {
    finalPlan = raw;
  } else {
    const buf = Buffer.from(raw, 'utf8');
    finalPlan = buf.slice(0, MAX_PLAN_BYTES).toString('utf8') + TRUNCATION_MARKER;
    truncated = true;
  }
  try {
    fs.writeFileSync(opts.planOutPath, finalPlan);
  } catch (err) {
    // We have a valid plan in memory — don't skip just because we
    // couldn't persist it. Log as ok-but-write-failed.
    return {
      ok: true,
      plan: finalPlan,
      skipped: false,
      reason: `plan captured (${bytes} bytes${truncated ? ', truncated' : ''}); write to ${opts.planOutPath} failed: ${(err as Error).message}`,
      durationMs,
      truncated,
      timedOut: false,
    };
  }
  return {
    ok: true,
    plan: finalPlan,
    skipped: false,
    reason: `plan captured (${bytes} bytes${truncated ? ', truncated' : ''}, ${durationMs}ms)`,
    durationMs,
    truncated,
    timedOut: false,
  };
}

module.exports = {
  MAX_PLAN_BYTES,
  DEFAULT_PLANNER_TIMEOUT_SEC,
  buildPlannerPrompt,
  resolvePlannerConfig,
  shouldSkipPlanner,
  runPlanner,
};
