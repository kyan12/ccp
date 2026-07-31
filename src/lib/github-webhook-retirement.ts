import { verifyHmacSha256 } from './webhook-auth';

interface RetiredGitHubWebhookInput {
  secret: string;
  rawBody: Buffer | string;
  signature: string;
}

interface RetiredGitHubWebhookResponse {
  status: 403 | 410;
  body: Record<string, unknown>;
}

function retiredGitHubWebhookResponse(input: RetiredGitHubWebhookInput): RetiredGitHubWebhookResponse {
  const authenticated = verifyHmacSha256(input.secret, input.rawBody, input.signature, 'sha256=');
  if (!authenticated) {
    return { status: 403, body: { ok: false, error: 'bad GitHub signature' } };
  }

  return {
    status: 410,
    body: {
      ok: false,
      action: 'retired',
      retryable: false,
      replacement: 'native-hermes-kanban',
      message: 'CCP GitHub intake is retired; native Hermes Kanban workers and GitHub required checks own review, CI, and merge lifecycle.',
    },
  };
}

module.exports = { retiredGitHubWebhookResponse };
export { retiredGitHubWebhookResponse };
