/**
 * Tests for outage.ts — per-agent circuit breaker.
 *
 * Covers:
 *  - Legacy outage.json is migrated to outage-claude-code.json on first read.
 *  - isApiOutageLog(text, agent?) delegates to the right driver's patterns.
 *  - recordJobOutcome(wasApiFailure, agent) writes to the per-agent file.
 *  - getOutageStatus(agent) reads the per-agent file without cross-talk.
 *  - clearOutage(agent) resets only that agent.
 *  - Default agent remains 'claude-code' for backward compatibility.
 */

import fs = require('fs');
import os = require('os');
import path = require('path');

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

/**
 * Each test gets its own fresh CCP_ROOT so files from one test don't leak
 * into another. outage.ts captures CCP_ROOT at module-load time, so we
 * have to delete the cached require each test.
 */
function freshRoot(label: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `ccp-outage-${label}-`));
  fs.mkdirSync(path.join(dir, 'configs'), { recursive: true });
  return dir;
}

function withRoot<T>(root: string, fn: (o: typeof import('./outage')) => T): T {
  const prev = process.env.CCP_ROOT;
  process.env.CCP_ROOT = root;
  try {
    // Clear cached modules so ROOT is re-evaluated.
    delete require.cache[require.resolve('./outage')];
    delete require.cache[require.resolve('./agents')];
    delete require.cache[require.resolve('./agents/claude')];
    delete require.cache[require.resolve('./agents/codex')];
    const mod = require('./outage') as typeof import('./outage');
    return fn(mod);
  } finally {
    if (prev === undefined) delete process.env.CCP_ROOT;
    else process.env.CCP_ROOT = prev;
  }
}

// ── Legacy migration ──
console.log('\nTest: legacy outage.json migrates to outage-claude-code.json on first read');
{
  const root = freshRoot('legacy');
  const legacy = path.join(root, 'configs', 'outage.json');
  const migrated = path.join(root, 'configs', 'outage-claude-code.json');
  fs.writeFileSync(
    legacy,
    JSON.stringify({
      outage: true,
      consecutiveApiFailures: 4,
      lastFailureAt: '2024-01-01T00:00:00.000Z',
      outageSince: '2024-01-01T00:00:00.000Z',
      lastProbeAt: null,
      lastProbeResult: null,
      rateLimitResetAt: null,
      rateLimitReason: null,
    }),
  );
  withRoot(root, (mod) => {
    const status = mod.getOutageStatus('claude-code');
    assert(status.outage === true, 'outage flag migrated');
    assert(status.consecutiveApiFailures === 4, 'counter migrated');
    assert(fs.existsSync(migrated), 'new outage-claude-code.json created');
    const migratedJson = JSON.parse(fs.readFileSync(migrated, 'utf8')) as { agent: string; outage: boolean };
    assert(migratedJson.agent === 'claude-code', 'migrated file carries agent field');
    assert(migratedJson.outage === true, 'migrated contents match legacy');
    assert(fs.existsSync(legacy), 'legacy file left in place as tombstone (non-destructive rollback)');
  });
}

// ── Non-default agent ignores legacy ──
console.log('\nTest: non-default agent does NOT inherit legacy outage.json');
{
  const root = freshRoot('no-cross');
  const legacy = path.join(root, 'configs', 'outage.json');
  fs.writeFileSync(
    legacy,
    JSON.stringify({
      outage: true,
      consecutiveApiFailures: 9,
      lastFailureAt: null,
      outageSince: null,
      lastProbeAt: null,
      lastProbeResult: null,
      rateLimitResetAt: null,
      rateLimitReason: null,
    }),
  );
  withRoot(root, (mod) => {
    const status = mod.getOutageStatus('codex');
    assert(status.outage === false, 'codex starts clean despite claude legacy file');
    assert(status.consecutiveApiFailures === 0, 'codex counter is zero');
  });
}

// ── Per-agent isolation ──
console.log('\nTest: per-agent state files do not cross-contaminate');
{
  const root = freshRoot('per-agent');
  withRoot(root, (mod) => {
    // Trip claude-code circuit (threshold = 2).
    mod.recordJobOutcome(true, 'claude-code');
    mod.recordJobOutcome(true, 'claude-code');
    const claude = mod.getOutageStatus('claude-code');
    const codex = mod.getOutageStatus('codex');
    assert(claude.outage === true, 'claude-code went into outage after 2 failures');
    assert(codex.outage === false, 'codex circuit remains closed');
    assert(codex.consecutiveApiFailures === 0, 'codex counter untouched');

    // Separate state files on disk.
    assert(
      fs.existsSync(path.join(root, 'configs', 'outage-claude-code.json')),
      'outage-claude-code.json written',
    );
  });
}

// ── clearOutage only affects target agent ──
console.log('\nTest: clearOutage is scoped to the requested agent');
{
  const root = freshRoot('clear-scope');
  withRoot(root, (mod) => {
    mod.recordJobOutcome(true, 'claude-code');
    mod.recordJobOutcome(true, 'claude-code');
    mod.recordJobOutcome(true, 'codex');
    mod.recordJobOutcome(true, 'codex');

    mod.clearOutage('claude-code');
    assert(mod.getOutageStatus('claude-code').outage === false, 'claude-code cleared');
    assert(mod.getOutageStatus('codex').outage === true, 'codex still in outage');
  });
}

// ── Default agent is claude-code ──
console.log('\nTest: default agent parameter is claude-code');
{
  const root = freshRoot('default-agent');
  withRoot(root, (mod) => {
    mod.recordJobOutcome(true);
    mod.recordJobOutcome(true);
    // getOutageStatus() with no args should see the claude-code trip.
    assert(mod.getOutageStatus().outage === true, 'no-arg getOutageStatus reads claude-code state');
    assert(mod.getOutageStatus('claude-code').outage === true, 'explicit lookup agrees');
  });
}

// ── isApiOutageLog: agent-scoped pattern matching ──
console.log('\nTest: isApiOutageLog scopes patterns to the supplied agent');
{
  const root = freshRoot('log-scope');
  withRoot(root, (mod) => {
    // Claude-specific phrasing: 529 overloaded.
    const claudeText = 'API Error: 529 overloaded';
    // OpenAI-specific phrasing: APIError 500 from the SDK.
    const codexText = 'APIError: 500 Internal Server Error';

    assert(mod.isApiOutageLog(claudeText, 'claude-code') === true, 'claude log matches claude patterns');
    assert(mod.isApiOutageLog(codexText, 'codex') === true, 'codex log matches codex patterns');

    // Cross-checks: neither driver should see the other's error as "theirs"…
    // unless it's an ambiguous overlap like ECONNRESET (which is shared).
    // 529 is Anthropic-specific; OpenAI SDK 500 matches both because the
    // generic /APIError:\s*5\d\d\b/ covers the shape. That's fine — the
    // point of per-agent isolation is state-file keying, not regex purity.
    assert(mod.isApiOutageLog(claudeText, 'codex') === false, 'codex patterns do NOT catch 529 overloaded');
  });
}

// ── isApiOutageLog: no agent arg → any-driver match ──
console.log('\nTest: isApiOutageLog() without agent matches any registered driver');
{
  const root = freshRoot('log-any');
  withRoot(root, (mod) => {
    assert(mod.isApiOutageLog('APIError: 500 Internal Server Error') === true, 'catches codex-only pattern');
    assert(mod.isApiOutageLog('API Error: 529 overloaded') === true, 'catches claude-only pattern');
    assert(mod.isApiOutageLog('TypeError: unrelated user bug') === false, 'ignores unrelated errors');
  });
}

// ── getAllOutageStatuses returns one entry per unique driver ──
console.log('\nTest: getAllOutageStatuses returns each unique driver exactly once');
{
  const root = freshRoot('all-statuses');
  withRoot(root, (mod) => {
    const all = mod.getAllOutageStatuses();
    assert('claude-code' in all, 'includes claude-code');
    assert('codex' in all, 'includes codex');
    // Aliases (claude, openai-codex, codex-cli) should not appear because
    // they point to the same driver object.
    assert(!('claude' in all), 'alias claude is deduped');
    assert(!('openai-codex' in all), 'alias openai-codex is deduped');
    // Each entry has the expected state shape.
    for (const [name, st] of Object.entries(all)) {
      assert(typeof st.outage === 'boolean', `${name}: outage is boolean`);
      assert(st.agent === name, `${name}: agent field matches key`);
    }
  });
}

console.log(`\nTotal: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
