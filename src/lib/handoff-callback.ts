/**
 * handoff-callback.ts — Structured completion callback for Hermes ↔ Code Crab handoffs.
 *
 * When a job with a handoff_id completes/blocks/fails, this module emits
 * exactly one structured callback to the Hermes webhook endpoint so Hermes
 * can update the handoff record and notify the origin thread without Kevin
 * as a manual relay.
 *
 * Separate from webhook-callback.ts which handles app-dispatched fix callbacks.
 */

import type { JobPacket } from '../types';

const DEFAULT_HERMES_WEBHOOK_URL = 'http://127.0.0.1:8644/webhooks/code-crab-completion';

export interface HandoffCallbackPayload {
  handoff_id: string;
  status: 'done' | 'blocked' | 'failed';
  summary: string;
  artifacts: {
    pr?: string;
    commit?: string;
    branch?: string;
    deploy_url?: string;
    logs?: string;
  };
  verification: {
    commands: string[];
    results: string;
  };
  needs_kevin: boolean;
  next_recommended_action: string;
  origin: {
    channel_id: string;
    thread_id: string;
    message_id: string;
  };
}

export interface HandoffCallbackOpts {
  packet: JobPacket;
  status: 'done' | 'blocked' | 'failed';
  summary: string;
  artifacts?: HandoffCallbackPayload['artifacts'];
  verification?: HandoffCallbackPayload['verification'];
  needs_kevin?: boolean;
  next_recommended_action?: string;
  origin?: Partial<HandoffCallbackPayload['origin']>;
}

/**
 * Extract the handoff_id from a JobPacket. Returns null if this job
 * is not part of a Hermes handoff.
 */
function extractHandoffId(packet: JobPacket): string | null {
  // Direct field on packet
  if (packet.handoff_id) return packet.handoff_id;
  // Fallback: check metadata
  const meta = (packet.metadata as Record<string, unknown>) || {};
  const innerMeta = (meta.metadata as Record<string, unknown>) || {};
  return (meta.handoff_id || innerMeta.handoff_id || null) as string | null;
}

/**
 * Resolve the Hermes webhook URL for handoff callbacks.
 * Priority: packet.callback_url > env HERMES_WEBHOOK_URL > default localhost.
 */
function resolveCallbackUrl(packet: JobPacket): string {
  if (packet.callback_url) return packet.callback_url;
  const meta = (packet.metadata as Record<string, unknown>) || {};
  if (meta.callback_url) return meta.callback_url as string;
  return process.env.HERMES_WEBHOOK_URL || DEFAULT_HERMES_WEBHOOK_URL;
}

/**
 * Parse origin metadata from the packet's origin field.
 * Expected format: "discord:#channel-name" or structured origin metadata.
 */
function extractOriginMeta(packet: JobPacket, overrides?: Partial<HandoffCallbackPayload['origin']>): HandoffCallbackPayload['origin'] {
  const meta = (packet.metadata as Record<string, unknown>) || {};
  return {
    channel_id: overrides?.channel_id || (meta.origin_channel_id as string) || '',
    thread_id: overrides?.thread_id || (meta.origin_thread_id as string) || '',
    message_id: overrides?.message_id || (meta.origin_message_id as string) || '',
  };
}

/**
 * Build the structured handoff callback payload.
 */
function buildHandoffPayload(opts: HandoffCallbackOpts): HandoffCallbackPayload {
  const handoff_id = extractHandoffId(opts.packet);
  if (!handoff_id) throw new Error('Cannot build handoff payload: no handoff_id on packet');

  return {
    handoff_id,
    status: opts.status,
    summary: opts.summary,
    artifacts: {
      pr: opts.artifacts?.pr || '',
      commit: opts.artifacts?.commit || '',
      branch: opts.artifacts?.branch || '',
      deploy_url: opts.artifacts?.deploy_url || '',
      logs: opts.artifacts?.logs || '',
    },
    verification: {
      commands: opts.verification?.commands || [],
      results: opts.verification?.results || '',
    },
    needs_kevin: opts.needs_kevin ?? false,
    next_recommended_action: opts.next_recommended_action || '',
    origin: extractOriginMeta(opts.packet, opts.origin),
  };
}

/**
 * Fire a structured handoff completion callback to the Hermes webhook.
 * Returns a log message describing what happened, or null if no callback was needed
 * (e.g., packet has no handoff_id).
 */
function fireHandoffCallback(opts: HandoffCallbackOpts): string | null {
  const handoffId = extractHandoffId(opts.packet);
  if (!handoffId) return null;

  const payload = buildHandoffPayload(opts);
  const body = JSON.stringify(payload);
  const callbackUrl = resolveCallbackUrl(opts.packet);

  // HMAC signing — uses the same CONTROL_PLANE_SECRET as webhook-callback.ts
  const secret = process.env.CONTROL_PLANE_SECRET;
  const sig = secret
    ? `sha256=${require('crypto').createHmac('sha256', secret).update(body).digest('hex')}`
    : '';

  try {
    const https = require('https');
    const http = require('http');
    const parsed = new URL(callbackUrl);
    const mod = parsed.protocol === 'https:' ? https : http;
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'X-Handoff-ID': handoffId,
    };
    if (sig) headers['X-Signature-256'] = sig;

    const req = mod.request(parsed, {
      method: 'POST',
      headers,
    });
    req.on('error', (err: Error) => {
      console.error(`[ccp] handoff callback network error for ${callbackUrl}: ${err.message}`);
    });
    req.write(body);
    req.end();
    return `handoff callback sent to ${callbackUrl} (handoff_id=${handoffId}, status=${opts.status})`;
  } catch (err) {
    return `handoff callback failed: ${(err as Error).message}`;
  }
}

module.exports = { fireHandoffCallback, extractHandoffId, buildHandoffPayload, resolveCallbackUrl };
export { fireHandoffCallback, extractHandoffId, buildHandoffPayload, resolveCallbackUrl };
