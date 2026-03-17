#!/usr/bin/env node
import fs = require('fs');
import path = require('path');
const { intakeToLinear } = require('../lib/intake-runner');

function usage(): void {
  console.log('usage: node src/bin/intake-linear.js <sentry|vercel|manual> <payload.json>');
}

async function main(): Promise<void> {
  const [, , kind, file] = process.argv;
  if (!kind || !file) {
    usage();
    process.exit(1);
  }

  const payload = JSON.parse(fs.readFileSync(path.resolve(file), 'utf8'));
  if (!['sentry', 'vercel', 'manual'].includes(kind)) {
    usage();
    process.exit(1);
  }
  console.log(JSON.stringify(await intakeToLinear(kind, payload), null, 2));
}

main().catch((error: Error) => {
  console.error(error.stack || error.message);
  process.exit(1);
});
