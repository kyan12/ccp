#!/usr/bin/env node
import fs = require('fs');
import path = require('path');
import { spawnSync } from 'child_process';
const { ROOT } = require('../lib/jobs');
const { buildSupervisorPlist, buildIntakePlist } = require('../lib/launchd');
const { loadConfig } = require('../lib/config');

const home: string = process.env.HOME || '/Users/crab';
const launchAgentsDir: string = path.join(home, 'Library', 'LaunchAgents');
const supervisorPlistPath: string = path.join(launchAgentsDir, 'ai.ccp.supervisor.plist');
const intakePlistPath: string = path.join(launchAgentsDir, 'ai.ccp.intake.plist');

function readOpSecret(ref: string): string {
  const out = spawnSync('op', ['read', ref], { encoding: 'utf8', env: process.env as Record<string, string> });
  return out.status === 0 ? (out.stdout || '').trim() : '';
}

function readExistingLaunchdEnv(envName: string): string {
  for (const plistPath of [supervisorPlistPath, intakePlistPath]) {
    const out = spawnSync('/usr/libexec/PlistBuddy', ['-c', `Print :EnvironmentVariables:${envName}`, plistPath], { encoding: 'utf8' });
    if (out.status === 0 && (out.stdout || '').trim()) return (out.stdout || '').trim();
  }
  return '';
}

function resolveLaunchdSecrets(): Record<string, string> {
  const onePassword = loadConfig('1password', { vault: '', items: {} });
  const extraEnv: Record<string, string> = {};
  const localEnvPath = path.join(ROOT, 'supervisor', 'daemon', 'intake.env.local');
  if (fs.existsSync(localEnvPath)) {
    for (const line of fs.readFileSync(localEnvPath, 'utf8').split(/\r?\n/)) {
      if (!line || line.trim().startsWith('#') || !line.includes('=')) continue;
      const idx = line.indexOf('=');
      const key = line.slice(0, idx).trim();
      const value = line.slice(idx + 1).trim();
      if (key && value) extraEnv[key] = value;
    }
  }
  for (const envName of ['LINEAR_API_KEY', 'LINEAR_SMA_API_KEY', 'VERCEL_TOKEN', 'SENTRY_AUTH_TOKEN', 'VERCEL_WEBHOOK_SECRET', 'DISCORD_BOT_TOKEN']) {
    if (process.env[envName]) {
      extraEnv[envName] = process.env[envName]!;
      continue;
    }
    // A protected host-local env file is an explicit operator override. Do not
    // replace it with a stale value from the currently installed plist.
    if (extraEnv[envName]) continue;
    const existing = readExistingLaunchdEnv(envName);
    if (existing) {
      extraEnv[envName] = existing;
      continue;
    }
    const entry = onePassword.items?.[envName];
    if (!entry || !onePassword.vault) continue;
    const ref = `op://${onePassword.vault}/${entry.itemId}/${entry.field || 'credential'}`;
    const value = readOpSecret(ref);
    if (value) extraEnv[envName] = value;
  }
  return extraEnv;
}

fs.mkdirSync(launchAgentsDir, { recursive: true });
fs.mkdirSync(path.join(ROOT, 'supervisor', 'daemon'), { recursive: true });
const extraEnv = resolveLaunchdSecrets();
fs.writeFileSync(supervisorPlistPath, buildSupervisorPlist({ extraEnv }), 'utf8');
fs.writeFileSync(intakePlistPath, buildIntakePlist({ extraEnv }), 'utf8');

process.stdout.write(JSON.stringify({
  ok: true,
  supervisorPlist: supervisorPlistPath,
  intakePlist: intakePlistPath,
  injectedSecrets: Object.keys(extraEnv),
}, null, 2) + '\n');
