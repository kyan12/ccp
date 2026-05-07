import fs = require('fs');
import path = require('path');
import type { JobPacket, JobResult, JobStatus } from '../types';
const { sendDiscordMessage, createDiscordThread } = require('./discord');

const ROOT: string = path.resolve(process.env.CCP_ROOT || path.join(__dirname, '..', '..'));
const PROGRESS_THREADS_DIR: string = path.join(ROOT, 'supervisor', 'progress-threads');
const PROGRESS_CHANNEL: string = process.env.CCP_DISCORD_PROGRESS_CHANNEL
  || process.env.CCP_DISCORD_MAIN_AGENT_CHANNEL
  || process.env.CCP_DISCORD_STATUS_CHANNEL
  || process.env.CCP_DISCORD_REVIEW_CHANNEL
  || '';

interface RepoProgressThreadState {
  date: string;
  repoKey: string;
  channelId: string;
  messageId: string;
  threadId: string;
  created_at: string;
}

function nowIso(): string {
  return new Date().toISOString();
}

function progressLocalDate(date: Date = new Date()): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date).reduce((acc: Record<string, string>, part) => {
    acc[part.type] = part.value;
    return acc;
  }, {});
  return `${parts.year}-${parts.month}-${parts.day}`;
}

function sanitizeSlug(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80) || 'unknown';
}

function repoDisplayName(packet: JobPacket): string {
  if (packet.repoKey) return packet.repoKey;
  if (packet.ownerRepo) return packet.ownerRepo.split('/').pop() || packet.ownerRepo;
  if (packet.repo) return path.basename(packet.repo);
  return 'unknown';
}

function repoThreadStatePath(date: string, repoKey: string): string {
  return path.join(PROGRESS_THREADS_DIR, date, `${sanitizeSlug(repoKey)}.json`);
}

function readThreadState(file: string): RepoProgressThreadState | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as Partial<RepoProgressThreadState>;
    if (parsed.threadId && parsed.channelId) return parsed as RepoProgressThreadState;
  } catch {
    // absent/corrupt state is treated as a cache miss; we'll create a fresh thread.
  }
  return null;
}

function writeThreadState(file: string, state: RepoProgressThreadState): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(state, null, 2) + '\n');
}

function ensureRepoProgressThread(packet: JobPacket, date: string = progressLocalDate()): { ok: boolean; threadId: string | null; reason?: string } {
  if (!PROGRESS_CHANNEL) return { ok: false, threadId: null, reason: 'progress channel not configured' };
  const repoKey = repoDisplayName(packet);
  if (repoKey === 'unknown') return { ok: false, threadId: null, reason: 'repo not available' };

  const file = repoThreadStatePath(date, repoKey);
  const existing = readThreadState(file);
  if (existing?.threadId) return { ok: true, threadId: existing.threadId };

  const anchor = sendDiscordMessage(
    PROGRESS_CHANNEL,
    `🧵 CCP repo progress — **${repoKey}** — ${date}\nNightly compounds and implementation runs for this repo will summarize here.`,
  );
  if (!anchor.ok || !anchor.messageId) {
    return { ok: false, threadId: null, reason: anchor.stderr || 'anchor message failed' };
  }

  const threadName = `CCP ${repoKey} — ${date}`.slice(0, 100);
  const thread = createDiscordThread(PROGRESS_CHANNEL, anchor.messageId, threadName);
  if (!thread.ok || !thread.threadId) {
    return { ok: false, threadId: null, reason: thread.stderr || 'thread creation failed' };
  }

  writeThreadState(file, {
    date,
    repoKey,
    channelId: PROGRESS_CHANNEL,
    messageId: anchor.messageId,
    threadId: thread.threadId,
    created_at: nowIso(),
  });
  return { ok: true, threadId: thread.threadId };
}

function truncateLine(value: string, max: number = 500): string {
  const trimmed = value.replace(/\s+/g, ' ').trim();
  return trimmed.length <= max ? trimmed : trimmed.slice(0, max - 3) + '...';
}

function buildRepoProgressSummary(packet: JobPacket, status: JobStatus, result: JobResult): string {
  const repoKey = repoDisplayName(packet);
  const ticket = packet.ticket_id || packet.job_id || result.job_id;
  const isNightly = packet.source === 'nightly' || packet.label === 'nightly' || packet.kind === 'compound';
  const icon = result.state === 'blocked' || result.state === 'failed' || result.state === 'dirty-repo' || result.state === 'harness-failure'
    ? '🔴'
    : result.state === 'no-op'
      ? '⏭️'
      : '✅';
  const lines: string[] = [
    `${icon} **${isNightly ? 'Nightly compound' : 'Implementation run'}** — ${ticket}`,
    `State: \`${result.state}\``,
  ];

  if (packet.goal) lines.push(`Goal: ${truncateLine(packet.goal, 280)}`);
  if (result.summary) lines.push(`Summary: ${truncateLine(result.summary, 700)}`);
  if (result.learning) lines.push(`Learned: ${truncateLine(result.learning, 500)}`);
  if (result.implemented) lines.push(`Added: ${truncateLine(result.implemented, 500)}`);
  if (result.pr_url) lines.push(`PR: ${result.pr_url}`);
  if (result.branch && result.branch !== 'unknown') lines.push(`Branch: \`${result.branch}\``);
  if (result.commit && result.commit !== 'none') lines.push(`Commit: \`${result.commit.slice(0, 12)}\``);
  if (result.verified && result.verified !== 'not yet') lines.push(`Verified: ${truncateLine(result.verified, 350)}`);
  if (result.risk) lines.push(`Risk: ${truncateLine(result.risk, 300)}`);
  if (result.blocker) lines.push(`Blocker: ${truncateLine(result.blocker, 700)}`);
  if (typeof status.elapsed_sec === 'number' && status.elapsed_sec > 0) lines.push(`Runtime: ${status.elapsed_sec}s`);

  const message = lines.join('\n');
  return message.length <= 1900 ? message : message.slice(0, 1897) + '...';
}

function postRepoProgressSummary(packet: JobPacket, status: JobStatus, result: JobResult): { ok: boolean; threadId: string | null; reason?: string } {
  if (!packet.repo && !packet.repoKey && !packet.ownerRepo) {
    return { ok: false, threadId: null, reason: 'repo not available' };
  }
  const ensured = ensureRepoProgressThread(packet);
  if (!ensured.ok || !ensured.threadId) return ensured;
  const sent = sendDiscordMessage(ensured.threadId, buildRepoProgressSummary(packet, status, result));
  return sent.ok
    ? { ok: true, threadId: ensured.threadId }
    : { ok: false, threadId: ensured.threadId, reason: sent.stderr || 'progress summary send failed' };
}

module.exports = {
  progressLocalDate,
  buildRepoProgressSummary,
  ensureRepoProgressThread,
  postRepoProgressSummary,
};

export {
  progressLocalDate,
  buildRepoProgressSummary,
  ensureRepoProgressThread,
  postRepoProgressSummary,
};
