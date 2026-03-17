#!/usr/bin/env node
import fs = require('fs');
import path = require('path');
import type { SupervisorCycleSummary } from '../types';
const { ROOT, runSupervisorCycle } = require('../lib/jobs');

const args: string[] = process.argv.slice(2);

function getArg(name: string, fallback: string | number | null = null): string | number | null {
  const prefix = `${name}=`;
  const exact = args.find((arg) => arg.startsWith(prefix));
  return exact ? exact.slice(prefix.length) : fallback;
}

function hasFlag(flag: string): boolean {
  return args.includes(flag);
}

const intervalMs: number = Number(getArg('--interval', process.env.CCP_SUPERVISOR_INTERVAL_MS || 15000));
const maxConcurrent: number = Number(getArg('--max-concurrent', process.env.CCP_MAX_CONCURRENT || 1));
const once: boolean = hasFlag('--once');
const stateDir: string = path.join(ROOT, 'supervisor', 'daemon');
const heartbeatFile: string = path.join(stateDir, 'heartbeat.json');

fs.mkdirSync(stateDir, { recursive: true });

function writeHeartbeat(payload: SupervisorCycleSummary): void {
  fs.writeFileSync(heartbeatFile, JSON.stringify(payload, null, 2) + '\n');
}

async function cycle(): Promise<SupervisorCycleSummary> {
  const result: SupervisorCycleSummary = await runSupervisorCycle({ maxConcurrent });
  writeHeartbeat(result);
  process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  return result;
}

cycle().catch((error: Error) => {
  process.stderr.write(`${error.stack || error.message}\n`);
  process.exit(1);
});

if (!once) {
  setInterval(() => {
    cycle().catch((error: Error) => {
      process.stderr.write(`${error.stack || error.message}\n`);
    });
  }, intervalMs);
}
