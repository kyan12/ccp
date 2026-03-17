import fs = require('fs');
import path = require('path');
import type { JobStatus, JobResult, JobPacket, PRReviewResult, PrWatcherCycleResult } from '../types';
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

function nowIso(): string {
  return new Date().toISOString();
}

function prReviewPolicy(repoPath?: string): { enabled: boolean; autoMerge: boolean; mergeMethod: string } {
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

function remediationEnabled(): boolean {
  return String(process.env.CCP_PR_REMEDIATE_ENABLED || 'true').toLowerCase() !== 'false';
}

/**
 * Collect jobs whose PRs should be watched.
 */
function collectWatchableJobs(): Array<{ status: JobStatus; result: JobResult; packet: JobPacket }> {
  const jobs: JobStatus[] = listJobs();
  const watchable: Array<{ status: JobStatus; result: JobResult; packet: JobPacket }> = [];

  for (const status of jobs) {
    if (!WATCHABLE_STATES.has(status.state)) continue;
    const rPath: string = resultPath(status.job_id);
    if (!fs.existsSync(rPath)) continue;

    let result: JobResult;
    try { result = readJson(rPath); } catch { continue; }
    if (!result.pr_url) continue;

    let packet: JobPacket;
    try { packet = readJson(packetPath(status.job_id)); } catch { continue; }

    watchable.push({ status, result, packet });
  }

  return watchable;
}

/**
 * Check whether a remediation job already exists for a given parent job.
 */
function remediationExists(jobId: string): boolean {
  const deployfixDir = path.join(JOBS_DIR, `${jobId}__deployfix`);
  const reviewfixDir = path.join(JOBS_DIR, `${jobId}__reviewfix`);
  return fs.existsSync(deployfixDir) || fs.existsSync(reviewfixDir);
}

/**
 * Run one watcher cycle across all watchable jobs.
 */
async function runPrWatcherCycle(): Promise<PrWatcherCycleResult> {
  const globalPolicy = prReviewPolicy();
  if (!globalPolicy.enabled) {
    return { ok: true, skipped: true, reason: 'PR review disabled', actions: [] };
  }

  const watchable = collectWatchableJobs();
  const actions: unknown[] = [];

  for (const { status, result, packet } of watchable) {
    const jobId = status.job_id;
    const entry: Record<string, unknown> = { job_id: jobId, ticket_id: packet.ticket_id, pr_url: result.pr_url };

    // Get per-repo policy for autoMerge/mergeMethod
    const policy = prReviewPolicy(packet?.repo || undefined);

    // Review live PR state
    let review: PRReviewResult;
    try {
      review = reviewPr({
        prUrl: result.pr_url,
        autoMerge: policy.autoMerge,
        mergeMethod: policy.mergeMethod,
      });
    } catch (error) {
      entry.error = (error as Error).message;
      actions.push(entry);
      appendLog(jobId, `[${nowIso()}] pr-watcher review error: ${(error as Error).message}`);
      continue;
    }

    entry.disposition = review.disposition;
    entry.blockerType = review.blockerType;
    entry.merged = review.merged || false;
    entry.autoMergeEnabled = review.autoMergeEnabled || false;

    // PR is closed/merged — mark done and sync Linear
    if (review.merged || (review.ok && review.disposition === 'approve' && review.autoMergeEnabled)) {
      appendLog(jobId, `[${nowIso()}] pr-watcher: PR merged or auto-merge enabled`);
      entry.action = 'merge-tracked';

      // Promote job state to done
      if (status.state !== 'done' && status.state !== 'verified') {
        saveStatus(jobId, { state: 'done' });
        entry.stateChange = (entry.stateChange ? entry.stateChange + ', ' : '') + `${status.state}→done`;
        appendLog(jobId, `[${nowIso()}] pr-watcher: job state → done (PR merged)`);
      }

      // Sync Linear ticket to Done
      if (packet.ticket_id) {
        try {
          const { syncJobToLinear } = require('./linear');
          const updated = { ...status, state: 'done' };
          syncJobToLinear({ packet, status: updated, result }).then((r: { ok: boolean }) => {
            if (r.ok) appendLog(jobId, `[${nowIso()}] pr-watcher: Linear ${packet.ticket_id} → Done`);
          }).catch(() => {});
        } catch (_) {}
      }
    }

    // PR is approved and green
    if (review.disposition === 'approve') {
      appendLog(jobId, `[${nowIso()}] pr-watcher: PR is green (disposition=approve)`);

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
    const current: JobStatus = loadStatus(jobId);
    const prevPrReview = current.integrations?.prReview || {} as Record<string, unknown>;
    const dispositionChanged = (prevPrReview as Record<string, unknown>).disposition !== review.disposition
      || (prevPrReview as Record<string, unknown>).merged !== (review.merged || false)
      || (prevPrReview as Record<string, unknown>).autoMergeEnabled !== (review.autoMergeEnabled || false);

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
        const parts: string[] = [`${emoji} PR status changed → **${review.disposition}**`];
        if (review.merged) parts.push('PR has been merged');
        if (review.autoMergeEnabled) parts.push('Auto-merge enabled');
        if (review.blockers?.length) parts.push(`Blockers: ${review.blockers.join('; ')}`);
        sendDiscordMessage(current.discord_thread_id, parts.join('\n'));
      } catch { /* thread message is best-effort */ }
    }

    // Only sync Linear when the PR disposition actually changed
    if (packet.ticket_id && dispositionChanged) {
      try {
        const { syncJobToLinear } = require('./linear');
        const freshResult: JobResult = readJson(resultPath(jobId));
        const freshStatus: JobStatus = loadStatus(jobId);
        await syncJobToLinear({ packet, status: freshStatus, result: freshResult });
        entry.linearSynced = true;
      } catch (error) {
        entry.linearSyncError = (error as Error).message;
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

export { runPrWatcherCycle, collectWatchableJobs, WATCHABLE_STATES };
