#!/usr/bin/env node
/**
 * intake-text.js — Create a job from free-text input (Discord intake, CLI, etc.)
 *
 * Usage:
 *   node src/bin/intake-text.js --title "Fix broken login" --repo my-repo \
 *     --kind bug --description "Login page 500s on submit" \
 *     [--constraints "Don't break SSO"] [--acceptance "Login works"] \
 *     [--verification "Submit login form"] [--ticket PRO-42] \
 *     [--enqueue] [--dispatch]
 *
 * With --enqueue: creates a local job immediately (skips Linear).
 * With --dispatch: creates Linear ticket + dispatches to job queue.
 * Default (neither flag): creates Linear ticket only.
 */

const { intakeToLinear, buildIncidentPacket } = require('../lib/intake-runner');
const { createJob } = require('../lib/jobs');
const { enrichPayloadWithRepo } = require('../lib/repos');

function parseArgs(argv) {
  const args = {};
  const rest = argv.slice(2);
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    if (arg === '--enqueue') { args.enqueue = true; continue; }
    if (arg === '--dispatch') { args.dispatch = true; continue; }
    if (arg.startsWith('--') && i + 1 < rest.length) {
      const key = arg.slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
      args[key] = rest[++i];
    }
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv);

  if (!args.title) {
    console.error('error: --title is required');
    process.exit(1);
  }

  const payload = {
    title: args.title,
    description: args.description || args.title,
    summary: args.description || args.title,
    repo: args.repo || null,
    kind: args.kind || 'feature',
    label: args.label || args.kind || 'feature',
    ticket_id: args.ticket || null,
    constraints: args.constraints ? args.constraints.split(';;') : [],
    acceptance_criteria: args.acceptance ? args.acceptance.split(';;') : [],
    verification_steps: args.verification ? args.verification.split(';;') : [],
  };

  const enriched = enrichPayloadWithRepo(payload);

  if (args.enqueue) {
    // Direct job creation, skip Linear
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

  // Linear ticket creation (default path)
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

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exit(1);
});
