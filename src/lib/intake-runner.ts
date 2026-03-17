import type { JobPacket, IntakePayload, IntakeToLinearResult } from '../types';
const { normalizeVercelFailure, normalizeSentryIssue, normalizeManualIssue } = require('./intake');
const { createIssueFromJob, updateIssueState, resolveStateName, resolveLinearOrg } = require('./linear');
const { enrichPayloadWithRepo } = require('./repos');
const { dispatchLinearIssues } = require('./linear-dispatch');

function buildIncidentPacket(kind: string, payload: IntakePayload): JobPacket {
  // For Sentry webhooks, extract project slug as a repo hint before enrichment
  if (kind === 'sentry' && (payload.data as Record<string, unknown>)?.issue) {
    const issue = (payload.data as Record<string, unknown>).issue as Record<string, unknown>;
    const project = issue.project as Record<string, unknown> | undefined;
    if (project?.slug) {
      payload = { ...payload, repo: payload.repo || project.slug as string };
    }
  }
  const enriched = enrichPayloadWithRepo(payload);
  let normalized;
  if (kind === 'sentry') normalized = normalizeSentryIssue(enriched);
  else if (kind === 'vercel') normalized = normalizeVercelFailure(enriched);
  else if (kind === 'manual') normalized = normalizeManualIssue(enriched);
  else throw new Error(`unsupported intake kind: ${kind}`);

  return {
    job_id: `incident_${Date.now()}`,
    ticket_id: enriched.ticket_id || null,
    repo: enriched.repo || null,
    repoKey: enriched.repoKey || null,
    ownerRepo: enriched.ownerRepo || null,
    gitUrl: enriched.gitUrl || null,
    repoResolved: !!enriched.repoResolved,
    goal: normalized.title,
    source: normalized.source,
    kind: normalized.kind,
    label: normalized.label,
    acceptance_criteria: [normalized.summary],
    constraints: enriched.constraints || [],
    verification_steps: enriched.verification_steps || [],
    metadata: normalized.metadata,
  };
}

async function intakeToLinear(kind: string, payload: IntakePayload, options: { autoDispatch?: boolean; autoStart?: boolean; maxConcurrent?: number } = {}): Promise<IntakeToLinearResult> {
  const packet = buildIncidentPacket(kind, payload);
  const orgKey = resolveLinearOrg(packet);
  const issue = await createIssueFromJob(packet);
  const desired = resolveStateName('inbox', orgKey);
  await updateIssueState(issue.id, desired, orgKey);

  let dispatch: unknown = null;
  let supervisor: unknown = null;
  if (options.autoDispatch) {
    dispatch = await dispatchLinearIssues().catch((error: Error) => ({ ok: false, error: error.message }));
    if (options.autoStart) {
      const { runSupervisorCycle } = require('./jobs');
      supervisor = await runSupervisorCycle({ maxConcurrent: options.maxConcurrent || 1 }).catch((error: Error) => ({ ok: false, error: error.message }));
    }
  }

  return {
    ok: true,
    issueId: issue.id,
    identifier: issue.identifier,
    url: issue.url,
    project: issue.project?.name || null,
    state: desired,
    packet,
    dispatch,
    supervisor,
  };
}

module.exports = {
  buildIncidentPacket,
  intakeToLinear,
};

export { buildIncidentPacket, intakeToLinear };
