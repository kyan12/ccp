import fs = require('fs');
import path = require('path');
import { spawnSync } from 'child_process';
import type {
  ValidationConfig,
  ValidationStep,
  ValidationStepResult,
  ValidationReport,
} from '../types';

const DEFAULT_STEP_TIMEOUT_SEC = 600;
const STDOUT_TAIL_CHARS = 4000;

function nowIso(): string {
  return new Date().toISOString();
}

function tail(text: string, max: number = STDOUT_TAIL_CHARS): string {
  if (!text) return '';
  return text.length <= max ? text : text.slice(-max);
}

export interface RunValidationOptions {
  repoPath: string;
  config: ValidationConfig | null | undefined;
  /** If provided, each step's full stdout+stderr stream is appended to this file. */
  logFile?: string | null;
  /** Stamp onto the report for reproducibility. */
  commit?: string | null;
  branch?: string | null;
  /** Called before each step runs — useful for dashboard/console progress. */
  onStepStart?: (step: ValidationStep, index: number, total: number) => void;
  /** Called after each step completes (success, failure, or timeout). */
  onStepEnd?: (result: ValidationStepResult, index: number, total: number) => void;
  /** Override for the default 10-minute timeout. */
  defaultTimeoutSec?: number;
}

function appendStepLog(logFile: string | null | undefined, header: string, body: string): void {
  if (!logFile) return;
  try {
    fs.appendFileSync(logFile, `${header}\n${body}\n`);
  } catch {
    // best-effort logging — never throw from the validator
  }
}

function runStep(
  step: ValidationStep,
  repoPath: string,
  logFile: string | null | undefined,
  defaultTimeoutSec: number,
): ValidationStepResult {
  const required = step.required !== false;
  const timeoutSec = Math.max(1, Number(step.timeoutSec || defaultTimeoutSec));
  const timeoutMs = timeoutSec * 1000;
  const startedAt = Date.now();
  const stamp = new Date().toISOString();

  appendStepLog(
    logFile,
    `\n[${stamp}] validator step: ${step.name}`,
    `cmd: ${step.cmd}\ncwd: ${repoPath}\ntimeout: ${timeoutSec}s\nrequired: ${required}`,
  );

  const mergedEnv = { ...process.env, ...(step.env || {}) };
  const result = spawnSync('sh', ['-lc', step.cmd], {
    cwd: repoPath,
    env: mergedEnv,
    encoding: 'utf8',
    timeout: timeoutMs,
    maxBuffer: 32 * 1024 * 1024, // 32 MiB cap to avoid OOM on runaway output
    killSignal: 'SIGTERM',
  });

  const durationMs = Date.now() - startedAt;
  const stdout = typeof result.stdout === 'string' ? result.stdout : '';
  const stderr = typeof result.stderr === 'string' ? result.stderr : '';
  const timedOut = result.error !== null && result.error !== undefined && (result.error as NodeJS.ErrnoException).code === 'ETIMEDOUT';
  // spawnSync kills the child on timeout; exit status is null in that case.
  const exitCode = typeof result.status === 'number' ? result.status : null;
  const ok = !timedOut && exitCode === 0;

  appendStepLog(
    logFile,
    `[${new Date().toISOString()}] validator step done: ${step.name}` +
      ` | exit=${exitCode ?? 'null'} | timedOut=${timedOut} | durationMs=${durationMs}`,
    `---- stdout ----\n${stdout}\n---- stderr ----\n${stderr}`,
  );

  return {
    name: step.name,
    cmd: step.cmd,
    required,
    ok,
    timedOut: timedOut || undefined,
    exitCode,
    durationMs,
    stdoutExcerpt: tail(stdout),
    stderrExcerpt: tail(stderr),
  };
}

/**
 * Run a repo's post-worker validation pipeline (typecheck / test / build / etc.).
 *
 * Behavior:
 * - Steps execute sequentially in config order.
 * - A `required` step failure fails overall validation but DOES NOT short-circuit —
 *   remaining steps still run so the agent sees the full picture in one pass.
 * - A non-required (`required: false`) step failure is surfaced in the report but
 *   does not flip `ok` to false.
 * - Steps respect a per-step timeout (default 600s).
 *
 * This function never throws. On any unexpected error it returns a skipped report
 * with the error reason so the caller can render it safely.
 */
export function runValidation(opts: RunValidationOptions): ValidationReport {
  const startedAt = nowIso();
  const startMs = Date.now();
  const {
    repoPath,
    config,
    logFile,
    commit = null,
    branch = null,
    onStepStart,
    onStepEnd,
    defaultTimeoutSec = DEFAULT_STEP_TIMEOUT_SEC,
  } = opts;

  const finish = (partial: Partial<ValidationReport>): ValidationReport => ({
    ok: false,
    steps: [],
    startedAt,
    finishedAt: nowIso(),
    durationMs: Date.now() - startMs,
    commit,
    branch,
    ...partial,
  });

  if (!config) {
    return finish({ ok: true, skipped: true, reason: 'no validation config for this repo' });
  }
  if (config.enabled === false) {
    return finish({ ok: true, skipped: true, reason: 'validation disabled for this repo' });
  }
  const steps = Array.isArray(config.steps) ? config.steps.filter((s) => s && s.name && s.cmd) : [];
  if (steps.length === 0) {
    return finish({ ok: true, skipped: true, reason: 'no validation steps configured' });
  }
  if (!repoPath) {
    return finish({ ok: false, skipped: true, reason: 'repoPath missing — cannot run validation' });
  }
  if (!fs.existsSync(repoPath)) {
    return finish({ ok: false, skipped: true, reason: `repoPath does not exist: ${repoPath}` });
  }

  const results: ValidationStepResult[] = [];
  let allRequiredOk = true;

  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];
    try {
      if (onStepStart) onStepStart(step, i, steps.length);
      const res = runStep(step, repoPath, logFile, defaultTimeoutSec);
      results.push(res);
      if (!res.ok && res.required) allRequiredOk = false;
      if (onStepEnd) onStepEnd(res, i, steps.length);
    } catch (err) {
      // Should be unreachable (spawnSync doesn't throw on non-zero exit) but
      // guard anyway so one malformed step never tanks the whole pipeline.
      const msg = err instanceof Error ? err.message : String(err);
      const synthetic: ValidationStepResult = {
        name: step.name,
        cmd: step.cmd,
        required: step.required !== false,
        ok: false,
        exitCode: null,
        durationMs: 0,
        stdoutExcerpt: '',
        stderrExcerpt: `validator internal error: ${msg}`,
      };
      results.push(synthetic);
      if (synthetic.required) allRequiredOk = false;
      if (onStepEnd) onStepEnd(synthetic, i, steps.length);
    }
  }

  return {
    ok: allRequiredOk,
    steps: results,
    startedAt,
    finishedAt: nowIso(),
    durationMs: Date.now() - startMs,
    commit,
    branch,
  };
}

/**
 * Build a single-line human summary of a validation report.
 * Used for Discord alerts and dashboard hover-text.
 */
export function summarizeReport(report: ValidationReport): string {
  if (report.skipped) return `validation skipped: ${report.reason || 'unknown'}`;
  const pass = report.steps.filter((s) => s.ok).length;
  const fail = report.steps.filter((s) => !s.ok && s.required).length;
  const warn = report.steps.filter((s) => !s.ok && !s.required).length;
  const durSec = Math.round(report.durationMs / 1000);
  const pieces = [`pass=${pass}`, `fail=${fail}`];
  if (warn > 0) pieces.push(`warn=${warn}`);
  pieces.push(`${durSec}s`);
  return `${report.ok ? 'ok' : 'FAIL'} (${pieces.join(' ')})`;
}

/**
 * Return a compact JSON-friendly summary for dashboard APIs.
 * Avoid shipping full stdout/stderr in list-view surfaces.
 */
export function compactReport(report: ValidationReport | undefined | null): Record<string, unknown> | null {
  if (!report) return null;
  return {
    ok: report.ok,
    skipped: report.skipped || false,
    reason: report.reason,
    durationMs: report.durationMs,
    commit: report.commit,
    branch: report.branch,
    steps: (report.steps || []).map((s) => ({
      name: s.name,
      ok: s.ok,
      required: s.required,
      timedOut: s.timedOut || false,
      exitCode: s.exitCode,
      durationMs: s.durationMs,
    })),
  };
}

/**
 * Phase 2b: decide whether a failing validation report should gate the job.
 *
 * Returns true iff:
 *   1. The report actually ran (not skipped) AND it failed, AND
 *   2. Gating is enabled \u2014 either globally via CCP_VALIDATION_GATE=true, or
 *      per-repo via `config.gate === true`. CCP_VALIDATION_GATE=false hard-disables
 *      even if per-repo config opts in.
 *
 * When CCP_VALIDATION_GATE is unset the per-repo flag wins.
 */
export function shouldGateOnValidation(
  config: ValidationConfig | null | undefined,
  report: ValidationReport | null | undefined,
): boolean {
  if (!report || report.skipped || report.ok) return false;
  const envRaw = process.env.CCP_VALIDATION_GATE;
  if (typeof envRaw === 'string' && envRaw.length > 0) {
    const lower = envRaw.toLowerCase();
    if (lower === 'false' || lower === '0' || lower === 'off' || lower === 'no') return false;
    if (lower === 'true' || lower === '1' || lower === 'on' || lower === 'yes') return true;
    // any other value \u2014 fall through to per-repo setting
  }
  return !!(config && config.gate === true);
}

export interface ValidationBlocker {
  /** Human-readable blocker message for result.blocker. */
  message: string;
  /** Synthetic check entries for result.failed_checks. */
  failedChecks: Array<{ name: string; state: string; url: string | null }>;
  /** Ordered list of failing required step names. */
  failedStepNames: string[];
  /** Structured feedback lines to hand to the remediation agent. */
  feedback: string[];
}

/**
 * Build blocker + feedback payloads from a failed validation report.
 * Pure function \u2014 no side effects, safe to unit-test.
 */
export function buildValidationBlocker(report: ValidationReport): ValidationBlocker {
  const failedRequired = (report.steps || []).filter((s) => !s.ok && s.required);
  const failedSoft = (report.steps || []).filter((s) => !s.ok && !s.required);
  const failedStepNames = failedRequired.map((s) => s.name);

  const firstLines = failedRequired
    .map((s) => {
      const tail = (s.stderrExcerpt || s.stdoutExcerpt || '').trim();
      const firstLine = tail ? tail.split(/\r?\n/).find((l) => l.trim().length > 0) : '';
      const tag = s.timedOut ? 'timeout' : `exit ${s.exitCode ?? 'null'}`;
      return `  - ${s.name} (${tag}, ${Math.round(s.durationMs / 1000)}s)${firstLine ? ` \u2014 ${firstLine.slice(0, 200)}` : ''}`;
    })
    .join('\n');

  const message =
    `validation failed on post-worker static checks (${failedRequired.length} required step(s) failing)\n${firstLines}`;

  const failedChecks = failedRequired.map((s) => ({
    name: `validation:${s.name}`,
    state: s.timedOut ? 'TIMED_OUT' : 'FAILURE',
    url: null,
  }));

  // Detailed feedback lines for the remediation agent. We include trailing
  // stderr/stdout excerpts so the agent doesn't have to guess what broke.
  const feedback: string[] = [
    `Static validation failed against commit ${report.commit || 'unknown'} on branch ${report.branch || 'unknown'}.`,
    `Failing required steps: ${failedStepNames.join(', ') || '(none reported)'}.`,
  ];
  if (failedSoft.length) {
    feedback.push(`Non-blocking soft failures (address opportunistically): ${failedSoft.map((s) => s.name).join(', ')}.`);
  }
  for (const s of failedRequired) {
    feedback.push(
      `\n=== step: ${s.name} (${s.timedOut ? 'timed out' : `exit ${s.exitCode ?? 'null'}`}, ${Math.round(s.durationMs / 1000)}s) ===`,
    );
    feedback.push(`cmd: ${s.cmd}`);
    const stderr = (s.stderrExcerpt || '').trim();
    const stdout = (s.stdoutExcerpt || '').trim();
    if (stderr) feedback.push(`stderr (trailing):\n${stderr}`);
    if (stdout && stdout !== stderr) feedback.push(`stdout (trailing):\n${stdout}`);
  }

  return { message, failedChecks, failedStepNames, feedback };
}

module.exports = {
  runValidation,
  summarizeReport,
  compactReport,
  shouldGateOnValidation,
  buildValidationBlocker,
};

// Silence unused-import warning for path (kept for future step-file resolution).
void path;
