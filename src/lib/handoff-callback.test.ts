/**
 * handoff-callback.test.ts — Tests for structured Hermes ↔ Code Crab handoff callbacks.
 */

import type { JobPacket } from '../types';
import type { HandoffCallbackPayload } from './handoff-callback';

const { extractHandoffId, buildHandoffPayload, resolveCallbackUrl, fireHandoffCallback } = require('./handoff-callback');

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

function makePacket(overrides: Partial<JobPacket> = {}): JobPacket {
  return {
    job_id: 'incident_1713900000000',
    ticket_id: 'PRO-559',
    repo: 'kyan12/ccp',
    goal: 'Add structured handoff completion return path',
    source: 'manual',
    kind: 'feature',
    label: 'hermes-handoff',
    handoff_id: 'hc_20260423_001',
    origin: 'discord:#business-code-handoff',
    requestor: 'Kevin',
    callback_required: true,
    callback_url: 'http://127.0.0.1:8644/webhooks/code-crab-completion',
    completion_routing: 'direct',
    metadata: {
      origin_channel_id: '123456789',
      origin_thread_id: '987654321',
      origin_message_id: '111222333',
    },
    ...overrides,
  };
}

// ── extractHandoffId ────────────────────────────────────────

console.log('\nTest: extractHandoffId — direct field');
{
  const id = extractHandoffId(makePacket());
  assert(id === 'hc_20260423_001', 'extracts handoff_id from direct field');
}

console.log('\nTest: extractHandoffId — metadata fallback');
{
  const id = extractHandoffId(makePacket({
    handoff_id: undefined,
    metadata: { handoff_id: 'hc_meta_001' },
  }));
  assert(id === 'hc_meta_001', 'extracts handoff_id from metadata');
}

console.log('\nTest: extractHandoffId — nested metadata fallback');
{
  const id = extractHandoffId(makePacket({
    handoff_id: undefined,
    metadata: { metadata: { handoff_id: 'hc_nested_001' } },
  }));
  assert(id === 'hc_nested_001', 'extracts handoff_id from nested metadata');
}

console.log('\nTest: extractHandoffId — null when absent');
{
  const id = extractHandoffId(makePacket({ handoff_id: undefined, metadata: {} }));
  assert(id === null, 'returns null when no handoff_id');
}

// ── resolveCallbackUrl ──────────────────────────────────────

console.log('\nTest: resolveCallbackUrl — packet callback_url');
{
  const url = resolveCallbackUrl(makePacket());
  assert(url === 'http://127.0.0.1:8644/webhooks/code-crab-completion', 'uses packet callback_url');
}

console.log('\nTest: resolveCallbackUrl — metadata fallback');
{
  const url = resolveCallbackUrl(makePacket({
    callback_url: undefined,
    metadata: { callback_url: 'http://custom:9999/webhooks/test' },
  }));
  assert(url === 'http://custom:9999/webhooks/test', 'uses metadata callback_url');
}

console.log('\nTest: resolveCallbackUrl — default when absent');
{
  const origEnv = process.env.HERMES_WEBHOOK_URL;
  delete process.env.HERMES_WEBHOOK_URL;
  const url = resolveCallbackUrl(makePacket({ callback_url: undefined, metadata: {} }));
  assert(url === 'http://127.0.0.1:8644/webhooks/code-crab-completion', 'uses default URL');
  if (origEnv) process.env.HERMES_WEBHOOK_URL = origEnv;
}

// ── buildHandoffPayload ─────────────────────────────────────

console.log('\nTest: buildHandoffPayload — full payload shape');
{
  const payload: HandoffCallbackPayload = buildHandoffPayload({
    packet: makePacket(),
    status: 'done',
    summary: 'Implemented handoff callback',
    artifacts: { pr: 'https://github.com/kyan12/ccp/pull/52', branch: 'feat/handoff' },
    verification: { commands: ['npm test'], results: 'all passed' },
    blockers: [],
    writeback_notes: ['Updated architecture docs'],
  });
  assert(payload.handoff_id === 'hc_20260423_001', 'payload has correct handoff_id');
  assert(payload.status === 'done', 'payload has correct status');
  assert(payload.completion_routing === 'direct', 'payload has explicit routing');
  assert(payload.summary === 'Implemented handoff callback', 'payload has summary');
  assert(payload.artifacts.pr === 'https://github.com/kyan12/ccp/pull/52', 'payload has PR artifact');
  assert(payload.artifacts.branch === 'feat/handoff', 'payload has branch artifact');
  assert(payload.artifacts.commit === '', 'absent artifacts default to empty string');
  assert(payload.verification.commands[0] === 'npm test', 'payload has verification commands');
  assert(payload.needs_kevin === false, 'needs_kevin defaults to false');
  assert(payload.origin.channel_id === '123456789', 'payload has origin channel_id');
  assert(payload.origin.thread_id === '987654321', 'payload has origin thread_id');
  assert(Array.isArray(payload.blockers) && payload.blockers.length === 0, 'payload has empty blockers');
  assert(payload.writeback_notes[0] === 'Updated architecture docs', 'payload has writeback_notes');
}

console.log('\nTest: buildHandoffPayload — throws without handoff_id');
{
  let threw = false;
  try {
    buildHandoffPayload({
      packet: makePacket({ handoff_id: undefined, metadata: {} }),
      status: 'done',
      summary: 'test',
    });
  } catch (e: any) {
    threw = e.message.includes('no handoff_id');
  }
  assert(threw, 'throws when handoff_id is missing');
}

console.log('\nTest: buildHandoffPayload — needs_kevin override');
{
  const payload = buildHandoffPayload({
    packet: makePacket(),
    status: 'blocked',
    summary: 'Needs credentials',
    needs_kevin: true,
    next_recommended_action: 'Provide API key for staging',
    blockers: ['Missing staging API key'],
  });
  assert(payload.needs_kevin === true, 'needs_kevin can be set to true');
  assert(payload.next_recommended_action === 'Provide API key for staging', 'next_recommended_action is set');
  assert(payload.blockers[0] === 'Missing staging API key', 'blockers populated for blocked status');
}

// ── Relay routing ───────────────────────────────────────────

console.log('\nTest: buildHandoffPayload — relay mode includes target_audience and relay_message');
{
  const payload = buildHandoffPayload({
    packet: makePacket({ completion_routing: 'relay', requestor: 'Kevin' }),
    status: 'done',
    summary: 'Feature shipped',
    relay_message: 'Hey Kevin, the dashboard is live with per-agent cost breakdowns.',
    target_audience: 'Kevin',
  });
  assert(payload.completion_routing === 'relay', 'relay routing set');
  assert(payload.target_audience === 'Kevin', 'target_audience set from opts');
  assert(payload.relay_message === 'Hey Kevin, the dashboard is live with per-agent cost breakdowns.', 'relay_message set');
}

console.log('\nTest: buildHandoffPayload — relay defaults target_audience to packet.requestor');
{
  const payload = buildHandoffPayload({
    packet: makePacket({ completion_routing: 'relay', requestor: 'Kevin' }),
    status: 'done',
    summary: 'Done',
  });
  assert(payload.target_audience === 'Kevin', 'target_audience defaults to requestor');
  assert(payload.relay_message === 'Done', 'relay_message defaults to summary');
}

console.log('\nTest: buildHandoffPayload — direct mode omits relay fields');
{
  const payload = buildHandoffPayload({
    packet: makePacket({ completion_routing: 'direct' }),
    status: 'done',
    summary: 'Done',
  });
  assert(payload.completion_routing === 'direct', 'direct routing set');
  assert(!payload.target_audience, 'no target_audience in direct mode');
  assert(!payload.relay_message, 'no relay_message in direct mode');
}

// ── fireHandoffCallback ─────────────────────────────────────

console.log('\nTest: fireHandoffCallback — returns null for non-handoff jobs');
{
  const result = fireHandoffCallback({
    packet: makePacket({ handoff_id: undefined, metadata: {} }),
    status: 'done',
    summary: 'regular job',
  });
  assert(result === null, 'returns null when no handoff_id');
}

console.log('\nTest: fireHandoffCallback — returns log message for handoff jobs');
{
  // This will attempt a real HTTP call to localhost which will fail silently
  // (the req.on('error') handler catches it). The function still returns the log msg.
  const result = fireHandoffCallback({
    packet: makePacket(),
    status: 'done',
    summary: 'Implemented the feature',
  });
  assert(typeof result === 'string' && result.includes('handoff callback sent'), 'returns log message');
  assert(result.includes('hc_20260423_001'), 'log message includes handoff_id');
  assert(result.includes('status=done'), 'log message includes status');
}

// ── idempotency: exactly one callback per handoff ────────────

console.log('\nTest: buildHandoffPayload — consistent payload for same inputs');
{
  const opts = {
    packet: makePacket(),
    status: 'done' as const,
    summary: 'test',
  };
  const p1 = buildHandoffPayload(opts);
  const p2 = buildHandoffPayload(opts);
  assert(JSON.stringify(p1) === JSON.stringify(p2), 'same inputs produce identical payloads (deterministic)');
}

// ── PRO-583: maybeFireMergeHandoffCallback (stale-worker reconciliation) ───

const { maybeFireMergeHandoffCallback } = require('./handoff-callback');

console.log('\nTest: maybeFireMergeHandoffCallback — bails on non-handoff packet');
{
  const result = maybeFireMergeHandoffCallback({
    packet: makePacket({ handoff_id: undefined, metadata: {} }),
    jobId: 'linear_pro_999',
    prUrl: 'https://github.com/foo/bar/pull/1',
  });
  assert(result.fired === false, 'does not fire when no handoff_id');
  assert(result.reason === 'no-handoff-id', 'reason is no-handoff-id');
}

console.log('\nTest: maybeFireMergeHandoffCallback — bails when already fired');
{
  const result = maybeFireMergeHandoffCallback({
    packet: makePacket(),
    jobId: 'linear_pro_580',
    prUrl: 'https://github.com/foo/bar/pull/445',
    alreadyFired: true,
  });
  assert(result.fired === false, 'does not re-fire when alreadyFired=true');
  assert(result.reason === 'already-fired', 'reason is already-fired');
}

console.log('\nTest: maybeFireMergeHandoffCallback — fires for stale-worker merged PR (linear_pro_580 case)');
{
  // Mirrors the linear_pro_580 scenario: worker was interrupted (exit 130),
  // job state went to blocked, but the PR for the work was merged. The
  // pr-watcher cycle now reconciles by firing the deferred handoff callback.
  const result = maybeFireMergeHandoffCallback({
    packet: makePacket({
      handoff_id: 'seo-koka-crawl-insert-claims-20260427',
      ticket_id: 'PRO-580',
    }),
    jobId: 'linear_pro_580',
    prUrl: 'https://github.com/ProteusX-Consulting/proteusx-seo/pull/445',
    commit: 'abc123def4567',
    branch: 'fix/koka-crawl-respectrobotstxt',
    alreadyFired: false,
  });
  assert(result.fired === true, 'fires when handoff_id present and not already fired');
  assert(result.reason === 'fired', 'reason is fired');
  assert(typeof result.log === 'string' && result.log.includes('seo-koka-crawl-insert-claims-20260427'),
    'log message references the handoff_id');
  assert(typeof result.log === 'string' && result.log.includes('status=done'),
    'log message reports done status (PR merged)');
}

console.log('\nTest: maybeFireMergeHandoffCallback — second cycle with alreadyFired=true is no-op');
{
  // This proves idempotency at the helper boundary: pr-watcher reads the
  // persisted handoffCallback.fired flag and passes it in. A subsequent
  // cycle on the same job must not re-fire.
  const opts = {
    packet: makePacket(),
    jobId: 'linear_pro_580',
    prUrl: 'https://github.com/foo/bar/pull/445',
    alreadyFired: false,
  };
  const first = maybeFireMergeHandoffCallback(opts);
  const second = maybeFireMergeHandoffCallback({ ...opts, alreadyFired: true });
  assert(first.fired === true, 'first call fires');
  assert(second.fired === false, 'second call (with alreadyFired=true) does not fire');
  assert(second.reason === 'already-fired', 'second call reason is already-fired');
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
