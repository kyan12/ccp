#!/usr/bin/env node
import fs = require('fs');
import path = require('path');
const { buildIncidentPacket } = require('../lib/intake-runner');
const { createJob } = require('../lib/jobs');

function usage(): void {
  console.log('usage: node src/bin/intake-job.js <sentry|vercel|manual> <payload.json>');
}

async function main(): Promise<void> {
  const [, , kind, file] = process.argv;
  if (!kind || !file) {
    usage();
    process.exit(1);
  }
  if (!['sentry', 'vercel', 'manual'].includes(kind)) {
    usage();
    process.exit(1);
  }

  const payload = JSON.parse(fs.readFileSync(path.resolve(file), 'utf8'));
  const packet = buildIncidentPacket(kind, payload);
  const created = createJob(packet);
  console.log(JSON.stringify({
    ok: true,
    job_id: created.jobId,
    state: created.status.state,
    packet: created.packet,
  }, null, 2));
}

main().catch((error: Error) => {
  console.error(error.stack || error.message);
  process.exit(1);
});
