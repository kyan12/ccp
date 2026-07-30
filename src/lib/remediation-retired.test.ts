import assert = require('node:assert/strict');
import fs = require('node:fs');
import os = require('node:os');
import path = require('node:path');
import test = require('node:test');
import type { JobPacket, JobResult, PRReviewResult } from '../types';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ccp-remediation-retired-'));
process.env.CCP_ROOT = root;
process.env.CCP_PR_REMEDIATE_ENABLED = 'true';

const {
  maybeEnqueueReviewRemediation,
  maybeEnqueueSmokeRemediation,
  maybeEnqueueValidationRemediation,
  retiredAutoUnblockSummary,
} = require('./jobs') as typeof import('./jobs');

const packet = {
  job_id: 'legacy-job',
  repo: '/tmp/example',
  goal: 'legacy work',
  source: 'test',
  kind: 'task',
  label: 'test',
} as JobPacket;

const result = {
  job_id: 'legacy-job',
  state: 'blocked',
  blocker_type: 'smoke-failed',
  pr_url: 'https://github.com/example/repo/pull/1',
  branch: 'legacy-branch',
  smoke: {
    ok: false,
    url: 'https://preview.example',
    durationMs: 10,
    finishedAt: new Date(0).toISOString(),
    failure: { kind: 'status', message: '500' },
  },
} as JobResult;

const blockedReview = {
  ok: true,
  disposition: 'block',
  blockerType: 'checks',
  blockers: ['required check failed'],
  failedChecks: [{ name: 'test', state: 'FAILURE' }],
} as PRReviewResult;

function assertRetired(response: { ok: boolean; skipped?: boolean; reason?: string }): void {
  assert.equal(response.ok, false);
  assert.equal(response.skipped, true);
  assert.match(response.reason || '', /native Hermes Kanban owns remediation/);
}

test('all legacy CCP remediation enqueue entry points are permanently retired', () => {
  assertRetired(maybeEnqueueReviewRemediation('legacy-job', packet, result, blockedReview));
  assertRetired(maybeEnqueueSmokeRemediation('legacy-job', packet, result));
  assertRetired(maybeEnqueueValidationRemediation('legacy-job', packet, {
    ...result,
    blocker_type: 'validation-failed',
    validation: {
      ok: false,
      skipped: false,
      startedAt: new Date(0).toISOString(),
      finishedAt: new Date(0).toISOString(),
      durationMs: 1,
      steps: [],
    },
  }));

  assert.equal(fs.existsSync(path.join(root, 'jobs', 'legacy-job__reviewfix')), false);
  assert.equal(fs.existsSync(path.join(root, 'jobs', 'legacy-job__deployfix')), false);
  assert.equal(fs.existsSync(path.join(root, 'jobs', 'legacy-job__valfix')), false);

  const autoUnblock = retiredAutoUnblockSummary();
  assert.equal(autoUnblock.scanned, 0);
  assert.deepEqual(autoUnblock.retried, []);
  assert.match(autoUnblock.skipped[0]?.reason || '', /native Hermes Kanban owns remediation/);
});
