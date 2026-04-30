import assert = require('assert');
import fs = require('fs');
import os = require('os');
import path = require('path');
import type { DecisionRequest, JobPacket, JobResult, JobStatus } from '../types';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ccp-pr-watcher-decision-'));
process.env.CCP_ROOT = root;

const { createJob, resultPath, statusPath, readJson } = require('./jobs') as typeof import('./jobs');
const { collectWatchableJobs } = require('./pr-watcher') as typeof import('./pr-watcher');

function writeJson(file: string, data: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data, null, 2) + '\n');
}

function packet(overrides: Partial<JobPacket> = {}): JobPacket {
  return {
    job_id: 'job_pr_decision',
    ticket_id: 'PRO-PRDECIDE',
    repo: '/tmp/repo',
    goal: 'Resolve ambiguous PR-backed work',
    source: 'test',
    kind: 'task',
    label: 'test',
    ...overrides,
  };
}

function pendingDecision(jobId: string): DecisionRequest {
  return {
    id: `${jobId}#decision`,
    job_id: jobId,
    question: 'Ship as-is or refactor?',
    options: [
      { id: 'A', label: 'Ship as-is' },
      { id: 'B', label: 'Refactor' },
    ],
    created_at: '2026-01-01T00:00:00.000Z',
    status: 'pending',
  };
}

console.log('\nTest: pr-watcher ignores PR-backed jobs pending operator decision');
{
  createJob(packet({ job_id: 'job_pr_decision_pending' }));
  const status = readJson(statusPath('job_pr_decision_pending')) as unknown as JobStatus;
  writeJson(statusPath('job_pr_decision_pending'), {
    ...status,
    state: 'blocked',
    integrations: { ...(status.integrations || {}), decision: pendingDecision('job_pr_decision_pending') },
  });
  const result: Partial<JobResult> = {
    job_id: 'job_pr_decision_pending',
    state: 'blocked',
    pr_url: 'https://github.com/acme/repo/pull/123',
    blocker: 'Decision needed: Ship as-is or refactor?',
    blocker_type: 'operator-decision',
  };
  writeJson(resultPath('job_pr_decision_pending'), result);

  const watchable = collectWatchableJobs();
  assert.equal(watchable.some((item) => item.status.job_id === 'job_pr_decision_pending'), false);
}

console.log('Test: pr-watcher resumes watching after operator decision is answered even while result keeps stale operator blocker');
{
  createJob(packet({ job_id: 'job_pr_decision_answered' }));
  const status = readJson(statusPath('job_pr_decision_answered')) as unknown as JobStatus;
  const answered = { ...pendingDecision('job_pr_decision_answered'), status: 'answered' as const, answer: 'A', answered_at: '2026-01-01T00:10:00.000Z' };
  writeJson(statusPath('job_pr_decision_answered'), {
    ...status,
    state: 'blocked',
    integrations: { ...(status.integrations || {}), decision: answered },
  });
  const result: Partial<JobResult> = {
    job_id: 'job_pr_decision_answered',
    state: 'blocked',
    pr_url: 'https://github.com/acme/repo/pull/124',
    blocker: 'Decision needed: Ship as-is or refactor?',
    blocker_type: 'operator-decision',
  };
  writeJson(resultPath('job_pr_decision_answered'), result);

  const watchable = collectWatchableJobs();
  assert.equal(watchable.some((item) => item.status.job_id === 'job_pr_decision_answered'), true);
}

console.log('pr-watcher decision tests passed');
