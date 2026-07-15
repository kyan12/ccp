#!/usr/bin/env node
import fs = require('fs');
import path = require('path');
const { submitKanbanJob, serializeKanbanJobResult, readJsonFromStdin } = require('../lib/hermes-kanban');
const { loadStatus, packetPath } = require('../lib/jobs');

function usage(): void {
  console.log(`hermes-kanban <command> [args]\n\nCommands:\n  submit [packet.json|--stdin]\n  status <job_id>\n  result <job_id>\n\nPacket fields: task_id, title/body/worker_context, repo or repoKey, acceptance_criteria, verification_steps, constraints.`);
}

function die(message: string, code = 1): never {
  console.error(message);
  process.exit(code);
}

async function readInput(arg?: string): Promise<unknown> {
  if (!arg || arg === '--stdin' || arg === '-') return readJsonFromStdin();
  return JSON.parse(fs.readFileSync(path.resolve(arg), 'utf8'));
}

async function main(): Promise<void> {
  const [, , command, ...args] = process.argv;
  if (!command) {
    usage();
    process.exit(1);
  }
  if (command === 'submit') {
    const input = await readInput(args[0]);
    const out = submitKanbanJob(input);
    console.log(JSON.stringify(out, null, 2));
    return;
  }
  if (command === 'status') {
    const jobId = args[0];
    if (!jobId) die('usage: hermes-kanban status <job_id>');
    console.log(JSON.stringify({ status: loadStatus(jobId), packet_path: packetPath(jobId) }, null, 2));
    return;
  }
  if (command === 'result') {
    const jobId = args[0];
    if (!jobId) die('usage: hermes-kanban result <job_id>');
    console.log(JSON.stringify(serializeKanbanJobResult(jobId), null, 2));
    return;
  }
  usage();
  process.exit(1);
}

main().catch((error: Error) => {
  console.error(error.stack || error.message);
  process.exit(1);
});
