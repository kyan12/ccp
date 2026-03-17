#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { intakeToLinear, buildIncidentPacket } = require('../lib/intake-runner');
const { createJob } = require('../lib/jobs');

function usage() {
  console.log('usage: node src/bin/intake-dispatch.js <sentry|vercel|manual> <payload.json> [--enqueue-job]');
}

async function main() {
  const [, , kind, file, ...rest] = process.argv;
  if (!kind || !file) {
    usage();
    process.exit(1);
  }
  if (!['sentry', 'vercel', 'manual'].includes(kind)) {
    usage();
    process.exit(1);
  }

  const enqueueJob = rest.includes('--enqueue-job');
  const payload = JSON.parse(fs.readFileSync(path.resolve(file), 'utf8'));
  const linear = await intakeToLinear(kind, payload);

  let job = null;
  if (enqueueJob) {
    const packet = buildIncidentPacket(kind, payload);
    packet.ticket_id = linear.identifier;

    if (packet.gitUrl && packet.repo && !packet.repoResolved) {
      fs.mkdirSync(path.dirname(packet.repo), { recursive: true });
      const clone = spawnSync('git', ['clone', packet.gitUrl, packet.repo], { encoding: 'utf8' });
      if (clone.status !== 0) {
        console.error(clone.stderr || clone.stdout || 'git clone failed');
        process.exit(2);
      }
      packet.repoResolved = true;
    }

    if (!packet.repoResolved) {
      console.error(`repo not available locally for enqueue: ${packet.repo || '(unset)'}`);
      process.exit(2);
    }

    const created = createJob(packet);
    job = {
      job_id: created.jobId,
      state: created.status.state,
      repo: created.packet.repo,
      ticket_id: created.packet.ticket_id,
    };
  }

  console.log(JSON.stringify({ ok: true, linear, job }, null, 2));
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exit(1);
});
