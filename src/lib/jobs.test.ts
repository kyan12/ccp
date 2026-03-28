import { buildPrompt } from './jobs';
import type { JobPacket } from '../types';

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

function makePacket(overrides: Partial<JobPacket> = {}): JobPacket {
  return {
    job_id: 'test_1',
    ticket_id: 'TEST-1',
    repo: '/tmp/repo',
    goal: 'Do something',
    source: 'test',
    kind: 'task',
    label: 'test',
    ...overrides,
  };
}

// ── Test: non-interactive constraint is present ──
console.log('\nTest: non-interactive constraint in prompt');
{
  const prompt = buildPrompt(makePacket());
  assert(
    prompt.includes('Never ask clarifying questions. You are running non-interactively — no one will answer.'),
    'contains non-interactive instruction',
  );
  assert(
    prompt.includes('If the ticket is ambiguous, investigate the codebase and make your best judgment.'),
    'contains ambiguity investigation instruction',
  );
  assert(
    prompt.includes('If truly blocked (missing credentials, broken build, etc.), exit with a clear blocker description — do not ask questions.'),
    'contains blocker exit instruction',
  );
}

// ── Test: clear ticket still works (no breakage) ──
console.log('\nTest: clear ticket produces valid prompt');
{
  const prompt = buildPrompt(makePacket({
    goal: 'Fix the login button color to blue',
    acceptance_criteria: ['Login button is blue', 'No other buttons changed'],
    verification_steps: ['Open the login page', 'Verify button is blue'],
  }));
  assert(prompt.includes('Ticket: TEST-1'), 'contains ticket id');
  assert(prompt.includes('Fix the login button color to blue'), 'contains goal');
  assert(prompt.includes('- [ ] Login button is blue'), 'contains acceptance criteria');
  assert(prompt.includes('1. Open the login page'), 'contains verification steps');
  assert(prompt.includes('Never ask clarifying questions'), 'still has non-interactive constraint');
}

// ── Test: ambiguous ticket - worker should investigate, not ask ──
console.log('\nTest: ambiguous ticket directs investigation');
{
  const prompt = buildPrompt(makePacket({
    goal: 'Update the H1 on 3 pages',
  }));
  // The prompt must tell the worker to investigate, not ask
  assert(
    prompt.includes('investigate the codebase and make your best judgment'),
    'ambiguous ticket prompt directs investigation',
  );
  assert(
    !prompt.includes('which pages') && !prompt.includes('Which pages'),
    'prompt does not ask clarifying questions itself',
  );
  // Non-interactive constraint must still be present
  assert(
    prompt.includes('no one will answer'),
    'non-interactive warning present for ambiguous ticket',
  );
}

// ── Test: blocked scenario directs blocker description ──
console.log('\nTest: blocked scenario directs blocker output');
{
  const prompt = buildPrompt(makePacket({
    goal: 'Deploy to production using AWS credentials',
  }));
  assert(
    prompt.includes('exit with a clear blocker description'),
    'prompt directs clear blocker description on true blockers',
  );
  assert(
    prompt.includes('do not ask questions'),
    'prompt says do not ask questions when blocked',
  );
}

// ── Test: review feedback prompt still works ──
console.log('\nTest: review feedback preserved');
{
  const prompt = buildPrompt(makePacket({
    review_feedback: ['Fix the typo in README'],
  }));
  assert(prompt.includes('Fix the typo in README'), 'review feedback included');
  assert(prompt.includes('Never ask clarifying questions'), 'non-interactive constraint with review feedback');
}

// ── Summary ──
console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
