// Phase 3: per-job git worktree lifecycle.
//
// When `repos.json` marks a repo with `worktree: true`, every job that
// targets it runs in its own checkout created with `git worktree add`
// instead of sharing the canonical `localPath` checkout. Benefits:
//
//   1. Isolation — a crashed / interrupted worker can't leave the
//      canonical checkout in a dirty state that leaks into the next job.
//   2. Parallelism — with `parallelJobs: N > 1`, multiple jobs can run
//      against the same repo concurrently without stomping on each
//      other's branch / working tree. The per-repo serial gate in
//      `runCycle` relaxes to a count gate keyed on parallelJobs.
//
// This module deliberately exposes only lifecycle primitives
// (isWorktreeEnabled / getParallelJobLimit / acquireWorktree /
// releaseWorktree). The gate-count logic lives in jobs.ts where the
// rest of dispatch coordination lives.
//
// All filesystem work is synchronous to match the rest of jobs.ts
// (spawnSync, writeFileSync, etc.) — the supervisor is single-threaded
// per cycle and worktree ops are fast (~100ms each) so there's no
// benefit to async plumbing here.

import fs = require('fs');
import path = require('path');
import { run, commandExists } from './shell';
import type { RepoMapping } from '../types';

const ROOT: string = path.resolve(process.env.CCP_ROOT || path.join(__dirname, '..', '..'));
const WORKTREES_DIR: string = path.join(ROOT, 'worktrees');

/**
 * True when this repo is configured to use per-job worktrees.
 */
export function isWorktreeEnabled(mapping: RepoMapping | null | undefined): boolean {
  return !!(mapping && mapping.worktree === true);
}

/**
 * Max concurrent jobs allowed against this repo. 1 for repos not using
 * worktrees (today's behavior), or `mapping.parallelJobs` (floored at 1)
 * when worktrees are enabled. parallelJobs > 1 without worktree: true is
 * silently clamped to 1 — running two workers against the same checkout
 * would corrupt each other's working tree.
 */
export function getParallelJobLimit(mapping: RepoMapping | null | undefined): number {
  if (!mapping) return 1;
  if (!isWorktreeEnabled(mapping)) return 1;
  const n = mapping.parallelJobs;
  if (typeof n !== 'number' || !Number.isFinite(n) || n < 1) return 1;
  return Math.floor(n);
}

/**
 * Resolve the on-disk worktree path for a given job + mapping. Pure
 * function of inputs — does not touch the filesystem. Exported so
 * callers can construct expected paths for logging / assertions
 * without side effects.
 */
export function worktreePathFor(mapping: RepoMapping, jobId: string): string {
  return path.join(WORKTREES_DIR, mapping.key, jobId);
}

export interface AcquireResult {
  /** Absolute path to the newly created worktree. */
  path: string;
  /** The source repo (mapping.localPath) the worktree was added from. */
  sourceRepo: string;
  /** True if the worktree directory already existed and was reused. */
  reused: boolean;
}

/**
 * Create a git worktree for this job rooted at `origin/main`. The
 * worker script downstream will `git checkout -b <feature-branch>
 * main` or `git reset --hard origin/main` exactly like it did before
 * Phase 3, so no change to the worker prompt is required — the cd
 * target simply swings from `mapping.localPath` to this path.
 *
 * Errors are thrown rather than swallowed — a worktree that fails to
 * allocate is a hard failure; jobs.ts catches this and falls back to
 * `localPath` so the job can still run (with the usual per-repo
 * serialization). Callers that need silent-skip semantics can wrap.
 */
export function acquireWorktree(mapping: RepoMapping, jobId: string): AcquireResult {
  const git = commandExists('git');
  if (!git) {
    throw new Error('git not available on PATH');
  }
  if (!mapping.localPath || !fs.existsSync(mapping.localPath)) {
    throw new Error(`source repo missing: ${mapping.localPath || '(unset)'}`);
  }
  const wtPath = worktreePathFor(mapping, jobId);
  fs.mkdirSync(path.dirname(wtPath), { recursive: true });

  // If the directory already exists, short-circuit and reuse it —
  // happens when the supervisor restarts mid-job, reconciles the tmux
  // session, and re-enters startTmuxWorker. Verifying with `git
  // worktree list` would be nicer but is overkill; the presence of a
  // .git file / directory is a reliable enough signal.
  if (fs.existsSync(wtPath) && fs.existsSync(path.join(wtPath, '.git'))) {
    return { path: wtPath, sourceRepo: mapping.localPath, reused: true };
  }

  // Pre-fetch so origin/main points at the latest commit. Failures
  // here aren't fatal (we still create the worktree from whatever
  // origin/main references locally), but a pre-push fetch avoids a
  // worker starting on a stale base branch.
  run(git, ['-C', mapping.localPath, 'fetch', 'origin', 'main', '--quiet']);

  // `--detach` is required: the primary checkout (mapping.localPath)
  // almost certainly has `main` checked out, and git forbids checking
  // out the same branch in two worktrees. Detached HEAD at origin/main
  // is fine — the worker's own `git checkout -b <feat>` creates its
  // branch from the current commit, independent of which branch label
  // is currently pointed at it.
  const add = run(git, [
    '-C', mapping.localPath,
    'worktree', 'add',
    '--detach',
    wtPath,
    'origin/main',
  ]);
  if (add.status !== 0) {
    throw new Error(`git worktree add failed: ${(add.stderr || add.stdout || '').trim()}`);
  }
  return { path: wtPath, sourceRepo: mapping.localPath, reused: false };
}

export interface ReleaseResult {
  ok: boolean;
  /** Short description of what happened, for the worker.log. */
  detail: string;
}

/**
 * Tear down a worktree after the job finalises. Uses `git worktree
 * remove --force` so an uncommitted working tree (e.g. blocked job
 * that never got to commit) still cleans up; the cleanup is a
 * best-effort operation — a failure here should NEVER prevent the
 * supervisor from reporting job completion. Returns `ok: false`
 * with a detail string that the caller can surface in logs.
 *
 * Calling with a `worktreePath` that doesn't exist is a no-op
 * returning `ok: true`, so finalizeJob can call this
 * unconditionally without a pre-check.
 */
export function releaseWorktree(worktreePath: string | null | undefined, sourceRepoPath: string | null | undefined): ReleaseResult {
  if (!worktreePath) return { ok: true, detail: 'no worktree to release' };
  if (!fs.existsSync(worktreePath)) {
    // Might have been cleaned up by a previous finalize pass, or never
    // allocated (e.g. acquire failed and we fell back to localPath).
    return { ok: true, detail: `worktree path already absent: ${worktreePath}` };
  }
  const git = commandExists('git');
  if (!git) {
    return { ok: false, detail: 'git not available on PATH — leaving worktree dir in place for manual cleanup' };
  }
  if (!sourceRepoPath || !fs.existsSync(sourceRepoPath)) {
    // Without a source repo we can't invoke `git worktree remove`.
    // Try a plain rmdir as a last resort so we don't leave stale
    // directories lying around forever.
    try {
      fs.rmSync(worktreePath, { recursive: true, force: true });
      return { ok: true, detail: `source repo missing; rm -rf ${worktreePath}` };
    } catch (e) {
      return { ok: false, detail: `source repo missing and rm -rf failed: ${(e as Error).message}` };
    }
  }
  const rem = run(git, ['-C', sourceRepoPath, 'worktree', 'remove', '--force', worktreePath]);
  if (rem.status === 0) {
    // Git also prunes the administrative entry under .git/worktrees/,
    // but only if --force was accepted. Belt-and-suspenders: run
    // `worktree prune` unconditionally. Cheap, idempotent.
    run(git, ['-C', sourceRepoPath, 'worktree', 'prune']);
    return { ok: true, detail: `removed ${worktreePath}` };
  }
  // Fallback: the remove command can fail if the worktree directory
  // was mutated outside git's knowledge (e.g. disk full mid-job).
  // Manual rm + prune still leaves us in a consistent state.
  const err = (rem.stderr || rem.stdout || '').trim();
  try {
    fs.rmSync(worktreePath, { recursive: true, force: true });
    run(git, ['-C', sourceRepoPath, 'worktree', 'prune']);
    return { ok: true, detail: `git worktree remove failed (${err}); rm -rf + prune recovered` };
  } catch (e) {
    return { ok: false, detail: `git worktree remove failed: ${err}; rm fallback also failed: ${(e as Error).message}` };
  }
}
