#!/usr/bin/env node
import fs = require('fs');
import path = require('path');
const { dispatchLinearIssues } = require('../lib/linear-dispatch');

function loadLocalEnv(): void {
  const file = path.resolve(process.cwd(), 'supervisor', 'daemon', 'intake.env.local');
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    if (!line || line.trim().startsWith('#') || !line.includes('=')) continue;
    const idx = line.indexOf('=');
    const key = line.slice(0, idx).trim();
    const value = line.slice(idx + 1).trim();
    if (key && value && !process.env[key]) process.env[key] = value;
  }
}

async function main(): Promise<void> {
  loadLocalEnv();
  const out = await dispatchLinearIssues();
  console.log(JSON.stringify({ ok: true, dispatched: out }, null, 2));
}

main().catch((error: Error) => {
  console.error(error.stack || error.message);
  process.exit(1);
});
