import type { JobPacket, IntakePayload, IntakeToLinearResult } from '../types';
import { spawnSync } from 'child_process';
const { normalizeVercelFailure, normalizeSentryIssue, normalizeManualIssue } = require('./intake');
const { createIssueFromJob, updateIssueState, resolveStateName, resolveLinearOrg } = require('./linear');
const { enrichPayloadWithRepo } = require('./repos');
const { dispatchLinearIssues } = require('./linear-dispatch');

/**
 * Use Claude Haiku to generate structured ticket fields from a rough description.
 * Returns enriched acceptance_criteria, verification_steps, constraints, and a clean title.
 * Falls back silently on failure (returns original input unchanged).
 */
function enrichWithAI(title: string, description: string, repoName?: string): {
  title: string;
  description: string;
  acceptance_criteria: string[];
  verification_steps: string[];
  constraints: string[];
} {
  const fallback = {
    title,
    description,
    acceptance_criteria: description ? [description] : [],
    verification_steps: [],
    constraints: [],
  };

  try {
    const prompt = `You are a ticket refinement assistant for a software engineering team.

Given this rough feature request or bug report, generate a structured ticket.

Title: ${title}
Description: ${description}
${repoName ? `Repository: ${repoName}` : ''}

Output ONLY valid JSON (no markdown, no code fences) with these fields:
{
  "title": "Clean, concise ticket title",
  "acceptance_criteria": ["3-5 specific, testable criteria as strings"],
  "verification_steps": ["2-4 concrete verification steps the developer should take"],
  "constraints": ["1-3 scope/risk notes, e.g. what NOT to touch, blast radius"],
  "description": "## Description\\n<1-2 sentence summary>\\n\\n## Acceptance Criteria\\n- <bullet items>\\n\\n## Validation\\n- <bullet items>\\n\\n## Risks\\n- <bullet items>"
}

Rules:
- Acceptance criteria must be binary pass/fail testable
- Verification steps should be concrete (e.g. "run pnpm tsc --noEmit", "verify the new page renders at /path")
- Constraints should mention what's out of scope
- The description field should be markdown with ## sections (this goes into the Linear ticket body)
- Keep it practical, not bureaucratic`;

    const result = spawnSync(
      'claude',
      ['--print', '--model', 'claude-haiku-4-5', prompt],
      { encoding: 'utf8', timeout: 30000 }
    );

    if (result.status !== 0) return fallback;

    const output = (result.stdout || '').trim();
    // Try to extract JSON from the output
    const jsonMatch = output.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return fallback;

    const parsed = JSON.parse(jsonMatch[0]);
    return {
      title: parsed.title || title,
      description: parsed.description || description,
      acceptance_criteria: Array.isArray(parsed.acceptance_criteria) ? parsed.acceptance_criteria : fallback.acceptance_criteria,
      verification_steps: Array.isArray(parsed.verification_steps) ? parsed.verification_steps : [],
      constraints: Array.isArray(parsed.constraints) ? parsed.constraints : [],
    };
  } catch {
    return fallback;
  }
}

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

  // For manual issues, enrich with AI-generated structured fields
  // Skip for automated sources (Sentry/Vercel) which have their own structure
  let acceptance_criteria = enriched.acceptance_criteria || [normalized.summary];
  let verification_steps = enriched.verification_steps || [];
  let constraints = enriched.constraints || [];
  let goal = normalized.title;
  let description = normalized.summary;

  if (kind === 'manual' && !enriched.acceptance_criteria?.length) {
    const repoName = enriched.ownerRepo || enriched.repoKey || undefined;
    const ai = enrichWithAI(normalized.title, normalized.summary, repoName);
    goal = ai.title;
    description = ai.description;
    acceptance_criteria = ai.acceptance_criteria;
    verification_steps = ai.verification_steps;
    constraints = ai.constraints;
  }

  return {
    job_id: `incident_${Date.now()}`,
    ticket_id: enriched.ticket_id || null,
    repo: enriched.repo || null,
    repoKey: enriched.repoKey || null,
    ownerRepo: enriched.ownerRepo || null,
    gitUrl: enriched.gitUrl || null,
    repoResolved: !!enriched.repoResolved,
    goal,
    source: normalized.source,
    kind: normalized.kind,
    label: normalized.label,
    acceptance_criteria,
    constraints,
    verification_steps,
    metadata: { ...normalized.metadata, enriched_description: description },
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
  enrichWithAI,
};

export { buildIncidentPacket, intakeToLinear, enrichWithAI };
