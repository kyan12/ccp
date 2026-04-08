/**
 * pr-comments.ts — GitHub PR review comment fetching and threaded reply logic.
 *
 * Responsible for:
 * 1. Fetching structured review comments from a PR (commentId, path, line, body)
 * 2. Posting per-comment replies with fix details (what changed, commit SHA, why not fixed)
 * 3. Posting a top-level PR summary comment aggregating all addressed comments
 * 4. Optionally resolving review threads when comments are fully addressed
 * 5. Falling back to a single PR-level summary when threading is unavailable
 */

import { spawnSync } from 'child_process';
import type { RunResult, ReviewComment, AddressedComment } from '../types';

function run(command: string, args: string[] = [], options: Record<string, unknown> = {}): RunResult {
  return spawnSync(command, args, { encoding: 'utf8', ...options }) as unknown as RunResult;
}

function commandExists(cmd: string): string {
  const out = spawnSync('sh', ['-lc', `command -v ${cmd}`], { encoding: 'utf8' });
  return out.status === 0 ? out.stdout.trim() : '';
}

function parsePrUrl(prUrl: string | null | undefined): { ownerRepo: string; number: number } | null {
  const m = String(prUrl || '').match(/^https:\/\/github\.com\/([^/]+\/[^/]+)\/pull\/(\d+)/i);
  if (!m) return null;
  return { ownerRepo: m[1], number: Number(m[2]) };
}

// ── Fetch review comments ──

interface RawReviewComment {
  id?: number;
  databaseId?: number;
  path?: string;
  line?: number | null;
  position?: number | null;
  originalLine?: number | null;
  side?: string;
  body?: string;
  author?: { login?: string };
  user?: { login?: string };
  in_reply_to_id?: number | null;
  pull_request_review_id?: number | null;
}

/**
 * Fetch all review comments on a PR using the GitHub REST API via `gh`.
 * Returns structured ReviewComment[] with comment IDs, paths, lines, and bodies.
 */
function fetchPrReviewComments(prUrl: string): ReviewComment[] {
  const ref = parsePrUrl(prUrl);
  if (!ref) return [];

  const gh = commandExists('gh') || 'gh';

  // Use REST API to get review comments (these are the inline code comments)
  const out = run(gh, [
    'api',
    `repos/${ref.ownerRepo}/pulls/${ref.number}/comments`,
    '--paginate',
    '--jq', '.',
  ]);

  if (out.status !== 0) {
    console.error(`[pr-comments] failed to fetch review comments: ${(out.stderr || '').slice(0, 300)}`);
    return [];
  }

  let raw: RawReviewComment[];
  try {
    // gh api --paginate may return multiple JSON arrays; concatenate them
    const text = (out.stdout || '').trim();
    if (!text) return [];
    // Handle paginated output: gh api --paginate may return multiple JSON arrays
    // separated by whitespace. Try parsing as-is first (covers single-page and
    // valid JSON). Only attempt line-by-line splitting if the initial parse fails,
    // which avoids false-positive detection of `] [` inside comment body strings.
    let parsed: RawReviewComment[];
    try {
      const p = JSON.parse(text);
      parsed = Array.isArray(p) ? p : [p];
    } catch {
      // Initial parse failed — likely multiple JSON arrays from pagination.
      // Split on lines that are standalone `[` or `]` boundaries and parse each page.
      const pages: RawReviewComment[][] = [];
      let depth = 0;
      let start = -1;
      for (let i = 0; i < text.length; i++) {
        if (text[i] === '[' && depth === 0) { start = i; depth++; }
        else if (text[i] === '[') { depth++; }
        else if (text[i] === ']' && depth === 1) {
          depth--;
          if (start >= 0) {
            try { pages.push(JSON.parse(text.slice(start, i + 1))); } catch { /* skip malformed page */ }
          }
          start = -1;
        }
        else if (text[i] === ']') { depth--; }
        // Skip characters inside strings to avoid counting brackets in string values
        else if (text[i] === '"') {
          i++;
          while (i < text.length && text[i] !== '"') {
            if (text[i] === '\\') i++; // skip escaped char
            i++;
          }
        }
      }
      parsed = pages.flat();
    }
    raw = parsed;
  } catch (e) {
    console.error(`[pr-comments] failed to parse review comments JSON: ${(e as Error).message}`);
    return [];
  }

  return raw
    .filter((c) => c.body && c.path) // Only include comments with content and a file path
    .map((c): ReviewComment => ({
      commentId: c.id || c.databaseId || 0,
      threadId: c.pull_request_review_id || null,
      path: c.path || '',
      line: c.line ?? c.originalLine ?? c.position ?? null,
      side: c.side || undefined,
      body: c.body || '',
      author: c.author?.login || c.user?.login || undefined,
      inReplyToId: c.in_reply_to_id || null,
    }))
    .filter((c) => c.commentId > 0);
}

// ── Post per-comment replies ──

interface CommentReplyResult {
  commentId: number;
  ok: boolean;
  error?: string;
}

/**
 * Post a reply to a specific PR review comment.
 */
function replyToComment(ownerRepo: string, prNumber: number, commentId: number, body: string): CommentReplyResult {
  const gh = commandExists('gh') || 'gh';
  const out = run(gh, [
    'api',
    `repos/${ownerRepo}/pulls/${prNumber}/comments/${commentId}/replies`,
    '--method', 'POST',
    '--field', `body=${body}`,
  ]);

  if (out.status !== 0) {
    return { commentId, ok: false, error: (out.stderr || out.stdout || 'reply failed').trim().slice(0, 300) };
  }
  return { commentId, ok: true };
}

/**
 * Format the body of a comment reply based on the addressed comment data.
 */
function formatCommentReply(addressed: AddressedComment): string {
  const statusEmoji = addressed.status === 'fixed' ? '\u2705' : addressed.status === 'partial' ? '\u26a0\ufe0f' : '\u274c';
  const statusLabel = addressed.status === 'fixed' ? 'Fixed' : addressed.status === 'partial' ? 'Partially addressed' : 'Not fixed';

  const parts: string[] = [`${statusEmoji} **${statusLabel}**`];
  if (addressed.explanation) parts.push(addressed.explanation);
  if (addressed.commitSha) parts.push(`Commit: \`${addressed.commitSha.slice(0, 7)}\``);
  return parts.join('\n\n');
}

/**
 * Post replies to each addressed comment on the PR.
 * Returns results for each comment reply attempt.
 */
function postCommentReplies(
  ownerRepo: string,
  prNumber: number,
  addressedComments: AddressedComment[],
): CommentReplyResult[] {
  const results: CommentReplyResult[] = [];

  for (const addressed of addressedComments) {
    const body = formatCommentReply(addressed);
    const result = replyToComment(ownerRepo, prNumber, addressed.commentId, body);
    results.push(result);
  }

  return results;
}

// ── Top-level PR summary comment ──

/**
 * Build a markdown summary table of all addressed comments.
 */
function buildSummaryBody(addressedComments: AddressedComment[], commitSha?: string | null): string {
  const fixed = addressedComments.filter((c) => c.status === 'fixed');
  const partial = addressedComments.filter((c) => c.status === 'partial');
  const notFixed = addressedComments.filter((c) => c.status === 'not_fixed');

  const parts: string[] = ['## Remediation Summary'];

  if (commitSha) {
    parts.push(`\nCommit: \`${commitSha.slice(0, 7)}\``);
  }

  parts.push(`\n| Status | Count |`);
  parts.push(`|--------|-------|`);
  parts.push(`| \u2705 Fixed | ${fixed.length} |`);
  if (partial.length) parts.push(`| \u26a0\ufe0f Partial | ${partial.length} |`);
  if (notFixed.length) parts.push(`| \u274c Not fixed | ${notFixed.length} |`);
  parts.push(`| **Total** | **${addressedComments.length}** |`);

  if (notFixed.length > 0 || partial.length > 0) {
    parts.push('\n### Details');
    for (const c of [...partial, ...notFixed]) {
      const emoji = c.status === 'partial' ? '\u26a0\ufe0f' : '\u274c';
      parts.push(`- ${emoji} Comment #${c.commentId}: ${c.explanation}`);
    }
  }

  return parts.join('\n');
}

/**
 * Post a top-level PR comment summarizing all remediation actions.
 */
function postPrSummaryComment(
  ownerRepo: string,
  prNumber: number,
  addressedComments: AddressedComment[],
  commitSha?: string | null,
): { ok: boolean; error?: string } {
  if (addressedComments.length === 0) return { ok: true };

  const gh = commandExists('gh') || 'gh';
  const body = buildSummaryBody(addressedComments, commitSha);
  const out = run(gh, [
    'pr', 'comment', String(prNumber),
    '--repo', ownerRepo,
    '--body', body,
  ]);

  if (out.status !== 0) {
    return { ok: false, error: (out.stderr || out.stdout || 'comment failed').trim().slice(0, 300) };
  }
  return { ok: true };
}

// ── Thread resolution ──

/**
 * Attempt to resolve a review thread on GitHub.
 * Uses the GraphQL `resolveReviewThread` mutation which marks the thread as resolved
 * while keeping the discussion visible and expandable (unlike `minimizeComment` which hides it).
 *
 * Requires fetching the thread's GraphQL node ID from the comment's node ID.
 * If the thread ID cannot be determined, skips resolution rather than hiding the comment.
 */
function resolveThread(ownerRepo: string, commentId: number): { ok: boolean; error?: string } {
  const gh = commandExists('gh') || 'gh';

  // Get the GraphQL node_id for this comment
  const nodeOut = run(gh, [
    'api',
    `repos/${ownerRepo}/pulls/comments/${commentId}`,
    '--jq', '.node_id',
  ]);

  if (nodeOut.status !== 0 || !nodeOut.stdout.trim()) {
    return { ok: false, error: 'could not fetch comment node_id' };
  }

  const commentNodeId = nodeOut.stdout.trim();

  // Query the thread node ID from the comment's node ID via GraphQL
  const threadQuery = `query { node(id: "${commentNodeId}") { ... on PullRequestReviewComment { pullRequestReviewThread { id } } } }`;
  const threadOut = run(gh, ['api', 'graphql', '--field', `query=${threadQuery}`, '--jq', '.data.node.pullRequestReviewThread.id']);

  const threadId = (threadOut.stdout || '').trim();
  if (threadOut.status !== 0 || !threadId) {
    return { ok: false, error: 'could not determine thread node_id from comment — skipping resolution' };
  }

  // Resolve the review thread (keeps content visible, just marks as resolved)
  const resolveQuery = `mutation { resolveReviewThread(input: {threadId: "${threadId}"}) { thread { isResolved } } }`;
  const resolveOut = run(gh, ['api', 'graphql', '--field', `query=${resolveQuery}`]);

  if (resolveOut.status !== 0) {
    return { ok: false, error: (resolveOut.stderr || 'graphql resolveReviewThread failed').trim().slice(0, 200) };
  }

  return { ok: true };
}

// ── Orchestration ──

interface PostRemediationCommentsOpts {
  prUrl: string;
  addressedComments: AddressedComment[];
  commitSha?: string | null;
  resolveThreads?: boolean;
}

interface PostRemediationCommentsResult {
  ok: boolean;
  replyResults: CommentReplyResult[];
  summaryResult: { ok: boolean; error?: string };
  resolveResults: Array<{ commentId: number; ok: boolean; error?: string }>;
  fallbackUsed: boolean;
}

/**
 * Main orchestration function: after a remediation job completes,
 * post per-comment replies and a top-level summary.
 *
 * Falls back to a single PR-level summary if per-comment threading fails.
 */
function postRemediationComments(opts: PostRemediationCommentsOpts): PostRemediationCommentsResult {
  const ref = parsePrUrl(opts.prUrl);
  if (!ref) {
    return {
      ok: false,
      replyResults: [],
      summaryResult: { ok: false, error: 'invalid PR URL' },
      resolveResults: [],
      fallbackUsed: false,
    };
  }

  const { ownerRepo, number: prNumber } = ref;
  const result: PostRemediationCommentsResult = {
    ok: true,
    replyResults: [],
    summaryResult: { ok: true },
    resolveResults: [],
    fallbackUsed: false,
  };

  // 1. Post individual replies to each addressed comment
  if (opts.addressedComments.length > 0) {
    result.replyResults = postCommentReplies(ownerRepo, prNumber, opts.addressedComments);

    // Check if per-comment replies mostly failed (threading unavailable)
    const failCount = result.replyResults.filter((r) => !r.ok).length;
    if (failCount > 0 && failCount === result.replyResults.length) {
      // All per-comment replies failed — fall back to PR-level summary only
      result.fallbackUsed = true;
    }
  }

  // 2. Post top-level summary comment
  result.summaryResult = postPrSummaryComment(ownerRepo, prNumber, opts.addressedComments, opts.commitSha);
  if (!result.summaryResult.ok) result.ok = false;

  // 3. Optionally resolve threads for fully-fixed comments
  if (opts.resolveThreads) {
    const fixedComments = opts.addressedComments.filter((c) => c.status === 'fixed');
    for (const addressed of fixedComments) {
      const resolveResult = resolveThread(ownerRepo, addressed.commentId);
      result.resolveResults.push({ commentId: addressed.commentId, ...resolveResult });
    }
  }

  return result;
}

module.exports = {
  fetchPrReviewComments,
  postCommentReplies,
  postPrSummaryComment,
  postRemediationComments,
  resolveThread,
  formatCommentReply,
  buildSummaryBody,
  replyToComment,
  parsePrUrl,
};

export {
  fetchPrReviewComments,
  postCommentReplies,
  postPrSummaryComment,
  postRemediationComments,
  resolveThread,
  formatCommentReply,
  buildSummaryBody,
  replyToComment,
  parsePrUrl,
};
