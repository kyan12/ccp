/**
 * auto-remediation.ts — PRO-598
 *
 * Collapses the three remediation paths (review, validation, smoke) into a
 * single structured `AutoRemediationStatus` so coding-error / blocked /
 * harness-failure Discord alerts can render an explicit "Auto-remediation:"
 * line and downstream callbacks can downgrade misleading terminal `failed`
 * statuses without having to scrape the blocker prose.
 *
 * Live PRO-597 incident drove this:
 *   - Worker exited 0 but produced no final summary
 *   - CCP could not recover a PR
 *   - integrations.remediation.reason="no blocking PR review"
 *   - integrations.validationRemediation.reason="validation not gated"
 *   - The user had to infer "auto-remediation will not happen" from those
 *     internal CCP fields. The Discord alert itself was ambiguous.
 *
 * The helper is intentionally a small pure function so jobs.ts /
 * pr-watcher.ts can both call it and tests can exercise the dispositions
 * without any filesystem state.
 */

import type {
  AutoRemediationDisposition,
  AutoRemediationStatus,
  RemediationResult,
} from '../types';

export interface SummarizeAutoRemediationInput {
  /** Final job state (`blocked` / `failed` / `harness-failure` / etc.). */
  state: string;
  /** Machine-readable blocker bucket, when set. */
  blockerType?: string | null;
  /** Has the job produced a PR (live or recovered)? */
  prUrl?: string | null;
  /** Recovered commit hash, if any (only relevant for harness-failure). */
  commitRecovered?: boolean;
  /** Result of `maybeEnqueueReviewRemediation` if it ran. */
  reviewRemediation?: RemediationResult | null;
  /** Result of `maybeEnqueueValidationRemediation` if it ran. */
  validationRemediation?: RemediationResult | null;
  /** Result of `maybeEnqueueSmokeRemediation` if it ran. */
  smokeRemediation?: RemediationResult | null;
  /**
   * True when this job is itself a remediation/auto-retry child
   * (`__reviewfix|__valfix|__deployfix|__autoretry` job-id suffix). Forces
   * `disposition: 'depth-limit'` regardless of the per-path results.
   */
  remediationDepthLimited?: boolean;
  /**
   * True when remediation is globally disabled
   * (`CCP_PR_REMEDIATE_ENABLED=false`). Forces `disposition: 'disabled'`.
   */
  remediationDisabled?: boolean;
  /**
   * True when an operator-initiated replacement attempt is active for the
   * same ticket (sibling job in queued/preflight/running). Forces
   * `disposition: 'superseded'` and `superseding: true`.
   */
  superseded?: boolean;
}

const REMEDIATION_SUFFIX_RE = /__deployfix|__reviewfix|__valfix|__autoretry/;

export function isRemediationJobId(jobId: string): boolean {
  return REMEDIATION_SUFFIX_RE.test(jobId);
}

function pickFirstActive(
  ...candidates: Array<{ source: AutoRemediationStatus['source']; res: RemediationResult | null | undefined }>
): { source: AutoRemediationStatus['source']; res: RemediationResult } | null {
  for (const c of candidates) {
    if (c.res && c.res.ok && !c.res.skipped && c.res.job_id) {
      return { source: c.source, res: c.res };
    }
  }
  return null;
}

function pickFirstExisting(
  ...candidates: Array<{ source: AutoRemediationStatus['source']; res: RemediationResult | null | undefined }>
): { source: AutoRemediationStatus['source']; res: RemediationResult } | null {
  for (const c of candidates) {
    const r = c.res;
    if (!r) continue;
    // The remediation enqueuers report skipped+reason='remediation already exists'
    // when they detect a sibling __reviewfix/__valfix/__deployfix is already
    // running. Treat that as an `existing` disposition so notifiers can say
    // "fix in progress" without spawning another.
    if (r.skipped && typeof r.reason === 'string' && /already exists|in progress|already enqueued/i.test(r.reason)) {
      return { source: c.source, res: r };
    }
  }
  return null;
}

export function summarizeAutoRemediation(input: SummarizeAutoRemediationInput): AutoRemediationStatus {
  // 1. Replacement attempt active → superseded (downgrades callback).
  if (input.superseded) {
    return {
      disposition: 'superseded',
      superseding: true,
      source: 'none',
      reason: 'replacement attempt is active for this ticket',
    };
  }

  // 2. Globally disabled (CCP_PR_REMEDIATE_ENABLED=false).
  if (input.remediationDisabled) {
    return {
      disposition: 'disabled',
      superseding: false,
      source: 'none',
      reason: 'auto-remediation disabled (CCP_PR_REMEDIATE_ENABLED=false)',
    };
  }

  // 3. Remediation depth guard tripped (this job is itself a fix child).
  if (input.remediationDepthLimited) {
    return {
      disposition: 'depth-limit',
      superseding: false,
      source: 'none',
      reason: 'remediation depth limit reached — no further auto retries',
    };
  }

  // 4. A fix child was just enqueued.
  const enqueued = pickFirstActive(
    { source: 'validation', res: input.validationRemediation },
    { source: 'review', res: input.reviewRemediation },
    { source: 'smoke', res: input.smokeRemediation },
  );
  if (enqueued) {
    return {
      disposition: 'queued',
      superseding: false,
      source: enqueued.source,
      remediationJobId: enqueued.res.job_id || null,
      reason: `fix job enqueued: ${enqueued.res.job_id}`,
    };
  }

  // 5. A fix child for this parent already exists.
  const existing = pickFirstExisting(
    { source: 'validation', res: input.validationRemediation },
    { source: 'review', res: input.reviewRemediation },
    { source: 'smoke', res: input.smokeRemediation },
  );
  if (existing) {
    return {
      disposition: 'existing',
      superseding: false,
      source: existing.source,
      reason: existing.res.reason || 'remediation already in progress',
    };
  }

  // 6. The job is blocked but has a PR — pr-watcher will decide once a
  //    review fires. Common at finalize time before pr-watcher's first cycle.
  if (input.prUrl && (input.state === 'blocked' || input.state === 'coded')) {
    return {
      disposition: 'pending-watcher',
      superseding: false,
      source: 'review',
      reason: 'PR present; awaiting pr-watcher review/check signal',
    };
  }

  // 7. Harness-failure with no recovered PR / commit — operator must rerun.
  if (input.state === 'harness-failure' && !input.prUrl && !input.commitRecovered) {
    return {
      disposition: 'not-applicable',
      superseding: false,
      source: 'none',
      reason: 'harness-failure: no PR/commit recovered — operator must rerun or refile',
    };
  }

  // 8. Catch-all: nothing the auto-remediation paths can act on.
  return {
    disposition: 'not-applicable',
    superseding: false,
    source: 'none',
    reason: 'no PR/blocking review/validation/smoke gate to remediate',
  };
}

const DISPOSITION_LABELS: Record<AutoRemediationDisposition, string> = {
  queued: 'queued',
  existing: 'existing fix in progress',
  'pending-watcher': 'pending PR-watcher cycle',
  'depth-limit': 'not applicable (depth limit reached)',
  disabled: 'disabled',
  'not-applicable': 'not applicable',
  superseded: 'superseded by replacement attempt',
};

/**
 * Render the structured status as a single Discord-friendly line.
 * Discord notifications include this verbatim so operators can answer
 * "will CCP fix this or do I need to jump in?" at a glance.
 */
export function formatAutoRemediationLine(status: AutoRemediationStatus): string {
  const label = DISPOSITION_LABELS[status.disposition] || status.disposition;
  const parts = [`Auto-remediation: ${label}`];
  if (status.disposition === 'queued' && status.remediationJobId) {
    parts.push(`(fix job: ${status.remediationJobId})`);
  } else if (status.reason) {
    parts.push(`— ${status.reason}`);
  }
  return parts.join(' ');
}

/**
 * Map an auto-remediation status onto a downgraded webhook callback status.
 * When the parent attempt is being superseded by a replacement, a `failed`
 * webhook would mislead the requestor — return `in_progress` instead.
 */
export function downgradeWebhookStatus(
  baseStatus: string,
  auto: AutoRemediationStatus | undefined,
): string {
  if (!auto || !auto.superseding) return baseStatus;
  if (baseStatus === 'failed') return 'in_progress';
  return baseStatus;
}

/**
 * Map an auto-remediation status onto a downgraded handoff callback status.
 * `failed` becomes `blocked` so Hermes treats this as "still in flight,
 * waiting on a replacement attempt" rather than terminal.
 */
export function downgradeHandoffStatus(
  baseStatus: 'done' | 'blocked' | 'failed',
  auto: AutoRemediationStatus | undefined,
): 'done' | 'blocked' | 'failed' {
  if (!auto || !auto.superseding) return baseStatus;
  if (baseStatus === 'failed') return 'blocked';
  return baseStatus;
}

module.exports = {
  isRemediationJobId,
  summarizeAutoRemediation,
  formatAutoRemediationLine,
  downgradeWebhookStatus,
  downgradeHandoffStatus,
};
