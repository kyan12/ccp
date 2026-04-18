/**
 * Unit tests for `maybeEnqueueSmokeRemediation` — Phase 4 PR D.
 *
 * Isolates CCP_ROOT to a tmp dir per-scenario so createJob(...) writes to
 * a scratch jobs/ tree. Does not touch real tmux, git, or the network.
 *
 * Run: `npm test`.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { JobPacket, JobResult, SmokeResult } from '../types';

let passed = 0;
let failed = 0;

function assert(cond: unknown, msg: string): void {
  if (cond) {
    passed += 1;
    console.log(`  PASS: ${msg}`);
  } else {
    failed += 1;
    console.error(`  FAIL: ${msg}`);
  }
}

// CCP_ROOT is read at module-load time by ./jobs, so we must set it before
// requiring it. Each scenario mutates CCP_ROOT to a fresh tmp dir and
// invalidates the require cache so ROOT / JOBS_DIR get re-derived.
function freshRoot(label: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `ccp-smokefix-${label}-`));
  process.env.CCP_ROOT = dir;
  // Drop cached modules that captured the old CCP_ROOT.
  for (const key of Object.keys(require.cache)) {
    if (
      /\/dist\/lib\/(jobs|repos|memory|worktree|planner|discord|linear|linear-dispatch|outage|shell|pr-review|pr-comments|webhook-callback|validator|smoke|agents)\.js$/.test(
        key,
      ) ||
      /\/dist\/lib\/agents\//.test(key)
    ) {
      delete require.cache[key];
    }
  }
  fs.mkdirSync(path.join(dir, 'jobs'), { recursive: true });
  return dir;
}

/**
 * `maybeEnqueueSmokeRemediation` calls `appendLog` on the parent job, which
 * writes to `<root>/jobs/<jobId>/worker.log` — so scenarios must create
 * the parent dir first even though createJob is what writes the child.
 */
function seedParentJob(jobId: string): void {
  const dir = path.join(process.env.CCP_ROOT!, 'jobs', jobId);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'worker.log'), '');
}

function mkPacket(overrides: Partial<JobPacket> = {}): JobPacket {
  return {
    job_id: 'test_1',
    ticket_id: 'TEST-1',
    repo: '/tmp/example-repo',
    goal: 'Ship a feature',
    source: 'linear',
    kind: 'task',
    label: 'feat',
    base_branch: 'main',
    acceptance_criteria: ['existing AC'],
    verification_steps: ['existing verify'],
    ...overrides,
  };
}

function mkResult(overrides: Partial<JobResult> = {}): JobResult {
  return {
    job_id: 'test_1',
    state: 'blocked',
    commit: 'abc1234',
    branch: 'devin/123-feat',
    pr_url: 'https://github.com/example/repo/pull/42',
    verified: 'not yet',
    prod: 'no',
    blocker: null,
    preview_url: 'https://example-pr-42.vercel.app',
    updated_at: '2025-01-01T00:00:00.000Z',
    ...overrides,
  };
}

function mkSmokeFail(overrides: Partial<SmokeResult> = {}): SmokeResult {
  return {
    ok: false,
    url: 'https://example-pr-42.vercel.app/',
    status: 500,
    durationMs: 187,
    finishedAt: '2025-01-01T00:00:00.000Z',
    failure: {
      kind: 'status',
      message: 'expected one of 200,302 but got 500',
    },
    ...overrides,
  };
}

// ────────────────────────────────────────────────────────────────────
// Scenarios
// ────────────────────────────────────────────────────────────────────

console.log('\nTest: happy path — smoke-failed job spawns __deployfix');
{
  freshRoot('happy');
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const jobs = require('./jobs');
  const savedRem = process.env.CCP_PR_REMEDIATE_ENABLED;
  delete process.env.CCP_PR_REMEDIATE_ENABLED; // default = enabled
  seedParentJob('job_happy');
  const packet = mkPacket({ job_id: 'job_happy' });
  const result = mkResult({
    blocker_type: 'smoke-failed',
    blocker: 'smoke test failed on preview deployment (status): expected one of 200,302 but got 500',
    smoke: mkSmokeFail(),
  });
  const r = jobs.maybeEnqueueSmokeRemediation('job_happy', packet, result);
  assert(r.ok === true, 'returns ok=true');
  assert(r.skipped === false, 'not skipped');
  assert(r.job_id === 'job_happy__deployfix', 'remediation job_id is <jobId>__deployfix');
  assert(r.blockerType === 'smoke-failed', 'blockerType echoed');
  assert(r.branch === 'devin/123-feat', 'targets existing branch');

  const remPacketPath = path.join(process.env.CCP_ROOT!, 'jobs', 'job_happy__deployfix', 'packet.json');
  assert(fs.existsSync(remPacketPath), 'remediation packet file exists');
  const remPacket = JSON.parse(fs.readFileSync(remPacketPath, 'utf8'));
  assert(remPacket.source === 'smoke', 'remediation source=smoke');
  assert(remPacket.kind === 'deploy', 'remediation kind=deploy');
  assert(remPacket.label === 'deploy', 'remediation label=deploy');
  assert(
    typeof remPacket.goal === 'string' && remPacket.goal.includes('Remediate smoke failure (status)'),
    'remediation goal mentions smoke + kind',
  );
  assert(
    Array.isArray(remPacket.review_feedback) && remPacket.review_feedback.length > 0,
    'review_feedback populated',
  );
  assert(
    remPacket.review_feedback.some((l: string) => /Preview URL:/.test(l)),
    'feedback includes Preview URL',
  );
  assert(
    remPacket.review_feedback.some((l: string) => /Do not create a new PR/.test(l)),
    'feedback says do not create new PR',
  );
  assert(remPacket.working_branch === 'devin/123-feat', 'working_branch = existing branch');
  assert(remPacket.base_branch === 'main', 'base_branch preserved');
  assert(
    Array.isArray(remPacket.acceptance_criteria) &&
      remPacket.acceptance_criteria.some((a: string) => /existing AC/.test(a)) &&
      remPacket.acceptance_criteria.some((a: string) => /Make the preview deployment/.test(a)),
    'acceptance_criteria appends smoke-fix ACs on top of inherited',
  );
  assert(
    Array.isArray(remPacket.verification_steps) &&
      remPacket.verification_steps.some((v: string) => /existing verify/.test(v)) &&
      remPacket.verification_steps.some((v: string) => /re-hit the preview URL/.test(v)),
    'verification_steps appends smoke-fix steps',
  );
  assert(remPacket.reviewComments === undefined, 'reviewComments cleared on remediation');

  if (savedRem !== undefined) process.env.CCP_PR_REMEDIATE_ENABLED = savedRem;
}

console.log('\nTest: remediation disabled via CCP_PR_REMEDIATE_ENABLED=false');
{
  freshRoot('disabled');
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const jobs = require('./jobs');
  const saved = process.env.CCP_PR_REMEDIATE_ENABLED;
  process.env.CCP_PR_REMEDIATE_ENABLED = 'false';
  const packet = mkPacket({ job_id: 'job_dis' });
  const result = mkResult({ blocker_type: 'smoke-failed', smoke: mkSmokeFail() });
  const r = jobs.maybeEnqueueSmokeRemediation('job_dis', packet, result);
  assert(r.ok === false && r.skipped === true, 'disabled → skipped');
  assert(r.reason === 'remediation disabled', 'disabled reason');
  assert(
    !fs.existsSync(path.join(process.env.CCP_ROOT!, 'jobs', 'job_dis__deployfix')),
    'no remediation job dir created',
  );
  if (saved !== undefined) process.env.CCP_PR_REMEDIATE_ENABLED = saved;
  else delete process.env.CCP_PR_REMEDIATE_ENABLED;
}

console.log('\nTest: depth-limit guard blocks cascading remediations');
{
  freshRoot('depth');
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const jobs = require('./jobs');
  const result = mkResult({ blocker_type: 'smoke-failed', smoke: mkSmokeFail() });
  for (const suffix of ['__deployfix', '__valfix', '__reviewfix']) {
    const r = jobs.maybeEnqueueSmokeRemediation(
      `job_x${suffix}`,
      mkPacket({ job_id: `job_x${suffix}` }),
      result,
    );
    assert(r.ok === false && r.skipped === true, `${suffix} → skipped`);
    assert(/remediation depth limit/.test(r.reason || ''), `${suffix} reason mentions depth`);
  }
}

console.log('\nTest: skip when blocker_type is not smoke-failed');
{
  freshRoot('notsmoke');
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const jobs = require('./jobs');
  for (const bt of [undefined, 'validation-failed', 'review', 'deploy', 'checks']) {
    const result = mkResult({ blocker_type: bt as JobResult['blocker_type'], smoke: mkSmokeFail() });
    const r = jobs.maybeEnqueueSmokeRemediation('job_nb', mkPacket({ job_id: 'job_nb' }), result);
    assert(
      r.ok === false && r.skipped === true && r.reason === 'job is not blocked on smoke',
      `blocker_type=${bt || 'undefined'} skipped`,
    );
  }
}

console.log('\nTest: skip when smoke result missing or passing or skipped');
{
  freshRoot('nosmoke');
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const jobs = require('./jobs');
  // missing smoke
  let r = jobs.maybeEnqueueSmokeRemediation(
    'job_ns',
    mkPacket({ job_id: 'job_ns' }),
    mkResult({ blocker_type: 'smoke-failed' }),
  );
  assert(r.ok === false && r.reason === 'no failing smoke result to remediate', 'missing smoke skipped');
  // passing smoke
  r = jobs.maybeEnqueueSmokeRemediation(
    'job_ok',
    mkPacket({ job_id: 'job_ok' }),
    mkResult({
      blocker_type: 'smoke-failed',
      smoke: {
        ok: true,
        url: 'https://ok.example/',
        status: 200,
        durationMs: 10,
        finishedAt: '2025-01-01T00:00:00.000Z',
      },
    }),
  );
  assert(r.ok === false && r.reason === 'no failing smoke result to remediate', 'ok=true smoke skipped');
  // skipped failure kind
  r = jobs.maybeEnqueueSmokeRemediation(
    'job_sk',
    mkPacket({ job_id: 'job_sk' }),
    mkResult({
      blocker_type: 'smoke-failed',
      smoke: mkSmokeFail({ failure: { kind: 'skipped', message: 'no preview url' } }),
    }),
  );
  assert(r.ok === false && r.reason === 'no failing smoke result to remediate', 'kind:skipped smoke skipped');
}

console.log('\nTest: re-enqueue is idempotent (existing remediation short-circuits)');
{
  freshRoot('idem');
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const jobs = require('./jobs');
  seedParentJob('job_idem');
  const packet = mkPacket({ job_id: 'job_idem' });
  const result = mkResult({ blocker_type: 'smoke-failed', smoke: mkSmokeFail() });
  const first = jobs.maybeEnqueueSmokeRemediation('job_idem', packet, result);
  assert(first.ok === true && first.skipped === false, 'first call enqueues');
  const second = jobs.maybeEnqueueSmokeRemediation('job_idem', packet, result);
  assert(second.ok === true && second.skipped === true, 'second call is skipped');
  assert(
    /remediation job already exists/.test(second.reason || ''),
    'second reason mentions already exists',
  );
  assert(second.job_id === first.job_id, 'second returns same remediation id');
}

console.log('\nTest: branch fallback — uses packet.working_branch when result.branch is missing/unknown');
{
  freshRoot('branch');
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const jobs = require('./jobs');
  seedParentJob('job_br');
  const result = mkResult({
    blocker_type: 'smoke-failed',
    smoke: mkSmokeFail(),
    branch: 'unknown',
  });
  const packet = mkPacket({ job_id: 'job_br', working_branch: 'feat/fallback' });
  const r = jobs.maybeEnqueueSmokeRemediation('job_br', packet, result);
  assert(r.ok === true, 'remediation enqueued');
  const remPacket = JSON.parse(
    fs.readFileSync(
      path.join(process.env.CCP_ROOT!, 'jobs', 'job_br__deployfix', 'packet.json'),
      'utf8',
    ),
  );
  assert(remPacket.working_branch === 'feat/fallback', 'working_branch falls back to packet.working_branch');
}

console.log('\nTest: feedback carries screenshotPath + bodyExcerpt when present');
{
  freshRoot('feedback');
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const jobs = require('./jobs');
  seedParentJob('job_fb');
  const result = mkResult({
    blocker_type: 'smoke-failed',
    smoke: mkSmokeFail({
      failure: {
        kind: 'title',
        message: 'title /My App/ not found',
        screenshotPath: '/var/ccp/jobs/job_fb/smoke-failure.png',
        bodyExcerpt: '<html><body>ReferenceError</body></html>',
      },
      title: 'ReferenceError: window is not defined',
    }),
  });
  const r = jobs.maybeEnqueueSmokeRemediation('job_fb', mkPacket({ job_id: 'job_fb' }), result);
  assert(r.ok === true, 'remediation enqueued');
  const remPacket = JSON.parse(
    fs.readFileSync(
      path.join(process.env.CCP_ROOT!, 'jobs', 'job_fb__deployfix', 'packet.json'),
      'utf8',
    ),
  );
  const fb: string[] = remPacket.review_feedback;
  assert(
    fb.some((l) => /Screenshot captured at \/var\/ccp\/jobs\/job_fb\/smoke-failure\.png/.test(l)),
    'feedback includes screenshot path',
  );
  assert(
    fb.some((l) => /Response body excerpt:/.test(l) && /ReferenceError/.test(l)),
    'feedback includes body excerpt',
  );
  assert(fb.some((l) => /Observed <title>/.test(l)), 'feedback includes observed title');
}

console.log('\nTest: PR URL included in feedback, with branch fallback when PR URL missing');
{
  freshRoot('prurl');
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const jobs = require('./jobs');
  // with PR URL
  seedParentJob('job_pr1');
  let result = mkResult({
    blocker_type: 'smoke-failed',
    smoke: mkSmokeFail(),
    pr_url: 'https://github.com/example/repo/pull/77',
  });
  let r = jobs.maybeEnqueueSmokeRemediation('job_pr1', mkPacket({ job_id: 'job_pr1' }), result);
  let remPacket = JSON.parse(
    fs.readFileSync(
      path.join(process.env.CCP_ROOT!, 'jobs', 'job_pr1__deployfix', 'packet.json'),
      'utf8',
    ),
  );
  assert(
    (remPacket.review_feedback as string[]).some((l) => /PR: https:\/\/github\.com\/example\/repo\/pull\/77/.test(l)),
    'feedback mentions PR URL when present',
  );

  // without PR URL — falls back to branch
  seedParentJob('job_pr2');
  result = mkResult({
    blocker_type: 'smoke-failed',
    smoke: mkSmokeFail(),
    branch: 'devin/no-pr',
    pr_url: undefined as unknown as string,
  });
  r = jobs.maybeEnqueueSmokeRemediation('job_pr2', mkPacket({ job_id: 'job_pr2' }), result);
  remPacket = JSON.parse(
    fs.readFileSync(
      path.join(process.env.CCP_ROOT!, 'jobs', 'job_pr2__deployfix', 'packet.json'),
      'utf8',
    ),
  );
  assert(
    (remPacket.review_feedback as string[]).some((l) => /Branch: devin\/no-pr/.test(l)),
    'feedback falls back to branch when PR URL missing',
  );
}

console.log(`\nsmoke-remediation.test: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
