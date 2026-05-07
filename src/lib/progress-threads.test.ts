import { buildRepoProgressSummary, progressLocalDate } from './progress-threads';
import type { JobPacket, JobResult, JobStatus } from '../types';

let passed = 0;
let failed = 0;

function assert(condition: boolean, msg: string) {
  if (condition) {
    passed++;
    console.log(`  PASS: ${msg}`);
  } else {
    failed++;
    console.error(`  FAIL: ${msg}`);
  }
}

function packet(overrides: Partial<JobPacket> = {}): JobPacket {
  return {
    job_id: 'nightly_webair_2026-05-07',
    ticket_id: 'NIGHTLY-webair',
    repo: '/tmp/webair.ai-chat-mvp',
    repoKey: 'webair-ai-chat-mvp',
    ownerRepo: 'WebAir-AI/Webair.ai-CHAT-MVP',
    goal: 'Nightly compound: review recent work, extract learnings, implement top priority',
    source: 'nightly',
    kind: 'compound',
    label: 'nightly',
    ...overrides,
  };
}

function status(overrides: Partial<JobStatus> = {}): JobStatus {
  return {
    job_id: 'nightly_webair_2026-05-07',
    ticket_id: 'NIGHTLY-webair',
    repo: '/tmp/webair.ai-chat-mvp',
    state: 'coded',
    started_at: '2026-05-07T02:00:00.000Z',
    updated_at: '2026-05-07T02:05:00.000Z',
    elapsed_sec: 300,
    tmux_session: null,
    last_heartbeat_at: null,
    last_output_excerpt: '',
    exit_code: 0,
    ...overrides,
  };
}

function result(overrides: Partial<JobResult> = {}): JobResult {
  return {
    job_id: 'nightly_webair_2026-05-07',
    state: 'coded',
    commit: 'abcdef1234567890',
    branch: 'nightly/test',
    pushed: 'yes',
    pr_url: 'https://github.com/WebAir-AI/Webair.ai-CHAT-MVP/pull/123',
    prod: 'no',
    verified: 'npm test',
    blocker: null,
    risk: 'low',
    summary: 'Added deterministic progress summaries.',
    learning: 'The repo needs grouped morning summaries, not scattered job posts.',
    implemented: 'Created per-repo progress thread routing.',
    tmux_session: null,
    worker_exit_code: 0,
    updated_at: '2026-05-07T02:05:00.000Z',
    ...overrides,
  };
}

console.log('\nTest: progress local date uses America/New_York');
{
  assert(progressLocalDate(new Date('2026-05-07T03:30:00.000Z')) === '2026-05-06', 'UTC early morning maps to prior ET day');
  assert(progressLocalDate(new Date('2026-05-07T14:30:00.000Z')) === '2026-05-07', 'UTC daytime maps to same ET day');
}

console.log('Test: nightly progress summary includes learning and additions');
{
  const msg = buildRepoProgressSummary(packet(), status(), result());
  assert(msg.includes('Nightly compound'), 'labels nightly compound');
  assert(msg.includes('Learned: The repo needs grouped morning summaries'), 'includes learning line');
  assert(msg.includes('Added: Created per-repo progress thread routing.'), 'includes implemented line as Added');
  assert(msg.includes('PR: https://github.com/WebAir-AI/Webair.ai-CHAT-MVP/pull/123'), 'includes PR URL');
  assert(msg.length <= 1900, 'stays below Discord safety limit');
}

console.log('Test: non-nightly progress summary is an implementation run');
{
  const msg = buildRepoProgressSummary(packet({ source: 'linear', kind: 'task', label: 'feature', ticket_id: 'PRO-123' }), status(), result({ learning: null, implemented: null }));
  assert(msg.includes('Implementation run'), 'labels implementation run');
  assert(msg.includes('PRO-123'), 'includes implementation ticket');
}

if (failed > 0) {
  console.error(`\n${failed} progress thread tests failed (${passed} passed)`);
  process.exit(1);
}
console.log(`\nAll progress thread tests passed (${passed})`);
