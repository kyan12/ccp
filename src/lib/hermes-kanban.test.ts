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
  assert(out.handoff?.summary.includes('CCP job'), 'human handoff summary is generated');
  assert(out.handoff?.metadata.ccp_job_id === created.job_id, 'machine metadata includes ccp job id');
  assert(out.handoff?.metadata.tests_or_verification === 'npm test', 'verification string mapped for Kanban');
}

console.log(`\nTotal: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
