import assert = require('node:assert/strict');
import test = require('node:test');
import { hmacSha256Hex } from './webhook-auth';
import { retiredGitHubWebhookResponse } from './github-webhook-retirement';

const secret = 'github-retirement-test-secret';
const rawBody = Buffer.from('{"action":"completed","check_run":{"conclusion":"failure"}}');

test('retired GitHub webhook rejects missing and tampered signatures', () => {
  const missing = retiredGitHubWebhookResponse({ secret, rawBody, signature: '' });
  assert.equal(missing.status, 403);
  assert.deepEqual(missing.body, { ok: false, error: 'bad GitHub signature' });

  const tampered = retiredGitHubWebhookResponse({
    secret,
    rawBody: Buffer.from('{"action":"completed","check_run":{"conclusion":"success"}}'),
    signature: `sha256=${hmacSha256Hex(secret, rawBody)}`,
  });
  assert.equal(tampered.status, 403);
});

test('retired GitHub webhook authenticates before returning an explicit non-retryable 410', () => {
  const response = retiredGitHubWebhookResponse({
    secret,
    rawBody,
    signature: `sha256=${hmacSha256Hex(secret, rawBody)}`,
  });

  assert.equal(response.status, 410);
  assert.equal(response.body.action, 'retired');
  assert.equal(response.body.retryable, false);
  assert.equal(response.body.replacement, 'native-hermes-kanban');
});
