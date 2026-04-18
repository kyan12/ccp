/**
 * Tests for the pre-worker planner (Phase 5b).
 *
 * We exercise `shouldSkipPlanner`, `resolvePlannerConfig`,
 * `buildPlannerPrompt` and `runPlanner`. The driver is a stub — we
 * don't shell out to a real agent CLI. Instead the stub's
 * `buildCommand` returns a trivial `bash` command that either echoes a
 * canned plan, exits non-zero, sleeps (for timeout coverage), or emits
 * too many bytes.
 *
 * All filesystem state lives in temp dirs; no real CCP_ROOT is used.
 */

import fs = require('fs');
import os = require('os');
import path = require('path');
import type { JobPacket, RepoMapping } from '../types';
import type { AgentDriver, AgentBuildContext, AgentCommand } from './agents/types';
import {
  MAX_PLAN_BYTES,
  DEFAULT_PLANNER_TIMEOUT_SEC,
  buildPlannerPrompt,
  resolvePlannerConfig,
  shouldSkipPlanner,
  runPlanner,
} from './planner';

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

function mkTmp(label: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `ccp-planner-${label}-`));
}

function makePacket(overrides: Partial<JobPacket> = {}): JobPacket {
  return {
    ticket_id: 'CCP-1',
    goal: 'Add a /health endpoint',
    repo: '/tmp/fake-repo',
    acceptance_criteria: ['Returns 200 OK with {ok: true}'],
    constraints: [],
    ...overrides,
  } as JobPacket;
}

function makeMapping(overrides: Partial<RepoMapping> = {}): RepoMapping {
  return {
    key: 'fake',
    localPath: '/tmp/fake-repo',
    ...overrides,
  } as RepoMapping;
}

/**
 * A stub AgentDriver whose `buildCommand` just returns the shell
 * command we pass in. Lets each test control exactly what happens
 * inside `spawnSync`.
 */
function makeStubDriver(shellCmdForTest: string): AgentDriver {
  return {
    name: 'stub',
    label: 'Stub',
    buildCommand(_ctx: AgentBuildContext): AgentCommand {
      return { shellCmd: shellCmdForTest };
    },
    preflight() {
      return { ok: true, bin: 'stub', failures: [], commands: {} };
    },
    probe() {
      return { ok: true };
    },
    failurePatterns: { apiError: [], rateLimit: [] },
  };
}

// ── buildPlannerPrompt ──

console.log('Test: buildPlannerPrompt — structure');
{
  const prompt = buildPlannerPrompt(makePacket());
  assert(prompt.includes('SHORT implementation plan'), 'prompt tells the agent to be short');
  assert(prompt.includes('Do NOT write any code'), 'prompt forbids code output');
  assert(prompt.includes('Ticket: CCP-1'), 'prompt includes ticket id');
  assert(prompt.includes('Goal: Add a /health endpoint'), 'prompt includes goal');
  assert(prompt.includes('## Files to touch'), 'prompt includes Files header');
  assert(prompt.includes('## Approach'), 'prompt includes Approach header');
  assert(prompt.includes('## Tests'), 'prompt includes Tests header');
  assert(prompt.includes('## Risks'), 'prompt includes Risks header');
  assert(prompt.includes('## Confidence'), 'prompt includes Confidence header');
}

console.log('Test: buildPlannerPrompt — memory injection');
{
  const prompt = buildPlannerPrompt(makePacket(), 'Repo uses Fastify, not Express.');
  assert(
    prompt.includes('--- BEGIN REPOSITORY MEMORY ---'),
    'prompt wraps memory in BEGIN marker',
  );
  assert(
    prompt.includes('Repo uses Fastify, not Express.'),
    'prompt contains memory body',
  );
  assert(
    prompt.includes('--- END REPOSITORY MEMORY ---'),
    'prompt wraps memory in END marker',
  );
}

console.log('Test: buildPlannerPrompt — no memory section when empty/whitespace');
{
  const noMem = buildPlannerPrompt(makePacket());
  const blank = buildPlannerPrompt(makePacket(), '   \n\t\n  ');
  assert(!noMem.includes('BEGIN REPOSITORY MEMORY'), 'missing memory skips BEGIN marker');
  assert(!blank.includes('BEGIN REPOSITORY MEMORY'), 'whitespace memory skips BEGIN marker');
}

// ── resolvePlannerConfig ──

console.log('Test: resolvePlannerConfig — disabled by default');
{
  assert(resolvePlannerConfig(null) === null, 'null mapping → null config');
  assert(resolvePlannerConfig(makeMapping()) === null, 'no planner field → null');
  assert(
    resolvePlannerConfig(makeMapping({ planner: { enabled: false } })) === null,
    'enabled=false → null',
  );
}

console.log('Test: resolvePlannerConfig — enabled with default timeout');
{
  const cfg = resolvePlannerConfig(makeMapping({ planner: { enabled: true } }));
  assert(cfg !== null, 'enabled=true → non-null');
  assert(cfg?.timeoutSec === DEFAULT_PLANNER_TIMEOUT_SEC, 'default timeout');
}

console.log('Test: resolvePlannerConfig — custom timeout is floored and clamped');
{
  const cfg = resolvePlannerConfig(makeMapping({ planner: { enabled: true, timeoutSec: 42.9 } }));
  assert(cfg?.timeoutSec === 42, 'fractional timeout floored');

  const cfgZero = resolvePlannerConfig(makeMapping({ planner: { enabled: true, timeoutSec: 0 } }));
  assert(cfgZero?.timeoutSec === DEFAULT_PLANNER_TIMEOUT_SEC, '0 → default');

  const cfgNeg = resolvePlannerConfig(makeMapping({ planner: { enabled: true, timeoutSec: -5 } }));
  assert(cfgNeg?.timeoutSec === DEFAULT_PLANNER_TIMEOUT_SEC, 'negative → default');

  const cfgNaN = resolvePlannerConfig(makeMapping({ planner: { enabled: true, timeoutSec: NaN } }));
  assert(cfgNaN?.timeoutSec === DEFAULT_PLANNER_TIMEOUT_SEC, 'NaN → default');
}

// ── shouldSkipPlanner ──

console.log('Test: shouldSkipPlanner — remediation jobs');
{
  const mapping = makeMapping({ planner: { enabled: true } });
  for (const jobId of ['job__valfix', 'job__reviewfix', 'job__deployfix', 'abc__valfix']) {
    const skip = shouldSkipPlanner({ jobId, packet: makePacket(), mapping });
    assert(skip?.skipped === true, `${jobId} skipped`);
    assert(/remediation/.test(skip?.reason || ''), `${jobId} reason mentions remediation`);
  }
}

console.log('Test: shouldSkipPlanner — continuation jobs');
{
  const skip = shouldSkipPlanner({
    jobId: 'job-1',
    packet: makePacket({ working_branch: 'feat/foo' }),
    mapping: makeMapping({ planner: { enabled: true } }),
  });
  assert(skip?.skipped === true, 'working_branch → skipped');
  assert(/continuation/.test(skip?.reason || ''), 'reason mentions continuation');
  assert(/feat\/foo/.test(skip?.reason || ''), 'reason includes branch name');
}

console.log('Test: shouldSkipPlanner — planner disabled');
{
  const skip = shouldSkipPlanner({
    jobId: 'job-1',
    packet: makePacket(),
    mapping: makeMapping({ planner: { enabled: false } }),
  });
  assert(skip?.skipped === true, 'enabled=false → skipped');
  assert(/disabled/.test(skip?.reason || ''), 'reason mentions disabled');
}

console.log('Test: shouldSkipPlanner — null mapping');
{
  const skip = shouldSkipPlanner({
    jobId: 'job-1',
    packet: makePacket(),
    mapping: null,
  });
  assert(skip?.skipped === true, 'null mapping → skipped');
}

console.log('Test: shouldSkipPlanner — should NOT skip when fully enabled');
{
  const result = shouldSkipPlanner({
    jobId: 'job-1',
    packet: makePacket(),
    mapping: makeMapping({ planner: { enabled: true } }),
  });
  assert(result === null, 'fully enabled → null (proceed)');
}

console.log('Test: shouldSkipPlanner — respects custom remediationPattern');
{
  const result = shouldSkipPlanner({
    jobId: 'myjob__custom',
    packet: makePacket(),
    mapping: makeMapping({ planner: { enabled: true } }),
    remediationPattern: /__custom/,
  });
  assert(result?.skipped === true, 'custom pattern matches');

  const result2 = shouldSkipPlanner({
    jobId: 'myjob__valfix',
    packet: makePacket(),
    mapping: makeMapping({ planner: { enabled: true } }),
    remediationPattern: /__never/,
  });
  assert(result2 === null, 'custom pattern ignores built-in suffixes');
}

// ── runPlanner — integration with a stub driver ──

function makeRunOpts(
  tmp: string,
  driver: AgentDriver,
  overrides: { packet?: Partial<JobPacket>; mapping?: Partial<RepoMapping>; jobId?: string } = {},
): Parameters<typeof runPlanner>[0] {
  const packet = makePacket(overrides.packet);
  const mapping = makeMapping({
    planner: { enabled: true, timeoutSec: 10 },
    ...(overrides.mapping || {}),
  });
  return {
    jobId: overrides.jobId || 'job-1',
    packet,
    mapping,
    agent: driver,
    bin: '/bin/true',
    workdir: tmp,
    planPromptPath: path.join(tmp, 'plan.prompt.txt'),
    planOutPath: path.join(tmp, 'plan.md'),
    memory: null,
  };
}

console.log('Test: runPlanner — happy path captures stdout');
{
  const tmp = mkTmp('happy');
  const driver = makeStubDriver('printf "## Files to touch\\n- foo.ts — add endpoint\\n"');
  const result = runPlanner(makeRunOpts(tmp, driver));
  assert(result.ok === true, 'ok=true');
  assert(result.skipped === false, 'skipped=false');
  assert(result.plan.includes('## Files to touch'), 'plan contains Files header');
  assert(result.plan.includes('foo.ts'), 'plan body captured');
  assert(result.truncated === false, 'not truncated');
  assert(result.timedOut === false, 'not timed out');
  assert(fs.existsSync(path.join(tmp, 'plan.md')), 'plan.md written');
  assert(fs.existsSync(path.join(tmp, 'plan.prompt.txt')), 'planner prompt persisted');
  fs.rmSync(tmp, { recursive: true, force: true });
}

console.log('Test: runPlanner — skipped when planner disabled');
{
  const tmp = mkTmp('skip');
  const driver = makeStubDriver('echo ignored');
  const opts = makeRunOpts(tmp, driver, { mapping: { planner: { enabled: false } } });
  const result = runPlanner(opts);
  assert(result.skipped === true, 'skipped=true');
  assert(result.ok === false, 'ok=false when skipped');
  assert(/disabled/.test(result.reason), 'reason mentions disabled');
  assert(!fs.existsSync(path.join(tmp, 'plan.md')), 'plan.md NOT written when skipped');
  fs.rmSync(tmp, { recursive: true, force: true });
}

console.log('Test: runPlanner — skipped for remediation jobs');
{
  const tmp = mkTmp('rem');
  const driver = makeStubDriver('echo ignored');
  const opts = makeRunOpts(tmp, driver, { jobId: 'abc__valfix' });
  const result = runPlanner(opts);
  assert(result.skipped === true, '__valfix → skipped');
  fs.rmSync(tmp, { recursive: true, force: true });
}

console.log('Test: runPlanner — non-zero exit surfaces reason');
{
  const tmp = mkTmp('fail');
  const driver = makeStubDriver('echo oops >&2; exit 2');
  const result = runPlanner(makeRunOpts(tmp, driver));
  assert(result.ok === false, 'ok=false');
  assert(result.skipped === true, 'treated as skip so worker still runs');
  assert(/exited 2/.test(result.reason), 'reason includes exit code');
  assert(/oops/.test(result.reason), 'reason includes stderr excerpt');
  fs.rmSync(tmp, { recursive: true, force: true });
}

console.log('Test: runPlanner — empty stdout is a skip');
{
  const tmp = mkTmp('empty');
  const driver = makeStubDriver('printf ""');
  const result = runPlanner(makeRunOpts(tmp, driver));
  assert(result.ok === false, 'ok=false');
  assert(result.skipped === true, 'skipped=true');
  assert(/empty/.test(result.reason), 'reason mentions empty');
  fs.rmSync(tmp, { recursive: true, force: true });
}

console.log('Test: runPlanner — output over MAX_PLAN_BYTES is truncated with marker');
{
  const tmp = mkTmp('trunc');
  // Produce a plan ~20KB so truncation triggers (cap is 16KB).
  const driver = makeStubDriver(`head -c 20000 /dev/zero | tr '\\0' x`);
  const result = runPlanner(makeRunOpts(tmp, driver));
  assert(result.ok === true, 'still ok when truncated');
  assert(result.truncated === true, 'truncated=true');
  assert(
    Buffer.byteLength(result.plan, 'utf8') <= MAX_PLAN_BYTES + 200,
    'plan bytes close to cap (marker adds ~100 bytes)',
  );
  assert(
    /planner output exceeded/.test(result.plan),
    'plan ends with truncation marker',
  );
  fs.rmSync(tmp, { recursive: true, force: true });
}

console.log('Test: runPlanner — timeout kills subprocess and returns timedOut');
{
  const tmp = mkTmp('timeout');
  const driver = makeStubDriver('sleep 5');
  const opts = makeRunOpts(tmp, driver, { mapping: { planner: { enabled: true, timeoutSec: 1 } } });
  const result = runPlanner(opts);
  // Node's spawnSync timeout either kills with SIGTERM or surfaces ETIMEDOUT;
  // either way runPlanner should flip timedOut=true.
  assert(result.ok === false, 'ok=false on timeout');
  assert(result.timedOut === true, 'timedOut=true');
  assert(/timed out/.test(result.reason), 'reason mentions timeout');
  fs.rmSync(tmp, { recursive: true, force: true });
}

console.log(`\nplanner.test: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
