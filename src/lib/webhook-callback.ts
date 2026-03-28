/**
 * webhook-callback.ts — Shared webhook callback logic for app-dispatched fixes.
 *
 * Extracted from jobs.ts and pr-watcher.ts to prevent drift.
 * Handles HMAC signing and HTTP POST to the callback URL.
 */

import type { JobPacket } from '../types';

interface WebhookCallbackOpts {
  packet: JobPacket;
  jobId: string;
  status: string;
  prUrl?: string | null;
  error?: string | null;
}

/**
 * Extract webhookUrl and fixId from potentially nested metadata.
 * metadata can be nested: packet.metadata.metadata.webhookUrl
 * (normalizeManualIssue wraps payload).
 */
function extractWebhookMeta(packet: JobPacket): { webhookUrl: string | null; fixId: string | null } {
  const meta = (packet.metadata as Record<string, unknown>) || {};
  const innerMeta = (meta.metadata as Record<string, unknown>) || {};
  return {
    webhookUrl: (meta.webhookUrl || innerMeta.webhookUrl || null) as string | null,
    fixId: (meta.fixId || innerMeta.fixId || null) as string | null,
  };
}

/**
 * Fire a webhook callback if the packet has a webhookUrl + fixId in metadata.
 * Returns a log message describing what happened, or null if no callback was needed.
 */
function fireWebhookCallback(opts: WebhookCallbackOpts): string | null {
  const { webhookUrl, fixId } = extractWebhookMeta(opts.packet);
  if (!webhookUrl || !fixId) return null;

  const webhookPayload = JSON.stringify({
    fixId,
    requestId: opts.packet.ticket_id || opts.jobId,
    status: opts.status,
    prUrl: opts.prUrl || null,
    linearTicketId: opts.packet.ticket_id || null,
    ...(opts.error !== undefined ? { error: opts.error } : {}),
  });

  const secret = process.env.CONTROL_PLANE_SECRET;
  const sig = secret ? `sha256=${require('crypto').createHmac('sha256', secret).update(webhookPayload).digest('hex')}` : '';

  try {
    const https = require('https');
    const http = require('http');
    const parsed = new URL(webhookUrl);
    const mod = parsed.protocol === 'https:' ? https : http;
    const whReq = mod.request(parsed, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(sig ? { 'X-Signature-256': sig } : {}) } });
    whReq.write(webhookPayload);
    whReq.end();
    return `webhook callback sent to ${webhookUrl} (status=${opts.status})`;
  } catch (whErr) {
    return `webhook callback failed: ${(whErr as Error).message}`;
  }
}

module.exports = { fireWebhookCallback, extractWebhookMeta };
export { fireWebhookCallback, extractWebhookMeta };
