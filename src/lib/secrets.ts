import { spawnSync } from 'child_process';
import type { OnePasswordConfig } from '../types';
const { loadConfig } = require('./config');

function readFromLaunchAgentEnv(envName: string): string {
  const label = process.env.CCP_INTAKE_LAUNCHD_LABEL || `gui/${process.getuid?.() ?? 0}/ai.openclaw.coding-control-plane.intake`;
  const shell = `pid=$(launchctl print ${label} 2>/dev/null | awk '/pid = /{print $3; exit}'); if [ -n "$pid" ]; then ps eww -p "$pid" | tr ' ' '\n' | sed -n 's/^${envName}=//p' | head -n 1; fi`;
  const out = spawnSync('sh', ['-lc', shell], { encoding: 'utf8' });
  return out.status === 0 ? (out.stdout || '').trim() : '';
}

function onePasswordConfig(): OnePasswordConfig {
  return loadConfig('1password', { vault: '', items: {} }) as OnePasswordConfig;
}

function getServiceAccountToken(): string {
  return process.env.OP_SERVICE_ACCOUNT_TOKEN || readFromLaunchAgentEnv('OP_SERVICE_ACCOUNT_TOKEN') || '';
}

function readFrom1Password(envName: string): string {
  const cfg = onePasswordConfig();
  const entry = cfg.items?.[envName];
  const serviceToken = getServiceAccountToken();
  if (!entry || !cfg.vault || !serviceToken) return '';

  const ref = `op://${cfg.vault}/${entry.itemId}/${entry.field || 'credential'}`;
  const out = spawnSync('op', ['read', ref], {
    encoding: 'utf8',
    env: {
      PATH: process.env.PATH || '/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin',
      HOME: process.env.HOME || '/Users/crab',
      OP_SERVICE_ACCOUNT_TOKEN: serviceToken,
    },
  });
  if (out.status !== 0) return '';
  return (out.stdout || '').trim();
}

function getSecret(envName: string): string {
  return process.env[envName] || readFromLaunchAgentEnv(envName) || readFrom1Password(envName) || '';
}

module.exports = {
  onePasswordConfig,
  getServiceAccountToken,
  readFrom1Password,
  readFromLaunchAgentEnv,
  getSecret,
};

export { onePasswordConfig, getServiceAccountToken, readFrom1Password, readFromLaunchAgentEnv, getSecret };
