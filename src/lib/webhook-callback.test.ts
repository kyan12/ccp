import type { JobPacket } from '../types';

const { extractWebhookMeta, fireWebhookCallback } = require('./webhook-callback');

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
    job_id: 'test_1',
    ticket_id: 'TEST-1',
    repo: '/tmp/repo',
    goal: 'Do something',
    source: 'test',
    kind: 'task',
    label: 'test',
    ...overrides,
  };
}

// ── Test: extractWebhookMeta returns null when no metadata ──
console.log('\nTest: extractWebhookMeta returns null when no metadata');
{
  const packet = makePacket();
  const result = extractWebhookMeta(packet);
  assert(result.webhookUrl === null, 'webhookUrl is null');
  assert(result.fixId === null, 'fixId is null');
}

// ── Test: extractWebhookMeta extracts from top-level metadata ──
console.log('\nTest: extractWebhookMeta extracts from top-level metadata');
{
  const packet = makePacket({
    metadata: { webhookUrl: 'https://example.com/hook', fixId: 'fix_123' },
  });
  const result = extractWebhookMeta(packet);
  assert(result.webhookUrl === 'https://example.com/hook', 'webhookUrl extracted');
  assert(result.fixId === 'fix_123', 'fixId extracted');
}

// ── Test: extractWebhookMeta extracts from nested metadata ──
console.log('\nTest: extractWebhookMeta extracts from nested metadata');
{
  const packet = makePacket({
    metadata: {
      metadata: { webhookUrl: 'https://nested.com/hook', fixId: 'fix_nested' },
    },
  });
  const result = extractWebhookMeta(packet);
  assert(result.webhookUrl === 'https://nested.com/hook', 'webhookUrl from nested metadata');
  assert(result.fixId === 'fix_nested', 'fixId from nested metadata');
}

// ── Test: top-level metadata takes precedence over nested ──
console.log('\nTest: top-level metadata takes precedence over nested');
{
  const packet = makePacket({
    metadata: {
      webhookUrl: 'https://top.com/hook',
      fixId: 'fix_top',
      metadata: { webhookUrl: 'https://nested.com/hook', fixId: 'fix_nested' },
    },
  });
  const result = extractWebhookMeta(packet);
  assert(result.webhookUrl === 'https://top.com/hook', 'top-level webhookUrl wins');
  assert(result.fixId === 'fix_top', 'top-level fixId wins');
}

// ── Test: fireWebhookCallback returns null when no webhook metadata ──
console.log('\nTest: fireWebhookCallback returns null when no webhook metadata');
{
  const packet = makePacket();
  const result = fireWebhookCallback({ packet, jobId: 'j1', status: 'done' });
  assert(result === null, 'returns null when no webhook metadata');
}

// ── Test: fireWebhookCallback returns log message on valid webhook ──
console.log('\nTest: fireWebhookCallback returns log message on valid webhook');
{
  const packet = makePacket({
    metadata: { webhookUrl: 'http://localhost:19999/hook', fixId: 'fix_1' },
  });
  const result = fireWebhookCallback({ packet, jobId: 'j1', status: 'done', prUrl: 'https://github.com/pr/1' });
  assert(typeof result === 'string', 'returns a string');
  assert(result!.includes('webhook callback sent'), 'log message indicates sent');
  assert(result!.includes('localhost:19999'), 'log message includes URL');
}

// ── Test: fireWebhookCallback handles invalid URL gracefully ──
console.log('\nTest: fireWebhookCallback handles invalid URL gracefully');
{
  const packet = makePacket({
    metadata: { webhookUrl: 'not-a-url', fixId: 'fix_bad' },
  });
  const result = fireWebhookCallback({ packet, jobId: 'j1', status: 'done' });
  assert(typeof result === 'string', 'returns a string');
  assert(result!.includes('webhook callback failed'), 'log message indicates failure');
}

// ── Summary ──
console.log(`\nwebhook-callback tests: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
