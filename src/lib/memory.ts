/**
 * Per-repo persistent memory loader (Phase 5a).
 *
 * Every job's prompt gets prepended with the contents of a per-repo
 * memory file so operators don't have to restate project conventions,
 * known pitfalls, or architectural notes in every Linear ticket.
 *
 * Resolution order for a given packet:
 *   1. repoMapping.memoryFile (absolute, or relative to repo root)
 *   2. <repoRoot>/.ccp/memory.md
 *   3. no memory (returns null)
 *
 * Missing files are not an error — they just mean "no memory configured
 * for this repo yet". The only hard failures are unreadable files with
 * the path explicitly configured (a misconfiguration the operator should
 * see), which surface as a console warning and a null return.
 *
 * Content is capped at MAX_MEMORY_BYTES so a runaway memory file can't
 * eat the context window. When we truncate, we append a visible marker
 * so the operator notices and splits the file up.
 */

import fs = require('fs');
import path = require('path');
import type { JobPacket, RepoMapping } from '../types';
const { findRepoByPath } = require('./repos') as typeof import('./repos');

/**
 * 16KB cap. This is a conservative ceiling that fits comfortably in
 * every provider's context window (~4k tokens) while leaving plenty of
 * room for the ticket goal, acceptance criteria, verification steps,
 * review comments, and the worker's own output. Operators who need
 * more detail should split their memory into task-specific snippets
 * and reference them from CLAUDE.md / AGENTS.md rather than dumping
 * everything into one file — long irrelevant context hurts agent
 * performance more than it helps.
 */
export const MAX_MEMORY_BYTES = 16 * 1024;

const TRUNCATION_MARKER =
  '\n\n[... memory file truncated at 16KB; split into smaller files to keep all context ...]';

export interface RepoMemory {
  /** Resolved absolute path that was read. */
  path: string;
  /** File contents, possibly truncated. */
  content: string;
  /** True iff the original file exceeded MAX_MEMORY_BYTES. */
  truncated: boolean;
}

/**
 * Resolve the absolute memory-file path for a packet, if any.
 *
 * Exported separately from loadRepoMemory so callers (e.g. a future
 * `ccp-jobs doctor --memory` command) can surface which file *would*
 * be loaded without actually reading it.
 */
export function resolveMemoryPath(packet: JobPacket): string | null {
  const repoPath = packet.repo;
  if (!repoPath) return null;
  const mapping: RepoMapping | null = findRepoByPath(repoPath);
  // If the mapping explicitly sets memoryFile, honor it verbatim.
  // Relative paths resolve against the repo root so `.ccp/memory.md`
  // and `docs/ccp-memory.md` both Just Work.
  if (mapping?.memoryFile) {
    return path.isAbsolute(mapping.memoryFile)
      ? mapping.memoryFile
      : path.resolve(repoPath, mapping.memoryFile);
  }
  // Default: `.ccp/memory.md` at the repo root. This co-locates the
  // memory with the repo so it's versioned alongside the code and
  // naturally follows branch/worktree context if a repo ever opts into
  // Phase 3 worktrees.
  return path.resolve(repoPath, '.ccp', 'memory.md');
}

/**
 * Load per-repo memory for a packet. Returns null if no memory is
 * configured, the file doesn't exist, or the file is empty after
 * trimming. Truncates at MAX_MEMORY_BYTES with a visible marker.
 */
export function loadRepoMemory(packet: JobPacket): RepoMemory | null {
  const memPath = resolveMemoryPath(packet);
  if (!memPath) return null;
  let raw: string;
  try {
    if (!fs.existsSync(memPath)) return null;
    raw = fs.readFileSync(memPath, 'utf8');
  } catch (err) {
    // Unreadable (permissions, I/O error). Log once and move on —
    // failing the job because of a memory-file problem would be worse
    // than running without memory.
    console.error(
      `[ccp] could not read repo memory at ${memPath}: ${(err as Error).message}`,
    );
    return null;
  }
  const trimmed = raw.trim();
  if (!trimmed) return null;
  // Byte-length cap, not character count, to match how provider
  // context windows are actually metered.
  const bytes = Buffer.byteLength(trimmed, 'utf8');
  if (bytes <= MAX_MEMORY_BYTES) {
    return { path: memPath, content: trimmed, truncated: false };
  }
  // Truncate by bytes, then decode back to a string. slice() on a
  // buffer could split a multi-byte UTF-8 character — tolerable here
  // because Node replaces the invalid tail with U+FFFD and the marker
  // makes clear the tail is truncated anyway.
  const buf = Buffer.from(trimmed, 'utf8');
  const truncated = buf.slice(0, MAX_MEMORY_BYTES).toString('utf8');
  return {
    path: memPath,
    content: truncated + TRUNCATION_MARKER,
    truncated: true,
  };
}

module.exports = {
  MAX_MEMORY_BYTES,
  resolveMemoryPath,
  loadRepoMemory,
};
