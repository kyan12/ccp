const fs = require('fs');
const path = require('path');
const { linearConfig, linearRequest } = require('./linear');
const { ROOT } = require('./paths');
const { findRepoMapping, enrichPayloadWithRepo } = require('./repos');

const DISPATCH_DIR = path.join(ROOT, 'supervisor', 'linear-dispatch');
const STATE_FILE = path.join(DISPATCH_DIR, 'state.json');

function ensureDir() {
  fs.mkdirSync(DISPATCH_DIR, { recursive: true });
}

function readState() {
  ensureDir();
  if (!fs.existsSync(STATE_FILE)) return { dispatchedIssueIds: {}, updatedAt: null };
  return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
}

function writeState(state) {
  ensureDir();
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2) + '\n');
}

const { loadConfig } = require('./config');
const { hasLinearCredentials } = require('./linear');

function listLinearOrgs() {
  const orgs = [null]; // default org
  const reposCfg = loadConfig('repos', { mappings: [] });
  const seen = new Set();
  for (const m of reposCfg.mappings || []) {
    if (m.linearOrg && !seen.has(m.linearOrg)) {
      seen.add(m.linearOrg);
      orgs.push(m.linearOrg);
    }
  }
  return orgs;
}

async function listDispatchCandidates() {
  const allIssues = [];
  for (const orgKey of listLinearOrgs()) {
    if (!hasLinearCredentials(orgKey)) continue;
    const cfg = linearConfig(orgKey);
    if (!cfg.teamId) continue;
    try {
      const data = await linearRequest(
        `query DispatchIssues($teamId: String!) {
          team(id: $teamId) {
            issues(first: 50, filter: { state: { name: { in: [\"Todo\", \"Backlog\"] } } }) {
              nodes {
                id
                identifier
                title
                description
                url
                state { name }
                project { id name }
                labels { nodes { id name } }
              }
            }
          }
        }`,
        { teamId: cfg.teamId },
        orgKey,
      );
      const issues = data?.team?.issues?.nodes || [];
      for (const issue of issues) {
        issue._orgKey = orgKey;
      }
      allIssues.push(...issues);
    } catch (_err) {
      // skip orgs that fail
    }
  }
  return allIssues;
}

function chooseKind(issue) {
  const labels = (issue.labels?.nodes || []).map((l) => String(l.name).toLowerCase());
  if (labels.includes('deploy')) return 'deploy';
  if (labels.includes('runtime')) return 'runtime';
  if (labels.includes('regression')) return 'regression';
  if (labels.includes('bug')) return 'bug';
  if (labels.includes('feature')) return 'feature';
  return issue.project?.name === 'Reliability / Incidents' ? 'bug' : 'feature';
}

function issueToPacket(issue) {
  const mapping = findRepoMapping({
    title: issue.title,
    description: issue.description,
    repo: issue.description,
  });
  const enriched = enrichPayloadWithRepo({
    title: issue.title,
    description: issue.description,
    repo: mapping?.ownerRepo || null,
  });
  return {
    job_id: `linear_${issue.identifier.toLowerCase().replace(/[^a-z0-9]+/g, '_')}`,
    ticket_id: issue.identifier,
    repo: enriched.repo || null,
    repoKey: enriched.repoKey || null,
    ownerRepo: enriched.ownerRepo || null,
    gitUrl: enriched.gitUrl || null,
    repoResolved: !!enriched.repoResolved,
    goal: issue.title,
    source: 'linear',
    kind: chooseKind(issue),
    label: chooseKind(issue),
    acceptance_criteria: issue.description ? [issue.description] : [],
    constraints: [],
    verification_steps: [],
  };
}

async function moveIssueToInProgress(issueId, orgKey) {
  const cfg = linearConfig(orgKey);
  const states = await linearRequest(
    `query WorkflowStates($teamId: String!) {
      team(id: $teamId) {
        states {
          nodes { id name }
        }
      }
    }`,
    { teamId: cfg.teamId },
    orgKey,
  );
  const match = states?.team?.states?.nodes?.find((s) => s.name === (cfg.defaultStates?.running || 'In Progress'));
  if (!match) return null;
  return linearRequest(
    `mutation IssueUpdate($id: String!, $input: IssueUpdateInput!) {
      issueUpdate(id: $id, input: $input) { success }
    }`,
    { id: issueId, input: { stateId: match.id } },
    orgKey,
  );
}

async function dispatchLinearIssues() {
  const { createJob } = require('./jobs');
  const state = readState();
  const issues = await listDispatchCandidates();
  const out = [];

  for (const issue of issues) {
    if (state.dispatchedIssueIds[issue.id]) continue;
    const packet = issueToPacket(issue);
    if (!packet.repo || !packet.repoResolved) {
      out.push({ identifier: issue.identifier, skipped: true, reason: `repo unavailable: ${packet.repo || 'unmapped'}` });
      continue;
    }
    const created = createJob(packet);
    state.dispatchedIssueIds[issue.id] = {
      identifier: issue.identifier,
      job_id: created.jobId,
      at: new Date().toISOString(),
    };
    await moveIssueToInProgress(issue.id, issue._orgKey).catch(() => null);
    out.push({ identifier: issue.identifier, job_id: created.jobId, queued: true });
  }

  state.updatedAt = new Date().toISOString();
  writeState(state);
  return out;
}

module.exports = {
  dispatchLinearIssues,
  listDispatchCandidates,
  issueToPacket,
  readState,
};
