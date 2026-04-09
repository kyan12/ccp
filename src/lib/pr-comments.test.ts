import type { ReviewComment, AddressedComment } from '../types';

const {
  fetchPrReviewComments,
  formatCommentReply,
  buildSummaryBody,
  parsePrUrl,
} = require('./pr-comments');

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

// ── Test: parsePrUrl ──
console.log('\nTest: parsePrUrl');
{
  const valid = parsePrUrl('https://github.com/owner/repo/pull/42');
  assert(valid !== null && valid.ownerRepo === 'owner/repo' && valid.number === 42, 'parses valid PR URL');

  assert(parsePrUrl(null) === null, 'returns null for null');
  assert(parsePrUrl('https://example.com/not-a-pr') === null, 'returns null for non-GitHub URL');
}

// ── Test: formatCommentReply ──
console.log('\nTest: formatCommentReply');
{
  const fixed: AddressedComment = { commentId: 1, status: 'fixed', explanation: 'Resolved the issue', commitSha: 'abc1234567' };
  const fixedReply = formatCommentReply(fixed);
  assert(fixedReply.includes('✅'), 'fixed reply has check emoji');
  assert(fixedReply.includes('Fixed'), 'fixed reply has Fixed label');
  assert(fixedReply.includes('abc1234'), 'fixed reply includes short commit SHA');

  const partial: AddressedComment = { commentId: 2, status: 'partial', explanation: 'Partially done' };
  const partialReply = formatCommentReply(partial);
  assert(partialReply.includes('⚠️'), 'partial reply has warning emoji');

  const notFixed: AddressedComment = { commentId: 3, status: 'not_fixed', explanation: 'Cannot fix' };
  const notFixedReply = formatCommentReply(notFixed);
  assert(notFixedReply.includes('❌'), 'not_fixed reply has X emoji');
}

// ── Test: buildSummaryBody ──
console.log('\nTest: buildSummaryBody');
{
  const comments: AddressedComment[] = [
    { commentId: 1, status: 'fixed', explanation: 'Done' },
    { commentId: 2, status: 'not_fixed', explanation: 'Blocked' },
    { commentId: 3, status: 'partial', explanation: 'WIP' },
  ];
  const body = buildSummaryBody(comments, 'deadbeef1234');
  assert(body.includes('Remediation Summary'), 'summary has title');
  assert(body.includes('deadbee'), 'summary includes commit SHA');
  assert(body.includes('1 |'), 'summary shows fixed count');
  assert(body.includes('Comment #2'), 'summary details not_fixed comment');
  assert(body.includes('Comment #3'), 'summary details partial comment');
}

// ── Test: fetchPrReviewComments excludes reply comments ──
// This is a unit-level structural test: we verify the filter logic by
// checking that the raw->ReviewComment pipeline filters in_reply_to_id.
// We can't call fetchPrReviewComments directly without gh, but we can
// verify the filter chain exists in the exported function's source.
console.log('\nTest: reply comment filtering (structural)');
{
  // The function source should include the in_reply_to_id filter
  const fnSrc = fetchPrReviewComments.toString();
  assert(
    fnSrc.includes('in_reply_to_id') && fnSrc.includes('filter'),
    'fetchPrReviewComments filters on in_reply_to_id',
  );
}

// ── Summary ──
console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
