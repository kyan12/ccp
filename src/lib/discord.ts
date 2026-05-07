import path = require('path');
import { spawnSync } from 'child_process';
import type { DiscordMessageResult, DiscordThreadResult } from '../types';
const { commandExists, run } = require('./shell');

const OPENCLAW_CMD = 'openclaw';
const HERMES_PYTHON = path.join(process.env.HOME || '/Users/crab', '.hermes', 'hermes-agent', 'venv', 'bin', 'python');
const DISCORD_BRIDGE = path.join(process.env.CCP_ROOT || path.join(__dirname, '..', '..'), 'scripts', 'discord_bridge.py');

interface DiscordTransportStatus {
  transport: 'hermes-discord' | 'openclaw' | 'none';
  botTokenPresent: boolean;
  openclawPath: string;
  apiOk: boolean | null;
  botUser: string | null;
  error: string | null;
}

function openclawPath(): string {
  return commandExists(OPENCLAW_CMD);
}

function hermesPythonPath(): string {
  return commandExists(HERMES_PYTHON) || (require('fs').existsSync(HERMES_PYTHON) ? HERMES_PYTHON : '');
}

function hasDiscordTransport(): boolean {
  return !!hermesPythonPath() || !!openclawPath();
}

function runBridge(action: 'send' | 'inspect' | 'thread-create', payload?: Record<string, unknown>): { ok: boolean; data: Record<string, unknown>; stderr: string } {
  const python = hermesPythonPath();
  if (!python) return { ok: false, data: {}, stderr: 'Hermes Python runtime not found' };
  const out = spawnSync(python, [DISCORD_BRIDGE, action], {
    encoding: 'utf8',
    input: payload ? JSON.stringify(payload) : undefined,
    cwd: path.join(process.env.HOME || '/Users/crab', '.hermes', 'hermes-agent'),
  });
  let data: Record<string, unknown> = {};
  try {
    data = JSON.parse((out.stdout || '{}').trim() || '{}');
  } catch {
    data = {};
  }
  return { ok: out.status === 0, data, stderr: (out.stderr || '').trim() };
}

function fallbackSendDiscordMessage(channelId: string, message: string): DiscordMessageResult {
  const out = run(OPENCLAW_CMD, ['message', 'send', '--channel', 'discord', '--target', `channel:${channelId}`, '--message', message]);
  let messageId: string | null = null;
  try {
    const parsed = JSON.parse(out.stdout || '{}') as { messageId?: string; id?: string };
    messageId = parsed.messageId || parsed.id || null;
  } catch {
    const match = (out.stdout || '').match(/(\d{17,20})/);
    messageId = match ? match[1] : null;
  }
  return { ok: out.status === 0, stdout: out.stdout, stderr: out.stderr, messageId };
}

function fallbackCreateDiscordThread(channelId: string, messageId: string, threadName: string): DiscordThreadResult {
  const out = run(OPENCLAW_CMD, [
    'message', 'thread', 'create',
    '--channel', 'discord',
    '--target', `channel:${channelId}`,
    '--message-id', messageId,
    '--thread-name', threadName.slice(0, 100),
    '--json',
  ]);
  let threadId: string | null = null;
  try {
    const parsed = JSON.parse(out.stdout || '{}') as { threadId?: string; id?: string };
    threadId = parsed.threadId || parsed.id || null;
  } catch {
    const match = (out.stdout || '').match(/(\d{17,20})/);
    threadId = match ? match[1] : null;
  }
  return { ok: out.status === 0, threadId, stdout: out.stdout, stderr: out.stderr };
}

function sendDiscordMessage(channelId: string, message: string): DiscordMessageResult {
  const bridge = runBridge('send', { channelId, message });
  if (bridge.ok && bridge.data.success) {
    return {
      ok: true,
      stdout: JSON.stringify(bridge.data),
      stderr: '',
      messageId: (bridge.data.message_id as string) || (bridge.data.messageId as string) || null,
    };
  }
  if (openclawPath()) return fallbackSendDiscordMessage(channelId, message);
  return {
    ok: false,
    stdout: JSON.stringify(bridge.data),
    stderr: (bridge.data.error as string) || bridge.stderr || 'Discord send failed',
    messageId: null,
  };
}

function createDiscordThread(channelId: string, messageId: string, threadName: string): DiscordThreadResult {
  const bridge = runBridge('thread-create', { channelId, messageId, threadName });
  if (bridge.ok && bridge.data.ok) {
    return {
      ok: true,
      threadId: (bridge.data.threadId as string) || null,
      stdout: (bridge.data.stdout as string) || JSON.stringify(bridge.data),
      stderr: '',
    };
  }
  if (openclawPath()) return fallbackCreateDiscordThread(channelId, messageId, threadName);
  return {
    ok: false,
    threadId: null,
    stdout: (bridge.data.stdout as string) || JSON.stringify(bridge.data),
    stderr: (bridge.data.stderr as string) || (bridge.data.error as string) || bridge.stderr || 'Discord thread create failed',
  };
}

function inspectDiscordTransport(): DiscordTransportStatus {
  const bridge = runBridge('inspect');
  if (bridge.ok && bridge.data.ok) {
    return {
      transport: 'hermes-discord',
      botTokenPresent: true,
      openclawPath: openclawPath(),
      apiOk: true,
      botUser: (bridge.data.botUser as string) || null,
      error: null,
    };
  }
  if (openclawPath()) {
    const out = run(OPENCLAW_CMD, ['status']);
    return {
      transport: 'openclaw',
      botTokenPresent: false,
      openclawPath: openclawPath(),
      apiOk: out.status === 0,
      botUser: null,
      error: out.status === 0 ? null : (out.stderr || out.stdout || 'openclaw status failed').trim(),
    };
  }
  return {
    transport: 'none',
    botTokenPresent: false,
    openclawPath: '',
    apiOk: null,
    botUser: null,
    error: (bridge.data.error as string) || bridge.stderr || 'No Discord transport configured',
  };
}

module.exports = {
  hasDiscordTransport,
  inspectDiscordTransport,
  sendDiscordMessage,
  createDiscordThread,
};

export {
  hasDiscordTransport,
  inspectDiscordTransport,
  sendDiscordMessage,
  createDiscordThread,
};
