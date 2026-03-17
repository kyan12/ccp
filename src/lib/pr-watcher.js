const fs = require('fs');
const path = require('path');
const { reviewPr } = require('./pr-review');
const {
  JOBS_DIR,
  listJobs,
  loadStatus,
  readJson,
  saveStatus,
  packetPath,
  resultPath,
  appendLog,
} = require('./jobs');

/**
 * PR-lifecycle watcher: scans finalized PR-backed jobs and re-evaluates
 * live PR state so the control plane reacts to check results, reviews,
 * and merges that arrive after the initial finalization pass.
 */

// States where the job is done executing but the PR may still be evolving.
const WATCHABLE_STATES = new Set(['coded', 'done', 'blocked']);

function nowIso() {
  return new Date().toISOString();
}

function prReviewPolicy(repoPath) {
  const globalAutoMerge = String(process.env.CCP_PR_AUTOMERGE || 'false').toLowerCase() === 'true';
  const globalMergeMethod = process.env.CCP_PR_MERGE_METHOD || 'squash';

  // Check per-repo config
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

function remediationEnabled() {
  return String(process.env.CCP_PR_REMEDIATE_ENABLED || 'true').toLowerCase() !== 'false';
}

/**
 * Collect jobs whose PRs should be watched.
 * Criteria: job is in a watchable terminal state and has a pr_url in result.json.
 */
function collectWatchableJobs() {
  const jobs = listJobs();
  const watchable = [];

  for (const status of jobs) {
    if (!WATCHABLE_STATES.has(status.state)) continue;
    const rPath = resultPath(status.job_id);
    if (!fs.existsSync(rPath)) continue;

    let result;
    try { result = readJson(rPath); } catch { continue; }
    if (!result.pr_url) continue;

    let packet;
    try { packet = readJson(packetPath(status.job_id)); } catch { continue; }

    watchable.push({ status, result, packet });
  }

  return watchable;
}

/**
 * Check whether a remediation job already exists for a given parent job.
 */
function remediationExists(jobId) {
  const deployfixDir = path.join(JOBS_DIR, `${jobId}__deployfix`);
  const reviewfixDir = path.join(JOBS_DIR, `${jobId}__reviewfix`);
  return fs.existsSync(deployfixDir) || fs.existsSync(reviewfixDir);
}

/**
 * Run one watcher cycle across all watchable jobs.
 * Returns a summary array of actions taken.
 */
async function runPrWatcherCycle() {
  const globalPolicy = prReviewPolicy();
  if (!globalPolicy.enabled) {
    return { ok: true, skipped: true, reason: 'PR review disabled', actions: [] };
  }

  const watchable = collectWatchableJobs();
  const actions = [];

  for (const { status, result, packet } of watchable) {
    const jobId = status.job_id;
    const entry = { job_id: jobId, ticket_id: packet.ticket_id, pr_url: result.pr_url };

    // Get per-repo policy for autoMerge/mergeMethod
    const policy = prReviewPolicy(packet?.repo);

    // Review live PR state
    let review;
    try {
      review = reviewPr({
        prUrl: result.pr_url,
        autoMerge: policy.autoMerge,
        mergeMethod: policy.mergeMethod,
      });
    } catch (error) {
      entry.error = error.message;
      actions.push(entry);
      appendLog(jobId, `[${nowIso()}] pr-watcher review error: ${error.message}`);
      continue;
    }

    entry.disposition = review.disposition;
    entry.blockerType = review.blockerType;
    entry.merged = review.merged || false;
    entry.autoMergeEnabled = review.autoMergeEnabled || false;

    // PR is closed/merged — mark verified if not already
    if (review.merged || (review.ok && review.disposition === 'approve' && review.autoMergeEnabled)) {
      appendLog(jobId, `[${nowIso()}] pr-watcher: PR merged or auto-merge enabled`);
      entry.action = 'merge-tracked';
    }

    // PR is approved and green — if we just enabled auto-merge, note it
    if (review.disposition === 'approve') {
      appendLog(jobId, `[${nowIso()}] pr-watcher: PR is green (disposition=approve)`);

      // If job was blocked, promote to coded since PR is now clean
      if (status.state === 'blocked' && !result.blocker) {
        saveStatus(jobId, { state: 'coded' });
        result.state = 'coded';
        entry.stateChange = 'blocked→coded';
      }
      entry.action = entry.action || 'approved';
    }

    // PR is blocked — consider remediation
    if (review.disposition === 'block') {
      appendLog(jobId, `[${nowIso()}] pr-watcher: PR blocked (${review.blockerType}): ${(review.blockers || []).join('; ')}`);

      if (remediationEnabled() && !remediationExists(jobId)) {
        const { maybeEnqueueReviewRemediation } = require('./jobs');
        const remResult = maybeEnqueueReviewRemediation(jobId, packet, result, review);
        entry.remediation = remResult;
        if (remResult.ok && !remResult.skipped) {
          entry.action = 'remediation-enqueued';
        }
      } else if (remediationExists(jobId)) {
        entry.action = 'remediation-exists';
      } else {
        entry.action = 'blocked-no-remediation';
      }
    }

    // PR is on hold (pending checks, etc.)
    if (review.disposition === 'hold') {
      entry.action = entry.action || 'hold';
    }

    // Persist updated PR review integration state
    const current = loadStatus(jobId);
    const prevPrReview = current.integrations?.prReview || {};
    const dispositionChanged = prevPrReview.disposition !== review.disposition
      || prevPrReview.merged !== (review.merged || false)
      || prevPrReview.autoMergeEnabled !== (review.autoMergeEnabled || false);

    saveStatus(jobId, {
      integrations: {
        ...(current.integrations || {}),
        prReview: {
          ok: review.ok,
          skipped: false,
          disposition: review.disposition,
          blockerType: review.blockerType,
          blockers: review.blockers,
          failedChecks: review.failedChecks,
          merged: review.merged,
          autoMergeEnabled: review.autoMergeEnabled,
          watchedAt: nowIso(),
        },
      },
    });

    // Post disposition changes to the job's Discord thread if one exists
    if (dispositionChanged && current.discord_thread_id) {
      try {
        const { sendDiscordMessage } = require('./jobs');
        const emoji = review.disposition === 'approve' ? '✅' : review.disposition === 'block' ? '🔴' : '🟡';
        const parts = [`${emoji} PR status changed → **${review.disposition}**`];
        if (review.merged) parts.push('PR has been merged');
        if (review.autoMergeEnabled) parts.push('Auto-merge enabled');
        if (review.blockers?.length) parts.push(`Blockers: ${review.blockers.join('; ')}`);
        sendDiscordMessage(current.discord_thread_id, parts.join('\n'));
      } catch { /* thread message is best-effort */ }
    }

    // Only sync Linear when the PR disposition actually changed — avoids
    // hammering the 5000 req/hr rate limit on every 15s supervisor cycle.
    if (packet.ticket_id && dispositionChanged) {
      try {
        const { syncJobToLinear } = require('./linear');
        const freshResult = readJson(resultPath(jobId));
        const freshStatus = loadStatus(jobId);
        await syncJobToLinear({ packet, status: freshStatus, result: freshResult });
        entry.linearSynced = true;
      } catch (error) {
        entry.linearSyncError = error.message;
      }
    } else if (packet.ticket_id) {
      entry.linearSynced = false;
      entry.linearSkipReason = 'disposition unchanged';
    }

    actions.push(entry);
  }

  return { ok: true, skipped: false, watchedCount: watchable.length, actions };
}

module.exports = {
  runPrWatcherCycle,
  collectWatchableJobs,
  WATCHABLE_STATES,
};
