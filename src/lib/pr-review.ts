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
    disposition: analysis.disposition,
    blockers: analysis.blockers,
    blockerType: analysis.blockerType,
    failedChecks: analysis.failedChecks,
    pendingChecks: analysis.pendingChecks,
    checks: analysis.checks.checks,
    merged: false,
    autoMergeEnabled: false,
  };

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
};

export { parsePrUrl, reviewPr, classifyPr };
