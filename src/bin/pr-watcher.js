#!/usr/bin/env node
const { runPrWatcherCycle } = require('../lib/pr-watcher');

const args = process.argv.slice(2);

function getArg(name, fallback = null) {
  const prefix = `${name}=`;
  const exact = args.find((arg) => arg.startsWith(prefix));
  return exact ? exact.slice(prefix.length) : fallback;
}

function hasFlag(flag) {
  return args.includes(flag);
}

const once = hasFlag('--once');
const intervalMs = Number(getArg('--interval', process.env.CCP_PR_WATCHER_INTERVAL_MS || 60000));

async function cycle() {
  const result = await runPrWatcherCycle();
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
