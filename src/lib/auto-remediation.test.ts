/**
 * auto-remediation.test.ts — Tests for structured auto-remediation status helpers.
 *
 * Covers summarizeAutoRemediation disposition logic, formatAutoRemediationLine
 * rendering, downgradeWebhookStatus / downgradeHandoffStatus callbacks, and
 * isRemediationJobId pattern matching.
 */

import type { AutoRemediationStatus } from '../types';
import type { SummarizeAutoRemediationInput } from './auto-remediation';

const {
  isRemediationJobId,
  summarizeAutoRemediation,
  formatAutoRemediationLine,
  downgradeWebhookStatus,
  downgradeHandoffStatus,
} = require('./auto-remediation');

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

function base(overrides: Partial<SummarizeAutoRemediationInput> = {}): SummarizeAutoRemediationInput {
  return {
    state: 'blocked',
    ...overrides,
  };
}

// ── isRemediationJobId ─────────────────────────────────────────

console.log('\nTest: isRemediationJobId');
{
  assert(isRemediationJobId('job_123__reviewfix') === true, 'matches __reviewfix suffix');
  assert(isRemediationJobId('job_123__valfix') === true, 'matches __valfix suffix');
  assert(isRemediationJobId('job_123__deployfix') === true, 'matches __deployfix suffix');
  assert(isRemediationJobId('job_123__autoretry') === true, 'matches __autoretry suffix');
  assert(isRemediationJobId('job_123') === false, 'rejects plain job id');
  assert(isRemediationJobId('job_123__other') === false, 'rejects unknown suffix');
  assert(isRemediationJobId('') === false, 'rejects empty string');
}

// ── summarizeAutoRemediation: superseded ────────────────────────

console.log('\nTest: summarizeAutoRemediation — superseded');
{
  const result: AutoRemediationStatus = summarizeAutoRemediation(base({ superseded: true }));
  assert(result.disposition === 'superseded', 'disposition is superseded');
  assert(result.superseding === true, 'superseding flag set');
  assert(result.source === 'none', 'source is none');
}

// ── summarizeAutoRemediation: disabled ──────────────────────────

console.log('\nTest: summarizeAutoRemediation — disabled');
{
  const result: AutoRemediationStatus = summarizeAutoRemediation(base({ remediationDisabled: true }));
  assert(result.disposition === 'disabled', 'disposition is disabled');
  assert(result.superseding === false, 'superseding is false');
}

// ── summarizeAutoRemediation: depth-limit ───────────────────────

console.log('\nTest: summarizeAutoRemediation — depth-limit');
{
  const result: AutoRemediationStatus = summarizeAutoRemediation(base({ remediationDepthLimited: true }));
  assert(result.disposition === 'depth-limit', 'disposition is depth-limit');
  assert(result.superseding === false, 'superseding is false');
}

// ── summarizeAutoRemediation: queued (validation) ───────────────

console.log('\nTest: summarizeAutoRemediation — queued via validation');
{
  const result: AutoRemediationStatus = summarizeAutoRemediation(base({
    validationRemediation: { ok: true, skipped: false, job_id: 'fix_val_001' },
  }));
  assert(result.disposition === 'queued', 'disposition is queued');
  assert(result.source === 'validation', 'source is validation');
  assert(result.remediationJobId === 'fix_val_001', 'remediationJobId set');
}

// ── summarizeAutoRemediation: queued (review) ───────────────────

console.log('\nTest: summarizeAutoRemediation — queued via review');
{
  const result: AutoRemediationStatus = summarizeAutoRemediation(base({
    reviewRemediation: { ok: true, skipped: false, job_id: 'fix_rev_001' },
  }));
  assert(result.disposition === 'queued', 'disposition is queued');
  assert(result.source === 'review', 'source is review');
}

// ── summarizeAutoRemediation: queued (smoke) ────────────────────

console.log('\nTest: summarizeAutoRemediation — queued via smoke');
{
  const result: AutoRemediationStatus = summarizeAutoRemediation(base({
    smokeRemediation: { ok: true, skipped: false, job_id: 'fix_smoke_001' },
  }));
  assert(result.disposition === 'queued', 'disposition is queued');
  assert(result.source === 'smoke', 'source is smoke');
}

// ── summarizeAutoRemediation: queued priority (validation > review > smoke) ──

console.log('\nTest: summarizeAutoRemediation — queued priority order');
{
  const result: AutoRemediationStatus = summarizeAutoRemediation(base({
    validationRemediation: { ok: true, skipped: false, job_id: 'val_001' },
    reviewRemediation: { ok: true, skipped: false, job_id: 'rev_001' },
    smokeRemediation: { ok: true, skipped: false, job_id: 'smoke_001' },
  }));
  assert(result.source === 'validation', 'validation wins when all three are active');
}

// ── summarizeAutoRemediation: existing ──────────────────────────

console.log('\nTest: summarizeAutoRemediation — existing remediation');
{
  const result: AutoRemediationStatus = summarizeAutoRemediation(base({
    reviewRemediation: { ok: false, skipped: true, reason: 'remediation already exists' },
  }));
  assert(result.disposition === 'existing', 'disposition is existing');
  assert(result.source === 'review', 'source is review');
}

console.log('\nTest: summarizeAutoRemediation — existing with "in progress" reason');
{
  const result: AutoRemediationStatus = summarizeAutoRemediation(base({
    validationRemediation: { ok: false, skipped: true, reason: 'fix in progress for parent' },
  }));
  assert(result.disposition === 'existing', 'disposition is existing for "in progress" reason');
}

console.log('\nTest: summarizeAutoRemediation — existing with "already enqueued" reason');
{
  const result: AutoRemediationStatus = summarizeAutoRemediation(base({
    smokeRemediation: { ok: false, skipped: true, reason: 'already enqueued' },
  }));
  assert(result.disposition === 'existing', 'disposition is existing for "already enqueued" reason');
}

// ── summarizeAutoRemediation: pending-watcher ───────────────────

console.log('\nTest: summarizeAutoRemediation — pending-watcher (blocked + PR)');
{
  const result: AutoRemediationStatus = summarizeAutoRemediation(base({
    state: 'blocked',
    prUrl: 'https://github.com/org/repo/pull/42',
  }));
  assert(result.disposition === 'pending-watcher', 'disposition is pending-watcher');
  assert(result.source === 'review', 'source is review');
}

console.log('\nTest: summarizeAutoRemediation — pending-watcher (coded + PR)');
{
  const result: AutoRemediationStatus = summarizeAutoRemediation(base({
    state: 'coded',
    prUrl: 'https://github.com/org/repo/pull/42',
  }));
  assert(result.disposition === 'pending-watcher', 'disposition is pending-watcher for coded state');
}

// ── summarizeAutoRemediation: harness-failure not-applicable ────

console.log('\nTest: summarizeAutoRemediation — harness-failure, no PR, no commit');
{
  const result: AutoRemediationStatus = summarizeAutoRemediation(base({
    state: 'harness-failure',
    prUrl: null,
    commitRecovered: false,
  }));
  assert(result.disposition === 'not-applicable', 'disposition is not-applicable');
  assert(result.reason!.includes('harness-failure'), 'reason mentions harness-failure');
}

// ── summarizeAutoRemediation: harness-failure WITH recovered PR ─
// Note: in practice, if CCP recovers a PR from a harnessless exit, the
// final state is `coded` (not `harness-failure`), so the pending-watcher
// path applies via the coded branch. A harness-failure + prUrl is not a
// realistic combination, but verify the catch-all handles it gracefully.

console.log('\nTest: summarizeAutoRemediation — harness-failure with PR falls to catch-all');
{
  const result: AutoRemediationStatus = summarizeAutoRemediation(base({
    state: 'harness-failure',
    prUrl: 'https://github.com/org/repo/pull/99',
    commitRecovered: false,
  }));
  assert(result.disposition === 'not-applicable', 'harness-failure + prUrl is not-applicable (coded state would be used in practice)');
}

// ── summarizeAutoRemediation: catch-all not-applicable ──────────

console.log('\nTest: summarizeAutoRemediation — catch-all not-applicable');
{
  const result: AutoRemediationStatus = summarizeAutoRemediation(base({
    state: 'failed',
    prUrl: null,
  }));
  assert(result.disposition === 'not-applicable', 'catch-all is not-applicable');
  assert(result.superseding === false, 'superseding is false');
}

// ── summarizeAutoRemediation: priority chain ────────────────────

console.log('\nTest: summarizeAutoRemediation — superseded beats everything');
{
  const result: AutoRemediationStatus = summarizeAutoRemediation(base({
    superseded: true,
    remediationDisabled: true,
    remediationDepthLimited: true,
    reviewRemediation: { ok: true, skipped: false, job_id: 'fix_001' },
  }));
  assert(result.disposition === 'superseded', 'superseded wins over all other dispositions');
}

console.log('\nTest: summarizeAutoRemediation — disabled beats depth-limit');
{
  const result: AutoRemediationStatus = summarizeAutoRemediation(base({
    remediationDisabled: true,
    remediationDepthLimited: true,
  }));
  assert(result.disposition === 'disabled', 'disabled wins over depth-limit');
}

console.log('\nTest: summarizeAutoRemediation — depth-limit beats queued');
{
  const result: AutoRemediationStatus = summarizeAutoRemediation(base({
    remediationDepthLimited: true,
    reviewRemediation: { ok: true, skipped: false, job_id: 'fix_001' },
  }));
  assert(result.disposition === 'depth-limit', 'depth-limit wins over queued');
}

// ── summarizeAutoRemediation: skipped remediation is not "queued" ─

console.log('\nTest: summarizeAutoRemediation — skipped remediation not treated as queued');
{
  const result: AutoRemediationStatus = summarizeAutoRemediation(base({
    reviewRemediation: { ok: true, skipped: true, reason: 'no blocking review' },
  }));
  // skipped=true means pickFirstActive won't match it; should fall through
  assert(result.disposition !== 'queued', 'skipped remediation does not produce queued disposition');
}

// ── formatAutoRemediationLine ──────────────────────────────────

console.log('\nTest: formatAutoRemediationLine — queued with job id');
{
  const line: string = formatAutoRemediationLine({
    disposition: 'queued',
    superseding: false,
    source: 'review',
    remediationJobId: 'fix_rev_001',
    reason: 'fix job enqueued: fix_rev_001',
  });
  assert(line.includes('Auto-remediation: queued'), 'starts with Auto-remediation: queued');
  assert(line.includes('fix_rev_001'), 'includes job id');
}

console.log('\nTest: formatAutoRemediationLine — disabled');
{
  const line: string = formatAutoRemediationLine({
    disposition: 'disabled',
    superseding: false,
    source: 'none',
    reason: 'auto-remediation disabled (CCP_PR_REMEDIATE_ENABLED=false)',
  });
  assert(line.includes('Auto-remediation: disabled'), 'starts with Auto-remediation: disabled');
  assert(line.includes('CCP_PR_REMEDIATE_ENABLED'), 'includes reason detail');
}

console.log('\nTest: formatAutoRemediationLine — not-applicable');
{
  const line: string = formatAutoRemediationLine({
    disposition: 'not-applicable',
    superseding: false,
    source: 'none',
    reason: 'no PR/blocking review/validation/smoke gate to remediate',
  });
  assert(line.includes('Auto-remediation: not applicable'), 'renders not-applicable label');
}

console.log('\nTest: formatAutoRemediationLine — superseded');
{
  const line: string = formatAutoRemediationLine({
    disposition: 'superseded',
    superseding: true,
    source: 'none',
    reason: 'replacement attempt is active for this ticket',
  });
  assert(line.includes('superseded by replacement attempt'), 'renders superseded label');
}

// ── downgradeWebhookStatus ─────────────────────────────────────

console.log('\nTest: downgradeWebhookStatus');
{
  assert(
    downgradeWebhookStatus('failed', { disposition: 'superseded', superseding: true }) === 'in_progress',
    'failed → in_progress when superseding',
  );
  assert(
    downgradeWebhookStatus('failed', { disposition: 'queued', superseding: false }) === 'failed',
    'failed stays failed when not superseding',
  );
  assert(
    downgradeWebhookStatus('done', { disposition: 'superseded', superseding: true }) === 'done',
    'done stays done even when superseding',
  );
  assert(
    downgradeWebhookStatus('failed', undefined) === 'failed',
    'failed stays failed when auto is undefined',
  );
}

// ── downgradeHandoffStatus ─────────────────────────────────────

console.log('\nTest: downgradeHandoffStatus');
{
  assert(
    downgradeHandoffStatus('failed', { disposition: 'superseded', superseding: true }) === 'blocked',
    'failed → blocked when superseding',
  );
  assert(
    downgradeHandoffStatus('failed', { disposition: 'queued', superseding: false }) === 'failed',
    'failed stays failed when not superseding',
  );
  assert(
    downgradeHandoffStatus('done', { disposition: 'superseded', superseding: true }) === 'done',
    'done stays done even when superseding',
  );
  assert(
    downgradeHandoffStatus('blocked', { disposition: 'superseded', superseding: true }) === 'blocked',
    'blocked stays blocked when superseding',
  );
  assert(
    downgradeHandoffStatus('failed', undefined) === 'failed',
    'failed stays failed when auto is undefined',
  );
}

// ── Summary ────────────────────────────────────────────────────

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
