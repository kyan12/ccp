const { spawnSync } = require('child_process');
const { loadConfig } = require('./config');

function readFromLaunchAgentEnv(envName) {
  const label = process.env.CCP_INTAKE_LAUNCHD_LABEL || `gui/${process.getuid()}/ai.openclaw.coding-control-plane.intake`;
  const shell = `pid=$(launchctl print ${label} 2>/dev/null | awk '/pid = /{print $3; exit}'); if [ -n "$pid" ]; then ps eww -p "$pid" | tr ' ' '\n' | sed -n 's/^${envName}=//p' | head -n 1; fi`;
  const out = spawnSync('sh', ['-lc', shell], { encoding: 'utf8' });
  return out.status === 0 ? (out.stdout || '').trim() : '';
}

function onePasswordConfig() {
  return loadConfig('1password', { vault: '', items: {} });
}

function getServiceAccountToken() {
  return process.env.OP_SERVICE_ACCOUNT_TOKEN || readFromLaunchAgentEnv('OP_SERVICE_ACCOUNT_TOKEN') || '';
}

function readFrom1Password(envName) {
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

function getSecret(envName) {
  return process.env[envName] || readFromLaunchAgentEnv(envName) || readFrom1Password(envName) || '';
}

module.exports = {
  onePasswordConfig,
  getServiceAccountToken,
  readFrom1Password,
  readFromLaunchAgentEnv,
  getSecret,
};
