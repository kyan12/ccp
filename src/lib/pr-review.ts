import { spawnSync } from 'child_process';
import type { RunResult, ChecksSummary, CheckInfo, PRClassification, PRReviewResult } from '../types';

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

function ghJson(args: string[]): Record<string, unknown> {
  const gh = commandExists('gh') || 'gh';
  const out = run(gh, args);
  if (out.status !== 0) {
    throw new Error((out.stderr || out.stdout || 'gh command failed').trim());
  }
  return JSON.parse(out.stdout || '{}');
}

interface StatusCheckItem {
  __typename?: string;
  status?: string;
  conclusion?: string;
  state?: string;
  name?: string;
  context?: string;
  detailsUrl?: string;
  targetUrl?: string;
}

function summarizeChecks(statusCheckRollup: StatusCheckItem[] = []): ChecksSummary {
  const checks: CheckInfo[] = [];
  let hasPending = false;
  let hasFailure = false;
  let hasSuccess = false;
  for (const item of statusCheckRollup || []) {
    let state: string | null = null;
    if (item.__typename === 'CheckRun') {
      state = item.status === 'COMPLETED' ? (item.conclusion || 'UNKNOWN') : (item.status || null);
    } else if (item.__typename === 'StatusContext') {
      state = item.state || null;
    }
    const normalized = String(state || '').toUpperCase();
    checks.push({
      name: item.name || item.context || 'unknown',
      state: normalized || 'UNKNOWN',
      url: item.detailsUrl || item.targetUrl || null,
    });
    if (['FAILURE', 'ERROR', 'CANCELLED', 'TIMED_OUT', 'ACTION_REQUIRED'].includes(normalized)) hasFailure = true;
    else if (['PENDING', 'QUEUED', 'IN_PROGRESS', 'EXPECTED', 'WAITING', 'REQUESTED'].includes(normalized)) hasPending = true;
    else if (['SUCCESS', 'NEUTRAL', 'SKIPPED'].includes(normalized)) hasSuccess = true;
  }
  return { checks, hasPending, hasFailure, hasSuccess };
}

function classifyPr(pr: Record<string, unknown>): PRClassification {
  const mergeable = String(pr.mergeable || 'UNKNOWN').toUpperCase();
  const reviewDecision = String(pr.reviewDecision || '').toUpperCase();
  const checks = summarizeChecks(pr.statusCheckRollup as StatusCheckItem[] || []);
  const failedChecks = checks.checks.filter((c) => ['FAILURE', 'ERROR', 'CANCELLED', 'TIMED_OUT', 'ACTION_REQUIRED'].includes(c.state));
  const pendingChecks = checks.checks.filter((c) => ['PENDING', 'QUEUED', 'IN_PROGRESS', 'EXPECTED', 'WAITING', 'REQUESTED'].includes(c.state));

  const blockers: string[] = [];
  if (pr.state !== 'OPEN') blockers.push(`pr is ${String(pr.state).toLowerCase()}`);
  if (pr.isDraft) blockers.push('pr is draft');
  if (mergeable === 'CONFLICTING') blockers.push('merge conflicts');
  if (checks.hasFailure) blockers.push('required checks failing');
  if (checks.hasPending) blockers.push('checks still pending');
  if (reviewDecision === 'CHANGES_REQUESTED') blockers.push('changes requested');

  let blockerType = 'none';
  if (failedChecks.some((c) => /vercel/i.test(c.name))) blockerType = 'deploy';
  else if (failedChecks.length) blockerType = 'checks';
  else if (pendingChecks.length) blockerType = 'pending';
  else if (blockers.some((b) => /changes requested/.test(b))) blockerType = 'review';
  else if (blockers.some((b) => /conflict/.test(b))) blockerType = 'merge';

  let disposition = 'hold';
  if (blockers.length === 0) disposition = 'approve';
  else if (blockers.some((b) => /conflict|failing|changes requested/.test(b))) disposition = 'block';

  return {
    disposition,
    blockers,
    blockerType,
    failedChecks,
    pendingChecks,
    mergeable,
    reviewDecision: reviewDecision || 'NONE',
    checks,
  };
}

function reviewPr({ prUrl, autoMerge = false, mergeMethod = 'squash' }: { prUrl: string; autoMerge?: boolean; mergeMethod?: string }): PRReviewResult {
  const ref = parsePrUrl(prUrl);
  if (!ref) throw new Error('invalid PR URL');
  const pr = ghJson([
    'pr', 'view', String(ref.number),
    '--repo', ref.ownerRepo,
    '--json', 'number,state,isDraft,mergeable,reviewDecision,statusCheckRollup,headRefName,baseRefName,url,title'
  ]);
  const analysis = classifyPr(pr);
  const alreadyMerged = String(pr.state).toUpperCase() === 'MERGED';
  const result: PRReviewResult = {
    ok: true,
    prUrl: pr.url as string,
    ownerRepo: ref.ownerRepo,
    number: pr.number as number,
    title: pr.title as string,
    headRefName: pr.headRefName as string,
    baseRefName: pr.baseRefName as string,
    mergeable: analysis.mergeable,
    reviewDecision: analysis.reviewDecision,
    disposition: alreadyMerged ? 'approve' : analysis.disposition,
    blockers: alreadyMerged ? [] : analysis.blockers,
    blockerType: alreadyMerged ? 'none' : analysis.blockerType,
    failedChecks: alreadyMerged ? [] : analysis.failedChecks,
    pendingChecks: alreadyMerged ? [] : analysis.pendingChecks,
    checks: analysis.checks.checks,
    merged: alreadyMerged,
    autoMergeEnabled: alreadyMerged,
  };

  // If already merged, skip review/merge logic
  if (alreadyMerged) return result;

  if (analysis.disposition === 'approve' && autoMerge) {
    const gh = commandExists('gh') || 'gh';

    const reviewOut = run(gh, ['pr', 'review', String(ref.number), '--repo', ref.ownerRepo, '--approve', '--body', 'Auto-merge: checks green, mergeable.']);
    const selfApproval = /Can.?not approve your own pull request/i.test((reviewOut.stderr || '') + (reviewOut.stdout || ''));
    const alreadyReviewed = /already reviewed/i.test((reviewOut.stderr || '') + (reviewOut.stdout || ''));
    if (reviewOut.status !== 0 && !selfApproval && !alreadyReviewed) {
      result.ok = false;
      result.disposition = 'hold';
      result.blockers.push(`approve failed: ${(reviewOut.stderr || reviewOut.stdout || '').trim()}`);
      return result;
    }

    const mergeArgs = ['pr', 'merge', String(ref.number), '--repo', ref.ownerRepo, '--auto', '--delete-branch'];
    if (mergeMethod === 'rebase') mergeArgs.push('--rebase');
    else if (mergeMethod === 'merge') mergeArgs.push('--merge');
    else mergeArgs.push('--squash');
    const mergeOut = run(gh, mergeArgs);

    if (mergeOut.status === 0) {
      result.autoMergeEnabled = true;
      result.merged = /merged pull request/i.test((mergeOut.stdout || '') + (mergeOut.stderr || ''));
    } else {
      const directArgs = ['pr', 'merge', String(ref.number), '--repo', ref.ownerRepo, '--delete-branch'];
      if (mergeMethod === 'rebase') directArgs.push('--rebase');
      else if (mergeMethod === 'merge') directArgs.push('--merge');
      else directArgs.push('--squash');
      const directOut = run(gh, directArgs);
      if (directOut.status === 0) {
        result.autoMergeEnabled = true;
        result.merged = true;
      } else {
        result.disposition = 'hold';
        result.blockers.push(`merge failed: ${(directOut.stderr || directOut.stdout || '').trim()}`);
      }
    }
  }

  return result;
}

// ── PR review comment types ──

interface PrReviewComment {
  author: string;
  body: string;
  path: string | null;
  line: number | null;
  side: string | null;
  createdAt: string;
  state: string | null;
}

interface PrCommentsSummary {
  ok: boolean;
  comments: PrReviewComment[];
  error?: string;
}

/**
 * Fetch all review comments on a PR (inline code comments + top-level review bodies).
 * Uses `gh api` to get both review-level bodies and inline file comments.
 * Returns structured data with file/line context for inline comments.
 */
function fetchPrComments(prUrl: string): PrCommentsSummary {
  const ref = parsePrUrl(prUrl);
  if (!ref) return { ok: false, comments: [], error: 'invalid PR URL' };

  const gh = commandExists('gh') || 'gh';
  const comments: PrReviewComment[] = [];

  // 1. Fetch top-level review bodies (the summary comment when submitting a review)
  try {
    const reviewsOut = run(gh, [
      'api', `repos/${ref.ownerRepo}/pulls/${ref.number}/reviews`,
      '--paginate', '--jq',
      '.[] | {author: .user.login, body: .body, state: .state, createdAt: .submitted_at}',
    ]);
    if (reviewsOut.status === 0 && reviewsOut.stdout.trim()) {
      for (const line of reviewsOut.stdout.trim().split('\n')) {
        try {
          const r = JSON.parse(line);
          if (r.body && r.body.trim()) {
            comments.push({
              author: r.author || 'unknown',
              body: r.body.trim(),
              path: null,
              line: null,
              side: null,
              createdAt: r.createdAt || '',
              state: r.state || null,
            });
          }
        } catch { /* skip malformed JSON lines */ }
      }
    }
  } catch { /* best-effort */ }

  // 2. Fetch inline review comments (file-level comments with line context)
  try {
    const inlineOut = run(gh, [
      'api', `repos/${ref.ownerRepo}/pulls/${ref.number}/comments`,
      '--paginate', '--jq',
      '.[] | {author: .user.login, body: .body, path: .path, line: .line, side: .side, createdAt: .created_at, in_reply_to_id: .in_reply_to_id}',
    ]);
    if (inlineOut.status === 0 && inlineOut.stdout.trim()) {
      for (const line of inlineOut.stdout.trim().split('\n')) {
        try {
          const c = JSON.parse(line);
          if (c.body && c.body.trim()) {
            comments.push({
              author: c.author || 'unknown',
              body: c.body.trim(),
              path: c.path || null,
              line: typeof c.line === 'number' ? c.line : null,
              side: c.side || null,
              createdAt: c.createdAt || '',
              state: null,
            });
          }
        } catch { /* skip malformed JSON lines */ }
      }
    }
  } catch { /* best-effort */ }

  // 3. Fetch general issue-style comments (non-review PR conversation comments)
  try {
    const issueCommentsOut = run(gh, [
      'api', `repos/${ref.ownerRepo}/issues/${ref.number}/comments`,
      '--paginate', '--jq',
      '.[] | {author: .user.login, body: .body, createdAt: .created_at}',
    ]);
    if (issueCommentsOut.status === 0 && issueCommentsOut.stdout.trim()) {
      for (const line of issueCommentsOut.stdout.trim().split('\n')) {
        try {
          const c = JSON.parse(line);
          if (c.body && c.body.trim()) {
            comments.push({
              author: c.author || 'unknown',
              body: c.body.trim(),
              path: null,
              line: null,
              side: null,
              createdAt: c.createdAt || '',
              state: null,
            });
          }
        } catch { /* skip malformed JSON lines */ }
      }
    }
  } catch { /* best-effort */ }

  // Sort by creation time (oldest first)
  comments.sort((a, b) => (a.createdAt || '').localeCompare(b.createdAt || ''));

  return { ok: true, comments };
}

/**
 * Format PR review comments into structured text for inclusion in a worker prompt.
 * Groups inline comments by file and includes line numbers for precise context.
 * Caps output at maxChars to avoid prompt bloat.
 */
function formatPrCommentsForPrompt(comments: PrReviewComment[], maxChars: number = 8000): string {
  if (!comments.length) return '';

  const parts: string[] = ['## PR Review Comments'];

  // Separate inline (file-specific) from general comments
  const inlineComments = comments.filter(c => c.path);
  const generalComments = comments.filter(c => !c.path);

  // Group inline comments by file
  if (inlineComments.length) {
    const byFile = new Map<string, PrReviewComment[]>();
    for (const c of inlineComments) {
      const key = c.path!;
      if (!byFile.has(key)) byFile.set(key, []);
      byFile.get(key)!.push(c);
    }

    parts.push('### Inline Comments (by file)');
    for (const [filePath, fileComments] of byFile) {
      parts.push(`\n**${filePath}**`);
      for (const c of fileComments) {
        const loc = c.line ? `:${c.line}` : '';
        parts.push(`- [${c.author}] at \`${filePath}${loc}\`: ${c.body}`);
      }
    }
  }

  // General review comments (top-level review bodies + conversation)
  const actionableGeneral = generalComments.filter(c =>
    // Skip bot comments and approved-without-comment reviews
    !c.author.includes('[bot]') && c.body.length > 5
  );
  if (actionableGeneral.length) {
    parts.push('### General Review Comments');
    for (const c of actionableGeneral) {
      const stateTag = c.state ? ` (${c.state})` : '';
      parts.push(`- [${c.author}${stateTag}]: ${c.body}`);
    }
  }

  let result = parts.join('\n');
  if (result.length > maxChars) {
    result = result.slice(0, maxChars - 50) + '\n\n... (truncated, see PR for full comments)';
  }
  return result;
}

module.exports = {
  parsePrUrl,
  reviewPr,
  classifyPr,
  fetchPrComments,
  formatPrCommentsForPrompt,
};

export { parsePrUrl, reviewPr, classifyPr, fetchPrComments, formatPrCommentsForPrompt };
