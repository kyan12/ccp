import fs = require('fs');
import type { JobStatus, JobResult, JobPacket, PRReviewResult, PrWatcherCycleResult } from '../types';
const { reviewPr } = require('./pr-review');
const {
  listJobs,
  readJson,
  saveStatus,
  packetPath,
  resultPath,
} = require('./jobs');
const { prReviewPolicy, isNightlyPacket } = require('./pr-policy');

/**
 * Historical PR drain watcher.
 *
 * Native Hermes Kanban owns all new GitHub lifecycle work. CCP may only poll
 * these two named historical jobs and reconcile read-only PR evidence into
 * status.json until they become terminal.
 */
const DRAIN_JOB_IDS = new Set([
  'nightly_proteusx-os_2026-07-11',
  'nightly_papyrx_2026-05-19',
]);
const WATCHABLE_STATES = new Set(['coded', 'done', 'blocked']);

function nowIso(): string {
  return new Date().toISOString();
}

function hasPendingOperatorDecision(status: JobStatus, result?: JobResult | null): boolean {
  const decision = status.integrations?.decision;
  if (decision) return decision.status === 'pending';
  return result?.blocker_type === 'operator-decision';
}

function collectWatchableJobs(): Array<{ status: JobStatus; result: JobResult; packet: JobPacket }> {
  const watchable: Array<{ status: JobStatus; result: JobResult; packet: JobPacket }> = [];

  for (const status of listJobs() as JobStatus[]) {
    if (!DRAIN_JOB_IDS.has(status.job_id)) continue;
    if (!WATCHABLE_STATES.has(status.state)) continue;

    const rPath = resultPath(status.job_id);
    if (!fs.existsSync(rPath)) continue;

    let result: JobResult;
    let packet: JobPacket;
    try {
      result = readJson(rPath);
      packet = readJson(packetPath(status.job_id));
    } catch {
      continue;
    }
    if (!result.pr_url || hasPendingOperatorDecision(status, result)) continue;

    const prior = status.integrations?.prReview as unknown as Record<string, unknown> | undefined;
    if ((status.state === 'done' || status.state === 'verified') && prior?.merged) continue;
    if (prior?.disposition === 'closed' || prior?.blockerType === 'closed') continue;

    watchable.push({ status, result, packet });
  }

  return watchable;
}

async function runPrWatcherCycle(): Promise<PrWatcherCycleResult> {
  const globalPolicy = prReviewPolicy();
  if (!globalPolicy.enabled) {
    return { ok: true, skipped: true, reason: 'PR review disabled', actions: [] };
  }

  const watchable = collectWatchableJobs();
  const actions: Array<Record<string, unknown>> = [];

  for (const { status, result, packet } of watchable) {
    const jobId = status.job_id;
    const entry: Record<string, unknown> = {
      job_id: jobId,
      ticket_id: packet.ticket_id,
      pr_url: result.pr_url,
    };

    let review: PRReviewResult;
    try {
      const policy = prReviewPolicy(packet.repo || undefined, { isNightly: isNightlyPacket(packet) });
      review = reviewPr({ prUrl: result.pr_url, autoMerge: false, mergeMethod: policy.mergeMethod });
    } catch (error) {
      entry.error = (error as Error).message;
      actions.push(entry);
      continue;
    }

    const prReview = {
      ok: review.ok,
      skipped: false,
      disposition: review.disposition,
      blockerType: review.blockerType,
      blockers: review.blockers,
      failedChecks: review.failedChecks,
      merged: review.merged || false,
      autoMergeEnabled: false,
      watchedAt: nowIso(),
      previewUrl: review.previewUrl ?? null,
    };

    const merged = review.merged === true;
    saveStatus(jobId, {
      // saveStatus merges this key with the latest integrations while holding
      // the status lock, so a concurrent decision update cannot be overwritten.
      integrations: { prReview },
    });

    entry.disposition = review.disposition;
    entry.blockerType = review.blockerType;
    entry.merged = merged;
    entry.autoMergeEnabled = false;
    entry.action = merged ? 'merge-reconciled' : 'status-reconciled';
    actions.push(entry);
  }

  return { ok: true, skipped: false, watchedCount: watchable.length, actions };
}

module.exports = {
  runPrWatcherCycle,
  collectWatchableJobs,
  WATCHABLE_STATES,
  DRAIN_JOB_IDS,
};

export { runPrWatcherCycle, collectWatchableJobs, WATCHABLE_STATES, DRAIN_JOB_IDS };