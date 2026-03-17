#!/usr/bin/env node
const { readJson, packetPath, resultPath, loadStatus } = require('../lib/jobs');
const { syncJobToLinear } = require('../lib/linear');

async function main() {
  const jobId = process.argv[2];
  if (!jobId) {
    console.error('usage: node src/bin/linear-sync.js <job_id>');
    process.exit(1);
  }

  const packet = readJson(packetPath(jobId));
  const status = loadStatus(jobId);
  const result = readJson(resultPath(jobId));
  const out = await syncJobToLinear({ packet, status, result });
  console.log(JSON.stringify(out, null, 2));
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exit(1);
});
