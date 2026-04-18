import type { ChecksSummary, CheckInfo, PRClassification, PRReviewResult } from '../types';
import { run, commandExists, parsePrUrl } from './shell';

/**
 * Phase 4 (PR A): Vercel preview URL extractor.
 *
 * Two sources, in preference order:
 *   1. Vercel bot PR comments (canonical — Vercel posts the exact preview URL
 *      once the deployment is ready, e.g. "Preview: https://my-app-abc.vercel.app").
 *   2. A Vercel-named check whose `detailsUrl` points to a *.vercel.app host
 *      (some integrations put the preview URL there; most point to
 *      vercel.com/... dashboard URLs, which we filter out).
 *
 * We scan comments newest-first so redeploys (new PR push → new preview URL)
 * pick up the latest one rather than the first one Vercel ever posted.
 *
 * Known limitations (documented rather than fixed here to keep PR scope tight):
 *   - Custom domains (my-app.example.com instead of my-app-abc.vercel.app)
 *     aren't auto-detected. Future PRs will let repos override the regex.
 *   - Netlify / Cloudflare Pages / Railway / Render aren't supported yet —
 *     same future-PR story.
 */
const VERCEL_PREVIEW_URL_RE = /(https?:\/\/[a-zA-Z0-9][a-zA-Z0-9-]*\.vercel\.app(?:\/[^\s<>"')\]]*)?)/g;
const VERCEL_COMMENT_AUTHOR_RE = /^(vercel(?:\[bot\])?|vercel-bot)$/i;
const VERCEL_DASHBOARD_URL_RE = /^https?:\/\/vercel\.com\//i;

interface PrComment {
  author?: { login?: string | null } | null;
  body?: string | null;
}

export function extractPreviewUrl(params: {
  checks: CheckInfo[];
  comments?: PrComment[] | null;
}): string | null {
  // 1. Prefer Vercel bot comments — scanning newest-first so we pick up the
  //    latest deployment rather than the first Vercel ever posted.
  const comments = Array.isArray(params.comments) ? params.comments : [];
  for (let i = comments.length - 1; i >= 0; i--) {
    const c = comments[i];
    const login = c?.author?.login || '';
    if (!VERCEL_COMMENT_AUTHOR_RE.test(login)) continue;
    const body = c?.body || '';
    // Reset regex state between calls (global flag carries lastIndex).
    VERCEL_PREVIEW_URL_RE.lastIndex = 0;
    const match = VERCEL_PREVIEW_URL_RE.exec(body);
    if (match && match[1]) return match[1];
  }
  // 2. Fallback: a Vercel-named check whose URL is an actual *.vercel.app
  //    preview (not a vercel.com dashboard link).
  for (const chk of params.checks || []) {
    if (!chk || !chk.url) continue;
    if (!/vercel/i.test(chk.name || '')) continue;
    if (VERCEL_DASHBOARD_URL_RE.test(chk.url)) continue;
    if (/\.vercel\.app(?:\/|$)/i.test(chk.url)) return chk.url;
  }
  return null;
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
    // Phase 4 (PR A): `comments` is included so the preview-URL extractor can
    // parse Vercel bot comments. `gh pr view --json comments` returns the full
    // comment thread including author login + body, which is everything the
    // extractor needs.
    '--json', 'number,state,isDraft,mergeable,reviewDecision,statusCheckRollup,headRefName,baseRefName,url,title,comments'
  ]);
  const analysis = classifyPr(pr);
  const alreadyMerged = String(pr.state).toUpperCase() === 'MERGED';
  const previewUrl = extractPreviewUrl({
    checks: analysis.checks.checks,
    comments: (pr.comments as PrComment[] | undefined) || [],
  });
  const result: PRReviewResult = {
    ok: true,
    prUrl: pr.url as string,
    previewUrl,
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

module.exports = {
  parsePrUrl,
  reviewPr,
  classifyPr,
  extractPreviewUrl,
};

export { parsePrUrl, reviewPr, classifyPr };
