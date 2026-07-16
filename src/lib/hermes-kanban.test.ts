import fs = require('fs');
import os = require('os');
import path = require('path');
import type { JobPacket } from '../types';

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

const TEST_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'ccp-kanban-test-'));
process.env.CCP_ROOT = TEST_ROOT;

function resetRoot(): string {
  fs.rmSync(path.join(TEST_ROOT, 'jobs'), { recursive: true, force: true });
  return TEST_ROOT;
}

console.log('\nTest: Kanban packet builds deterministic Hermes job packet');
{
  resetRoot();
  const { buildKanbanJobPacket } = require('./hermes-kanban');
  const packet: JobPacket = buildKanbanJobPacket({
    task_id: 't_abc123',
    title: 'Fix checkout totals',
    body: 'Body from kanban card',
    worker_context: '# Kanban task t_abc123\nFull context',
    repo: '/tmp/repo',
    repoKey: 'demo',
    acceptance_criteria: ['Totals update'],
    verification_steps: ['Run tests'],
  });
  assert(packet.job_id === 'kanban_t_abc123', 'job id is deterministic from Kanban task id');
  assert(packet.ticket_id === 't_abc123', 'ticket id is exact Kanban task id');
  assert(packet.source === 'hermes-kanban', 'packet source is hermes-kanban');
  assert(packet.metadata?.source_transport === 'hermes-kanban', 'metadata persists source_transport');
  assert(packet.metadata?.hermes_kanban_task_id === 't_abc123', 'metadata persists exact task id');
  assert(packet.goal === 'Fix checkout totals', 'title becomes goal');
  assert(!!packet.acceptance_criteria?.includes('Totals update'), 'explicit acceptance criteria preserved');
  assert(!!packet.verification_steps?.includes('Run tests'), 'explicit verification steps preserved');
  assert(String(packet.metadata?.kanban_worker_context).includes('Full context'), 'worker context retained for prompt evidence');
}

console.log('\nTest: submitting same Kanban task twice returns one existing job');
{
  const root = resetRoot();
  const { submitKanbanJob } = require('./hermes-kanban');
  const input = { task_id: 't_dup001', title: 'Duplicate test', body: 'Do it', repo: '/tmp/repo' };
  const first = submitKanbanJob(input);
  const second = submitKanbanJob(input);
  assert(first.ok && second.ok, 'both submissions succeed');
  assert(first.job_id === second.job_id, 'same job id returned');
  assert(first.created === true, 'first submission reports created');
  assert(second.created === false && second.existing === true, 'second submission reports existing');
  const jobDirs = fs.readdirSync(path.join(root, 'jobs')).filter((name: string) => name.startsWith('kanban_t_dup001'));
  assert(jobDirs.length === 1, 'only one job directory exists');
}

console.log('\nTest: Kanban terminal result serialization is stable for board handoff');
{
  resetRoot();
  const { submitKanbanJob, serializeKanbanJobResult } = require('./hermes-kanban');
  const { saveStatus, resultPath } = require('./jobs');
  const created = submitKanbanJob({ task_id: 't_result001', title: 'Result test', body: 'Do it', repo: '/tmp/repo' });
  saveStatus(created.job_id, { state: 'verified', exit_code: 0, last_output_excerpt: 'done' });
  fs.writeFileSync(resultPath(created.job_id), JSON.stringify({
    job_id: created.job_id,
    state: 'verified',
    commit: 'abc1234',
    branch: 'feat/test',
    pushed: 'yes',
    pr_url: 'https://github.com/owner/repo/pull/1',
    prod: 'no',
    verified: 'npm test',
    blocker: null,
    summary: 'Implemented and tested.',
    updated_at: '2026-01-01T00:00:00.000Z',
  }, null, 2) + '\n');
  const out = serializeKanbanJobResult(created.job_id);
  assert(out.ok === true, 'serialization succeeds');
  assert(out.terminal === true, 'verified is terminal');
  assert(out.kanban?.task_id === 't_result001', 'serialized result carries Kanban task id');
  assert(out.ccp?.job_id === created.job_id, 'serialized result carries CCP job id');
  assert(out.result?.pr_url === 'https://github.com/owner/repo/pull/1', 'PR URL preserved');
  assert(out.evidence?.repository?.repo === '/tmp/repo', 'evidence includes repository path');
  assert(out.evidence?.repository?.commit === 'abc1234', 'evidence includes commit');
  assert(out.evidence?.tests?.verification === 'npm test', 'evidence includes tests/verification');
  assert(out.evidence?.pr?.url === 'https://github.com/owner/repo/pull/1', 'evidence includes PR URL');
  assert(out.evidence?.deploy?.prod === 'no', 'evidence includes deploy/prod state');
  assert(String(out.evidence?.logs?.worker_log_path || '').endsWith('/worker.log'), 'evidence includes worker log path');
  assert(out.handoff?.summary.includes('CCP job'), 'human handoff summary is generated');
  assert(out.handoff?.metadata.ccp_job_id === created.job_id, 'machine metadata includes ccp job id');
  assert(out.handoff?.metadata.tests_or_verification === 'npm test', 'verification string mapped for Kanban');
}


console.log('\nTest: Kanban handoff action completes only for final successful states');
{
  resetRoot();
  const { submitKanbanJob, serializeKanbanJobResult } = require('./hermes-kanban');
  const { saveStatus, resultPath } = require('./jobs');
  const created = submitKanbanJob({ task_id: 't_action_done', title: 'Done action', body: 'Do it', repo: '/tmp/repo' });
  saveStatus(created.job_id, { state: 'done', exit_code: 0, last_output_excerpt: 'merged' });
  fs.writeFileSync(resultPath(created.job_id), JSON.stringify({
    job_id: created.job_id,
    state: 'verified',
    commit: 'abc1234',
    branch: 'feat/test',
    pushed: 'yes',
    pr_url: 'https://github.com/owner/repo/pull/1',
    prod: 'no',
    verified: 'npm test and PR merged',
    blocker: null,
    summary: 'Merged and verified.',
    updated_at: '2026-01-01T00:00:00.000Z',
  }, null, 2) + '\n');
  const out = serializeKanbanJobResult(created.job_id);
  assert((out.handoff as Record<string, unknown>)?.action === 'complete', 'done/verified handoff action is complete');
}

console.log('\nTest: Kanban handoff action completes when status is done and stale result is coded');
{
  resetRoot();
  const { submitKanbanJob, serializeKanbanJobResult } = require('./hermes-kanban');
  const { saveStatus, resultPath } = require('./jobs');
  const created = submitKanbanJob({ task_id: 't_action_done_stale_coded', title: 'Merged action', body: 'Do it', repo: '/tmp/repo' });
  saveStatus(created.job_id, { state: 'done', exit_code: 0, last_output_excerpt: 'PR merged' });
  fs.writeFileSync(resultPath(created.job_id), JSON.stringify({
    job_id: created.job_id,
    state: 'coded',
    commit: 'abc1234',
    branch: 'feat/test',
    pushed: 'yes',
    pr_url: 'https://github.com/owner/repo/pull/1',
    prod: 'no',
    verified: 'tests passed before merge',
    blocker: null,
    summary: 'PR opened before watcher marked status done.',
    updated_at: '2026-01-01T00:00:00.000Z',
  }, null, 2) + '\n');
  const out = serializeKanbanJobResult(created.job_id);
  assert((out.handoff as Record<string, unknown>)?.action === 'complete', 'done status is authoritative even when result state is stale coded');
}

console.log('\nTest: Kanban handoff action completes for successful no-op result');
{
  resetRoot();
  const { submitKanbanJob, serializeKanbanJobResult } = require('./hermes-kanban');
  const { saveStatus, resultPath } = require('./jobs');
  const created = submitKanbanJob({ task_id: 't_action_noop_success', title: 'No-op action', body: 'Do it', repo: '/tmp/repo' });
  saveStatus(created.job_id, { state: 'no-op', exit_code: 0, last_output_excerpt: 'already satisfied' });
  fs.writeFileSync(resultPath(created.job_id), JSON.stringify({
    job_id: created.job_id,
    state: 'no-op',
    commit: 'none',
    branch: 'main',
    pushed: 'no',
    pr_url: null,
    prod: 'no',
    verified: 'npm test and clean repo evidence passed',
    blocker: null,
    worker_exit_code: 0,
    summary: 'No product change required; verification passed.',
    updated_at: '2026-01-01T00:00:00.000Z',
  }, null, 2) + '\n');
  const out = serializeKanbanJobResult(created.job_id);
  assert((out.handoff as Record<string, unknown>)?.action === 'complete', 'successful no-op handoff action is complete');
  assert(out.terminal === true, 'successful no-op is terminal for Kanban');
}

console.log('\nTest: Kanban handoff action blocks when no-op has blocker');
{
  resetRoot();
  const { submitKanbanJob, serializeKanbanJobResult } = require('./hermes-kanban');
  const { saveStatus, resultPath } = require('./jobs');
  const created = submitKanbanJob({ task_id: 't_action_noop_blocked', title: 'No-op blocked action', body: 'Do it', repo: '/tmp/repo' });
  saveStatus(created.job_id, { state: 'no-op', exit_code: 0, last_output_excerpt: 'needs human review' });
  fs.writeFileSync(resultPath(created.job_id), JSON.stringify({
    job_id: created.job_id,
    state: 'no-op',
    commit: 'none',
    prod: 'no',
    verified: 'not yet',
    blocker: 'needs human review',
    worker_exit_code: 0,
    summary: 'No-op could not be accepted without review.',
    updated_at: '2026-01-01T00:00:00.000Z',
  }, null, 2) + '\n');
  const out = serializeKanbanJobResult(created.job_id);
  assert((out.handoff as Record<string, unknown>)?.action === 'block', 'blocked no-op handoff action is block');
  assert((out.handoff as Record<string, unknown>)?.block_reason === 'needs human review', 'blocked no-op preserves blocker reason');
}

console.log('\nTest: Kanban handoff action waits for coded and running states');
{
  resetRoot();
  const { submitKanbanJob, serializeKanbanJobResult } = require('./hermes-kanban');
  const { saveStatus, resultPath } = require('./jobs');
  const coded = submitKanbanJob({ task_id: 't_action_coded', title: 'Coded action', body: 'Do it', repo: '/tmp/repo' });
  saveStatus(coded.job_id, { state: 'coded', exit_code: 0, last_output_excerpt: 'PR opened' });
  fs.writeFileSync(resultPath(coded.job_id), JSON.stringify({
    job_id: coded.job_id,
    state: 'coded',
    commit: 'def5678',
    branch: 'feat/test',
    pushed: 'yes',
    pr_url: 'https://github.com/owner/repo/pull/2',
    prod: 'no',
    verified: 'tests passed, awaiting PR merge',
    blocker: null,
    summary: 'PR open.',
    updated_at: '2026-01-01T00:00:00.000Z',
  }, null, 2) + '\n');
  const codedOut = serializeKanbanJobResult(coded.job_id);
  assert((codedOut.handoff as Record<string, unknown>)?.action === 'wait', 'coded handoff action is wait');

  const running = submitKanbanJob({ task_id: 't_action_running', title: 'Running action', body: 'Do it', repo: '/tmp/repo' });
  saveStatus(running.job_id, { state: 'running', exit_code: null, last_output_excerpt: 'working' });
  const runningOut = serializeKanbanJobResult(running.job_id);
  assert((runningOut.handoff as Record<string, unknown>)?.action === 'wait', 'running handoff action is wait');
}

console.log('\nTest: Kanban handoff action blocks for blocked and harness-failure states');
{
  resetRoot();
  const { submitKanbanJob, serializeKanbanJobResult } = require('./hermes-kanban');
  const { saveStatus, resultPath } = require('./jobs');
  const blocked = submitKanbanJob({ task_id: 't_action_blocked', title: 'Blocked action', body: 'Do it', repo: '/tmp/repo' });
  saveStatus(blocked.job_id, { state: 'blocked', exit_code: 1, last_output_excerpt: 'needs API key' });
  const blockedOut = serializeKanbanJobResult(blocked.job_id);
  assert((blockedOut.handoff as Record<string, unknown>)?.action === 'block', 'blocked handoff action is block');
  assert((blockedOut.handoff as Record<string, unknown>)?.block_reason === 'needs API key', 'blocked handoff keeps block reason');

  const harness = submitKanbanJob({ task_id: 't_action_harness', title: 'Harness action', body: 'Do it', repo: '/tmp/repo' });
  saveStatus(harness.job_id, { state: 'harness-failure', exit_code: 1, last_output_excerpt: 'worker summary missing' });
  fs.writeFileSync(resultPath(harness.job_id), JSON.stringify({
    job_id: harness.job_id,
    state: 'harness-failure',
    commit: 'none',
    prod: 'no',
    verified: 'not yet',
    blocker: 'worker summary missing',
    summary: null,
    updated_at: '2026-01-01T00:00:00.000Z',
  }, null, 2) + '\n');
  const harnessOut = serializeKanbanJobResult(harness.job_id);
  assert((harnessOut.handoff as Record<string, unknown>)?.action === 'block', 'harness-failure handoff action is block');
}


console.log('\nTest: Kanban adapter rejects legacy Linear migration envelopes without persisting a job');
{
  const root = resetRoot();
  const { submitKanbanJob } = require('./hermes-kanban');
  let message = '';
  try {
    submitKanbanJob({
      task_id: 't_legacy_linear',
      title: 'Legacy migrated card',
      body: 'Imported from Linear for local Hermes execution.\n\nDo not run this stale card.',
      repo: '/tmp/repo',
    });
  } catch (error) {
    message = String((error as Error).message || error);
  }
  assert(/archive\/recreate|archive and recreate|recreate/i.test(message), 'legacy migration rejection tells board owner to archive/recreate natively');
  assert(!fs.existsSync(path.join(root, 'jobs', 'kanban_t_legacy_linear')), 'legacy migration rejection does not persist a job directory');
}

console.log('\nTest: Kanban adapter rejects linear-migration metadata without persisting packet');
{
  const root = resetRoot();
  const { buildKanbanJobPacket, submitKanbanJob } = require('./hermes-kanban');
  let buildMessage = '';
  try {
    buildKanbanJobPacket({ task_id: 't_legacy_meta_build', title: 'Legacy meta', body: 'Plain body', metadata: { created_by: 'linear-migration' } });
  } catch (error) {
    buildMessage = String((error as Error).message || error);
  }
  assert(/legacy Linear/i.test(buildMessage), 'created_by=linear-migration is rejected during packet build');
  let submitMessage = '';
  try {
    submitKanbanJob({ task_id: 't_legacy_meta_submit', title: 'Legacy meta', body: 'Plain body', metadata: { source: 'linear-migration' } });
  } catch (error) {
    submitMessage = String((error as Error).message || error);
  }
  assert(/legacy Linear/i.test(submitMessage), 'source=linear-migration is rejected during submit');
  assert(!fs.existsSync(path.join(root, 'jobs', 'kanban_t_legacy_meta_submit')), 'linear-migration metadata rejection does not persist packet');
}

console.log('\nTest: Kanban adapter strips legacy Linear comments but accepts native Linear cleanup prose');
{
  resetRoot();
  const { buildKanbanJobPacket } = require('./hermes-kanban');
  const packet: JobPacket = buildKanbanJobPacket({
    task_id: 't_native_linear_cleanup',
    title: 'Retire Linear cleanup path',
    body: 'Normal native task prose may mention Linear for cleanup work.\n\n## Linear comments\n- stale imported discussion that must not enter the CCP packet',
    worker_context: '# Context\nKeep native Hermes Kanban Linear-free.\n\n### Linear comments\nold migrated comments',
    comments: [{ heading: 'Linear comments', body: 'stale migrated discussion' }, { body: 'native board comment' }],
    repo: '/tmp/repo',
  });
  const serialized = JSON.stringify(packet);
  assert(packet.job_id === 'kanban_t_native_linear_cleanup', 'native task mentioning Linear uses kanban job id');
  assert(packet.metadata?.source_transport === 'hermes-kanban', 'native task keeps hermes-kanban transport');
  assert(!serialized.includes('stale imported discussion') && !serialized.includes('old migrated comments'), 'legacy Linear comments are not copied into packet metadata/body/context');
  assert(serialized.includes('Normal native task prose may mention Linear'), 'normal native Linear cleanup prose is preserved');
}

console.log(`\nTotal: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
