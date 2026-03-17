const https = require('https');
const fs = require('fs');
const path = require('path');
const { loadConfig } = require('./config');
const { getSecret } = require('./secrets');
const { chooseLinearProjectKey, buildLinearLabels } = require('./intake');
const { ROOT } = require('./paths');

const LINEAR_URL = 'https://api.linear.app/graphql';
const LINEAR_CACHE_DIR = path.join(ROOT, 'supervisor', 'linear');
const LINEAR_LINKS_FILE = path.join(LINEAR_CACHE_DIR, 'job-links.json');

function ensureLinearCacheDir() {
  fs.mkdirSync(LINEAR_CACHE_DIR, { recursive: true });
}

function linearConfig(orgKey) {
  if (orgKey && orgKey !== 'default') {
    return loadConfig(`linear-${orgKey}`, {});
  }
  return loadConfig('linear', {});
}

function linearApiKey(orgKey) {
  const cfg = linearConfig(orgKey);
  const envKey = cfg.apiKeyEnv || 'LINEAR_API_KEY';
  return getSecret(envKey);
}

function hasLinearCredentials(orgKey) {
  return !!linearApiKey(orgKey);
}

function resolveLinearOrg(packet) {
  const { repoConfig } = require('./repos');
  const cfg = repoConfig();
  for (const mapping of cfg.mappings || []) {
    if (mapping.key === packet.repoKey || mapping.ownerRepo === packet.ownerRepo) {
      return mapping.linearOrg || null;
    }
  }
  return null;
}

function readLinks() {
  ensureLinearCacheDir();
  if (!fs.existsSync(LINEAR_LINKS_FILE)) return {};
  return JSON.parse(fs.readFileSync(LINEAR_LINKS_FILE, 'utf8'));
}

function writeLinks(data) {
  ensureLinearCacheDir();
  fs.writeFileSync(LINEAR_LINKS_FILE, JSON.stringify(data, null, 2) + '\n');
}

function saveJobLinearLink(jobId, data) {
  const links = readLinks();
  links[jobId] = { ...(links[jobId] || {}), ...data };
  writeLinks(links);
  return links[jobId];
}

function getJobLinearLink(jobId) {
  const links = readLinks();
  return links[jobId] || null;
}

function linearRequest(query, variables = {}, orgKey) {
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
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data || '{}');
          if (parsed.errors?.length) {
            reject(new Error(parsed.errors.map((e) => e.message).join('; ')));
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

function chooseProject(payload, orgKey) {
  const cfg = linearConfig(orgKey);
  const key = chooseLinearProjectKey(payload);
  const project = cfg.projects?.[key] || null;
  return { key, project };
}

function normalizeJobToLinearIssue(packet, orgKey) {
  const routing = chooseProject(packet, orgKey);
  const labels = buildLinearLabels(packet);
  return {
    identifier: packet.ticket_id || null,
    title: packet.goal || `Coding job ${packet.job_id}`,
    description: [
      `Job ID: ${packet.job_id || 'pending'}`,
      `Repo: ${packet.repo || 'unknown'}`,
      routing.project?.name ? `Linear project: ${routing.project.name}` : null,
      labels.length ? `Labels:\n- ${labels.join('\n- ')}` : null,
      packet.working_branch ? `Working branch: ${packet.working_branch}` : null,
      packet.base_branch ? `Base branch: ${packet.base_branch}` : null,
      packet.source ? `Source: ${packet.source}` : null,
      packet.kind ? `Kind: ${packet.kind}` : null,
      packet.constraints?.length ? `Constraints:\n- ${packet.constraints.join('\n- ')}` : null,
      packet.acceptance_criteria?.length ? `Acceptance criteria:\n- ${packet.acceptance_criteria.join('\n- ')}` : null,
      packet.verification_steps?.length ? `Verification steps:\n- ${packet.verification_steps.join('\n- ')}` : null,
      packet.review_feedback?.length ? `Review feedback:\n- ${packet.review_feedback.join('\n- ')}` : null,
    ].filter(Boolean).join('\n\n'),
    projectId: routing.project?.id || null,
    projectName: routing.project?.name || null,
    routingKey: routing.key,
    labels,
  };
}

function resolveStateName(kind, orgKey) {
  const cfg = linearConfig(orgKey);
  const defaults = cfg.defaultStates || {};
  return defaults[kind] || kind;
}

function buildCommentBody(job, result) {
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
const _stateCache = {};
const STATE_CACHE_TTL_MS = 10 * 60 * 1000;

async function fetchWorkflowStates(teamId, orgKey) {
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
  );
  const states = data?.team?.states?.nodes || [];
  _stateCache[cacheKey] = { states, at: Date.now() };
  return states;
}

async function resolveStateIdByName(name, orgKey) {
  const cfg = linearConfig(orgKey);
  if (!cfg.teamId) throw new Error(`linear teamId missing in config${orgKey ? ` (org: ${orgKey})` : ''}`);
  const states = await fetchWorkflowStates(cfg.teamId, orgKey);
  const match = states.find((state) => state.name.toLowerCase() === String(name).toLowerCase());
  return match ? match.id : null;
}

async function ensureLabel(name, orgKey) {
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
    );
    const existing = data?.team?.labels?.nodes?.find((label) => label.name.toLowerCase() === String(name).toLowerCase());
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
    );
    return created?.issueLabelCreate?.issueLabel?.id || null;
  } catch (_error) {
    return null;
  }
}

async function ensureLabels(names = [], orgKey) {
  const ids = [];
  for (const name of names) {
    const id = await Promise.race([
      ensureLabel(name, orgKey),
      new Promise((resolve) => setTimeout(() => resolve(null), 1500)),
    ]);
    if (id) ids.push(id);
  }
  return ids;
}

async function findIssueByIdentifier(identifier) {
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
  );
  const issues = data?.team?.issues?.nodes || [];
  return issues.find((issue) => issue.identifier === identifier) || null;
}

async function createIssueFromJob(packet) {
  const orgKey = resolveLinearOrg(packet);
  const cfg = linearConfig(orgKey);
  if (!cfg.teamId) throw new Error(`linear teamId missing in config${orgKey ? ` (org: ${orgKey})` : ''}`);
  const normalized = normalizeJobToLinearIssue(packet, orgKey);
  const labelIds = await ensureLabels(normalized.labels || [], orgKey);
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
  );
  return data?.issueCreate?.issue || null;
}

async function updateIssueState(issueId, stateName, orgKey) {
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
  );
  return data?.issueUpdate?.issue || null;
}

async function createIssueComment(issueId, body) {
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
  );
  return data?.commentCreate?.comment || null;
}

async function syncJobToLinear({ packet, status, result }) {
  if (!hasLinearCredentials()) {
    return { ok: false, skipped: true, reason: 'LINEAR_API_KEY missing' };
  }

  const lifecycleMap = {
    queued: 'ready',
    preflight: 'ready',
    running: 'running',
    blocked: 'blocked',
    failed: 'blocked',
    coded: 'review',
    done: 'review',
    verified: 'verified',
  };

  const desiredStateName = resolveStateName(lifecycleMap[result?.state || status?.state || 'ready']);
  const canonicalIssue = packet.ticket_id ? await findIssueByIdentifier(packet.ticket_id).catch(() => null) : null;
  let link = getJobLinearLink(packet.job_id);
  let issue = null;

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
    await updateIssueState(link.issueId, desiredStateName);
    await createIssueComment(link.issueId, buildCommentBody(status || {}, result || {}));
  } catch (error) {
    if (!/Entity not found: Issue/i.test(error.message || '')) throw error;
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
    issueId: link.issueId,
    identifier: link.identifier,
    url: link.url,
    state: desiredStateName,
    projectName: link.projectName || null,
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
};
