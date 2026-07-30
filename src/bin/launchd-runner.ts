#!/usr/bin/env node
import fs = require('fs');
import path = require('path');
const { ROOT } = require('../lib/paths');

function parseEnvFile(file: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const raw of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#') || !line.includes('=')) continue;
    const idx = line.indexOf('=');
    const key = line.slice(0, idx).trim();
    let value = line.slice(idx + 1).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
      throw new Error(`invalid environment key in ${file}: ${key}`);
    }
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    env[key] = value;
  }
  return env;
}

function loadProtectedEnv(file: string): void {
  const stat = fs.lstatSync(file);
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw new Error(`refusing to load ${file}: protected environment must be a regular file, not a symlink`);
  }
  if (typeof process.getuid === 'function' && stat.uid !== process.getuid()) {
    throw new Error(`refusing to load ${file}: protected environment must be owned by the current user`);
  }
  if ((stat.mode & 0o777) !== 0o600) {
    throw new Error(`refusing to load ${file}: permissions must be 0600`);
  }
  for (const [key, value] of Object.entries(parseEnvFile(file))) {
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

function main(): void {
  const mode = process.argv[2];
  const forwardedArgs = process.argv.slice(3);
  const envFile = path.resolve(process.env.CCP_ENV_FILE || path.join(ROOT, 'supervisor', 'daemon', 'intake.env.local'));
  loadProtectedEnv(envFile);
  const target = mode === 'supervisor'
    ? path.join(ROOT, 'dist', 'bin', 'supervisor.js')
    : path.join(ROOT, 'dist', 'bin', 'intake-server.js');
  process.argv = [process.argv[0], target, ...forwardedArgs];

  if (mode === 'supervisor') {
    require('./supervisor');
  } else if (mode === 'intake') {
    require('./intake-server');
  } else {
    throw new Error('usage: launchd-runner <supervisor|intake> [args...]');
  }
}

if (require.main === module) main();

export { parseEnvFile, loadProtectedEnv, main };
