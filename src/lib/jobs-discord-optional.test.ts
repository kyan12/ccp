import fs = require('fs');
import os = require('os');
import path = require('path');
import assert = require('assert');
import type { JobPacket } from '../types';

function writeExecutable(file: string, body: string): void {
  fs.writeFileSync(file, body, { mode: 0o755 });
}

function makeGitRepo(root: string): string {
  const repo = path.join(root, 'repo');
  fs.mkdirSync(repo, { recursive: true });
  require('child_process').spawnSync('git', ['init', '-q'], { cwd: repo });
  require('child_process').spawnSync('git', ['config', 'user.email', 'test@example.com'], { cwd: repo });
  require('child_process').spawnSync('git', ['config', 'user.name', 'Test User'], { cwd: repo });
  fs.writeFileSync(path.join(repo, 'README.md'), 'test\n');
  require('child_process').spawnSync('git', ['add', 'README.md'], { cwd: repo });
  require('child_process').spawnSync('git', ['commit', '-qm', 'init'], { cwd: repo });
  return repo;
}

function loadJobsWithDiscord(discord: {
  inspect: () => Record<string, unknown>;
  send: () => { ok: boolean; stderr?: string; messageId?: string | null };
}) {
  const jobsPath = require.resolve('./jobs');
  const discordPath = require.resolve('./discord');
  delete require.cache[jobsPath];
  delete require.cache[discordPath];
  require.cache[discordPath] = {
    id: discordPath,
    filename: discordPath,
    loaded: true,
    exports: {
      inspectDiscordTransport: discord.inspect,
      hasDiscordTransport: () => {
        const status = discord.inspect();
        return status.transport !== 'none' && status.apiOk === true;
      },
      sendDiscordMessage: discord.send,
      createDiscordThread: () => ({ ok: true, threadId: 'thread_1', stdout: '', stderr: '' }),
    },
  } as NodeJS.Module;
  return require('./jobs');
}

function setupHarness(discord: Parameters<typeof loadJobsWithDiscord>[0]) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ccp-discord-optional-'));
  const repo = makeGitRepo(root);
  const fakeBin = path.join(root, 'bin');
  fs.mkdirSync(fakeBin);
  writeExecutable(path.join(fakeBin, 'tmux'), '#!/usr/bin/env bash\nexit 0\n');
  writeExecutable(path.join(fakeBin, 'claude'), '#!/usr/bin/env bash\nif [ "$1" = "--version" ]; then echo "claude test"; exit 0; fi\ncat >/dev/null\necho ok\n');
  const oldEnv = { ...process.env };
  process.env.CCP_ROOT = root;
  process.env.CCP_AGENT = 'claude-code';
  process.env.CCP_DISCORD_RUNS_CHANNEL = 'runs-channel';
  process.env.CCP_DISCORD_STATUS_CHANNEL = 'status-channel';
  process.env.CCP_DISCORD_ERRORS_CHANNEL = 'errors-channel';
  process.env.PATH = `${fakeBin}${path.delimiter}${oldEnv.PATH || ''}`;
  const jobs = loadJobsWithDiscord(discord);
  const packet: JobPacket = {
    job_id: 'kanban_t_discord_optional',
    ticket_id: 't_discord_optional',
    repo,
    goal: 'No-op canary',
    source: 'hermes-kanban',
    kind: 'task',
    label: 'kanban',
  };
  const created = jobs.createJob(packet);
  return { root, repo, jobs, jobId: created.jobId, restore: () => { process.env = oldEnv; } };
}

function readLog(root: string, jobId: string): string {
  return fs.readFileSync(path.join(root, 'jobs', jobId, 'worker.log'), 'utf8');
}

console.log('\nTest: Hermes Kanban job records successful optional Discord start notification');
{
  const h = setupHarness({
    inspect: () => ({ transport: 'hermes-discord', botTokenPresent: true, apiOk: true, botUser: 'Code Crab#1701', error: null }),
    send: () => ({ ok: true, stderr: '', messageId: 'msg_1' }),
  });
  try {
    const result = h.jobs.startJob(h.jobId);
    const status = h.jobs.loadStatus(h.jobId);
    const log = readLog(h.root, h.jobId);
    assert.strictEqual(result.ok, true);
    assert.strictEqual(status.state, 'running');
    assert.strictEqual(status.notifications.start, true);
    assert.ok(!status.notifications.start_warning, 'no warning when Discord send succeeds');
    assert.ok(log.includes('START notify: ok'));
  } finally {
    h.restore();
  }
}

console.log('\nTest: Hermes Kanban job continues with explicit warning when Discord auth is unavailable');
{
  const h = setupHarness({
    inspect: () => ({ transport: 'none', botTokenPresent: true, apiOk: false, botUser: null, error: 'HTTP 401 Unauthorized' }),
    send: () => ({ ok: false, stderr: 'HTTP 401 Unauthorized', messageId: null }),
  });
  try {
    const result = h.jobs.startJob(h.jobId);
    const status = h.jobs.loadStatus(h.jobId);
    const runResult = h.jobs.readJson(h.jobs.resultPath(h.jobId));
    const log = readLog(h.root, h.jobId);
    assert.strictEqual(result.ok, true);
    assert.strictEqual(status.state, 'running');
    assert.strictEqual(runResult.state, 'running');
    assert.strictEqual(status.notifications.start, false, 'failed Discord send is not claimed as delivered');
    assert.match(status.notifications.start_warning || '', /Discord optional notification unavailable: HTTP 401 Unauthorized/);
    assert.match(log, /WARN: Discord optional notification unavailable: HTTP 401 Unauthorized/);
    assert.match(log, /START notify: HTTP 401 Unauthorized/);
  } finally {
    h.restore();
  }
}

console.log('\nTest: Hermes Kanban job still blocks on required repo dependency despite optional Discord outage');
{
  const h = setupHarness({
    inspect: () => ({ transport: 'none', botTokenPresent: true, apiOk: false, botUser: null, error: 'HTTP 401 Unauthorized' }),
    send: () => ({ ok: false, stderr: 'HTTP 401 Unauthorized', messageId: null }),
  });
  try {
    const packet = h.jobs.readJson(h.jobs.packetPath(h.jobId));
    packet.repo = path.join(h.root, 'missing-repo');
    fs.writeFileSync(h.jobs.packetPath(h.jobId), JSON.stringify(packet, null, 2) + '\n');
    const result = h.jobs.startJob(h.jobId);
    const status = h.jobs.loadStatus(h.jobId);
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.blocked, true);
    assert.strictEqual(status.state, 'blocked');
    assert.match(result.reason, /repo missing/);
    assert.doesNotMatch(result.reason, /Discord transport unavailable/);
  } finally {
    h.restore();
  }
}
