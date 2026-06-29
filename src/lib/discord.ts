import path = require('path');
import { spawnSync } from 'child_process';
import type { DiscordMessageResult, DiscordThreadResult } from '../types';
const { commandExists } = require('./shell');

const HERMES_PYTHON = path.join(process.env.HOME || '/Users/crab', '.hermes', 'hermes-agent', 'venv', 'bin', 'python');
const DISCORD_BRIDGE = path.join(process.env.CCP_ROOT || path.join(__dirname, '..', '..'), 'scripts', 'discord_bridge.py');

interface DiscordTransportStatus {
  transport: 'hermes-discord' | 'none';
  botTokenPresent: boolean;
  apiOk: boolean | null;
  botUser: string | null;
  error: string | null;
}

function hermesPythonPath(): string {
  return commandExists(HERMES_PYTHON) || (require('fs').existsSync(HERMES_PYTHON) ? HERMES_PYTHON : '');
}

function hasDiscordTransport(): boolean {
  const status = inspectDiscordTransport();
  return status.transport !== 'none' && status.apiOk === true;
}

function runBridge(action: 'send' | 'inspect' | 'thread-create', payload?: Record<string, unknown>): { ok: boolean; data: Record<string, unknown>; stderr: string } {
  const python = hermesPythonPath();
  if (!python) return { ok: false, data: {}, stderr: 'Hermes Python runtime not found' };
  const out = spawnSync(python, [DISCORD_BRIDGE, action], {
    encoding: 'utf8',
    input: payload ? JSON.stringify(payload) : undefined,
    cwd: path.join(process.env.HOME || '/Users/crab', '.hermes', 'hermes-agent'),
    env: process.env,
  });
  let data: Record<string, unknown> = {};
  try {
    data = JSON.parse((out.stdout || '{}').trim() || '{}');
  } catch {
    data = {};
  }
  return { ok: out.status === 0, data, stderr: (out.stderr || '').trim() };
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
      apiOk: true,
      botUser: (bridge.data.botUser as string) || null,
      error: null,
    };
  }
  return {
    transport: 'none',
    botTokenPresent: false,
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
