import https = require('https');
import fs = require('fs');
import path = require('path');
import type { LinearConfig, LinearIssue, LinearJobLink, LinearSyncResult, JobPacket, JobStatus, JobResult } from '../types';
const { loadConfig } = require('./config');
const { getSecret } = require('./secrets');
const { chooseLinearProjectKey, buildLinearLabels } = require('./intake');
const { ROOT } = require('./paths');

const LINEAR_URL = 'https://api.linear.app/graphql';
const LINEAR_CACHE_DIR: string = path.join(ROOT, 'supervisor', 'linear');
const LINEAR_LINKS_FILE: string = path.join(LINEAR_CACHE_DIR, 'job-links.json');

function ensureLinearCacheDir(): void {
  fs.mkdirSync(LINEAR_CACHE_DIR, { recursive: true });
}

function linearConfig(orgKey?: string | null): LinearConfig {
  if (orgKey && orgKey !== 'default') {
    return loadConfig(`linear-${orgKey}`, {}) as LinearConfig;
  }
  return loadConfig('linear', {}) as LinearConfig;
}

function linearApiKey(orgKey?: string | null): string {
  const cfg = linearConfig(orgKey);
  const envKey = cfg.apiKeyEnv || 'LINEAR_API_KEY';
  return getSecret(envKey);
}

function hasLinearCredentials(orgKey?: string | null): boolean {
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

function readLinks(): Record<string, LinearJobLink> {
  ensureLinearCacheDir();
  if (!fs.existsSync(LINEAR_LINKS_FILE)) return {};
  return JSON.parse(fs.readFileSync(LINEAR_LINKS_FILE, 'utf8'));
}

function writeLinks(data: Record<string, LinearJobLink>): void {
  ensureLinearCacheDir();
  fs.writeFileSync(LINEAR_LINKS_FILE, JSON.stringify(data, null, 2) + '\n');
}

function saveJobLinearLink(jobId: string, data: Partial<LinearJobLink>): LinearJobLink {
  const links = readLinks();
  links[jobId] = { ...(links[jobId] || {} as LinearJobLink), ...data } as LinearJobLink;
  writeLinks(links);
  return links[jobId];
}

function getJobLinearLink(jobId: string): LinearJobLink | null {
  const links = readLinks();
  return links[jobId] || null;
}

function linearRequest(query: string, variables: Record<string, unknown> = {}, orgKey?: string | null): Promise<Record<string, unknown>> {
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
          const parsed = JSON.parse(data || '{}');
          if (parsed.errors?.length) {
            reject(new Error(parsed.errors.map((e: { message: string }) => e.message).join('; ')));
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
  const description = enrichedDesc ? (enrichedDesc + repoTag) : [
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

function resolveStateName(kind: string, orgKey?: string | null): string {
  const cfg = linearConfig(orgKey);
  const defaults = cfg.defaultStates || {};
  return defaults[kind] || kind;
}

function buildCommentBody(job: Partial<JobStatus>, result: Partial<JobResult>): string {
  return [
    `Job: ${job.job_id}`,
    `State: ${result?.state || job.state || 'unknown'}`,
    `Commit: ${result?.commit || 'none'}`,
    `Prod: ${result?.prod || 'no'}`,
    `Verified: ${result?.verified || 'not yet'}`,
    `Blocker: ${result?.blocker || 'none'}`,
    result?.pr_url ? `PR: ${result.pr_url}` : null,
    result?.blocker_type ? `Blocker type: ${result.blocker_type}` : null,
    result?.failed_checks?.length ? `Failed checks:\n- ${result.failed_checks.map((c) => `${c.name}: ${c.state}${c.url ? ` (${c.url})` : ''}`).join('\n- ')}` : null,
    job.repo ? `Repo: ${job.repo}` : null,
    job.tmux_session ? `tmux: ${job.tmux_session}` : null,
  ].filter(Boolean).join('\n');
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
  } catch (_error) {
    return null;
  }
}

async function ensureLabels(names: string[] = [], orgKey?: string | null): Promise<string[]> {
  const ids: string[] = [];
  for (const name of names) {
    const id = await Promise.race([
      ensureLabel(name, orgKey),
      new Promise<string | null>((resolve) => setTimeout(() => resolve(null), 1500)),
    ]);
    if (id) ids.push(id);
  }
  return ids;
}

async function findIssueByIdentifier(identifier: string): Promise<LinearIssue | null> {
  const cfg = linearConfig();
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

async function createIssueComment(issueId: string, body: string): Promise<{ id: string; body: string } | null> {
  const data = await linearRequest(
    `mutation CommentCreate($input: CommentCreateInput!) {
      commentCreate(input: $input) {
        success
        comment {
          id
          body
        }
      }
    }`,
    {
      input: {
        issueId,
        body,
      },
    },
  ) as Record<string, unknown>;
  return ((data?.commentCreate as Record<string, unknown>)?.comment as { id: string; body: string }) || null;
}

async function postCompletionComment(
  issueId: string,
  result: JobResult,
  options?: { discordThreadId?: string | null },
): Promise<boolean> {
  const parts: string[] = [`**Job completed: ${result.state}**`];
  if (result.commit && result.commit !== 'none') parts.push(`Commit: \`${result.commit.slice(0, 10)}\``);
  if (result.pr_url) parts.push(`PR: ${result.pr_url}`);
  if (result.summary) parts.push(`**Summary:** ${result.summary}`);
  if (result.risk) parts.push(`**Risk:** ${result.risk}`);
  if (result.verified && result.verified !== 'not yet') parts.push(`**Verified:** ${result.verified}`);
  if (result.blocker) parts.push(`**Blocker:** ${result.blocker}`);
  if (options?.discordThreadId) parts.push(`[Discord thread](https://discord.com/channels/${options.discordThreadId})`);
  try {
    await createIssueComment(issueId, parts.join('\n'));
    return true;
  } catch {
    return false;
  }
}

async function syncJobToLinear({ packet, status, result }: { packet: JobPacket; status: JobStatus; result: JobResult }): Promise<LinearSyncResult> {
  if (!hasLinearCredentials()) {
    return { ok: false, skipped: true, reason: 'LINEAR_API_KEY missing' };
  }

  const lifecycleMap: Record<string, string> = {
    queued: 'ready',
    preflight: 'ready',
    running: 'running',
    blocked: 'blocked',
    failed: 'blocked',
    coded: 'review',
    done: 'done',
    verified: 'done',
  };

  const desiredStateName = resolveStateName(lifecycleMap[result?.state || status?.state || 'ready'] || 'ready');
  const canonicalIssue = packet.ticket_id ? await findIssueByIdentifier(packet.ticket_id).catch(() => null) : null;
  let link = getJobLinearLink(packet.job_id);
  let issue: LinearIssue | null = null;

  if (canonicalIssue?.id) {
    link = saveJobLinearLink(packet.job_id, {
      issueId: canonicalIssue.id,
      identifier: canonicalIssue.identifier,
      url: canonicalIssue.url,
      projectName: canonicalIssue.project?.name || null,
    });
  } else if (link?.identifier && packet.ticket_id && link.identifier !== packet.ticket_id) {
    link = null;
  }

  if (!link?.issueId) {
    if (packet.ticket_id) {
      return { ok: false, skipped: true, reason: `canonical Linear issue not found for ${packet.ticket_id}` };
    }
    issue = await createIssueFromJob(packet);
    if (!issue?.id) throw new Error('linear issue creation returned no issue');
    link = saveJobLinearLink(packet.job_id, {
      issueId: issue.id,
      identifier: issue.identifier,
      url: issue.url,
      projectName: issue.project?.name || null,
    });
  }

  try {
    await updateIssueState(link!.issueId, desiredStateName);
    await createIssueComment(link!.issueId, buildCommentBody(status || {}, result || {}));
  } catch (error) {
    if (!/Entity not found: Issue/i.test((error as Error).message || '')) throw error;
    issue = packet.ticket_id ? await findIssueByIdentifier(packet.ticket_id).catch(() => null) : null;
    if (!issue?.id) {
      if (packet.ticket_id) {
        return { ok: false, skipped: true, reason: `canonical Linear issue not found for ${packet.ticket_id}` };
      }
      issue = await createIssueFromJob(packet);
    }
    if (!issue?.id) throw error;
    link = saveJobLinearLink(packet.job_id, {
      issueId: issue.id,
      identifier: issue.identifier,
      url: issue.url,
      projectName: issue.project?.name || null,
    });
    await updateIssueState(link.issueId, desiredStateName);
    await createIssueComment(link.issueId, buildCommentBody(status || {}, result || {}));
  }

  return {
    ok: true,
    issueId: link!.issueId,
    identifier: link!.identifier,
    url: link!.url,
    state: desiredStateName,
    projectName: link!.projectName || null,
  };
}

module.exports = {
  linearConfig,
  linearApiKey,
  hasLinearCredentials,
  linearRequest,
  normalizeJobToLinearIssue,
  saveJobLinearLink,
  getJobLinearLink,
  syncJobToLinear,
  chooseProject,
  ensureLabels,
  createIssueFromJob,
  updateIssueState,
  resolveStateName,
  resolveLinearOrg,
  findIssueByIdentifier,
  postCompletionComment,
};

export {
  linearConfig,
  linearApiKey,
  hasLinearCredentials,
  linearRequest,
  normalizeJobToLinearIssue,
  saveJobLinearLink,
  getJobLinearLink,
  syncJobToLinear,
  chooseProject,
  ensureLabels,
  createIssueFromJob,
  updateIssueState,
  resolveStateName,
  resolveLinearOrg,
  findIssueByIdentifier,
  postCompletionComment,
};
