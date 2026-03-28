/**
 * pr-policy.ts — Shared PR review policy logic.
 *
 * Extracted from jobs.ts and pr-watcher.ts to prevent drift.
 */

function prReviewPolicy(repoPath?: string): { enabled: boolean; autoMerge: boolean; mergeMethod: string } {
  const globalAutoMerge = String(process.env.CCP_PR_AUTOMERGE || 'false').toLowerCase() === 'true';
  const globalMergeMethod = process.env.CCP_PR_MERGE_METHOD || 'squash';

  let repoAutoMerge = globalAutoMerge;
  let repoMergeMethod = globalMergeMethod;
  try {
    const { findRepoByPath } = require('./repos');
    const repo = repoPath ? findRepoByPath(repoPath) : null;
    if (repo?.autoMerge !== undefined) repoAutoMerge = !!repo.autoMerge;
    if (repo?.mergeMethod) repoMergeMethod = repo.mergeMethod;
  } catch { /* repos module not available */ }

  return {
    enabled: String(process.env.CCP_PR_REVIEW_ENABLED || 'true').toLowerCase() !== 'false',
    autoMerge: repoAutoMerge,
    mergeMethod: repoMergeMethod,
  };
}

module.exports = { prReviewPolicy };
export { prReviewPolicy };
