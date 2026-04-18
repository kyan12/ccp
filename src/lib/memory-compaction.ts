/**
 * Phase 5c: LLM-driven memory-file compaction.
 *
 * The Phase 5a memory loader (memory.ts) is deliberately dumb: it reads
 * `.ccp/memory.md`, caps it at MAX_MEMORY_BYTES (16KB), and appends a
 * visible truncation marker. That's fine when operators curate memory
 * by hand, but once agents start appending their own learnings the file
 * grows past 16KB and important context silently falls off the end.
 *
 * Compaction asks an LLM (the repo's resolved agent driver, or an
 * explicit override) to produce a condensed version of the file,
 * preserving facts / conventions / pitfalls while dropping redundancy
 * and chatty prose. The original is archived under
 * `.ccp/memory.archive/<ISO>.md` before the memory file is overwritten,
 * so nothing is irrecoverably lost.
 *
 * Design constraints:
 *   - Opt-in per repo (`memoryCompaction.enabled: true`). Default OFF
 *     so landing this PR cannot change behavior for any existing repo.
 *   - Synchronous in the dispatch path so the next worker sees the
 *     compacted file. Protected by a tight `timeoutSec` cap.
 *   - Every failure mode (no agent binary, agent times out, agent
 *     prints empty/oversized output) leaves the original file
 *     untouched and is logged to stderr. A failed compaction never
 *     blocks the job — the worker still runs with the original file
 *     (which the loader will still truncate at 16KB for safety).
 *   - Atomic writes: compacted content goes to a sibling `.tmp` file
 *     then `fs.renameSync()`s into place. Archive is written before
 *     the rename so even a crash between archive and rename leaves a
 *     recoverable copy.
 *
 * Testability: the subprocess invocation is parameterized via a
 * `runCompaction` hook so unit tests can inject a fake agent without
 * shelling out to a real CLI.
 */

import fs = require('fs');
import path = require('path');
import { spawnSync, type SpawnSyncReturns } from 'child_process';
import type {
  JobPacket,
  MemoryCompactionConfig,
  RepoMapping,
} from '../types';
import { resolveMemoryPath } from './memory';
const agents = require('./agents') as typeof import('./agents');
const { findRepoByPath } = require('./repos') as typeof import('./repos');

/** Defaults mirror MAX_MEMORY_BYTES from memory.ts (16KB / 8KB / 5 min). */
export const DEFAULT_COMPACTION_MAX_BYTES = 16 * 1024;
export const DEFAULT_COMPACTION_TARGET_BYTES = 8 * 1024;
export const DEFAULT_COMPACTION_TIMEOUT_SEC = 300;

/** Hard ceiling on absolute bytes we accept back from the agent. */
const MAX_ACCEPTABLE_COMPACTED_BYTES = 32 * 1024;

export interface ResolvedCompactionConfig {
  enabled: boolean;
  maxBytes: number;
  targetBytes: number;
  timeoutSec: number;
  agent: string | null;
}

/** Normalize a raw config (from repos.json) into concrete numbers + defaults. */
export function resolveCompactionConfig(
  raw: MemoryCompactionConfig | undefined | null,
): ResolvedCompactionConfig {
  const cfg = raw ?? {};
  const enabled = cfg.enabled === true;
  const maxBytes =
    typeof cfg.maxBytes === 'number' && cfg.maxBytes > 0
      ? Math.floor(cfg.maxBytes)
      : DEFAULT_COMPACTION_MAX_BYTES;
  // Clamp target below maxBytes so a misconfigured target > max never
  // makes compaction a no-op loop.
  const rawTarget =
    typeof cfg.targetBytes === 'number' && cfg.targetBytes > 0
      ? Math.floor(cfg.targetBytes)
      : DEFAULT_COMPACTION_TARGET_BYTES;
  const targetBytes = Math.min(rawTarget, Math.max(1024, maxBytes - 1024));
  const timeoutSec =
    typeof cfg.timeoutSec === 'number' && cfg.timeoutSec > 0
      ? Math.floor(cfg.timeoutSec)
      : DEFAULT_COMPACTION_TIMEOUT_SEC;
  const agent = typeof cfg.agent === 'string' && cfg.agent.trim()
    ? cfg.agent.trim()
    : null;
  return { enabled, maxBytes, targetBytes, timeoutSec, agent };
}

export interface CompactionDecision {
  /** If false, skip compaction. `reason` explains why. */
  shouldCompact: boolean;
  /** Absolute bytes on disk (0 when file missing). */
  sizeBytes: number;
  /** Resolved memory-file path (may not exist). */
  memoryPath: string | null;
  /** Why we decided to compact or skip. */
  reason: string;
}

/**
 * Decide whether compaction should run for this packet. Caller passes
 * the resolved per-repo config so a CLI can pass explicit overrides
 * (e.g. `ccp-jobs compact-memory --force`) without re-reading
 * repos.json.
 */
export function shouldCompact(
  packet: JobPacket,
  cfg: ResolvedCompactionConfig,
): CompactionDecision {
  const memoryPath = resolveMemoryPath(packet);
  if (!memoryPath) {
    return {
      shouldCompact: false,
      sizeBytes: 0,
      memoryPath: null,
      reason: 'no memory file resolved for this packet (missing packet.repo)',
    };
  }
  if (!cfg.enabled) {
    return {
      shouldCompact: false,
      sizeBytes: 0,
      memoryPath,
      reason: 'memoryCompaction.enabled is false (default)',
    };
  }
  let size = 0;
  try {
    size = fs.existsSync(memoryPath) ? fs.statSync(memoryPath).size : 0;
  } catch {
    size = 0;
  }
  if (size === 0) {
    return {
      shouldCompact: false,
      sizeBytes: 0,
      memoryPath,
      reason: 'memory file missing or empty',
    };
  }
  if (size <= cfg.maxBytes) {
    return {
      shouldCompact: false,
      sizeBytes: size,
      memoryPath,
      reason: `memory file ${size}B ≤ maxBytes ${cfg.maxBytes}B`,
    };
  }
  return {
    shouldCompact: true,
    sizeBytes: size,
    memoryPath,
    reason: `memory file ${size}B > maxBytes ${cfg.maxBytes}B`,
  };
}

export interface CompactionRunResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  /** True iff the subprocess was killed by the timeout. */
  timedOut: boolean;
}

/** Hook signature used by the real runner and test fakes. */
export type CompactionRunner = (
  bin: string,
  args: string[],
  promptStdin: string,
  timeoutMs: number,
) => CompactionRunResult;

/**
 * Default runner: spawn the binary and pipe the prompt on stdin.
 * Extracted so tests can swap it out for a deterministic fake without
 * touching node's child_process.
 */
export const defaultCompactionRunner: CompactionRunner = (
  bin,
  args,
  promptStdin,
  timeoutMs,
) => {
  const result: SpawnSyncReturns<string> = spawnSync(bin, args, {
    input: promptStdin,
    encoding: 'utf8',
    timeout: timeoutMs,
    // Don't inherit stdio — we need captured stdout/stderr.
  });
  const timedOut =
    (result as unknown as { error?: { code?: string } }).error?.code ===
    'ETIMEDOUT';
  return {
    stdout: result.stdout || '',
    stderr: result.stderr || '',
    exitCode: typeof result.status === 'number' ? result.status : null,
    timedOut,
  };
};

/** Build the summarization prompt. Exported for tests + CLI visibility. */
export function buildCompactionPrompt(
  original: string,
  targetBytes: number,
): string {
  return [
    'You are compacting a persistent repository memory file used to brief a',
    'coding agent on every task in this repo. The file is getting too large',
    'and needs to be rewritten in a shorter, denser form.',
    '',
    'Rules for the rewrite:',
    '1. Preserve EVERY concrete fact, command, path, convention, or',
    '   "don\'t touch X" warning. Drop chatty prose and commentary.',
    '2. Merge duplicate or overlapping notes into one entry.',
    '3. Keep the markdown structure (headings, bullet lists). Short',
    '   bullets > long paragraphs.',
    '4. Do NOT invent new information. Only rephrase what is already',
    '   in the source.',
    `5. Aim for roughly ${targetBytes} bytes or less. Dense bullets are`,
    '   fine; full sentences are rarely needed.',
    '6. Output ONLY the new memory file contents. No preamble, no',
    '   "Here is the compacted file:", no trailing summary. The first',
    '   byte of your response is the first byte of the new file.',
    '',
    '--- BEGIN CURRENT MEMORY FILE ---',
    original,
    '--- END CURRENT MEMORY FILE ---',
  ].join('\n');
}

export interface CompactionOutcome {
  ok: boolean;
  /** Absolute path of the memory file we operated on. */
  memoryPath: string;
  /** Absolute path of the archive copy (null when compaction was skipped). */
  archivePath: string | null;
  /** Original file size in bytes. */
  originalBytes: number;
  /** Compacted file size in bytes (0 when compaction failed / skipped). */
  compactedBytes: number;
  /** Agent driver name used (null when skipped). */
  agent: string | null;
  /** Wall-clock duration of the compaction subprocess. */
  durationMs: number;
  /** Short code describing what happened. */
  status:
    | 'compacted'
    | 'skipped'
    | 'agent-missing'
    | 'agent-failed'
    | 'agent-timeout'
    | 'empty-output'
    | 'oversized-output'
    | 'io-error';
  /** Optional human-readable detail for logs. */
  detail?: string;
}

export interface CompactMemoryOptions {
  /** Explicit packet, used to resolve memoryPath + repo config. */
  packet: JobPacket;
  /** Pre-resolved repo mapping (saves a lookup when the caller already has it). */
  repo?: RepoMapping | null;
  /** Override the compaction config (e.g. from a CLI --force). */
  config?: ResolvedCompactionConfig;
  /** Swap out the subprocess runner (tests). */
  runner?: CompactionRunner;
  /** Swap out the clock (tests). */
  now?: () => Date;
}

/**
 * Run one compaction pass. Idempotent: if the file no longer exceeds
 * maxBytes by the time we get here, we return `status: 'skipped'`
 * without touching the file.
 */
export function compactMemory(opts: CompactMemoryOptions): CompactionOutcome {
  const packet = opts.packet;
  const repo: RepoMapping | null =
    opts.repo ?? (packet.repo ? findRepoByPath(packet.repo) : null);
  const cfg =
    opts.config ?? resolveCompactionConfig(repo?.memoryCompaction);
  const runner = opts.runner ?? defaultCompactionRunner;
  const now = opts.now ?? (() => new Date());

  const decision = shouldCompact(packet, cfg);
  if (!decision.shouldCompact || !decision.memoryPath) {
    return {
      ok: false,
      memoryPath: decision.memoryPath || '',
      archivePath: null,
      originalBytes: decision.sizeBytes,
      compactedBytes: 0,
      agent: null,
      durationMs: 0,
      status: 'skipped',
      detail: decision.reason,
    };
  }
  const memoryPath = decision.memoryPath;

  // Resolve agent driver. If a config.agent override is set, that wins;
  // otherwise resolveAgent() does the normal packet→repo→env→default dance.
  const driver =
    (cfg.agent && agents.getAgent(cfg.agent)) ||
    agents.resolveAgent(packet, repo).driver;
  const preflight = driver.preflight();
  if (!preflight.ok || !preflight.bin) {
    return {
      ok: false,
      memoryPath,
      archivePath: null,
      originalBytes: decision.sizeBytes,
      compactedBytes: 0,
      agent: driver.name,
      durationMs: 0,
      status: 'agent-missing',
      detail: `agent '${driver.name}' preflight failed: ${preflight.failures.join('; ') || 'bin not found'}`,
    };
  }

  // Read original. Failure here bails out before archive/rename.
  let original: string;
  try {
    original = fs.readFileSync(memoryPath, 'utf8');
  } catch (err) {
    return {
      ok: false,
      memoryPath,
      archivePath: null,
      originalBytes: decision.sizeBytes,
      compactedBytes: 0,
      agent: driver.name,
      durationMs: 0,
      status: 'io-error',
      detail: `failed to read memory file: ${(err as Error).message}`,
    };
  }

  // Archive BEFORE we spawn the agent — if the process crashes
  // between archive and rename, the operator still has the pre-
  // compaction content sitting next to the memory file.
  const archiveDir = path.join(path.dirname(memoryPath), 'memory.archive');
  const archiveName = toArchiveName(now());
  const archivePath = path.join(archiveDir, archiveName);
  try {
    fs.mkdirSync(archiveDir, { recursive: true });
    fs.writeFileSync(archivePath, original);
  } catch (err) {
    return {
      ok: false,
      memoryPath,
      archivePath: null,
      originalBytes: decision.sizeBytes,
      compactedBytes: 0,
      agent: driver.name,
      durationMs: 0,
      status: 'io-error',
      detail: `failed to write archive: ${(err as Error).message}`,
    };
  }

  const prompt = buildCompactionPrompt(original, cfg.targetBytes);
  const args = compactionArgsFor(driver.name);
  const started = Date.now();
  const runResult = runner(preflight.bin, args, prompt, cfg.timeoutSec * 1000);
  const durationMs = Date.now() - started;

  if (runResult.timedOut) {
    return {
      ok: false,
      memoryPath,
      archivePath,
      originalBytes: decision.sizeBytes,
      compactedBytes: 0,
      agent: driver.name,
      durationMs,
      status: 'agent-timeout',
      detail: `agent '${driver.name}' did not finish within ${cfg.timeoutSec}s`,
    };
  }
  if (runResult.exitCode !== 0) {
    return {
      ok: false,
      memoryPath,
      archivePath,
      originalBytes: decision.sizeBytes,
      compactedBytes: 0,
      agent: driver.name,
      durationMs,
      status: 'agent-failed',
      detail: `agent '${driver.name}' exited ${runResult.exitCode}: ${(runResult.stderr || runResult.stdout).slice(0, 200)}`,
    };
  }

  const compactedRaw = runResult.stdout.trim();
  if (!compactedRaw) {
    return {
      ok: false,
      memoryPath,
      archivePath,
      originalBytes: decision.sizeBytes,
      compactedBytes: 0,
      agent: driver.name,
      durationMs,
      status: 'empty-output',
      detail: `agent '${driver.name}' produced empty output`,
    };
  }
  const compactedBytes = Buffer.byteLength(compactedRaw, 'utf8');
  if (compactedBytes > MAX_ACCEPTABLE_COMPACTED_BYTES) {
    return {
      ok: false,
      memoryPath,
      archivePath,
      originalBytes: decision.sizeBytes,
      compactedBytes,
      agent: driver.name,
      durationMs,
      status: 'oversized-output',
      detail: `agent '${driver.name}' produced ${compactedBytes}B (> hard cap ${MAX_ACCEPTABLE_COMPACTED_BYTES}B)`,
    };
  }
  if (compactedBytes >= decision.sizeBytes) {
    return {
      ok: false,
      memoryPath,
      archivePath,
      originalBytes: decision.sizeBytes,
      compactedBytes,
      agent: driver.name,
      durationMs,
      status: 'oversized-output',
      detail: `compacted output ${compactedBytes}B is not smaller than original ${decision.sizeBytes}B`,
    };
  }

  // Atomic overwrite.
  const tmpPath = `${memoryPath}.compact.tmp`;
  try {
    fs.writeFileSync(tmpPath, compactedRaw);
    fs.renameSync(tmpPath, memoryPath);
  } catch (err) {
    try {
      if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
    } catch {
      /* ignore cleanup failure */
    }
    return {
      ok: false,
      memoryPath,
      archivePath,
      originalBytes: decision.sizeBytes,
      compactedBytes,
      agent: driver.name,
      durationMs,
      status: 'io-error',
      detail: `failed to overwrite memory file: ${(err as Error).message}`,
    };
  }

  return {
    ok: true,
    memoryPath,
    archivePath,
    originalBytes: decision.sizeBytes,
    compactedBytes,
    agent: driver.name,
    durationMs,
    status: 'compacted',
    detail: `compacted ${decision.sizeBytes}B → ${compactedBytes}B via ${driver.name}`,
  };
}

/**
 * Per-agent CLI arguments for one-shot non-interactive completion.
 * Mirrors each driver's buildCommand() shape but without the `cat <prompt>|`
 * piping since we feed the prompt via stdin of the spawnSync call.
 *
 * Exported for test visibility; callers should not need to invoke it
 * directly.
 */
export function compactionArgsFor(agentName: string): string[] {
  switch (agentName) {
    case 'claude-code':
      return ['--print', '--permission-mode', 'bypassPermissions'];
    case 'codex':
      // Match the codex driver's buildCommand() shape, which pipes the
      // prompt on stdin (`cat prompt | codex exec ...`). We MUST NOT
      // append a trailing `-` here — codex treats any positional arg
      // after `exec` as the literal prompt text, so passing `-` would
      // make the agent reply to the string "-" and ignore our stdin
      // entirely, then silently overwrite the memory file with whatever
      // short nonsense it came up with. `read-only` sandbox (vs
      // workspace-write in the main driver) because the compactor
      // shouldn't touch the repo — it only rewrites the memory file,
      // and that write is done by this module, not the agent.
      return [
        'exec',
        '--color',
        'never',
        '--sandbox',
        'read-only',
        '--skip-git-repo-check',
      ];
    default:
      // Unknown driver name — fall back to claude-code's flag shape.
      // resolveAgent() would have already caught this and warned.
      return ['--print'];
  }
}

/** Archive filename: ISO timestamp, colons → dashes (Windows-friendly). */
function toArchiveName(d: Date): string {
  return `${d.toISOString().replace(/[:.]/g, '-')}.md`;
}

module.exports = {
  DEFAULT_COMPACTION_MAX_BYTES,
  DEFAULT_COMPACTION_TARGET_BYTES,
  DEFAULT_COMPACTION_TIMEOUT_SEC,
  resolveCompactionConfig,
  shouldCompact,
  defaultCompactionRunner,
  buildCompactionPrompt,
  compactMemory,
  compactionArgsFor,
};
