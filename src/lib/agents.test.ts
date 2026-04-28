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

import { resolveAgent, getAgent, listAgents, claudeCodeDriver, codexDriver, devinDriver, parseClaudeUsage, parseCodexUsage } from './agents';

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

// ── devinDriver is registered but inactive unless selected ──
console.log('\nTest: devin driver is registered under all expected aliases');
{
  assert(listAgents().includes('devin'), 'devin is in listAgents()');
  assert(getAgent('devin') === devinDriver, 'getAgent(devin) returns devinDriver');
  assert(getAgent('devin-ai') === devinDriver, 'alias devin-ai resolves to devinDriver');
  assert(getAgent('cognition-devin') === devinDriver, 'alias cognition-devin resolves to devinDriver');
  assert(getAgent('DEVIN') === devinDriver, 'devin lookup is case-insensitive');
  assert(devinDriver.name === 'devin', 'devinDriver.name = devin');
  assert(typeof devinDriver.label === 'string' && devinDriver.label.length > 0, 'devinDriver has a label');
}

// ── devinDriver.buildCommand shape ──
console.log('\nTest: devinDriver.buildCommand builds the configurable terminal bridge shell');
{
  withEnv('CCP_DEVIN_COMMAND', undefined, () => {
    const cmd = devinDriver.buildCommand({
      promptPath: '/tmp/prompt.txt',
      repoPath: '/tmp/repo',
      packet: { job_id: 'x', ticket_id: null, repo: '/tmp/repo', goal: '', source: '', kind: '', label: '' },
      bin: '/usr/local/bin/devin',
    });
    assert(cmd.shellCmd.startsWith("cat '/tmp/prompt.txt' | "), 'pipes prompt on stdin');
    assert(cmd.shellCmd.includes("'/usr/local/bin/devin'"), 'uses resolved devin binary');
    assert(cmd.shellCmd.includes('terminal'), 'default command targets Devin terminal mode');
    assert(cmd.env === undefined || Object.keys(cmd.env).length === 0, 'no extra env for devin driver');
  });
}

console.log('\nTest: devinDriver.buildCommand honors CCP_DEVIN_COMMAND template without activating it globally');
{
  withEnv('CCP_DEVIN_COMMAND', "devin terminal run --cwd {repoPath} --prompt-file {promptPath}", () => {
    const cmd = devinDriver.buildCommand({
      promptPath: '/tmp/space dir/prompt.txt',
      repoPath: '/tmp/repo with space',
      packet: { job_id: 'x', ticket_id: null, repo: '/tmp/repo with space', goal: '', source: '', kind: '', label: '' },
      bin: '/opt/bin with space/devin',
    });
    assert(cmd.shellCmd.includes("'/tmp/space dir/prompt.txt'"), 'template prompt path is quoted');
    assert(cmd.shellCmd.includes("'/tmp/repo with space'"), 'template repo path is quoted');
    assert(cmd.shellCmd.includes("'/opt/bin with space/devin'"), 'template binary token is available and quoted');
  });
}

// ── devinDriver.failurePatterns ──
console.log('\nTest: devinDriver.failurePatterns match known terminal/API failure strings');
{
  const pats = devinDriver.failurePatterns.apiError;
  const sample = (s: string): boolean => pats.some((re) => re.test(s));
  assert(sample('Devin API Error: 503 Service Unavailable'), 'matches Devin API 503');
  assert(sample('devin terminal session failed: 502 bad gateway'), 'matches Devin terminal 502');
  assert(sample('ECONNRESET while connecting to Devin'), 'matches ECONNRESET');
  assert(sample('Devin is temporarily unavailable'), 'matches temporary unavailable');
  assert(!sample('TypeError: x is not a function'), 'does NOT match user-code errors');
}

// ── devinDriver.preflight returns an AgentPreflight shape ──
console.log('\nTest: devinDriver.preflight returns a well-formed shape');
{
  const pf = devinDriver.preflight();
  assert(typeof pf.ok === 'boolean', 'ok is boolean');
  assert(typeof pf.bin === 'string', 'bin is string');
  assert(Array.isArray(pf.failures), 'failures is array');
  assert(typeof pf.commands === 'object' && pf.commands !== null, 'commands is object');
  assert('devin' in pf.commands && 'devin_ai' in pf.commands, 'commands includes devin + devin_ai');
  if (!pf.bin) {
    assert(pf.ok === false, 'ok=false when devin is not installed/configured');
    assert(pf.failures.some((f) => f.toLowerCase().includes('devin')), 'failure message mentions devin');
    assert(pf.failures.some((f) => f.includes('CCP_DEVIN_COMMAND') || f.includes('PATH')), 'failure message hints at configuration');
  }
}

console.log('\nTest: devinDriver.preflight rejects invalid CCP_DEVIN_BIN paths');
{
  withEnv('CCP_DEVIN_BIN', '/definitely/not/a/devin', () => {
    const pf = devinDriver.preflight();
    assert(pf.ok === false, 'invalid configured binary fails preflight');
    assert(pf.bin === '/definitely/not/a/devin', 'preflight echoes configured binary for diagnostics');
    assert(pf.failures.some((f) => f.includes('CCP_DEVIN_BIN')), 'failure message mentions CCP_DEVIN_BIN');
  });
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

// ── resolveAgent picks devin only when explicitly selected ──
console.log('\nTest: resolveAgent routes to devin via explicit config only');
{
  withEnv('CCP_AGENT', undefined, () => {
    const defaulted = resolveAgent(null, null);
    assert(defaulted.driver === claudeCodeDriver, 'default remains claude-code (devin inactive by default)');
    const byRepo = resolveAgent(null, { agent: 'devin' });
    assert(byRepo.driver === devinDriver, 'repo.agent=devin selects devin');
    assert(byRepo.source === 'repo', 'repo selection source');
    const byPacket = resolveAgent({ agent: 'devin' }, { agent: 'claude-code' });
    assert(byPacket.driver === devinDriver, 'packet.agent=devin selects devin');
    assert(byPacket.source === 'packet', 'packet selection source');
  });
  withEnv('CCP_AGENT', 'devin', () => {
    const byEnv = resolveAgent(null, null);
    assert(byEnv.driver === devinDriver, 'CCP_AGENT=devin selects devin when no packet/repo override');
    assert(byEnv.source === 'env', 'env selection source');
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

// ── Phase 6e: parseClaudeUsage ──
const fixedClock = (): string => '2026-04-17T05:00:00Z';

console.log('\nTest: parseClaudeUsage: single final JSON object from --output-format=json');
{
  const log = [
    'Starting work on ENG-42 ...',
    'thinking...',
    '{"type":"result","subtype":"success","total_cost_usd":0.0432,"usage":{"input_tokens":1250,"output_tokens":780,"cache_read_input_tokens":14000,"cache_creation_input_tokens":200},"model":"claude-sonnet-4-5"}',
  ].join('\n');
  const u = parseClaudeUsage(log, 'claude-code', fixedClock);
  assert(u !== null, 'returns AgentUsage');
  assert(u!.agent === 'claude-code', 'agent stamped');
  assert(u!.model === 'claude-sonnet-4-5', 'model picked up');
  assert(u!.costUsd === 0.0432, 'costUsd extracted');
  assert(u!.inputTokens === 1250, 'inputTokens extracted');
  assert(u!.outputTokens === 780, 'outputTokens extracted');
  assert(u!.cachedInputTokens === 14000, 'cachedInputTokens extracted');
  assert(u!.cacheCreationTokens === 200, 'cacheCreationTokens extracted');
  assert(u!.totalTokens === 1250 + 780 + 14000 + 200, 'totalTokens summed');
  assert(u!.capturedAt === '2026-04-17T05:00:00Z', 'clock used for capturedAt');
  assert(u!.source === 'claude-code:json', 'source stamped');
}

console.log('\nTest: parseClaudeUsage: NDJSON stream picks LAST result event');
{
  const log = [
    '{"type":"assistant","usage":{"input_tokens":10,"output_tokens":20}}',
    '{"type":"assistant","usage":{"input_tokens":30,"output_tokens":40}}',
    '{"type":"result","total_cost_usd":0.12,"usage":{"input_tokens":100,"output_tokens":200}}',
  ].join('\n');
  const u = parseClaudeUsage(log, 'claude-code', fixedClock);
  assert(u !== null && u.inputTokens === 100, 'last result event wins (cumulative)');
  assert(u !== null && u.costUsd === 0.12, 'cost from result event');
}

console.log('\nTest: parseClaudeUsage: log with no cost/usage returns null');
{
  const log = 'Worker starting...\nCoded change.\nWORKER_EXIT_CODE: 0\n';
  assert(parseClaudeUsage(log, 'claude-code', fixedClock) === null, 'text-only log → null');
}

console.log('\nTest: parseClaudeUsage: malformed JSON blocks return null');
{
  const log = 'noise { not "total_cost_usd": json ';
  assert(parseClaudeUsage(log, 'claude-code', fixedClock) === null, 'unterminated → null');
}

console.log('\nTest: parseClaudeUsage: total_cost_usd only, no usage block');
{
  const log = '{"type":"result","total_cost_usd":0.01}';
  const u = parseClaudeUsage(log, 'claude-code', fixedClock);
  assert(u !== null, 'returns AgentUsage when only cost present');
  assert(u!.costUsd === 0.01, 'cost stamped');
  assert(u!.inputTokens === undefined, 'no tokens when absent');
  assert(u!.totalTokens === undefined || u!.totalTokens === 0 || u!.totalTokens === null, 'totalTokens null when no inputs');
}

console.log('\nTest: parseClaudeUsage: empty string and non-string returns null');
{
  assert(parseClaudeUsage('', 'claude-code', fixedClock) === null, 'empty log → null');
  assert(parseClaudeUsage(null as unknown as string, 'claude-code', fixedClock) === null, 'null log → null');
  assert(parseClaudeUsage(undefined as unknown as string, 'claude-code', fixedClock) === null, 'undefined log → null');
}

console.log('\nTest: parseClaudeUsage: usage with string-typed numbers still parses');
{
  const log = '{"type":"result","total_cost_usd":"0.05","usage":{"input_tokens":"500","output_tokens":"1,200"}}';
  const u = parseClaudeUsage(log, 'claude-code', fixedClock);
  assert(u !== null && u.costUsd === 0.05, 'cost coerced from string');
  assert(u !== null && u.inputTokens === 500, 'input coerced from string');
  assert(u !== null && u.outputTokens === 1200, 'output coerces comma-separated string');
}

console.log('\nTest: parseClaudeUsage: empty-string numeric fields are absent (not 0)');
{
  // Regression: pickNumber("") used to return 0 because Number("") === 0.
  // Empty / whitespace-only strings must coerce to null so an empty usage
  // block doesn't silently fabricate a zero-token record.
  const log = '{"type":"result","total_cost_usd":"","usage":{"input_tokens":"","output_tokens":"   ","cache_read_input_tokens":",,,"}}';
  const u = parseClaudeUsage(log, 'claude-code', fixedClock);
  // Every numeric field is empty → no useful signal → parser returns null.
  assert(u === null, 'all-empty usage returns null (no zero fabrication)');
}

console.log('\nTest: parseClaudeUsage: non-numeric values are skipped');
{
  const log = '{"type":"result","total_cost_usd":"not-a-number","usage":{"input_tokens":"NaN","output_tokens":42}}';
  const u = parseClaudeUsage(log, 'claude-code', fixedClock);
  assert(u !== null, 'still returns (partial is better than null when any field usable)');
  assert(u !== null && u.costUsd === undefined, 'bogus cost dropped');
  assert(u !== null && u.inputTokens === undefined, 'NaN dropped');
  assert(u !== null && u.outputTokens === 42, 'valid output preserved');
}

// ── Phase 6e: parseCodexUsage ──
console.log('\nTest: parseCodexUsage: turn.completed JSONL event');
{
  const log = [
    '{"type":"turn.start"}',
    '{"type":"turn.completed","usage":{"input_tokens":2000,"output_tokens":500,"cached_input_tokens":10000},"model":"gpt-5"}',
  ].join('\n');
  const u = parseCodexUsage(log, 'codex', fixedClock);
  assert(u !== null, 'returns AgentUsage');
  assert(u!.agent === 'codex', 'agent=codex');
  assert(u!.model === 'gpt-5', 'model picked up');
  assert(u!.inputTokens === 2000, 'inputTokens');
  assert(u!.outputTokens === 500, 'outputTokens');
  assert(u!.cachedInputTokens === 10000, 'cachedInputTokens');
  assert(u!.totalTokens === 2000 + 500 + 10000, 'totalTokens summed');
  assert(u!.costUsd === undefined, 'no cost (Codex does not self-report USD)');
  assert(u!.source === 'codex:turn.completed', 'source stamped');
}

console.log('\nTest: parseCodexUsage: last turn.completed wins when multiple present');
{
  const log = [
    '{"type":"turn.completed","usage":{"input_tokens":100,"output_tokens":10}}',
    '{"type":"turn.completed","usage":{"input_tokens":999,"output_tokens":77}}',
  ].join('\n');
  const u = parseCodexUsage(log, 'codex', fixedClock);
  assert(u !== null && u.inputTokens === 999, 'last event cumulative wins');
  assert(u !== null && u.outputTokens === 77, 'last output wins');
}

console.log('\nTest: parseCodexUsage: token_count rollout event');
{
  const log = '{"type":"event_msg","payload":{"type":"token_count","info":{"total_token_usage":{"input_tokens":50,"output_tokens":25,"cached_input_tokens":0}}}}';
  const u = parseCodexUsage(log, 'codex', fixedClock);
  assert(u !== null, 'token_count shape parses');
  assert(u!.inputTokens === 50, 'input');
  assert(u!.outputTokens === 25, 'output');
  assert(u!.totalTokens === 75, 'total summed');
  assert(u!.source === 'codex:token_count', 'source labels rollout shape');
}

console.log('\nTest: parseCodexUsage: plain-text "tokens used: N in / M out"');
{
  const log = [
    'codex exec starting...',
    'work done.',
    'tokens used: 1,234 in / 567 out (cached 890)',
  ].join('\n');
  const u = parseCodexUsage(log, 'codex', fixedClock);
  assert(u !== null, 'text summary parses');
  assert(u!.inputTokens === 1234, 'input (comma-stripped)');
  assert(u!.outputTokens === 567, 'output');
  assert(u!.cachedInputTokens === 890, 'cached');
  assert(u!.source === 'codex:text-summary', 'text-summary source');
}

console.log('\nTest: parseCodexUsage: no recognisable signal returns null');
{
  assert(parseCodexUsage('Just a worker log', 'codex', fixedClock) === null, 'plain text → null');
  assert(parseCodexUsage('', 'codex', fixedClock) === null, 'empty → null');
  assert(parseCodexUsage('{"unrelated":"json"}', 'codex', fixedClock) === null, 'unrelated json → null');
}

console.log('\nTest: parseCodexUsage: prefers JSONL over text summary');
{
  const log = [
    '{"type":"turn.completed","usage":{"input_tokens":111,"output_tokens":222}}',
    'tokens used: 9999 in / 9999 out',
  ].join('\n');
  const u = parseCodexUsage(log, 'codex', fixedClock);
  assert(u !== null && u.inputTokens === 111, 'JSONL wins (text form is usually a duplicate summary)');
}

console.log('\nTest: parseCodexUsage: turn.completed with usage block but no numeric fields');
{
  const log = '{"type":"turn.completed","usage":{"input_tokens":"bad","output_tokens":null}}';
  const u = parseCodexUsage(log, 'codex', fixedClock);
  // Falls through past the usage-block scan to the text-summary
  // scan; with no text summary either, returns null.
  assert(u === null, 'all non-numeric → null (no text summary fallback present)');
}

// ── parseUsage integration: drivers wire their helper correctly ──
console.log('\nTest: claudeCodeDriver.parseUsage ties into parseClaudeUsage');
{
  const u = claudeCodeDriver.parseUsage!({
    jobDir: '/tmp/job-x',
    workerLog: '{"type":"result","total_cost_usd":0.5,"usage":{"input_tokens":1,"output_tokens":2}}',
  });
  assert(u !== null && u.agent === 'claude-code', 'driver method returns claude-code usage');
  assert(u !== null && u.costUsd === 0.5, 'cost pass-through');
}

console.log('\nTest: codexDriver.parseUsage ties into parseCodexUsage');
{
  const u = codexDriver.parseUsage!({
    jobDir: '/tmp/job-y',
    workerLog: '{"type":"turn.completed","usage":{"input_tokens":3,"output_tokens":4}}',
  });
  assert(u !== null && u.agent === 'codex', 'driver method returns codex usage');
  assert(u !== null && u.totalTokens === 7, 'tokens summed');
}

console.log('\nTest: driver parseUsage never throws on malformed input');
{
  const pathologic = '{'.repeat(100) + '"type":"result"' + '}'.repeat(50);
  assert(claudeCodeDriver.parseUsage!({ jobDir: '/', workerLog: pathologic }) === null, 'claude: pathologic → null');
  assert(codexDriver.parseUsage!({ jobDir: '/', workerLog: pathologic }) === null, 'codex: pathologic → null');
}

console.log(`\nTotal: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
