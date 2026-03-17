#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const {
  ROOT,
  createJob,
  listJobs,
  summarizeJobs,
  loadStatus,
  readJson,
  packetPath,
  resultPath,
  jobDir,
  startJob,
  reconcileJob,
  inspectEnvironment,
  interruptJob,
} = require('../lib/jobs');

function usage() {
  console.log(`jobs <command> [args]\n\nCommands:\n  enqueue <packet.json>\n  start <job_id>\n  list\n  status\n  show <job_id>\n  tail <job_id>\n  result <job_id>\n  interrupt <job_id>\n  retry <job_id>\n  reconcile <job_id|all>\n  doctor [repo]\n  phase0 [repo]`);
}

function die(msg, code = 1) {
  console.error(msg);
  process.exit(code);
}

const [, , command, ...args] = process.argv;
if (!command) {
  usage();
  process.exit(1);
}

async function main() {
  switch (command) {
    case 'enqueue': {
      const file = args[0];
      if (!file) die('usage: jobs enqueue <packet.json>');
      const packet = JSON.parse(fs.readFileSync(path.resolve(file), 'utf8'));
      const created = createJob(packet);
      console.log(JSON.stringify({ root: ROOT, job_id: created.jobId, state: created.status.state }, null, 2));
      break;
    }
    case 'start': {
      const jobId = args[0];
      if (!jobId) die('usage: jobs start <job_id>');
      const out = startJob(jobId);
      console.log(JSON.stringify(out, null, 2));
      process.exit(out.ok ? 0 : 2);
      break;
    }
    case 'list': {
      console.log(JSON.stringify(listJobs(), null, 2));
      break;
    }
    case 'status': {
      console.log(JSON.stringify(summarizeJobs(), null, 2));
      break;
    }
    case 'show': {
      const jobId = args[0];
      if (!jobId) die('usage: jobs show <job_id>');
      console.log(JSON.stringify({
        status: loadStatus(jobId),
        packet: readJson(packetPath(jobId)),
      }, null, 2));
      break;
    }
    case 'tail': {
      const jobId = args[0];
      if (!jobId) die('usage: jobs tail <job_id>');
      const file = path.join(jobDir(jobId), 'worker.log');
      if (!fs.existsSync(file)) die(`missing log for ${jobId}`);
      process.stdout.write(fs.readFileSync(file, 'utf8'));
      break;
    }
    case 'result': {
      const jobId = args[0];
      if (!jobId) die('usage: jobs result <job_id>');
      console.log(fs.readFileSync(resultPath(jobId), 'utf8'));
      break;
    }
    case 'interrupt': {
      const jobId = args[0];
      if (!jobId) die('usage: jobs interrupt <job_id>');
      console.log(JSON.stringify(interruptJob(jobId), null, 2));
      break;
    }
    case 'retry': {
      const jobId = args[0];
      if (!jobId) die('usage: jobs retry <job_id>');
      const out = startJob(jobId);
      console.log(JSON.stringify(out, null, 2));
      process.exit(out.ok ? 0 : 2);
      break;
    }
    case 'reconcile': {
      const target = args[0];
      if (!target) die('usage: jobs reconcile <job_id|all>');
      const ids = target === 'all' ? listJobs().map((j) => j.job_id) : [target];
      const out = [];
      for (const jobId of ids) {
        out.push({ job_id: jobId, ...(await reconcileJob(jobId)) });
      }
      console.log(JSON.stringify(out, null, 2));
      break;
    }
    case 'doctor':
    case 'phase0': {
      const repo = path.resolve(args[0] || ROOT);
      console.log(JSON.stringify(inspectEnvironment(repo), null, 2));
      break;
    }
    default:
      usage();
      process.exit(1);
  }
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exit(1);
});
