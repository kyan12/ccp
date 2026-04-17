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

import { resolveAgent, getAgent, listAgents, claudeCodeDriver, codexDriver } from './agents';

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

// ── codexDriver is registered ──
console.log('\nTest: codex driver is registered under all expected aliases');
{
  assert(listAgents().includes('codex'), 'codex is in listAgents()');
  assert(getAgent('codex') === codexDriver, 'getAgent(codex) returns codexDriver');
  assert(getAgent('openai-codex') === codexDriver, 'alias openai-codex resolves to codexDriver');
  assert(getAgent('codex-cli') === codexDriver, 'alias codex-cli resolves to codexDriver');
  assert(getAgent('CODEX') === codexDriver, 'codex lookup is case-insensitive');
  assert(codexDriver.name === 'codex', 'codexDriver.name = codex');
  assert(typeof codexDriver.label === 'string' && codexDriver.label.length > 0, 'codexDriver has a label');
}

// ── codexDriver.buildCommand shape ──
console.log('\nTest: codexDriver.buildCommand builds the expected headless shell');
{
  const cmd = codexDriver.buildCommand({
    promptPath: '/tmp/prompt.txt',
    repoPath: '/tmp/repo',
    packet: { job_id: 'x', ticket_id: null, repo: '/tmp/repo', goal: '', source: '', kind: '', label: '' },
    bin: '/usr/local/bin/codex',
  });
  assert(cmd.shellCmd.startsWith("cat '/tmp/prompt.txt' | "), 'pipes prompt on stdin');
  assert(cmd.shellCmd.includes("'/usr/local/bin/codex' exec"), 'uses `codex exec`');
  assert(cmd.shellCmd.includes('--color never'), 'disables ANSI color');
  assert(cmd.shellCmd.includes('--sandbox workspace-write'), 'uses workspace-write sandbox');
  assert(cmd.shellCmd.includes('--skip-git-repo-check'), 'skips git repo check (worker cwd varies)');
  assert(cmd.env === undefined || Object.keys(cmd.env).length === 0, 'no extra env for codex driver');
}

// ── codexDriver quotes shell-unsafe paths ──
console.log('\nTest: codexDriver.buildCommand shell-quotes paths with spaces');
{
  const cmd = codexDriver.buildCommand({
    promptPath: '/tmp/space dir/prompt.txt',
    repoPath: '/tmp/repo',
    packet: { job_id: 'x', ticket_id: null, repo: '/tmp/repo', goal: '', source: '', kind: '', label: '' },
    bin: '/opt/bin with space/codex',
  });
  assert(cmd.shellCmd.includes("'/tmp/space dir/prompt.txt'"), 'prompt path is quoted');
  assert(cmd.shellCmd.includes("'/opt/bin with space/codex'"), 'binary path is quoted');
}

// ── codexDriver.failurePatterns ──
console.log('\nTest: codexDriver.failurePatterns match known OpenAI error strings');
{
  const pats = codexDriver.failurePatterns.apiError;
  const sample = (s: string): boolean => pats.some((re) => re.test(s));
  assert(sample('APIError: 500 Internal Server Error'), 'matches OpenAI SDK 500 APIError');
  assert(sample('APIError: 503 Service Unavailable'), 'matches OpenAI SDK 503 APIError');
  assert(sample('openai: 502 Bad Gateway'), 'matches 502 Bad Gateway');
  assert(sample('ECONNRESET while streaming tokens'), 'matches ECONNRESET');
  assert(sample('EAI_AGAIN: temporary DNS failure'), 'matches EAI_AGAIN');
  assert(sample('openai is currently unavailable — retry shortly'), 'matches openai unavailable');
  assert(!sample('TypeError: x is not a function'), 'does NOT match user-code errors');
  assert(!sample('ENOENT: no such file or directory'), 'does NOT match missing-file errors');

  const rl = codexDriver.failurePatterns.rateLimit;
  const rlMatch = (s: string): RegExpMatchArray | null => {
    for (const re of rl) {
      const m = s.match(re);
      if (m) return m;
    }
    return null;
  };
  assert(!!rlMatch('rate_limit exceeded, reset 2pm'), 'matches rate_limit reset 2pm');
  assert(!!rlMatch('rate limit hit, try again in 30 seconds'), 'matches "try again in 30 seconds"');
  assert(!!rlMatch('insufficient_quota for this request'), 'matches insufficient_quota');
}

// ── codexDriver.preflight returns an AgentPreflight shape ──
console.log('\nTest: codexDriver.preflight returns a well-formed shape');
{
  const pf = codexDriver.preflight();
  assert(typeof pf.ok === 'boolean', 'ok is boolean');
  assert(typeof pf.bin === 'string', 'bin is string');
  assert(Array.isArray(pf.failures), 'failures is array');
  assert(typeof pf.commands === 'object' && pf.commands !== null, 'commands is object');
  assert('codex' in pf.commands, 'commands includes codex');
  if (!pf.bin) {
    assert(pf.ok === false, 'ok=false when codex is not installed');
    assert(pf.failures.some((f) => f.toLowerCase().includes('codex')), 'failure message mentions codex');
    assert(pf.failures.some((f) => f.includes('@openai/codex') || f.includes('npm')), 'failure message hints at install');
  }
}

// ── resolveAgent picks codex when repo.agent=codex ──
console.log('\nTest: resolveAgent routes to codex via repo.agent');
{
  withEnv('CCP_AGENT', undefined, () => {
    const r = resolveAgent(null, { agent: 'codex' });
    assert(r.driver === codexDriver, 'driver = codexDriver');
    assert(r.source === 'repo', 'source = repo');
    assert(r.fellBack === false, 'no fallback (agent is known)');
    assert(r.fellBackDueToOutage === false, 'no outage swap');
  });
}

// ── resolveAgent picks codex via packet override ──
console.log('\nTest: resolveAgent honors packet.agent=codex (Linear label path)');
{
  withEnv('CCP_AGENT', 'claude-code', () => {
    const r = resolveAgent({ agent: 'codex' }, { agent: 'claude-code' });
    assert(r.driver === codexDriver, 'driver = codexDriver');
    assert(r.source === 'packet', 'source = packet');
  });
}

// ── resolveAgent fallback: primary circuit open → swap ──
console.log('\nTest: resolveAgent swaps to repo.agentFallback when primary circuit open');
{
  withEnv('CCP_AGENT', undefined, () => {
    const checkCircuit = (name: string): boolean => name === 'claude-code';
    const r = resolveAgent(null, { agent: 'claude-code', agentFallback: 'codex' }, { checkCircuit });
    assert(r.driver === codexDriver, 'driver swapped to codex');
    assert(r.fellBackDueToOutage === true, 'fellBackDueToOutage = true');
    assert(r.primaryDriver === claudeCodeDriver, 'primaryDriver = claudeCodeDriver');
    assert(r.source === 'repo', 'source preserved from primary resolution');
  });
}

// ── resolveAgent fallback: primary closed → no swap ──
console.log('\nTest: resolveAgent does not swap when primary circuit is closed');
{
  withEnv('CCP_AGENT', undefined, () => {
    const checkCircuit = (_name: string): boolean => false;
    const r = resolveAgent(null, { agent: 'claude-code', agentFallback: 'codex' }, { checkCircuit });
    assert(r.driver === claudeCodeDriver, 'driver stays claude-code');
    assert(r.fellBackDueToOutage === false, 'no outage swap');
    assert(r.primaryDriver === undefined, 'primaryDriver unset when no swap');
  });
}

// ── resolveAgent fallback: no agentFallback set → no swap even during outage ──
console.log('\nTest: resolveAgent: missing agentFallback means no swap');
{
  withEnv('CCP_AGENT', undefined, () => {
    const checkCircuit = (_name: string): boolean => true;
    const r = resolveAgent(null, { agent: 'claude-code' }, { checkCircuit });
    assert(r.driver === claudeCodeDriver, 'driver stays claude-code (no fallback configured)');
    assert(r.fellBackDueToOutage === false, 'no outage swap');
  });
}

// ── resolveAgent fallback: packet override wins even during outage ──
console.log('\nTest: packet.agent is never swapped (manual override beats fallback)');
{
  withEnv('CCP_AGENT', undefined, () => {
    const checkCircuit = (_name: string): boolean => true;
    const r = resolveAgent({ agent: 'claude-code' }, { agent: 'claude-code', agentFallback: 'codex' }, { checkCircuit });
    assert(r.driver === claudeCodeDriver, 'packet override sticks');
    assert(r.fellBackDueToOutage === false, 'no swap when source=packet');
  });
}

// ── resolveAgent fallback: both circuits open → keep primary ──
console.log('\nTest: resolveAgent: when both circuits open, keep primary so probe cycle continues');
{
  withEnv('CCP_AGENT', undefined, () => {
    const origWarn = console.warn;
    const warnings: string[] = [];
    console.warn = (msg: string) => { warnings.push(String(msg)); };
    try {
      const checkCircuit = (_name: string): boolean => true; // both out
      const r = resolveAgent(null, { agent: 'claude-code', agentFallback: 'codex' }, { checkCircuit });
      assert(r.driver === claudeCodeDriver, 'driver stays primary (both out)');
      assert(r.fellBackDueToOutage === false, 'not marked as fallback swap');
      assert(warnings.some((w) => w.includes('open circuits')), 'warning logged when both circuits open');
    } finally {
      console.warn = origWarn;
    }
  });
}

// ── resolveAgent fallback: unknown fallback name → warn + keep primary ──
console.log('\nTest: resolveAgent: unknown repo.agentFallback warns and keeps primary');
{
  withEnv('CCP_AGENT', undefined, () => {
    const origWarn = console.warn;
    const warnings: string[] = [];
    console.warn = (msg: string) => { warnings.push(String(msg)); };
    try {
      const checkCircuit = (name: string): boolean => name === 'claude-code';
      const r = resolveAgent(null, { agent: 'claude-code', agentFallback: 'not-a-real-driver' }, { checkCircuit });
      assert(r.driver === claudeCodeDriver, 'driver stays primary when fallback unknown');
      assert(r.fellBackDueToOutage === false, 'no outage swap');
      assert(
        warnings.some((w) => w.includes('not-a-real-driver')),
        'warning mentions the unknown fallback name',
      );
    } finally {
      console.warn = origWarn;
    }
  });
}

// ── resolveAgent fallback: alias fallback pointing to same driver → no swap ──
console.log('\nTest: resolveAgent: alias fallback pointing to same driver is a no-op');
{
  withEnv('CCP_AGENT', undefined, () => {
    const checkCircuit = (_name: string): boolean => true;
    const r = resolveAgent(null, { agent: 'claude-code', agentFallback: 'claude' }, { checkCircuit });
    assert(r.driver === claudeCodeDriver, 'driver stays claude-code');
    assert(r.fellBackDueToOutage === false, 'no swap when fallback resolves to same driver');
  });
}

// ── resolveAgent fallback: no opts.checkCircuit → pure static resolution ──
console.log('\nTest: resolveAgent: omitting checkCircuit never triggers fallback');
{
  withEnv('CCP_AGENT', undefined, () => {
    const r = resolveAgent(null, { agent: 'claude-code', agentFallback: 'codex' });
    assert(r.driver === claudeCodeDriver, 'static resolution never swaps');
    assert(r.fellBackDueToOutage === false, 'no outage swap');
  });
}

console.log(`\nTotal: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
