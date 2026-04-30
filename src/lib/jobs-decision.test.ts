import assert = require('assert');
import fs = require('fs');
import os = require('os');
import path = require('path');
import { spawnSync } from 'child_process';
import type { DecisionRequest, JobPacket, JobStatus } from '../types';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ccp-job-decision-'));
process.env.CCP_ROOT = root;

const { answerDecision, createJob } = require('./jobs') as typeof import('./jobs');

function readJson<T>(file: string): T {
  return JSON.parse(fs.readFileSync(file, 'utf8')) as T;
}

function writeJson(file: string, data: unknown): void {
  fs.writeFileSync(file, JSON.stringify(data, null, 2) + '\n');
}

function statusFile(jobId: string): string {
  return path.join(root, 'jobs', jobId, 'status.json');
}

function packetFile(jobId: string): string {
  return path.join(root, 'jobs', jobId, 'packet.json');
}

function packet(overrides: Partial<JobPacket> = {}): JobPacket {
  return {
    job_id: 'job_parent',
    ticket_id: 'PRO-DECIDE',
    repo: '/tmp/repo',
    goal: 'Resolve an ambiguous implementation path',
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
    question: 'Patch or refactor?',
    options: [
      { id: 'A', label: 'Patch' },
      { id: 'B', label: 'Refactor' },
    ],
    recommended: 'A',
    created_at: '2026-01-01T00:00:00.000Z',
    status: 'pending',
  };
}

console.log('\nTest: answerDecision rejects jobs without a pending decision');
{
  createJob(packet({ job_id: 'job_no_decision' }));
  const out = answerDecision('job_no_decision', 'A');
  assert.equal(out.ok, false);
  assert(String(out.reason).includes('no pending decision'));
}

console.log('Test: answerDecision rejects invalid choices');
{
  createJob(packet({ job_id: 'job_bad_choice' }));
  const status = readJson<JobStatus>(statusFile('job_bad_choice'));
  writeJson(statusFile('job_bad_choice'), {
    ...status,
    state: 'blocked',
    integrations: { ...(status.integrations || {}), decision: pendingDecision('job_bad_choice') },
  });
  const out = answerDecision('job_bad_choice', 'Z');
  assert.equal(out.ok, false);
  assert(String(out.reason).includes('Expected one of: A, B'));
}

console.log('Test: answerDecision creates continuation and marks parent answered');
{
  createJob(packet({ job_id: 'job_parent', working_branch: 'feat/decision' }));
  const status = readJson<JobStatus>(statusFile('job_parent'));
  writeJson(statusFile('job_parent'), {
    ...status,
    state: 'blocked',
    integrations: { ...(status.integrations || {}), decision: pendingDecision('job_parent') },
  });

  const out = answerDecision('job_parent', 'B', 'Prefer long-term cleanup');
  assert.equal(out.ok, true);
  assert.equal(out.job_id, 'job_parent__decision_B');

  const parentStatus = readJson<JobStatus>(statusFile('job_parent'));
  assert.equal(parentStatus.integrations?.decision?.status, 'answered');
  assert.equal(parentStatus.integrations?.decision?.answer, 'B');

  const retry = answerDecision('job_parent', 'b', 'Safe duplicate retry');
  assert.equal(retry.ok, true);
  assert.equal(retry.skipped, true);
  assert.equal(retry.job_id, 'job_parent__decision_B');

  const conflictingRetry = answerDecision('job_parent', 'A', 'Too late');
  assert.equal(conflictingRetry.ok, false);
  assert(String(conflictingRetry.reason).includes('different option'));

  const childPacket = readJson<JobPacket>(packetFile('job_parent__decision_B'));
  assert.equal(childPacket.working_branch, 'feat/decision');
  assert.equal(childPacket.decisionMode, 'auto');
  assert(childPacket.review_feedback?.some((line) => line.includes('Human decision: B')));
}

console.log('Test: answerDecision reconciles an existing continuation after partial failure');
{
  createJob(packet({ job_id: 'job_reconcile', working_branch: 'feat/reconcile' }));
  const status = readJson<JobStatus>(statusFile('job_reconcile'));
  writeJson(statusFile('job_reconcile'), {
    ...status,
    state: 'blocked',
    integrations: { ...(status.integrations || {}), decision: pendingDecision('job_reconcile') },
  });

  createJob(packet({ job_id: 'job_reconcile__decision_A', working_branch: 'feat/reconcile', decisionMode: 'auto' }));
  const out = answerDecision('job_reconcile', 'A', 'Already queued before crash');
  assert.equal(out.ok, true);
  assert.equal(out.skipped, true);
  const parentStatus = readJson<JobStatus>(statusFile('job_reconcile'));
  assert.equal(parentStatus.integrations?.decision?.status, 'answered');
  assert.equal(parentStatus.integrations?.decision?.answer, 'A');
}

console.log('Test: answerDecision rejects conflicting choice when another continuation already exists');
{
  createJob(packet({ job_id: 'job_conflict', working_branch: 'feat/conflict' }));
  const status = readJson<JobStatus>(statusFile('job_conflict'));
  writeJson(statusFile('job_conflict'), {
    ...status,
    state: 'blocked',
    integrations: { ...(status.integrations || {}), decision: pendingDecision('job_conflict') },
  });

  createJob(packet({ job_id: 'job_conflict__decision_B', working_branch: 'feat/conflict', decisionMode: 'auto' }));
  const out = answerDecision('job_conflict', 'A', 'Conflicting retry after partial crash');
  assert.equal(out.ok, false);
  assert(String(out.reason).includes('different option'));
  assert.equal(fs.readdirSync(path.join(root, 'jobs')).includes('job_conflict__decision_A'), false);
  const parentStatus = readJson<JobStatus>(statusFile('job_conflict'));
  assert.equal(parentStatus.integrations?.decision?.status, 'pending');
}

console.log('Test: answerDecision reconciles existing continuation using canonical option casing');
{
  createJob(packet({ job_id: 'job_case', working_branch: 'feat/case' }));
  const status = readJson<JobStatus>(statusFile('job_case'));
  writeJson(statusFile('job_case'), {
    ...status,
    state: 'blocked',
    integrations: { ...(status.integrations || {}), decision: pendingDecision('job_case') },
  });

  createJob(packet({ job_id: 'job_case__decision_B', working_branch: 'feat/case', decisionMode: 'auto' }));
  const out = answerDecision('job_case', 'b', 'Retry with lowercase operator input');
  assert.equal(out.ok, true);
  assert.equal(out.skipped, true);
  assert.equal(out.job_id, 'job_case__decision_B');
  const exactJobDirs = fs.readdirSync(path.join(root, 'jobs'));
  assert.equal(exactJobDirs.includes('job_case__decision_b'), false);
  const parentStatus = readJson<JobStatus>(statusFile('job_case'));
  assert.equal(parentStatus.integrations?.decision?.status, 'answered');
  assert.equal(parentStatus.integrations?.decision?.answer, 'B');
}

console.log('Test: answerDecision recovers orphaned same-option claim without child status');
{
  createJob(packet({ job_id: 'job_orphan_claim', working_branch: 'feat/orphan' }));
  const status = readJson<JobStatus>(statusFile('job_orphan_claim'));
  writeJson(statusFile('job_orphan_claim'), {
    ...status,
    state: 'blocked',
    integrations: { ...(status.integrations || {}), decision: pendingDecision('job_orphan_claim') },
  });
  writeJson(path.join(root, 'jobs', 'job_orphan_claim', 'decision-answer.json'), {
    choice: 'B',
    child_job_id: 'job_orphan_claim__decision_B',
    claimed_at: '2026-01-01T00:00:00.000Z',
  });

  const out = answerDecision('job_orphan_claim', 'b', 'Retry after crash between claim and child create');
  assert.equal(out.ok, true);
  assert.equal(out.job_id, 'job_orphan_claim__decision_B');
  assert.equal(out.recovered, true);
  assert.equal(fs.existsSync(statusFile('job_orphan_claim__decision_B')), true);
  const parentStatus = readJson<JobStatus>(statusFile('job_orphan_claim'));
  assert.equal(parentStatus.integrations?.decision?.status, 'answered');
  assert.equal(parentStatus.integrations?.decision?.answer, 'B');
}

console.log('Test: answerDecision recovers answered parent with orphaned same-option claim');
{
  createJob(packet({ job_id: 'job_answered_orphan', working_branch: 'feat/answered-orphan' }));
  const status = readJson<JobStatus>(statusFile('job_answered_orphan'));
  const answered = { ...pendingDecision('job_answered_orphan'), status: 'answered' as const, answer: 'B', answered_at: '2026-01-01T00:00:01.000Z' };
  writeJson(statusFile('job_answered_orphan'), {
    ...status,
    state: 'blocked',
    integrations: { ...(status.integrations || {}), decision: answered },
  });
  writeJson(path.join(root, 'jobs', 'job_answered_orphan', 'decision-answer.json'), {
    choice: 'B',
    child_job_id: 'job_answered_orphan__decision_B',
    claimed_at: '2026-01-01T00:00:00.000Z',
  });

  const out = answerDecision('job_answered_orphan', 'b', 'Retry after crash after parent answered');
  assert.equal(out.ok, true);
  assert.equal(out.job_id, 'job_answered_orphan__decision_B');
  assert.equal(out.recovered, true);
  assert.equal(fs.existsSync(statusFile('job_answered_orphan__decision_B')), true);
  const parentStatus = readJson<JobStatus>(statusFile('job_answered_orphan'));
  assert.equal(parentStatus.integrations?.decision?.status, 'answered');
  assert.equal(parentStatus.integrations?.decision?.answer, 'B');
}

console.log('Test: answerDecision serializes concurrent answers for one pending decision');
{
  createJob(packet({ job_id: 'job_race', working_branch: 'feat/race' }));
  const status = readJson<JobStatus>(statusFile('job_race'));
  writeJson(statusFile('job_race'), {
    ...status,
    state: 'blocked',
    integrations: { ...(status.integrations || {}), decision: pendingDecision('job_race') },
  });

  const worker = (choice: string): string => [
    'node',
    '-e',
    JSON.stringify(`process.env.CCP_ROOT=${JSON.stringify(root)}; const { answerDecision } = require('./dist/lib/jobs'); console.log(JSON.stringify(answerDecision('job_race', ${JSON.stringify(choice)})));`),
  ].join(' ');
  const race = spawnSync('bash', ['-lc', `${worker('A')} & ${worker('B')} & wait`], { cwd: path.join(__dirname, '..', '..'), encoding: 'utf8' });
  assert.equal(race.status, 0, race.stderr || race.stdout);
  const continuationDirs = fs.readdirSync(path.join(root, 'jobs')).filter((name) => name.startsWith('job_race__decision_'));
  assert.equal(continuationDirs.length, 1, `expected one continuation, got ${continuationDirs.join(', ')}; stdout=${race.stdout}`);
  const parentStatus = readJson<JobStatus>(statusFile('job_race'));
  assert.equal(parentStatus.integrations?.decision?.status, 'answered');
  assert(['A', 'B'].includes(parentStatus.integrations?.decision?.answer || ''));
}

console.log('jobs decision tests passed');
