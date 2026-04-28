/**
 * Tests for the Phase 5c memory-compaction module.
 *
 * The agent subprocess is stubbed via an injected `runner` hook so the
 * suite never shells out to real Claude/Codex binaries. That keeps the
 * tests deterministic and fast, and lets us exercise every failure
 * mode (timeout, non-zero exit, empty stdout, oversized stdout,
 * agent-missing) without mocking spawnSync.
 *
 * Each scenario runs against a fresh temp repo + fresh CCP_ROOT so
 * cached module state from prior tests can't leak in.
 */

import fs = require('fs');
import os = require('os');
import path = require('path');
import type {
  JobPacket,
  MemoryCompactionConfig,
  RepoMapping,
} from '../types';

let passed = 0;
let failed = 0;

function assert(cond: boolean, msg: string): void {
  if (cond) {
    passed++;
    console.log(`  PASS: ${msg}`);
  } else {
    failed++;
    console.error(`  FAIL: ${msg}`);
  }
}

function mkTmpDir(label: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `ccp-compact-${label}-`));
}

function writeReposConfig(cfgDir: string, mappings: unknown[]): void {
  fs.mkdirSync(cfgDir, { recursive: true });
  fs.writeFileSync(
    path.join(cfgDir, 'repos.json'),
    JSON.stringify({ mappings }, null, 2),
  );
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
  }
}

function mkPacket(repoPath: string): JobPacket {
  return {
    job_id: 'compact_test_1',
    ticket_id: 'TEST-1',
    repo: repoPath,
    goal: 'test',
    source: 'test',
    kind: 'task',
    label: 'test',
  };
}

function mkMapping(repoPath: string, comp?: MemoryCompactionConfig): RepoMapping {
  return {
    key: 'test-repo',
    localPath: repoPath,
    memoryCompaction: comp,
  } as RepoMapping;
}

function writeMemory(repoPath: string, content: string): string {
  const dir = path.join(repoPath, '.ccp');
  fs.mkdirSync(dir, { recursive: true });
  const p = path.join(dir, 'memory.md');
  fs.writeFileSync(p, content);
  return p;
}

/** Stub agent driver used via require.cache swap so tests never hit spawnSync. */
function installStubAgent(stubName = 'claude-code'): void {
  const agentsModulePath = require.resolve('./agents');
  const stub = {
    AGENTS: {
      'claude-code': {
        name: stubName,
        label: 'Claude (stub)',
        buildCommand: () => ({ shellCmd: ':' }),
        preflight: () => ({
          ok: true,
          bin: '/fake/claude',
          failures: [],
          commands: { claude: '/fake/claude' },
        }),
        probe: () => ({ ok: true }),
        failurePatterns: { apiError: [], rateLimit: [] },
      },
    },
    listAgents: () => ['claude-code'],
    getAgent: (name: string) => {
      if (!name) return null;
      return stub.AGENTS[name as 'claude-code'] ?? null;
    },
    resolveAgent: () => ({
      driver: stub.AGENTS['claude-code'],
      source: 'default' as const,
      requested: null,
      fellBack: false,
      fellBackDueToOutage: false,
    }),
  };
  require.cache[agentsModulePath] = {
    id: agentsModulePath,
    filename: agentsModulePath,
    loaded: true,
    exports: stub,
  } as NodeJS.Module;
}

/** Stub agent whose preflight says the binary is missing. */
function installBrokenAgent(): void {
  const agentsModulePath = require.resolve('./agents');
  const stub = {
    AGENTS: {
      'claude-code': {
        name: 'claude-code',
        label: 'Claude (broken stub)',
        buildCommand: () => ({ shellCmd: ':' }),
        preflight: () => ({
          ok: false,
          bin: '',
          failures: ['claude not found on PATH'],
          commands: {},
        }),
        probe: () => ({ ok: false }),
        failurePatterns: { apiError: [], rateLimit: [] },
      },
    },
    listAgents: () => ['claude-code'],
    getAgent: (n: string) => stub.AGENTS[n as 'claude-code'] ?? null,
    resolveAgent: () => ({
      driver: stub.AGENTS['claude-code'],
      source: 'default' as const,
      requested: null,
      fellBack: false,
      fellBackDueToOutage: false,
    }),
  };
  require.cache[agentsModulePath] = {
    id: agentsModulePath,
    filename: agentsModulePath,
    loaded: true,
    exports: stub,
  } as NodeJS.Module;
}

// ── resolveCompactionConfig defaults ──
console.log('\nTest: resolveCompactionConfig fills in defaults');
{
  const ccpRoot = mkTmpDir('cfg-defaults');
  writeReposConfig(path.join(ccpRoot, 'configs'), []);
  runWithFakeRoot(ccpRoot, () => {
    const {
      resolveCompactionConfig,
      DEFAULT_COMPACTION_MAX_BYTES,
      DEFAULT_COMPACTION_TARGET_BYTES,
      DEFAULT_COMPACTION_TIMEOUT_SEC,
    } = require('./memory-compaction');
    const cfg = resolveCompactionConfig(undefined);
    assert(cfg.enabled === false, 'enabled defaults to false');
    assert(cfg.maxBytes === DEFAULT_COMPACTION_MAX_BYTES, 'maxBytes default = 16KB');
    assert(cfg.targetBytes === DEFAULT_COMPACTION_TARGET_BYTES, 'targetBytes default = 8KB');
    assert(cfg.timeoutSec === DEFAULT_COMPACTION_TIMEOUT_SEC, 'timeoutSec default = 300');
    assert(cfg.agent === null, 'agent override defaults to null');
    const cfg2 = resolveCompactionConfig({ enabled: true });
    assert(cfg2.enabled === true, 'enabled flag honored when true');
    const cfg3 = resolveCompactionConfig({
      enabled: true,
      maxBytes: 1000,
      targetBytes: 500,
      timeoutSec: 60,
      agent: 'codex',
    });
    assert(cfg3.maxBytes === 1000, 'explicit maxBytes overrides default');
    assert(cfg3.targetBytes === 500, 'explicit targetBytes overrides default');
    assert(cfg3.timeoutSec === 60, 'explicit timeoutSec overrides default');
    assert(cfg3.agent === 'codex', 'explicit agent override honored');
  });
}

// ── targetBytes clamped below maxBytes ──
console.log('\nTest: resolveCompactionConfig clamps target below max');
{
  const ccpRoot = mkTmpDir('cfg-clamp');
  writeReposConfig(path.join(ccpRoot, 'configs'), []);
  runWithFakeRoot(ccpRoot, () => {
    const { resolveCompactionConfig } = require('./memory-compaction');
    const cfg = resolveCompactionConfig({
      enabled: true,
      maxBytes: 5000,
      targetBytes: 9999,
    });
    assert(cfg.targetBytes < cfg.maxBytes, 'target clamped below max even when config sets target > max');
    assert(cfg.targetBytes >= 1024, 'target not clamped below floor of 1KB');
  });
}

// ── shouldCompact: disabled → skip ──
console.log('\nTest: shouldCompact returns false when disabled');
{
  const ccpRoot = mkTmpDir('gate-disabled-root');
  const repoPath = mkTmpDir('gate-disabled-repo');
  writeReposConfig(path.join(ccpRoot, 'configs'), [
    { key: 'test-repo', localPath: repoPath },
  ]);
  writeMemory(repoPath, 'x'.repeat(32 * 1024));
  runWithFakeRoot(ccpRoot, () => {
    const {
      shouldCompact,
      resolveCompactionConfig,
    } = require('./memory-compaction');
    const cfg = resolveCompactionConfig({ enabled: false });
    const decision = shouldCompact(mkPacket(repoPath), cfg);
    assert(decision.shouldCompact === false, 'disabled config skips');
    assert(/enabled is false/i.test(decision.reason), 'reason mentions enabled=false');
  });
}

// ── shouldCompact: under threshold → skip ──
console.log('\nTest: shouldCompact skips when file under maxBytes');
{
  const ccpRoot = mkTmpDir('gate-small-root');
  const repoPath = mkTmpDir('gate-small-repo');
  writeReposConfig(path.join(ccpRoot, 'configs'), [
    { key: 'test-repo', localPath: repoPath },
  ]);
  writeMemory(repoPath, 'small contents under cap');
  runWithFakeRoot(ccpRoot, () => {
    const {
      shouldCompact,
      resolveCompactionConfig,
    } = require('./memory-compaction');
    const cfg = resolveCompactionConfig({ enabled: true, maxBytes: 1024, targetBytes: 512 });
    const decision = shouldCompact(mkPacket(repoPath), cfg);
    assert(decision.shouldCompact === false, 'small file skipped');
    assert(/≤ maxBytes/.test(decision.reason), 'reason explains size threshold');
  });
}

// ── shouldCompact: missing file → skip ──
console.log('\nTest: shouldCompact skips when memory file missing');
{
  const ccpRoot = mkTmpDir('gate-missing-root');
  const repoPath = mkTmpDir('gate-missing-repo');
  writeReposConfig(path.join(ccpRoot, 'configs'), [
    { key: 'test-repo', localPath: repoPath },
  ]);
  // No memory file written.
  runWithFakeRoot(ccpRoot, () => {
    const {
      shouldCompact,
      resolveCompactionConfig,
    } = require('./memory-compaction');
    const cfg = resolveCompactionConfig({ enabled: true });
    const decision = shouldCompact(mkPacket(repoPath), cfg);
    assert(decision.shouldCompact === false, 'missing file skipped');
    assert(/missing or empty/.test(decision.reason), 'reason mentions missing file');
  });
}

// ── shouldCompact: over threshold → true ──
console.log('\nTest: shouldCompact triggers when file exceeds maxBytes');
{
  const ccpRoot = mkTmpDir('gate-big-root');
  const repoPath = mkTmpDir('gate-big-repo');
  writeReposConfig(path.join(ccpRoot, 'configs'), [
    { key: 'test-repo', localPath: repoPath },
  ]);
  writeMemory(repoPath, 'x'.repeat(20 * 1024));
  runWithFakeRoot(ccpRoot, () => {
    const {
      shouldCompact,
      resolveCompactionConfig,
    } = require('./memory-compaction');
    const cfg = resolveCompactionConfig({ enabled: true, maxBytes: 16 * 1024, targetBytes: 8 * 1024 });
    const decision = shouldCompact(mkPacket(repoPath), cfg);
    assert(decision.shouldCompact === true, 'oversized file triggers compaction');
    assert(decision.sizeBytes === 20 * 1024, 'size reported accurately');
    assert(/> maxBytes/.test(decision.reason), 'reason explains size threshold');
  });
}

// ── buildCompactionPrompt shape ──
console.log('\nTest: buildCompactionPrompt embeds the original and target size');
{
  const ccpRoot = mkTmpDir('prompt-shape');
  writeReposConfig(path.join(ccpRoot, 'configs'), []);
  runWithFakeRoot(ccpRoot, () => {
    const { buildCompactionPrompt } = require('./memory-compaction');
    const prompt = buildCompactionPrompt('# Original memory\n\n- fact A', 4096);
    assert(prompt.includes('# Original memory'), 'prompt embeds original content');
    assert(prompt.includes('4096 bytes'), 'prompt mentions target byte budget');
    assert(
      prompt.includes('--- BEGIN CURRENT MEMORY FILE ---'),
      'prompt wraps original in begin marker',
    );
    assert(
      prompt.includes('--- END CURRENT MEMORY FILE ---'),
      'prompt wraps original in end marker',
    );
  });
}

// ── compactionArgsFor per agent ──
console.log('\nTest: compactionArgsFor emits agent-appropriate flags');
{
  const ccpRoot = mkTmpDir('args-shape');
  writeReposConfig(path.join(ccpRoot, 'configs'), []);
  runWithFakeRoot(ccpRoot, () => {
    const { compactionArgsFor } = require('./memory-compaction');
    const claudeArgs = compactionArgsFor('claude-code');
    assert(claudeArgs.includes('--print'), 'claude-code uses --print for one-shot');
    assert(claudeArgs.includes('bypassPermissions'), 'claude-code bypasses permissions for compaction');
    const codexArgs = compactionArgsFor('codex');
    assert(codexArgs[0] === 'exec', 'codex uses exec subcommand');
    assert(codexArgs.includes('--skip-git-repo-check'), 'codex skips git-repo check');
    assert(codexArgs.includes('read-only'), 'codex compaction runs read-only sandbox');
    // Regression: codex exec treats any positional arg as the literal
    // prompt text. If we append `-` (or anything else) codex ignores the
    // stdin prompt and replies to "-", producing short nonsense that
    // would pass our size check and silently corrupt the memory file.
    assert(
      !codexArgs.some((a: string) => !a.startsWith('-') && a !== 'exec' && a !== 'never' && a !== 'read-only'),
      'codex args must not contain a positional prompt arg (would shadow stdin)',
    );
    assert(!codexArgs.includes('-'), "codex args must not include bare '-' (treated as literal prompt)");
    const devinArgs = compactionArgsFor('devin');
    assert(devinArgs[0] === 'terminal', 'devin compaction uses terminal subcommand');
    assert(devinArgs[1] === 'run', 'devin compaction uses non-interactive terminal run shape');
    assert(!devinArgs.includes('-'), "devin args must not include bare '-' (prompt is provided on stdin)");
    const unknown = compactionArgsFor('some-future-agent');
    assert(unknown.includes('--print'), 'unknown agent falls back to --print (claude-style)');
  });
}

// ── compactMemory happy path ──
console.log('\nTest: compactMemory rewrites the file and archives the original');
{
  const ccpRoot = mkTmpDir('happy-root');
  const repoPath = mkTmpDir('happy-repo');
  writeReposConfig(path.join(ccpRoot, 'configs'), [
    { key: 'test-repo', localPath: repoPath },
  ]);
  const original = 'x'.repeat(20 * 1024);
  const memPath = writeMemory(repoPath, original);
  runWithFakeRoot(ccpRoot, () => {
    installStubAgent();
    const { compactMemory, resolveCompactionConfig } = require('./memory-compaction');
    const cfg = resolveCompactionConfig({ enabled: true, maxBytes: 16 * 1024, targetBytes: 4 * 1024 });
    const compacted = '# Compacted\n- fact A\n- fact B\n';
    const outcome = compactMemory({
      packet: mkPacket(repoPath),
      repo: mkMapping(repoPath, { enabled: true, maxBytes: 16 * 1024, targetBytes: 4 * 1024 }),
      config: cfg,
      runner: () => ({ stdout: compacted, stderr: '', exitCode: 0, timedOut: false }),
    });
    assert(outcome.ok === true, 'happy path returns ok=true');
    assert(outcome.status === 'compacted', 'status is compacted');
    assert(outcome.originalBytes === 20 * 1024, 'originalBytes matches input');
    assert(outcome.compactedBytes < outcome.originalBytes, 'compactedBytes < originalBytes');
    const onDisk = fs.readFileSync(memPath, 'utf8');
    assert(onDisk === compacted.trim(), 'memory file overwritten with compacted content');
    assert(
      outcome.archivePath !== null && fs.existsSync(outcome.archivePath),
      'archive file created',
    );
    const archived = fs.readFileSync(outcome.archivePath!, 'utf8');
    assert(archived === original, 'archive contains pre-compaction content');
    assert(outcome.agent === 'claude-code', 'outcome records agent name');
  });
}

// ── compactMemory skipped when under threshold ──
console.log('\nTest: compactMemory short-circuits when file is already small enough');
{
  const ccpRoot = mkTmpDir('skip-small-root');
  const repoPath = mkTmpDir('skip-small-repo');
  writeReposConfig(path.join(ccpRoot, 'configs'), [
    { key: 'test-repo', localPath: repoPath },
  ]);
  const original = 'small';
  const memPath = writeMemory(repoPath, original);
  runWithFakeRoot(ccpRoot, () => {
    installStubAgent();
    const { compactMemory, resolveCompactionConfig } = require('./memory-compaction');
    const cfg = resolveCompactionConfig({ enabled: true, maxBytes: 1024 });
    let runnerCalls = 0;
    const outcome = compactMemory({
      packet: mkPacket(repoPath),
      repo: mkMapping(repoPath),
      config: cfg,
      runner: () => {
        runnerCalls++;
        return { stdout: 'should-not-be-used', stderr: '', exitCode: 0, timedOut: false };
      },
    });
    assert(outcome.ok === false, 'skipped → ok=false');
    assert(outcome.status === 'skipped', 'status === skipped');
    assert(runnerCalls === 0, 'runner never invoked for under-threshold file');
    assert(fs.readFileSync(memPath, 'utf8') === original, 'memory file untouched');
  });
}

// ── compactMemory agent-missing ──
console.log('\nTest: compactMemory bails when preflight fails');
{
  const ccpRoot = mkTmpDir('agent-missing-root');
  const repoPath = mkTmpDir('agent-missing-repo');
  writeReposConfig(path.join(ccpRoot, 'configs'), [
    { key: 'test-repo', localPath: repoPath },
  ]);
  const original = 'x'.repeat(20 * 1024);
  const memPath = writeMemory(repoPath, original);
  runWithFakeRoot(ccpRoot, () => {
    installBrokenAgent();
    const { compactMemory, resolveCompactionConfig } = require('./memory-compaction');
    const cfg = resolveCompactionConfig({ enabled: true, maxBytes: 16 * 1024 });
    let runnerCalls = 0;
    const outcome = compactMemory({
      packet: mkPacket(repoPath),
      repo: mkMapping(repoPath),
      config: cfg,
      runner: () => {
        runnerCalls++;
        return { stdout: '', stderr: '', exitCode: 0, timedOut: false };
      },
    });
    assert(outcome.ok === false, 'agent-missing → ok=false');
    assert(outcome.status === 'agent-missing', 'status === agent-missing');
    assert(runnerCalls === 0, 'runner never invoked when preflight fails');
    assert(fs.readFileSync(memPath, 'utf8') === original, 'memory file untouched on preflight failure');
  });
}

// ── compactMemory agent timeout ──
console.log('\nTest: compactMemory detects subprocess timeout');
{
  const ccpRoot = mkTmpDir('timeout-root');
  const repoPath = mkTmpDir('timeout-repo');
  writeReposConfig(path.join(ccpRoot, 'configs'), [
    { key: 'test-repo', localPath: repoPath },
  ]);
  const original = 'x'.repeat(20 * 1024);
  const memPath = writeMemory(repoPath, original);
  runWithFakeRoot(ccpRoot, () => {
    installStubAgent();
    const { compactMemory, resolveCompactionConfig } = require('./memory-compaction');
    const cfg = resolveCompactionConfig({ enabled: true, maxBytes: 16 * 1024 });
    const outcome = compactMemory({
      packet: mkPacket(repoPath),
      repo: mkMapping(repoPath),
      config: cfg,
      runner: () => ({ stdout: '', stderr: 'killed', exitCode: null, timedOut: true }),
    });
    assert(outcome.ok === false, 'timeout → ok=false');
    assert(outcome.status === 'agent-timeout', 'status === agent-timeout');
    assert(fs.readFileSync(memPath, 'utf8') === original, 'memory file untouched on timeout');
    assert(
      outcome.archivePath !== null && fs.existsSync(outcome.archivePath),
      'archive still written (recoverable on crash)',
    );
  });
}

// ── compactMemory agent non-zero exit ──
console.log('\nTest: compactMemory handles non-zero exit');
{
  const ccpRoot = mkTmpDir('exit-root');
  const repoPath = mkTmpDir('exit-repo');
  writeReposConfig(path.join(ccpRoot, 'configs'), [
    { key: 'test-repo', localPath: repoPath },
  ]);
  const original = 'x'.repeat(20 * 1024);
  const memPath = writeMemory(repoPath, original);
  runWithFakeRoot(ccpRoot, () => {
    installStubAgent();
    const { compactMemory, resolveCompactionConfig } = require('./memory-compaction');
    const cfg = resolveCompactionConfig({ enabled: true, maxBytes: 16 * 1024 });
    const outcome = compactMemory({
      packet: mkPacket(repoPath),
      repo: mkMapping(repoPath),
      config: cfg,
      runner: () => ({ stdout: 'partial output', stderr: 'boom', exitCode: 2, timedOut: false }),
    });
    assert(outcome.ok === false, 'non-zero exit → ok=false');
    assert(outcome.status === 'agent-failed', 'status === agent-failed');
    assert(fs.readFileSync(memPath, 'utf8') === original, 'memory file untouched on exit!=0');
  });
}

// ── compactMemory empty output ──
console.log('\nTest: compactMemory rejects empty agent output');
{
  const ccpRoot = mkTmpDir('empty-root');
  const repoPath = mkTmpDir('empty-repo');
  writeReposConfig(path.join(ccpRoot, 'configs'), [
    { key: 'test-repo', localPath: repoPath },
  ]);
  const original = 'x'.repeat(20 * 1024);
  const memPath = writeMemory(repoPath, original);
  runWithFakeRoot(ccpRoot, () => {
    installStubAgent();
    const { compactMemory, resolveCompactionConfig } = require('./memory-compaction');
    const cfg = resolveCompactionConfig({ enabled: true, maxBytes: 16 * 1024 });
    const outcome = compactMemory({
      packet: mkPacket(repoPath),
      repo: mkMapping(repoPath),
      config: cfg,
      runner: () => ({ stdout: '   \n  \n', stderr: '', exitCode: 0, timedOut: false }),
    });
    assert(outcome.ok === false, 'empty output → ok=false');
    assert(outcome.status === 'empty-output', 'status === empty-output');
    assert(fs.readFileSync(memPath, 'utf8') === original, 'memory file untouched on empty output');
  });
}

// ── compactMemory oversized output ──
console.log('\nTest: compactMemory rejects output >= original size');
{
  const ccpRoot = mkTmpDir('over-root');
  const repoPath = mkTmpDir('over-repo');
  writeReposConfig(path.join(ccpRoot, 'configs'), [
    { key: 'test-repo', localPath: repoPath },
  ]);
  const original = 'x'.repeat(20 * 1024);
  const memPath = writeMemory(repoPath, original);
  runWithFakeRoot(ccpRoot, () => {
    installStubAgent();
    const { compactMemory, resolveCompactionConfig } = require('./memory-compaction');
    const cfg = resolveCompactionConfig({ enabled: true, maxBytes: 16 * 1024 });
    // Agent produces a LARGER output than the original (pathological).
    const outcome = compactMemory({
      packet: mkPacket(repoPath),
      repo: mkMapping(repoPath),
      config: cfg,
      runner: () => ({
        stdout: 'y'.repeat(25 * 1024),
        stderr: '',
        exitCode: 0,
        timedOut: false,
      }),
    });
    assert(outcome.ok === false, 'oversized output → ok=false');
    assert(outcome.status === 'oversized-output', 'status === oversized-output');
    assert(fs.readFileSync(memPath, 'utf8') === original, 'memory file untouched on oversized output');
  });
}

// ── compactMemory: archive is written before rename ──
console.log('\nTest: archive file persists even when compaction is rejected post-archive');
{
  const ccpRoot = mkTmpDir('archive-persist-root');
  const repoPath = mkTmpDir('archive-persist-repo');
  writeReposConfig(path.join(ccpRoot, 'configs'), [
    { key: 'test-repo', localPath: repoPath },
  ]);
  const original = 'x'.repeat(20 * 1024);
  writeMemory(repoPath, original);
  runWithFakeRoot(ccpRoot, () => {
    installStubAgent();
    const { compactMemory, resolveCompactionConfig } = require('./memory-compaction');
    const cfg = resolveCompactionConfig({ enabled: true, maxBytes: 16 * 1024 });
    const outcome = compactMemory({
      packet: mkPacket(repoPath),
      repo: mkMapping(repoPath),
      config: cfg,
      runner: () => ({ stdout: '', stderr: '', exitCode: 0, timedOut: false }),
    });
    assert(outcome.status === 'empty-output', 'scenario produces empty-output');
    assert(
      outcome.archivePath !== null && fs.existsSync(outcome.archivePath),
      'archive file exists despite rejected compaction',
    );
    const archiveDir = path.join(repoPath, '.ccp', 'memory.archive');
    const entries = fs.readdirSync(archiveDir);
    assert(entries.length === 1, 'exactly one archive entry for this run');
  });
}

// ── Integration via compactMemory default config path ──
console.log('\nTest: compactMemory reads config from repo mapping when not overridden');
{
  const ccpRoot = mkTmpDir('default-cfg-root');
  const repoPath = mkTmpDir('default-cfg-repo');
  writeReposConfig(path.join(ccpRoot, 'configs'), [
    {
      key: 'test-repo',
      localPath: repoPath,
      memoryCompaction: {
        enabled: true,
        maxBytes: 16 * 1024,
        targetBytes: 4 * 1024,
      },
    },
  ]);
  const original = 'x'.repeat(20 * 1024);
  writeMemory(repoPath, original);
  runWithFakeRoot(ccpRoot, () => {
    installStubAgent();
    const { compactMemory } = require('./memory-compaction');
    // No `config` override — pulled from the repo mapping.
    const outcome = compactMemory({
      packet: mkPacket(repoPath),
      runner: () => ({ stdout: '# compacted', stderr: '', exitCode: 0, timedOut: false }),
    });
    assert(outcome.status === 'compacted', 'picks up config from repo mapping');
  });
}

// ── Summary ──
console.log(`\nmemory-compaction.test: ${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
