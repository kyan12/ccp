import https = require('https');
import type { LinearConfig, LinearIssue, JobPacket } from '../types';
const { loadConfig } = require('./config');
const { getSecret } = require('./secrets');
const { chooseLinearProjectKey, buildLinearLabels } = require('./intake');
const { isLinearGloballyDisabled } = require('./linear-disabled');

const LINEAR_URL = 'https://api.linear.app/graphql';
function linearConfig(orgKey?: string | null): LinearConfig {
  if (orgKey && orgKey !== 'default') {
    return loadConfig(`linear-${orgKey}`, {}) as LinearConfig;
  }
  return loadConfig('linear', {}) as LinearConfig;
}

function linearApiKey(orgKey?: string | null): string {
  if (isLinearGloballyDisabled()) return '';
  const cfg = linearConfig(orgKey);
  const envKey = cfg.apiKeyEnv || 'LINEAR_API_KEY';
  return getSecret(envKey);
}

function hasLinearCredentials(orgKey?: string | null): boolean {
  if (isLinearGloballyDisabled()) return false;
  return !!linearApiKey(orgKey);
}

function resolveLinearOrg(packet: JobPacket): string | null {
  const { repoConfig } = require('./repos');
  const cfg = repoConfig();
  for (const mapping of cfg.mappings || []) {
    if (mapping.key === packet.repoKey || mapping.ownerRepo === packet.ownerRepo) {
      return mapping.linearOrg || null;
    }
  }
  return null;
}

function parseRateLimitReset(headers: Record<string, string | string[] | number | undefined>): number | null {
  const raw = headers['x-ratelimit-complexity-reset'] || headers['x-ratelimit-requests-reset'];
  const value = Array.isArray(raw) ? raw[0] : raw;
  const num = Number(value || 0);
  if (!Number.isFinite(num) || num <= 0) return null;
  // HTTP rate-limit reset headers are typically Unix epoch seconds (~1.7e9),
  // but Date.now() returns milliseconds (~1.7e12). Detect and convert.
  return num < 1e12 ? num * 1000 : num;
}

function linearRequest(query: string, variables: Record<string, unknown> = {}, orgKey?: string | null): Promise<Record<string, unknown>> {
  if (isLinearGloballyDisabled()) {
    return Promise.reject(new Error('Linear disabled by CCP_LINEAR_DISABLED/CCP_DISABLE_LINEAR'));
  }
  const apiKey = linearApiKey(orgKey);
  if (!apiKey) {
    return Promise.reject(new Error(`LINEAR_API_KEY missing${orgKey ? ` (org: ${orgKey})` : ''}`));
  }

  const body = JSON.stringify({ query, variables });
  return new Promise((resolve, reject) => {
    const req = https.request(LINEAR_URL, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(body),
        authorization: apiKey,
      },
    }, (res) => {
      let data = '';
      res.on('data', (chunk: string) => { data += chunk; });
      res.on('end', () => {
        try {
          // Handle non-2xx HTTP responses before parsing GraphQL body.
          // Linear may return 429 (rate limit), 500, 502, 503, etc. with a
          // non-GraphQL body (e.g. {"error":"Too Many Requests"} without an
          // `errors` array). Without this check, such responses silently
          // resolve as `undefined` (parsed.data is missing), causing callers
          // to fail in unexpected ways.
          const statusCode = res.statusCode || 0;
          if (statusCode < 200 || statusCode >= 300) {
            const isRateLimit = statusCode === 429 || /rate limit/i.test(data);
            const message = `Linear API HTTP ${statusCode}: ${data.slice(0, 200)}`;
            const err = new Error(message) as Error & { rateLimitResetMs?: number | null; linearOrgKey?: string | null; linearRateLimited?: boolean };
            if (isRateLimit) {
              err.linearRateLimited = true;
              err.rateLimitResetMs = parseRateLimitReset(res.headers);
              err.linearOrgKey = orgKey || null;
            }
            reject(err);
            return;
          }

          const parsed = JSON.parse(data || '{}');
          if (parsed.errors?.length) {
            const message = parsed.errors.map((e: { message: string }) => e.message).join('; ');
            const err = new Error(message) as Error & { rateLimitResetMs?: number | null; linearOrgKey?: string | null; linearRateLimited?: boolean };
            if (/rate limit/i.test(message)) {
              err.linearRateLimited = true;
              err.rateLimitResetMs = parseRateLimitReset(res.headers);
              err.linearOrgKey = orgKey || null;
            }
            reject(err);
            return;
          }
          resolve(parsed.data);
        } catch (error) {
          reject(error);
        }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

function chooseProject(payload: JobPacket, orgKey?: string | null): { key: string; project: { id: string; name: string } | null } {
  const cfg = linearConfig(orgKey);
  const key = chooseLinearProjectKey(payload);
  const project = cfg.projects?.[key] || null;
  return { key, project };
}

function normalizeJobToLinearIssue(packet: JobPacket, orgKey?: string | null): Record<string, unknown> {
  const routing = chooseProject(packet, orgKey);
  const labels: string[] = buildLinearLabels(packet);

  // If the packet has an AI-enriched description (with ## sections), use it directly
  // Always append Repo: tag so dispatch can resolve the repo from the Linear issue
  const enrichedDesc = (packet.metadata as Record<string, unknown>)?.enriched_description as string | undefined;
  const repoTag = packet.ownerRepo ? `\n\n**Repo:** ${packet.ownerRepo}` : (packet.repo ? `\n\n**Repo:** ${packet.repo}` : '');
  let description = enrichedDesc ? (enrichedDesc + repoTag) : [
    `Job ID: ${packet.job_id || 'pending'}`,
    `Repo: ${packet.repo || 'unknown'}`,
    routing.project?.name ? `Linear project: ${routing.project.name}` : null,
    labels.length ? `Labels:\n- ${labels.join('\n- ')}` : null,
    packet.working_branch ? `Working branch: ${packet.working_branch}` : null,
    packet.base_branch ? `Base branch: ${packet.base_branch}` : null,
    packet.source ? `Source: ${packet.source}` : null,
    packet.kind ? `Kind: ${packet.kind}` : null,
    packet.constraints?.length ? `## Constraints\n- ${packet.constraints.join('\n- ')}` : null,
    packet.acceptance_criteria?.length ? `## Acceptance Criteria\n- ${packet.acceptance_criteria.join('\n- ')}` : null,
    packet.verification_steps?.length ? `## Validation\n- ${packet.verification_steps.join('\n- ')}` : null,
    packet.review_feedback?.length ? `Review feedback:\n- ${packet.review_feedback.join('\n- ')}` : null,
  ].filter(Boolean).join('\n\n');

  return {
    identifier: packet.ticket_id || null,
    title: packet.goal || `Coding job ${packet.job_id}`,
    description,
    projectId: routing.project?.id || null,
    projectName: routing.project?.name || null,
    routingKey: routing.key,
    labels: [...labels, ...(packet.repoKey ? [`repo:${packet.repoKey}`] : [])],
  };
}

const LINEAR_STATE_DEFAULTS: Record<string, string> = {
  in_progress: 'In Progress',
  in_review: 'In Review',
  done: 'Done',
  blocked: 'Blocked',
};

function resolveStateName(kind: string, orgKey?: string | null): string {
  const cfg = linearConfig(orgKey);
  const overrides = cfg.defaultStates || {};
  return overrides[kind] || LINEAR_STATE_DEFAULTS[kind] || kind;
}

// Cache workflow states for 10 minutes to reduce API calls
const _stateCache: Record<string, { states: Array<{ id: string; name: string; type: string }>; at: number }> = {};
const STATE_CACHE_TTL_MS = 10 * 60 * 1000;

async function fetchWorkflowStates(teamId: string, orgKey?: string | null): Promise<Array<{ id: string; name: string; type: string }>> {
  const cacheKey = `${orgKey || 'default'}:${teamId}`;
  const cached = _stateCache[cacheKey];
  if (cached && Date.now() - cached.at < STATE_CACHE_TTL_MS) {
    return cached.states;
  }
  const data = await linearRequest(
    `query WorkflowStates($teamId: String!) {
      team(id: $teamId) {
        states {
          nodes {
            id
            name
            type
          }
        }
      }
    }`,
    { teamId },
    orgKey,
  ) as Record<string, unknown>;
  const states = ((data?.team as Record<string, unknown>)?.states as Record<string, unknown>)?.nodes as Array<{ id: string; name: string; type: string }> || [];
  _stateCache[cacheKey] = { states, at: Date.now() };
  return states;
}

async function resolveStateIdByName(name: string, orgKey?: string | null): Promise<string | null> {
  const cfg = linearConfig(orgKey);
  if (!cfg.teamId) throw new Error(`linear teamId missing in config${orgKey ? ` (org: ${orgKey})` : ''}`);
  const states = await fetchWorkflowStates(cfg.teamId, orgKey);
  const match = states.find((state) => state.name.toLowerCase() === String(name).toLowerCase());
  return match ? match.id : null;
}

async function ensureLabel(name: string, orgKey?: string | null): Promise<string | null> {
  const cfg = linearConfig(orgKey);
  try {
    const data = await linearRequest(
      `query Labels($teamId: String!) {
        team(id: $teamId) {
          labels {
            nodes {
              id
              name
            }
          }
        }
      }`,
      { teamId: cfg.teamId },
      orgKey,
    ) as Record<string, unknown>;
    const existing = (((data?.team as Record<string, unknown>)?.labels as Record<string, unknown>)?.nodes as Array<{ id: string; name: string }>)?.find((label) => label.name.toLowerCase() === String(name).toLowerCase());
    if (existing) return existing.id;
    const created = await linearRequest(
      `mutation LabelCreate($input: IssueLabelCreateInput!) {
        issueLabelCreate(input: $input) {
          success
          issueLabel {
            id
            name
          }
        }
      }`,
      {
        input: {
          teamId: cfg.teamId,
          name,
        },
      },
      orgKey,
    ) as Record<string, unknown>;
    return ((created?.issueLabelCreate as Record<string, unknown>)?.issueLabel as Record<string, unknown>)?.id as string || null;
  } catch (error) {
    console.error(`[ccp] linear: failed to ensure label "${name}":`, error);
    return null;
  }
}

async function ensureLabels(names: string[] = [], orgKey?: string | null): Promise<string[]> {
  const ids: string[] = [];
  for (const name of names) {
    const id = await Promise.race([
      ensureLabel(name, orgKey).catch(() => null),
      new Promise<string | null>((resolve) => setTimeout(() => resolve(null), 1500)),
    ]);
    if (id) ids.push(id);
  }
  return ids;
}

async function findIssueByIdentifier(identifier: string, orgKey?: string | null): Promise<LinearIssue | null> {
  const cfg = linearConfig(orgKey);
  if (!identifier || !cfg.teamId) return null;
  const data = await linearRequest(
    `query RecentTeamIssues($teamId: String!) {
      team(id: $teamId) {
        issues(first: 100) {
          nodes {
            id
            identifier
            title
            url
            project { id name }
            team { id key name }
          }
        }
      }
    }`,
    { teamId: cfg.teamId },
    orgKey,
  ) as Record<string, unknown>;
  const issues = ((data?.team as Record<string, unknown>)?.issues as Record<string, unknown>)?.nodes as LinearIssue[] || [];
  return issues.find((issue) => issue.identifier === identifier) || null;
}

async function createIssueFromJob(packet: JobPacket): Promise<LinearIssue | null> {
  const orgKey = resolveLinearOrg(packet);
  const cfg = linearConfig(orgKey);
  if (!cfg.teamId) throw new Error(`linear teamId missing in config${orgKey ? ` (org: ${orgKey})` : ''}`);
  const normalized = normalizeJobToLinearIssue(packet, orgKey);
  const labelIds = await ensureLabels(normalized.labels as string[] || [], orgKey);
  const data = await linearRequest(
    `mutation IssueCreate($input: IssueCreateInput!) {
      issueCreate(input: $input) {
        success
        issue {
          id
          identifier
          title
          url
          project { id name }
        }
      }
    }`,
    {
      input: {
        teamId: cfg.teamId,
        title: normalized.title,
        description: normalized.description,
        projectId: normalized.projectId || undefined,
        ...(labelIds.length ? { labelIds } : {}),
      },
    },
    orgKey,
  ) as Record<string, unknown>;
  return ((data?.issueCreate as Record<string, unknown>)?.issue as LinearIssue) || null;
}

async function updateIssueState(issueId: string, stateName: string, orgKey?: string | null): Promise<LinearIssue | null> {
  const stateId = await resolveStateIdByName(stateName, orgKey);
  if (!stateId) throw new Error(`linear state not found: ${stateName}`);
  const data = await linearRequest(
    `mutation IssueUpdate($id: String!, $input: IssueUpdateInput!) {
      issueUpdate(id: $id, input: $input) {
        success
        issue {
          id
          identifier
          state {
            id
            name
          }
        }
      }
    }`,
    {
      id: issueId,
      input: { stateId },
    },
    orgKey,
  ) as Record<string, unknown>;
  return ((data?.issueUpdate as Record<string, unknown>)?.issue as LinearIssue) || null;
}

module.exports = {
  linearConfig,
  linearApiKey,
  hasLinearCredentials,
  linearRequest,
  normalizeJobToLinearIssue,
  chooseProject,
  ensureLabels,
  createIssueFromJob,
  updateIssueState,
  resolveStateName,
  resolveLinearOrg,
  findIssueByIdentifier,
  parseRateLimitReset,
};

export {
  linearConfig,
  linearApiKey,
  hasLinearCredentials,
  linearRequest,
  normalizeJobToLinearIssue,
  chooseProject,
  ensureLabels,
  createIssueFromJob,
  updateIssueState,
  resolveStateName,
  resolveLinearOrg,
  findIssueByIdentifier,
  parseRateLimitReset,
};
