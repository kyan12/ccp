/**
 * Tests for the per-repo memory loader (Phase 5a).
 *
 * We run every test against a fresh temp repo directory and a fake
 * repos config so mapping resolution is deterministic regardless of
 * what's in the real configs/repos.json on the host.
 */

import fs = require('fs');
import os = require('os');
import path = require('path');
import type { JobPacket } from '../types';

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

function mkTmpRepo(label: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `ccp-memory-${label}-`));
  return dir;
}

function writeReposConfig(cfgDir: string, mappings: unknown[]): void {
  fs.mkdirSync(cfgDir, { recursive: true });
  fs.writeFileSync(
    path.join(cfgDir, 'repos.json'),
    JSON.stringify({ mappings }, null, 2),
  );
}

/**
 * Each test sets CCP_ROOT before importing so repos.ts/config.ts pick
 * up our fake config. We blow away the require cache between tests so
 * the new CCP_ROOT takes effect — otherwise the first import's config
 * path would stick for the whole run.
 */
function runWithFakeRoot<T>(ccpRoot: string, fn: () => T): T {
  const prev = process.env.CCP_ROOT;
  process.env.CCP_ROOT = ccpRoot;
  // Drop every relative ./* module cached by prior tests. Coarse but
  // safe — these modules are cheap to re-parse.
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
  }
}

function makePacket(repoPath: string): JobPacket {
  return {
    job_id: 'test_1',
    ticket_id: 'TEST-1',
    repo: repoPath,
    goal: 'Do something',
    source: 'test',
    kind: 'task',
    label: 'test',
  };
}

// ── Test: no memory file configured or present → null ──
console.log('\nTest: no memory file returns null');
{
  const ccpRoot = mkTmpRepo('no-memory-root');
  const repoPath = mkTmpRepo('no-memory-repo');
  writeReposConfig(path.join(ccpRoot, 'configs'), [
    { key: 'test-repo', localPath: repoPath },
  ]);
  runWithFakeRoot(ccpRoot, () => {
    const { loadRepoMemory } = require('./memory');
    const result = loadRepoMemory(makePacket(repoPath));
    assert(result === null, 'returns null when no .ccp/memory.md exists');
  });
}

// ── Test: default .ccp/memory.md is picked up ──
console.log('\nTest: default .ccp/memory.md path');
{
  const ccpRoot = mkTmpRepo('default-root');
  const repoPath = mkTmpRepo('default-repo');
  writeReposConfig(path.join(ccpRoot, 'configs'), [
    { key: 'test-repo', localPath: repoPath },
  ]);
  const memDir = path.join(repoPath, '.ccp');
  fs.mkdirSync(memDir, { recursive: true });
  const memPath = path.join(memDir, 'memory.md');
  fs.writeFileSync(memPath, '# Project notes\n\nUse Volta, not nvm.');
  runWithFakeRoot(ccpRoot, () => {
    const { loadRepoMemory } = require('./memory');
    const result = loadRepoMemory(makePacket(repoPath));
    assert(result !== null, 'loads default .ccp/memory.md');
    assert(result.path === memPath, `resolves to ${memPath}`);
    assert(result.content.includes('Use Volta, not nvm.'), 'content is read');
    assert(result.truncated === false, 'not marked truncated');
  });
}

// ── Test: explicit mapping.memoryFile overrides default ──
console.log('\nTest: explicit memoryFile (relative) overrides default');
{
  const ccpRoot = mkTmpRepo('explicit-rel-root');
  const repoPath = mkTmpRepo('explicit-rel-repo');
  const customPath = path.join(repoPath, 'docs', 'ccp-memory.md');
  fs.mkdirSync(path.dirname(customPath), { recursive: true });
  fs.writeFileSync(customPath, 'CUSTOM MEMORY');
  // Default path should NOT be read.
  fs.mkdirSync(path.join(repoPath, '.ccp'), { recursive: true });
  fs.writeFileSync(path.join(repoPath, '.ccp', 'memory.md'), 'WRONG');
  writeReposConfig(path.join(ccpRoot, 'configs'), [
    { key: 'test-repo', localPath: repoPath, memoryFile: 'docs/ccp-memory.md' },
  ]);
  runWithFakeRoot(ccpRoot, () => {
    const { loadRepoMemory } = require('./memory');
    const result = loadRepoMemory(makePacket(repoPath));
    assert(result !== null, 'loads explicit relative memoryFile');
    assert(result.path === customPath, 'resolves relative path against repo root');
    assert(result.content === 'CUSTOM MEMORY', 'reads custom file, not default');
  });
}

// ── Test: absolute memoryFile path ──
console.log('\nTest: explicit memoryFile (absolute) works');
{
  const ccpRoot = mkTmpRepo('explicit-abs-root');
  const repoPath = mkTmpRepo('explicit-abs-repo');
  const absDir = mkTmpRepo('explicit-abs-memory');
  const absPath = path.join(absDir, 'my-memory.md');
  fs.writeFileSync(absPath, 'ABSOLUTE CONTENT');
  writeReposConfig(path.join(ccpRoot, 'configs'), [
    { key: 'test-repo', localPath: repoPath, memoryFile: absPath },
  ]);
  runWithFakeRoot(ccpRoot, () => {
    const { loadRepoMemory } = require('./memory');
    const result = loadRepoMemory(makePacket(repoPath));
    assert(result !== null, 'loads explicit absolute memoryFile');
    assert(result.path === absPath, 'returns the absolute path as-is');
    assert(result.content === 'ABSOLUTE CONTENT', 'reads absolute file');
  });
}

// ── Test: configured memoryFile that doesn't exist → null (not error) ──
console.log('\nTest: configured-but-missing memoryFile returns null');
{
  const ccpRoot = mkTmpRepo('missing-root');
  const repoPath = mkTmpRepo('missing-repo');
  writeReposConfig(path.join(ccpRoot, 'configs'), [
    { key: 'test-repo', localPath: repoPath, memoryFile: 'does-not-exist.md' },
  ]);
  runWithFakeRoot(ccpRoot, () => {
    const { loadRepoMemory } = require('./memory');
    const result = loadRepoMemory(makePacket(repoPath));
    assert(result === null, 'missing configured memory file does not throw');
  });
}

// ── Test: empty/whitespace memory file → null ──
console.log('\nTest: whitespace-only memory file returns null');
{
  const ccpRoot = mkTmpRepo('empty-root');
  const repoPath = mkTmpRepo('empty-repo');
  fs.mkdirSync(path.join(repoPath, '.ccp'), { recursive: true });
  fs.writeFileSync(path.join(repoPath, '.ccp', 'memory.md'), '   \n\t\n  ');
  writeReposConfig(path.join(ccpRoot, 'configs'), [
    { key: 'test-repo', localPath: repoPath },
  ]);
  runWithFakeRoot(ccpRoot, () => {
    const { loadRepoMemory } = require('./memory');
    const result = loadRepoMemory(makePacket(repoPath));
    assert(result === null, 'whitespace-only file treated as empty');
  });
}

// ── Test: truncation at 16KB ──
console.log('\nTest: oversized memory is truncated with a visible marker');
{
  const ccpRoot = mkTmpRepo('big-root');
  const repoPath = mkTmpRepo('big-repo');
  fs.mkdirSync(path.join(repoPath, '.ccp'), { recursive: true });
  // 20KB of ASCII 'A' — safely beyond the 16KB cap.
  const big = 'A'.repeat(20 * 1024);
  fs.writeFileSync(path.join(repoPath, '.ccp', 'memory.md'), big);
  writeReposConfig(path.join(ccpRoot, 'configs'), [
    { key: 'test-repo', localPath: repoPath },
  ]);
  runWithFakeRoot(ccpRoot, () => {
    const { loadRepoMemory, MAX_MEMORY_BYTES } = require('./memory');
    const result = loadRepoMemory(makePacket(repoPath));
    assert(result !== null, 'loads oversized file');
    assert(result.truncated === true, 'marks result.truncated=true');
    assert(
      result.content.includes('memory file truncated at 16KB'),
      'appends visible truncation marker',
    );
    // The returned content may exceed MAX_MEMORY_BYTES because of the
    // appended marker. What we care about is that the *original* payload
    // was clipped at MAX_MEMORY_BYTES.
    const payloadBytes = Buffer.byteLength(
      result.content.replace(/\n\n\[\.\.\. memory file truncated.*$/s, ''),
      'utf8',
    );
    assert(
      payloadBytes === MAX_MEMORY_BYTES,
      `payload clipped exactly at ${MAX_MEMORY_BYTES} bytes (got ${payloadBytes})`,
    );
  });
}

// ── Test: packet with no repo path → null (robustness guard) ──
console.log('\nTest: packet without repo path returns null');
{
  const ccpRoot = mkTmpRepo('norepo-root');
  writeReposConfig(path.join(ccpRoot, 'configs'), []);
  runWithFakeRoot(ccpRoot, () => {
    const { loadRepoMemory } = require('./memory');
    const packet: JobPacket = {
      job_id: 'test_1',
      ticket_id: 'TEST-1',
      repo: null,
      goal: 'x',
      source: 'test',
      kind: 'task',
      label: 'test',
    };
    const result = loadRepoMemory(packet);
    assert(result === null, 'missing packet.repo does not throw');
  });
}

// ── Test: resolveMemoryPath works independently of file presence ──
console.log('\nTest: resolveMemoryPath returns the path even when file is absent');
{
  const ccpRoot = mkTmpRepo('resolve-root');
  const repoPath = mkTmpRepo('resolve-repo');
  writeReposConfig(path.join(ccpRoot, 'configs'), [
    { key: 'test-repo', localPath: repoPath },
  ]);
  runWithFakeRoot(ccpRoot, () => {
    const { resolveMemoryPath } = require('./memory');
    const resolved = resolveMemoryPath(makePacket(repoPath));
    assert(
      resolved === path.resolve(repoPath, '.ccp', 'memory.md'),
      'returns default path even when file is missing',
    );
  });
}

console.log(`\nmemory.test: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
