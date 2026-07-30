#!/usr/bin/env node
import fs = require('fs');
import path = require('path');
import { spawnSync } from 'child_process';
const { ROOT } = require('../lib/jobs');
const { buildSupervisorPlist, buildIntakePlist } = require('../lib/launchd');
const { parseEnvFile } = require('./launchd-runner');
const { loadConfig } = require('../lib/config');

const home: string = process.env.CCP_HOST_HOME || '/Users/kyan';
const launchAgentsDir: string = path.join(home, 'Library', 'LaunchAgents');
const supervisorPlistPath: string = path.join(launchAgentsDir, 'ai.ccp.supervisor.plist');
const intakePlistPath: string = path.join(launchAgentsDir, 'ai.ccp.intake.plist');
const RETIRED_LINEAR_ENV_KEYS = new Set(['LINEAR_API_KEY', 'LINEAR_SMA_API_KEY', 'LINEAR_WEBHOOK_SECRET']);
const MANAGED_ENV_KEYS = new Set([...RETIRED_LINEAR_ENV_KEYS, 'CCP_LINEAR_DISABLED', 'CCP_DISABLE_LINEAR']);

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
    for (const [key, value] of Object.entries(parseEnvFile(localEnvPath)) as Array<[string, string]>) {
      if (value && !MANAGED_ENV_KEYS.has(key)) extraEnv[key] = value;
    }
  }
  for (const envName of ['OP_SERVICE_ACCOUNT_TOKEN', 'VERCEL_TOKEN', 'SENTRY_AUTH_TOKEN', 'VERCEL_WEBHOOK_SECRET', 'DISCORD_BOT_TOKEN']) {
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
const localEnvPath = path.join(ROOT, 'supervisor', 'daemon', 'intake.env.local');
const retiredEnvKeys = MANAGED_ENV_KEYS;
const existingEnvLines = fs.existsSync(localEnvPath)
  ? fs.readFileSync(localEnvPath, 'utf8').split(/\r?\n/).filter((line) => !retiredEnvKeys.has(line.split('=', 1)[0].trim()))
  : [];
const existingEnv = existingEnvLines.join('\n').trimEnd();
const existingKeys = new Set(existingEnvLines.map((line) => line.split('=', 1)[0].trim()).filter(Boolean));
const additions = Object.entries(extraEnv)
  .filter(([key, value]) => value && !existingKeys.has(key))
  .map(([key, value]) => `${key}=${value}`);
const requiredEnv: Record<string, string> = {
  CCP_LINEAR_DISABLED: '1',
  CCP_DISABLE_LINEAR: '1',
};
for (const [key, value] of Object.entries(requiredEnv)) {
  if (!existingKeys.has(key)) additions.push(`${key}=${value}`);
}
const nextEnv = [existingEnv, ...additions].filter(Boolean).join('\n') + '\n';
fs.writeFileSync(localEnvPath, nextEnv, { encoding: 'utf8', mode: 0o600 });
fs.chmodSync(localEnvPath, 0o600);
const protectedEnv = parseEnvFile(localEnvPath);
fs.writeFileSync(supervisorPlistPath, buildSupervisorPlist({
  envFilePath: localEnvPath,
  maxConcurrent: protectedEnv.CCP_MAX_CONCURRENT,
}), { encoding: 'utf8', mode: 0o600 });
fs.writeFileSync(intakePlistPath, buildIntakePlist({
  envFilePath: localEnvPath,
  port: protectedEnv.CCP_INTAKE_PORT,
}), { encoding: 'utf8', mode: 0o600 });
fs.chmodSync(supervisorPlistPath, 0o600);
fs.chmodSync(intakePlistPath, 0o600);

process.stdout.write(JSON.stringify({
  ok: true,
  supervisorPlist: supervisorPlistPath,
  intakePlist: intakePlistPath,
  protectedEnvFile: localEnvPath,
  protectedEnvKeys: Object.keys(protectedEnv).filter(Boolean).sort(),
}, null, 2) + '\n');
