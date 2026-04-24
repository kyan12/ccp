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
  });
  assert(payload.handoff_id === 'hc_20260423_001', 'payload has correct handoff_id');
  assert(payload.status === 'done', 'payload has correct status');
  assert(payload.summary === 'Implemented handoff callback', 'payload has summary');
  assert(payload.artifacts.pr === 'https://github.com/kyan12/ccp/pull/52', 'payload has PR artifact');
  assert(payload.artifacts.branch === 'feat/handoff', 'payload has branch artifact');
  assert(payload.artifacts.commit === '', 'absent artifacts default to empty string');
  assert(payload.verification.commands[0] === 'npm test', 'payload has verification commands');
  assert(payload.needs_kevin === false, 'needs_kevin defaults to false');
  assert(payload.origin.channel_id === '123456789', 'payload has origin channel_id');
  assert(payload.origin.thread_id === '987654321', 'payload has origin thread_id');
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
  });
  assert(payload.needs_kevin === true, 'needs_kevin can be set to true');
  assert(payload.next_recommended_action === 'Provide API key for staging', 'next_recommended_action is set');
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

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
