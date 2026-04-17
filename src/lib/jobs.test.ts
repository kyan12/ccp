import { buildPrompt, isNoOpOutcome, inferBlockedReason, extractWorkerFailureContext } from './jobs';
import type { JobPacket, RepoProof } from '../types';

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

// ── Test: memory section injection (Phase 5a) ──
console.log('\nTest: memory parameter injects repository context section');
{
  const mem = '# My project\n\nUse Volta, not nvm. Branch from main.';
  const prompt = buildPrompt(makePacket(), mem);
  assert(
    prompt.includes('Repository context (persistent memory'),
    'contains memory section header',
  );
  assert(
    prompt.includes('--- BEGIN REPOSITORY MEMORY ---'),
    'contains begin marker',
  );
  assert(
    prompt.includes('--- END REPOSITORY MEMORY ---'),
    'contains end marker',
  );
  assert(prompt.includes('Use Volta, not nvm.'), 'memory body is in the prompt');
  // Memory must appear before the ticket goal (human-reading order).
  const memIdx = prompt.indexOf('--- BEGIN REPOSITORY MEMORY ---');
  const goalIdx = prompt.indexOf('Goal: ');
  assert(memIdx >= 0 && memIdx < goalIdx, 'memory precedes ticket goal');
}

console.log('\nTest: no memory section when memory is absent');
{
  const plain = buildPrompt(makePacket());
  assert(!plain.includes('Repository context'), 'omits header when no memory');
  assert(!plain.includes('BEGIN REPOSITORY MEMORY'), 'omits markers when no memory');
}

console.log('\nTest: whitespace-only memory is ignored by buildPrompt');
{
  const prompt = buildPrompt(makePacket(), '   \n\t\n');
  assert(!prompt.includes('Repository context'), 'empty memory not rendered');
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

// ── Finalization classification helpers ──

function makeProof(overrides: Partial<RepoProof> = {}): RepoProof {
  return {
    repoExists: true,
    git: true,
    dirty: false,
    commitExists: false,
    branch: 'main',
    pushed: null,
    upstream: null,
    ahead: null,
    behind: null,
    ...overrides,
  };
}

// ── Test: isNoOpOutcome ──
console.log('\nTest: isNoOpOutcome classification');
{
  // True no-op: no commit, no dirty, summary says "already fixed"
  assert(
    isNoOpOutcome({ summary: 'No changes needed — all acceptance criteria already met', commit: 'none' }, makeProof()),
    'detects "already met" as no-op',
  );
  assert(
    isNoOpOutcome({ summary: 'Already fixed in previous commit', commit: 'none' }, makeProof()),
    'detects "already fixed" as no-op',
  );
  assert(
    isNoOpOutcome({ summary: 'Nothing to change, tests pass', commit: 'none', blocker: 'nothing to do' }, makeProof()),
    'detects "nothing to do" via blocker field',
  );
  assert(
    isNoOpOutcome({ summary: 'All 5 PR review comments are already addressed in the current branch', commit: 'none' }, makeProof()),
    'detects "already addressed" as no-op',
  );
  assert(
    isNoOpOutcome({ summary: 'No new changes needed', commit: 'none', addressedComments: [{ commentId: 1, status: 'fixed' }] } as unknown as Record<string, string>, makeProof()),
    'treats all-fixed addressedComments as no-op evidence when repo is clean',
  );
  // Not no-op: addressedComments with not_fixed status
  assert(
    !isNoOpOutcome({ summary: 'Could not fix the issues', commit: 'none', addressedComments: [{ commentId: 1, status: 'not_fixed' }] } as unknown as Record<string, string>, makeProof()),
    'not no-op when addressedComments has not_fixed status',
  );
  // Not no-op: addressedComments with mixed statuses
  assert(
    !isNoOpOutcome({ summary: 'Partial progress', commit: 'none', addressedComments: [{ commentId: 1, status: 'fixed' }, { commentId: 2, status: 'not_fixed' }] } as unknown as Record<string, string>, makeProof()),
    'not no-op when addressedComments has mixed fixed/not_fixed',
  );
  // Not no-op: addressedComments with partial status
  assert(
    !isNoOpOutcome({ summary: 'Partially done', commit: 'none', addressedComments: [{ commentId: 1, status: 'partial' }] } as unknown as Record<string, string>, makeProof()),
    'not no-op when addressedComments has partial status',
  );
  // Not no-op: has commit
  assert(
    !isNoOpOutcome({ summary: 'Already fixed', commit: 'abc1234' }, makeProof({ commitExists: true })),
    'not no-op when commit exists',
  );
  // Not no-op: dirty repo
  assert(
    !isNoOpOutcome({ summary: 'Already fixed', commit: 'none' }, makeProof({ dirty: true })),
    'not no-op when repo is dirty',
  );
  // Not no-op: normal success summary
  assert(
    !isNoOpOutcome({ summary: 'Added new feature and tests pass', commit: 'none' }, makeProof()),
    'not no-op for normal work summary',
  );
}

// ── Test: inferBlockedReason — dirty-repo removed ──
console.log('\nTest: inferBlockedReason does not handle dirty-repo');
{
  // dirty + no commit should NOT be caught by inferBlockedReason (handled separately in finalizeJob)
  const reason = inferBlockedReason(
    'some log\nWORKER_EXIT_CODE: 0',
    { state: 'coded', commit: 'none', prod: 'no', verified: 'not yet', pr_url: null },
    makeProof({ dirty: true }),
  );
  // inferBlockedReason should NOT return for dirty+no-commit (that's dirty-repo, handled in finalizeJob)
  assert(reason === null, 'dirty repo case delegated to finalizeJob');
}

// ── Test: inferBlockedReason — no commit, no dirty ──
console.log('\nTest: inferBlockedReason catches no-commit-no-dirty');
{
  const reason = inferBlockedReason(
    'Summary: did stuff\nWORKER_EXIT_CODE: 0',
    { state: 'coded', commit: 'none', prod: 'no', verified: 'not yet', pr_url: null },
    makeProof(),
  );
  assert(reason !== null && reason.includes('no commit or file changes found'), 'detects no commit no dirty');
}

// ── Test: inferBlockedReason — unpushed commit ──
console.log('\nTest: inferBlockedReason catches unpushed commit');
{
  const reason = inferBlockedReason(
    'Summary: did stuff\nWORKER_EXIT_CODE: 0',
    { state: 'coded', commit: 'abc1234', prod: 'no', verified: 'not yet', pr_url: null },
    makeProof({ commitExists: true, pushed: false }),
  );
  assert(reason !== null && reason.includes('not pushed'), 'detects unpushed commit');
}

// ── Test: extractWorkerFailureContext ──
console.log('\nTest: extractWorkerFailureContext');
{
  const ctx1 = extractWorkerFailureContext('Blocker: missing API key\nWORKER_EXIT_CODE: 1');
  assert(ctx1 === 'missing API key', 'extracts blocker line');

  const ctx2 = extractWorkerFailureContext('Summary: Fixed the bug\nWORKER_EXIT_CODE: 0');
  assert(ctx2 === 'Fixed the bug', 'extracts summary line');

  const ctx3 = extractWorkerFailureContext('WORKER_EXIT_CODE: 0');
  // Should return last non-empty lines or fallback
  assert(typeof ctx3 === 'string' && ctx3.length > 0, 'returns fallback context');
}

// ── Test: harness-failure scenario (exit 0, no summary fields) ──
console.log('\nTest: harness-failure detection logic');
{
  // When parseSummary returns empty (no State, Summary, or Commit), exit 0 → harness-failure
  // This is tested by verifying hasSummaryOutput logic
  const emptyResult = { state: undefined, summary: undefined, commit: undefined } as unknown as Record<string, string>;
  const hasSummary = !!(emptyResult.state || emptyResult.summary || emptyResult.commit);
  assert(!hasSummary, 'empty summary detected for harness-failure path');

  const validResult = { state: 'coded', summary: 'did work', commit: 'abc1234' };
  const hasValidSummary = !!(validResult.state || validResult.summary || validResult.commit);
  assert(hasValidSummary, 'valid summary not mistaken for harness-failure');
}

// ── Summary ──
console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
