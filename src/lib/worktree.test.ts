/**
 * Tests for the per-job git worktree lifecycle (Phase 3).
 *
 * Each test allocates a fresh temp directory, initialises a bare-ish
 * git repo inside it (so `git worktree add` and friends have a real
 * .git to point at), and runs lifecycle primitives against that
 * isolated setup. No network, no dependency on the real CCP_ROOT /
 * configs on the host.
 */

import fs = require('fs');
import os = require('os');
import path = require('path');
import { spawnSync } from 'child_process';
import type { RepoMapping } from '../types';

let passed = 0;
let failed = 0;

function assert(condition: boolean, msg: string): void {
  if (condition) {
    passed++;
    console.log(`  PASS: ${msg}`);
  } else {
    failed++;
    console.error(`  FAIL: ${msg}`);
  }
}

function sh(cwd: string, args: string[]): { status: number | null; stdout: string; stderr: string } {
  const res = spawnSync('git', args, { cwd, encoding: 'utf8' });
  return { status: res.status, stdout: res.stdout || '', stderr: res.stderr || '' };
}

function mkTmpRoot(label: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `ccp-worktree-${label}-`));
}

/**
 * Stand up a minimal git repo with an `origin/main` reference that
 * `git worktree add origin/main` can resolve. We mock a remote by
 * creating a second bare repo and pointing origin at it.
 */
function initRepoWithOrigin(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
  const bareRemote = fs.mkdtempSync(path.join(os.tmpdir(), 'ccp-worktree-remote-'));
  sh(bareRemote, ['init', '--bare', '-b', 'main']);

  sh(dir, ['init', '-b', 'main']);
  sh(dir, ['config', 'user.email', 'test@example.com']);
  sh(dir, ['config', 'user.name', 'Test']);
  fs.writeFileSync(path.join(dir, 'README.md'), '# test\n');
  sh(dir, ['add', 'README.md']);
  sh(dir, ['commit', '-m', 'initial']);
  sh(dir, ['remote', 'add', 'origin', bareRemote]);
  sh(dir, ['push', 'origin', 'main']);
  // Ensure origin/main is tracked locally — otherwise `worktree add
  // origin/main` can't resolve the ref. Push already created the
  // remote-tracking ref, but be belt-and-suspenders.
  sh(dir, ['fetch', 'origin', 'main']);
}

function runWithFakeRoot<T>(ccpRoot: string, fn: () => T): T {
  const prev = process.env.CCP_ROOT;
  process.env.CCP_ROOT = ccpRoot;
  for (const key of Object.keys(require.cache)) {
    if (key.includes('/src/lib/') || key.includes('/dist/lib/')) {
      delete require.cache[key];
    }
  }
  try {
    return fn();
  } finally {
    if (prev === undefined) delete process.env.CCP_ROOT;
    else process.env.CCP_ROOT = prev;
    for (const key of Object.keys(require.cache)) {
      if (key.includes('/src/lib/') || key.includes('/dist/lib/')) {
        delete require.cache[key];
      }
    }
  }
}

function mkMapping(localPath: string, overrides: Partial<RepoMapping> = {}): RepoMapping {
  return {
    key: 'test',
    localPath,
    ...overrides,
  };
}

function listWorktrees(repoPath: string): string[] {
  const res = sh(repoPath, ['worktree', 'list', '--porcelain']);
  if (res.status !== 0) return [];
  return res.stdout.split('\n').filter((l) => l.startsWith('worktree ')).map((l) => l.slice('worktree '.length).trim());
}

function runTests(): void {
  console.log('\nTest: isWorktreeEnabled returns false by default');
  {
    const ccpRoot = mkTmpRoot('en1');
    runWithFakeRoot(ccpRoot, () => {
      const { isWorktreeEnabled } = require('./worktree');
      assert(isWorktreeEnabled(null) === false, 'null mapping → disabled');
      assert(isWorktreeEnabled(undefined) === false, 'undefined mapping → disabled');
      assert(isWorktreeEnabled(mkMapping('/x')) === false, 'no worktree field → disabled');
      assert(isWorktreeEnabled(mkMapping('/x', { worktree: false })) === false, 'worktree: false → disabled');
      assert(isWorktreeEnabled(mkMapping('/x', { worktree: true })) === true, 'worktree: true → enabled');
    });
  }

  console.log('\nTest: getParallelJobLimit defaults to 1 and requires worktree');
  {
    const ccpRoot = mkTmpRoot('pl1');
    runWithFakeRoot(ccpRoot, () => {
      const { getParallelJobLimit } = require('./worktree');
      assert(getParallelJobLimit(null) === 1, 'null → 1');
      assert(getParallelJobLimit(mkMapping('/x')) === 1, 'no fields → 1');
      assert(
        getParallelJobLimit(mkMapping('/x', { parallelJobs: 4 })) === 1,
        'parallelJobs without worktree → clamped to 1',
      );
      assert(
        getParallelJobLimit(mkMapping('/x', { worktree: true, parallelJobs: 4 })) === 4,
        'worktree + parallelJobs: 4 → 4',
      );
      assert(
        getParallelJobLimit(mkMapping('/x', { worktree: true, parallelJobs: 0 })) === 1,
        'parallelJobs: 0 → 1 (floor)',
      );
      assert(
        getParallelJobLimit(mkMapping('/x', { worktree: true, parallelJobs: -5 })) === 1,
        'negative parallelJobs → 1',
      );
      assert(
        getParallelJobLimit(mkMapping('/x', { worktree: true, parallelJobs: 3.7 })) === 3,
        'fractional parallelJobs → floor',
      );
      assert(
        getParallelJobLimit(mkMapping('/x', { worktree: true, parallelJobs: NaN })) === 1,
        'NaN parallelJobs → 1',
      );
    });
  }

  console.log('\nTest: worktreePathFor is deterministic and under CCP_ROOT/worktrees');
  {
    const ccpRoot = mkTmpRoot('wp1');
    runWithFakeRoot(ccpRoot, () => {
      const { worktreePathFor } = require('./worktree');
      const mapping = mkMapping('/opt/app', { key: 'myrepo' });
      const p = worktreePathFor(mapping, 'job_abc');
      assert(p === path.join(ccpRoot, 'worktrees', 'myrepo', 'job_abc'), `path = ${p}`);
    });
  }

  console.log('\nTest: acquireWorktree creates a detached checkout at origin/main');
  {
    const ccpRoot = mkTmpRoot('acq1');
    const repo = path.join(ccpRoot, 'repo');
    initRepoWithOrigin(repo);
    runWithFakeRoot(ccpRoot, () => {
      const { acquireWorktree, worktreePathFor } = require('./worktree');
      const mapping = mkMapping(repo, { key: 'acq' });
      const result = acquireWorktree(mapping, 'job1');
      assert(result.path === worktreePathFor(mapping, 'job1'), 'path matches worktreePathFor');
      assert(result.sourceRepo === repo, 'sourceRepo echoes mapping.localPath');
      assert(result.reused === false, 'reused=false on first acquire');
      assert(fs.existsSync(result.path), 'worktree directory exists on disk');
      assert(fs.existsSync(path.join(result.path, 'README.md')), 'seed file checked out');
      // Verify detached HEAD (not on main — main is owned by source repo)
      const head = sh(result.path, ['symbolic-ref', '-q', 'HEAD']);
      assert(head.status !== 0, 'HEAD is detached (symbolic-ref fails)');
      const wts = listWorktrees(repo);
      assert(wts.includes(result.path), 'git worktree list includes the new path');
    });
  }

  console.log('\nTest: acquireWorktree reuses an existing directory idempotently');
  {
    const ccpRoot = mkTmpRoot('acq2');
    const repo = path.join(ccpRoot, 'repo');
    initRepoWithOrigin(repo);
    runWithFakeRoot(ccpRoot, () => {
      const { acquireWorktree } = require('./worktree');
      const mapping = mkMapping(repo, { key: 'acq' });
      const first = acquireWorktree(mapping, 'job1');
      const second = acquireWorktree(mapping, 'job1');
      assert(first.path === second.path, 'same path returned');
      assert(second.reused === true, 'second acquire flagged reused=true');
    });
  }

  console.log('\nTest: acquireWorktree supports multiple concurrent worktrees in same repo');
  {
    const ccpRoot = mkTmpRoot('acq3');
    const repo = path.join(ccpRoot, 'repo');
    initRepoWithOrigin(repo);
    runWithFakeRoot(ccpRoot, () => {
      const { acquireWorktree } = require('./worktree');
      const mapping = mkMapping(repo, { key: 'acq' });
      const a = acquireWorktree(mapping, 'job_a');
      const b = acquireWorktree(mapping, 'job_b');
      assert(a.path !== b.path, 'distinct paths for distinct jobs');
      assert(fs.existsSync(a.path) && fs.existsSync(b.path), 'both worktrees exist');
      const wts = listWorktrees(repo);
      assert(wts.includes(a.path) && wts.includes(b.path), 'git reports both worktrees');
    });
  }

  console.log('\nTest: acquireWorktree throws when source repo is missing');
  {
    const ccpRoot = mkTmpRoot('acq4');
    runWithFakeRoot(ccpRoot, () => {
      const { acquireWorktree } = require('./worktree');
      const mapping = mkMapping('/nonexistent/path/xyzzy', { key: 'miss' });
      let threw = false;
      try {
        acquireWorktree(mapping, 'job1');
      } catch (e) {
        threw = /source repo missing/.test((e as Error).message);
      }
      assert(threw, 'throws with helpful message');
    });
  }

  console.log('\nTest: releaseWorktree removes the worktree and prunes admin state');
  {
    const ccpRoot = mkTmpRoot('rel1');
    const repo = path.join(ccpRoot, 'repo');
    initRepoWithOrigin(repo);
    runWithFakeRoot(ccpRoot, () => {
      const { acquireWorktree, releaseWorktree } = require('./worktree');
      const mapping = mkMapping(repo, { key: 'rel' });
      const acquired = acquireWorktree(mapping, 'job1');
      const release = releaseWorktree(acquired.path, repo);
      assert(release.ok === true, `ok=true (detail=${release.detail})`);
      assert(!fs.existsSync(acquired.path), 'worktree dir removed from disk');
      const wts = listWorktrees(repo);
      assert(!wts.includes(acquired.path), 'git worktree list no longer includes it');
    });
  }

  console.log('\nTest: releaseWorktree is a no-op when path already absent');
  {
    const ccpRoot = mkTmpRoot('rel2');
    const repo = path.join(ccpRoot, 'repo');
    initRepoWithOrigin(repo);
    runWithFakeRoot(ccpRoot, () => {
      const { releaseWorktree } = require('./worktree');
      const neverExisted = path.join(ccpRoot, 'worktrees', 'never', 'here');
      const r = releaseWorktree(neverExisted, repo);
      assert(r.ok === true, 'ok=true');
      assert(/already absent/.test(r.detail), 'detail explains no-op');
    });
  }

  console.log('\nTest: releaseWorktree succeeds on null/empty path');
  {
    const ccpRoot = mkTmpRoot('rel3');
    runWithFakeRoot(ccpRoot, () => {
      const { releaseWorktree } = require('./worktree');
      assert(releaseWorktree(null, null).ok === true, 'null path → ok');
      assert(releaseWorktree(undefined, undefined).ok === true, 'undefined path → ok');
      assert(releaseWorktree('', '').ok === true, 'empty path → ok');
    });
  }

  console.log('\nTest: releaseWorktree cleans up when worktree is dirty');
  {
    const ccpRoot = mkTmpRoot('rel4');
    const repo = path.join(ccpRoot, 'repo');
    initRepoWithOrigin(repo);
    runWithFakeRoot(ccpRoot, () => {
      const { acquireWorktree, releaseWorktree } = require('./worktree');
      const mapping = mkMapping(repo, { key: 'dirty' });
      const acquired = acquireWorktree(mapping, 'job_dirty');
      // Simulate blocked/interrupted worker: untracked + modified files.
      fs.writeFileSync(path.join(acquired.path, 'scratch.txt'), 'oops\n');
      fs.appendFileSync(path.join(acquired.path, 'README.md'), 'modified\n');
      const r = releaseWorktree(acquired.path, repo);
      assert(r.ok === true, `dirty worktree removed successfully (${r.detail})`);
      assert(!fs.existsSync(acquired.path), 'path gone after force-remove');
    });
  }

  console.log('\nTest: releaseWorktree falls back to rm -rf when source repo is missing');
  {
    const ccpRoot = mkTmpRoot('rel5');
    const repo = path.join(ccpRoot, 'repo');
    initRepoWithOrigin(repo);
    runWithFakeRoot(ccpRoot, () => {
      const { acquireWorktree, releaseWorktree } = require('./worktree');
      const mapping = mkMapping(repo, { key: 'missing-src' });
      const acquired = acquireWorktree(mapping, 'job_ms');
      // Simulate source repo being gone (e.g. ops reprovisioning) —
      // release should still clean the worktree directory on disk.
      fs.rmSync(repo, { recursive: true, force: true });
      const r = releaseWorktree(acquired.path, repo);
      assert(r.ok === true, `rm -rf fallback ok (${r.detail})`);
      assert(!fs.existsSync(acquired.path), 'worktree path removed by fallback');
    });
  }

  console.log(`\nworktree.test: ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

runTests();
