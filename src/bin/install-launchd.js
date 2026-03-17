#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { ROOT } = require('../lib/jobs');
const { buildSupervisorPlist, buildIntakePlist } = require('../lib/launchd');
const { loadConfig } = require('../lib/config');

const home = process.env.HOME || '/Users/crab';
const launchAgentsDir = path.join(home, 'Library', 'LaunchAgents');
const supervisorPlistPath = path.join(launchAgentsDir, 'ai.openclaw.coding-control-plane.plist');
const intakePlistPath = path.join(launchAgentsDir, 'ai.openclaw.coding-control-plane.intake.plist');

function readOpSecret(ref) {
  const out = spawnSync('op', ['read', ref], { encoding: 'utf8', env: process.env });
  return out.status === 0 ? (out.stdout || '').trim() : '';
}

function resolveLaunchdSecrets() {
  const onePassword = loadConfig('1password', { vault: '', items: {} });
  const extraEnv = {};
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
  for (const envName of ['LINEAR_API_KEY', 'LINEAR_SMA_API_KEY', 'VERCEL_TOKEN', 'SENTRY_AUTH_TOKEN', 'VERCEL_WEBHOOK_SECRET']) {
    if (process.env[envName]) {
      extraEnv[envName] = process.env[envName];
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
fs.writeFileSync(supervisorPlistPath, buildSupervisorPlist(), 'utf8');
fs.writeFileSync(intakePlistPath, buildIntakePlist({ extraEnv }), 'utf8');

process.stdout.write(JSON.stringify({
  ok: true,
  supervisorPlist: supervisorPlistPath,
  intakePlist: intakePlistPath,
  injectedSecrets: Object.keys(extraEnv),
}, null, 2) + '\n');
