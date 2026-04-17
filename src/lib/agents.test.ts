/**
 * Tests for the agent registry + resolver (src/lib/agents).
 *
 * Covers:
 *  - resolveAgent precedence: packet > repo > env > default
 *  - alias handling (claude → claude-code)
 *  - unknown name → graceful fallback with `fellBack=true`
 *  - claudeCodeDriver.buildCommand returns the exact pre-refactor shell shape
 *  - claudeCodeDriver.failurePatterns match the strings outage.ts flagged before
 */

import { resolveAgent, getAgent, listAgents, claudeCodeDriver } from './agents';

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

function withEnv<T>(key: string, value: string | undefined, fn: () => T): T {
  const prev = process.env[key];
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
  try {
    return fn();
  } finally {
    if (prev === undefined) delete process.env[key];
    else process.env[key] = prev;
  }
}

// ── listAgents / getAgent ──
console.log('\nTest: registry lists known agents');
{
  const names = listAgents();
  assert(names.includes('claude-code'), 'claude-code is registered');
  assert(!names.includes('claude'), 'alias "claude" is deduped from listAgents()');
  assert(getAgent('claude-code') === claudeCodeDriver, 'getAgent(claude-code) returns the driver');
  assert(getAgent('claude') === claudeCodeDriver, 'alias "claude" resolves to claude-code');
  assert(getAgent('CLAUDE-CODE') === claudeCodeDriver, 'getAgent is case-insensitive');
  assert(getAgent('  claude-code  ') === claudeCodeDriver, 'getAgent trims whitespace');
  assert(getAgent('nonexistent') === null, 'unknown agent returns null');
  assert(getAgent('') === null, 'empty string returns null');
  assert(getAgent(null) === null, 'null returns null');
  assert(getAgent(undefined) === null, 'undefined returns null');
}

// ── resolveAgent default ──
console.log('\nTest: resolveAgent falls back to claude-code when nothing is set');
{
  withEnv('CCP_AGENT', undefined, () => {
    const r = resolveAgent(null, null);
    assert(r.driver === claudeCodeDriver, 'driver = claude-code');
    assert(r.source === 'default', 'source = default');
    assert(r.requested === null, 'requested = null');
    assert(r.fellBack === false, 'fellBack = false (nothing was requested)');
  });
}

// ── resolveAgent: env precedence ──
console.log('\nTest: resolveAgent honors CCP_AGENT env when packet+repo unset');
{
  withEnv('CCP_AGENT', 'claude-code', () => {
    const r = resolveAgent(null, null);
    assert(r.source === 'env', 'source = env');
    assert(r.driver === claudeCodeDriver, 'driver = claude-code');
    assert(r.requested === 'claude-code', 'requested echoes env value');
  });
}

// ── resolveAgent: repo overrides env ──
console.log('\nTest: resolveAgent: repo.agent overrides CCP_AGENT');
{
  withEnv('CCP_AGENT', 'claude-code', () => {
    const r = resolveAgent(null, { agent: 'claude' });
    assert(r.source === 'repo', 'source = repo');
    assert(r.driver === claudeCodeDriver, 'driver = claude-code (via alias)');
    assert(r.requested === 'claude', 'requested echoes repo value');
  });
}

// ── resolveAgent: packet overrides repo + env ──
console.log('\nTest: resolveAgent: packet.agent is highest precedence');
{
  withEnv('CCP_AGENT', 'claude-code', () => {
    const r = resolveAgent({ agent: 'claude' }, { agent: 'claude-code' });
    assert(r.source === 'packet', 'source = packet');
    assert(r.requested === 'claude', 'requested = packet value');
  });
}

// ── resolveAgent: unknown name → graceful fallback ──
console.log('\nTest: resolveAgent: unknown agent name falls back to claude-code with fellBack=true');
{
  const origWarn = console.warn;
  const warnings: string[] = [];
  console.warn = (msg: string) => { warnings.push(String(msg)); };
  try {
    withEnv('CCP_AGENT', undefined, () => {
      const r = resolveAgent({ agent: 'codex-v9' }, null);
      assert(r.driver === claudeCodeDriver, 'driver still claude-code');
      assert(r.fellBack === true, 'fellBack = true');
      assert(r.requested === 'codex-v9', 'requested echoes unknown name');
      assert(r.source === 'default', 'source = default after fall-back');
      assert(warnings.some((w) => w.includes('codex-v9')), 'warning was logged');
    });
  } finally {
    console.warn = origWarn;
  }
}

// ── resolveAgent: env ignored when empty/whitespace ──
console.log('\nTest: resolveAgent: empty CCP_AGENT is ignored');
{
  withEnv('CCP_AGENT', '', () => {
    const r = resolveAgent(null, null);
    assert(r.source === 'default', 'source = default when env is empty');
    assert(r.requested === null, 'requested = null');
  });
  withEnv('CCP_AGENT', '   ', () => {
    const r = resolveAgent(null, null);
    assert(r.source === 'default', 'source = default when env is whitespace');
  });
}

// ── claudeCodeDriver.buildCommand shape ──
console.log('\nTest: claudeCodeDriver.buildCommand builds the pre-refactor shell command');
{
  const cmd = claudeCodeDriver.buildCommand({
    promptPath: '/tmp/prompt.txt',
    repoPath: '/tmp/repo',
    packet: { job_id: 'x', ticket_id: null, repo: '/tmp/repo', goal: '', source: '', kind: '', label: '' },
    bin: '/usr/local/bin/claude',
  });
  assert(
    cmd.shellCmd === "cat '/tmp/prompt.txt' | '/usr/local/bin/claude' --print --permission-mode bypassPermissions",
    `shellCmd has expected shape: ${cmd.shellCmd}`,
  );
  assert(cmd.env === undefined || Object.keys(cmd.env).length === 0, 'no extra env for claude driver');
}

// ── claudeCodeDriver.buildCommand quotes paths with spaces ──
console.log('\nTest: claudeCodeDriver.buildCommand shell-quotes paths with special chars');
{
  const cmd = claudeCodeDriver.buildCommand({
    promptPath: "/tmp/space dir/prompt.txt",
    repoPath: '/tmp/repo',
    packet: { job_id: 'x', ticket_id: null, repo: '/tmp/repo', goal: '', source: '', kind: '', label: '' },
    bin: '/opt/bin with space/claude',
  });
  assert(cmd.shellCmd.includes("'/tmp/space dir/prompt.txt'"), 'prompt path is quoted');
  assert(cmd.shellCmd.includes("'/opt/bin with space/claude'"), 'binary path is quoted');
}

// ── claudeCodeDriver.failurePatterns cover the regexes outage.ts used pre-refactor ──
console.log('\nTest: claudeCodeDriver.failurePatterns match known claude outage strings');
{
  const pats = claudeCodeDriver.failurePatterns.apiError;
  const sample = (s: string): boolean => pats.some((re) => re.test(s));
  assert(sample('API Error: 529 overloaded'), 'matches "API Error: 529"');
  assert(sample('API Error: 503 service unavailable'), 'matches "API Error: 503"');
  assert(sample('overloaded_error: too many requests'), 'matches overloaded_error');
  assert(sample('ECONNRESET while reading response'), 'matches ECONNRESET');
  assert(sample('anthropic server is unavailable right now'), 'matches anthropic unavailable');
  assert(!sample('TypeError: cannot read property of undefined'), 'does NOT match user-code errors');

  const rl = claudeCodeDriver.failurePatterns.rateLimit;
  const rlMatch = (s: string): RegExpMatchArray | null => {
    for (const re of rl) {
      const m = s.match(re);
      if (m) return m;
    }
    return null;
  };
  const m = rlMatch("You've hit your limit. Resets 2pm (America/New_York)");
  assert(!!m, 'matches "hit your limit, resets 2pm"');
  assert(!!m && m[1].toLowerCase().includes('2pm'), 'captures the reset time');
}

// ── claudeCodeDriver.preflight returns an AgentPreflight shape (runs actual commandExists) ──
console.log('\nTest: claudeCodeDriver.preflight returns a well-formed shape');
{
  const pf = claudeCodeDriver.preflight();
  assert(typeof pf.ok === 'boolean', 'ok is boolean');
  assert(typeof pf.bin === 'string', 'bin is string');
  assert(Array.isArray(pf.failures), 'failures is array');
  assert(typeof pf.commands === 'object' && pf.commands !== null, 'commands is object');
  assert('claude' in pf.commands && 'claude_opus' in pf.commands, 'commands includes claude + claude_opus');
  // On any machine without claude installed we expect ok=false, failures populated.
  if (!pf.bin) {
    assert(pf.ok === false, 'ok=false when neither binary exists');
    assert(pf.failures.length > 0, 'failures includes missing-binary message');
  }
}

console.log(`\nTotal: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
