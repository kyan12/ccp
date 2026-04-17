import fs = require('fs');
import os = require('os');
import path = require('path');
import { runValidation, summarizeReport, compactReport } from './validator';
import type { ValidationConfig } from '../types';

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

function makeTempRepo(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccp-validator-test-'));
  return dir;
}

function cleanup(dir: string): void {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    // best-effort
  }
}

// ── no config → skipped but ok ──
console.log('\nTest: missing config is skipped, not failed');
{
  const repo = makeTempRepo();
  const report = runValidation({ repoPath: repo, config: null });
  assert(report.ok === true, 'ok=true when no config');
  assert(report.skipped === true, 'skipped=true when no config');
  assert(Array.isArray(report.steps) && report.steps.length === 0, 'no step results');
  cleanup(repo);
}

// ── explicitly disabled ──
console.log('\nTest: enabled=false is skipped');
{
  const repo = makeTempRepo();
  const report = runValidation({
    repoPath: repo,
    config: { enabled: false, steps: [{ name: 'typecheck', cmd: 'true' }] },
  });
  assert(report.ok === true, 'ok=true when enabled=false');
  assert(report.skipped === true, 'skipped=true when enabled=false');
  cleanup(repo);
}

// ── empty steps ──
console.log('\nTest: empty steps array is skipped');
{
  const repo = makeTempRepo();
  const report = runValidation({ repoPath: repo, config: { steps: [] } });
  assert(report.ok === true, 'ok=true when no steps');
  assert(report.skipped === true, 'skipped=true when no steps');
  cleanup(repo);
}

// ── missing repo path ──
console.log('\nTest: nonexistent repo path fails gracefully');
{
  const report = runValidation({
    repoPath: '/nonexistent/path/ccp-validator-test-xxx',
    config: { steps: [{ name: 'test', cmd: 'true' }] },
  });
  assert(report.skipped === true, 'skipped=true for missing repo');
  assert(report.ok === false, 'ok=false for missing repo');
  assert(typeof report.reason === 'string' && report.reason.includes('repoPath'), 'reason mentions repoPath');
}

// ── all steps pass ──
console.log('\nTest: all steps pass → ok=true');
{
  const repo = makeTempRepo();
  const report = runValidation({
    repoPath: repo,
    config: {
      steps: [
        { name: 'noop1', cmd: 'true' },
        { name: 'noop2', cmd: 'echo hello' },
      ],
    },
  });
  assert(report.ok === true, 'ok=true when all steps pass');
  assert(!report.skipped, 'not skipped');
  assert(report.steps.length === 2, 'both steps reported');
  assert(report.steps[0].ok === true, 'step 1 ok');
  assert(report.steps[1].ok === true, 'step 2 ok');
  assert(report.steps[1].stdoutExcerpt.includes('hello'), 'stdout captured');
  cleanup(repo);
}

// ── required step fails → report.ok=false ──
console.log('\nTest: required step failure fails overall');
{
  const repo = makeTempRepo();
  const report = runValidation({
    repoPath: repo,
    config: {
      steps: [
        { name: 'good', cmd: 'true' },
        { name: 'bad', cmd: 'false' },
        { name: 'after', cmd: 'echo still-ran' },
      ],
    },
  });
  assert(report.ok === false, 'ok=false when required step fails');
  assert(report.steps.length === 3, 'all 3 steps run (no fail-fast)');
  assert(report.steps[1].ok === false, 'failing step marked not ok');
  assert(report.steps[1].exitCode !== 0, 'failing step exit code captured');
  assert(report.steps[2].stdoutExcerpt.includes('still-ran'), 'subsequent step still ran');
  cleanup(repo);
}

// ── non-required step fails → report.ok stays true ──
console.log('\nTest: non-required step failure does not fail overall');
{
  const repo = makeTempRepo();
  const report = runValidation({
    repoPath: repo,
    config: {
      steps: [
        { name: 'must-pass', cmd: 'true' },
        { name: 'soft', cmd: 'false', required: false },
      ],
    },
  });
  assert(report.ok === true, 'ok=true despite soft failure');
  assert(report.steps[1].ok === false, 'soft step still shown as not ok');
  assert(report.steps[1].required === false, 'soft step marked non-required');
  cleanup(repo);
}

// ── timeout ──
console.log('\nTest: step honors timeout');
{
  const repo = makeTempRepo();
  const start = Date.now();
  const report = runValidation({
    repoPath: repo,
    config: { steps: [{ name: 'slow', cmd: 'sleep 5', timeoutSec: 1 }] },
  });
  const elapsed = Date.now() - start;
  assert(report.ok === false, 'ok=false on timeout');
  assert(report.steps[0].timedOut === true, 'timedOut=true recorded');
  assert(elapsed < 4000, `step killed quickly (elapsed=${elapsed}ms)`);
  cleanup(repo);
}

// ── cwd is the repo path ──
console.log('\nTest: step runs with cwd = repoPath');
{
  const repo = makeTempRepo();
  fs.writeFileSync(path.join(repo, 'marker.txt'), 'yes');
  const report = runValidation({
    repoPath: repo,
    config: { steps: [{ name: 'pwd-check', cmd: 'cat marker.txt' }] },
  });
  assert(report.ok === true, 'ok=true when cat finds file in cwd');
  assert(report.steps[0].stdoutExcerpt.includes('yes'), 'file contents captured');
  cleanup(repo);
}

// ── env vars are injected ──
console.log('\nTest: per-step env vars are passed through');
{
  const repo = makeTempRepo();
  const report = runValidation({
    repoPath: repo,
    config: {
      steps: [
        {
          name: 'env-check',
          cmd: 'echo "value=$CCP_TEST_VAR"',
          env: { CCP_TEST_VAR: 'hello-validator' },
        },
      ],
    },
  });
  assert(report.ok === true, 'ok=true for env step');
  assert(
    report.steps[0].stdoutExcerpt.includes('hello-validator'),
    'env var visible to the step',
  );
  cleanup(repo);
}

// ── log file receives stdout/stderr ──
console.log('\nTest: log file captures step output');
{
  const repo = makeTempRepo();
  const logFile = path.join(repo, 'validation.log');
  const report = runValidation({
    repoPath: repo,
    logFile,
    config: {
      steps: [
        { name: 'stdout-step', cmd: 'echo hello-stdout' },
        { name: 'stderr-step', cmd: 'echo hello-stderr 1>&2' },
      ],
    },
  });
  assert(report.ok === true, 'ok=true');
  const logContents = fs.readFileSync(logFile, 'utf8');
  assert(logContents.includes('hello-stdout'), 'log has stdout');
  assert(logContents.includes('hello-stderr'), 'log has stderr');
  assert(logContents.includes('validator step: stdout-step'), 'log has step header');
  cleanup(repo);
}

// ── malformed steps filtered ──
console.log('\nTest: malformed steps filtered');
{
  const repo = makeTempRepo();
  const config = {
    steps: [
      { name: 'good', cmd: 'true' },
      { name: '', cmd: 'true' } as unknown,
      { name: 'no-cmd', cmd: '' } as unknown,
      null as unknown,
    ],
  } as ValidationConfig;
  const report = runValidation({ repoPath: repo, config });
  assert(report.ok === true, 'ok=true');
  assert(report.steps.length === 1, 'only the well-formed step ran');
  cleanup(repo);
}

// ── summarize / compact helpers ──
console.log('\nTest: summarizeReport + compactReport');
{
  const repo = makeTempRepo();
  const report = runValidation({
    repoPath: repo,
    config: {
      steps: [
        { name: 'a', cmd: 'true' },
        { name: 'b', cmd: 'false' },
        { name: 'c', cmd: 'false', required: false },
      ],
    },
    commit: 'abc123',
    branch: 'feature/test',
  });
  const summary = summarizeReport(report);
  assert(summary.startsWith('FAIL'), `summary starts with FAIL, got: ${summary}`);
  assert(summary.includes('pass=1'), 'summary has pass=1');
  assert(summary.includes('fail=1'), 'summary has fail=1');
  assert(summary.includes('warn=1'), 'summary has warn=1');

  const compact = compactReport(report);
  assert(compact !== null, 'compact not null');
  assert((compact as { ok: boolean }).ok === false, 'compact.ok=false');
  const steps = (compact as { steps: Array<{ name: string }> }).steps;
  assert(steps.length === 3, 'compact has all steps');
  assert(
    !Object.prototype.hasOwnProperty.call(steps[0], 'stdoutExcerpt'),
    'compact strips stdoutExcerpt',
  );
  assert((compact as { commit: string }).commit === 'abc123', 'commit passed through');
  assert((compact as { branch: string }).branch === 'feature/test', 'branch passed through');

  const skippedSummary = summarizeReport({
    ok: true,
    skipped: true,
    reason: 'no config',
    steps: [],
    startedAt: '',
    finishedAt: '',
    durationMs: 0,
  });
  assert(skippedSummary.includes('skipped'), 'skipped summary mentions skipped');

  assert(compactReport(null) === null, 'compactReport(null) === null');
  assert(compactReport(undefined) === null, 'compactReport(undefined) === null');
  cleanup(repo);
}

console.log(`\nTotal: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
