const { normalizeVercelFailure, normalizeSentryIssue, normalizeManualIssue } = require('./intake');
const { createIssueFromJob, updateIssueState, resolveStateName, resolveLinearOrg } = require('./linear');
const { enrichPayloadWithRepo } = require('./repos');
const { dispatchLinearIssues } = require('./linear-dispatch');

function buildIncidentPacket(kind, payload) {
  // For Sentry webhooks, extract project slug as a repo hint before enrichment
  if (kind === 'sentry' && payload.data?.issue?.project?.slug) {
    payload = { ...payload, repo: payload.repo || payload.data.issue.project.slug };
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

async function intakeToLinear(kind, payload, options = {}) {
  const packet = buildIncidentPacket(kind, payload);
  const orgKey = resolveLinearOrg(packet);
  const issue = await createIssueFromJob(packet);
  const desired = resolveStateName('inbox', orgKey);
  await updateIssueState(issue.id, desired, orgKey);

  let dispatch = null;
  let supervisor = null;
  if (options.autoDispatch) {
    dispatch = await dispatchLinearIssues().catch((error) => ({ ok: false, error: error.message }));
    if (options.autoStart) {
      const { runSupervisorCycle } = require('./jobs');
      supervisor = await runSupervisorCycle({ maxConcurrent: options.maxConcurrent || 1 }).catch((error) => ({ ok: false, error: error.message }));
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
