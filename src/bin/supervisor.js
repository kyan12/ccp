#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const { ROOT, runSupervisorCycle } = require('../lib/jobs');

const args = process.argv.slice(2);

function getArg(name, fallback = null) {
  const prefix = `${name}=`;
  const exact = args.find((arg) => arg.startsWith(prefix));
  return exact ? exact.slice(prefix.length) : fallback;
}

function hasFlag(flag) {
  return args.includes(flag);
}

const intervalMs = Number(getArg('--interval', process.env.CCP_SUPERVISOR_INTERVAL_MS || 15000));
const maxConcurrent = Number(getArg('--max-concurrent', process.env.CCP_MAX_CONCURRENT || 1));
const once = hasFlag('--once');
const stateDir = path.join(ROOT, 'supervisor', 'daemon');
const heartbeatFile = path.join(stateDir, 'heartbeat.json');

fs.mkdirSync(stateDir, { recursive: true });

function writeHeartbeat(payload) {
  fs.writeFileSync(heartbeatFile, JSON.stringify(payload, null, 2) + '\n');
}

async function cycle() {
  const result = await runSupervisorCycle({ maxConcurrent });
  writeHeartbeat(result);
  process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  return result;
}

cycle().catch((error) => {
  process.stderr.write(`${error.stack || error.message}\n`);
  process.exit(1);
});

if (!once) {
  setInterval(() => {
    cycle().catch((error) => {
      process.stderr.write(`${error.stack || error.message}\n`);
    });
  }, intervalMs);
}
