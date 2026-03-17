#!/usr/bin/env node
import type { PrWatcherCycleResult } from '../types';
const { runPrWatcherCycle } = require('../lib/pr-watcher');

const args: string[] = process.argv.slice(2);

function getArg(name: string, fallback: string | number | null = null): string | number | null {
  const prefix = `${name}=`;
  const exact = args.find((arg) => arg.startsWith(prefix));
  return exact ? exact.slice(prefix.length) : fallback;
}

function hasFlag(flag: string): boolean {
  return args.includes(flag);
}

const once: boolean = hasFlag('--once');
const intervalMs: number = Number(getArg('--interval', process.env.CCP_PR_WATCHER_INTERVAL_MS || 60000));

async function cycle(): Promise<PrWatcherCycleResult> {
  const result: PrWatcherCycleResult = await runPrWatcherCycle();
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
