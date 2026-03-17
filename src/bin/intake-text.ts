#!/usr/bin/env node
/**
 * intake-text.ts — Create a job from free-text input (Discord intake, CLI, etc.)
 */

import type { IntakePayload } from '../types';
const { intakeToLinear, buildIncidentPacket } = require('../lib/intake-runner');
const { createJob } = require('../lib/jobs');
const { enrichPayloadWithRepo } = require('../lib/repos');

function parseArgs(argv: string[]): Record<string, string | boolean> {
  const args: Record<string, string | boolean> = {};
  const rest = argv.slice(2);
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    if (arg === '--enqueue') { args.enqueue = true; continue; }
    if (arg === '--dispatch') { args.dispatch = true; continue; }
    if (arg.startsWith('--') && i + 1 < rest.length) {
      const key = arg.slice(2).replace(/-([a-z])/g, (_: string, c: string) => c.toUpperCase());
      args[key] = rest[++i];
    }
  }
  return args;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv);

  if (!args.title) {
    console.error('error: --title is required');
    process.exit(1);
  }

  const payload: IntakePayload = {
    title: args.title as string,
    description: (args.description as string) || (args.title as string),
    summary: (args.description as string) || (args.title as string),
    repo: (args.repo as string) || undefined,
    kind: (args.kind as string) || 'feature',
    label: (args.label as string) || (args.kind as string) || 'feature',
    ticket_id: (args.ticket as string) || undefined,
    constraints: args.constraints ? (args.constraints as string).split(';;') : [],
    acceptance_criteria: args.acceptance ? (args.acceptance as string).split(';;') : [],
    verification_steps: args.verification ? (args.verification as string).split(';;') : [],
  };

  const enriched = enrichPayloadWithRepo(payload);

  if (args.enqueue) {
    const packet = buildIncidentPacket('manual', enriched);
    if (args.ticket) packet.ticket_id = args.ticket;
    if (!packet.repoResolved) {
      console.error(`error: repo not available locally: ${packet.repo || '(unset)'}`);
      console.error('hint: check configs/repos.json mappings');
      process.exit(2);
    }
    const created = createJob(packet);
    console.log(JSON.stringify({
      ok: true,
      mode: 'enqueue',
      job_id: created.jobId,
      state: created.status.state,
      repo: created.packet.repo,
      ticket_id: created.packet.ticket_id,
    }, null, 2));
    return;
  }

  const result = await intakeToLinear('manual', enriched, {
    autoDispatch: !!args.dispatch,
    autoStart: !!args.dispatch,
    maxConcurrent: 1,
  });

  console.log(JSON.stringify({
    ok: true,
    mode: args.dispatch ? 'dispatch' : 'linear-only',
    identifier: result.identifier,
    url: result.url,
    project: result.project,
    state: result.state,
    dispatch: result.dispatch,
    supervisor: result.supervisor ? { ok: true } : null,
  }, null, 2));
}

main().catch((error: Error) => {
  console.error(error.stack || error.message);
  process.exit(1);
});
