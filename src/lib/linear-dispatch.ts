import fs = require('fs');
import path = require('path');
import type { DispatchState, DispatchResult, JobPacket, RepoMapping } from '../types';
const { linearConfig, linearRequest } = require('./linear');
const { ROOT } = require('./paths');
const { findRepoMapping, enrichPayloadWithRepo } = require('./repos');

const DISPATCH_DIR: string = path.join(ROOT, 'supervisor', 'linear-dispatch');
const STATE_FILE: string = path.join(DISPATCH_DIR, 'state.json');

function ensureDir(): void {
  fs.mkdirSync(DISPATCH_DIR, { recursive: true });
}

function readState(): DispatchState {
  ensureDir();
  if (!fs.existsSync(STATE_FILE)) return { dispatchedIssueIds: {}, updatedAt: null };
  return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
}

function writeState(state: DispatchState): void {
  ensureDir();
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2) + '\n');
}

const { loadConfig } = require('./config');
const { hasLinearCredentials } = require('./linear');

function listLinearOrgs(): Array<string | null> {
  const orgs: Array<string | null> = [null]; // default org
  const reposCfg = loadConfig('repos', { mappings: [] });
  const seen = new Set<string>();
  for (const m of reposCfg.mappings || []) {
    if (m.linearOrg && !seen.has(m.linearOrg)) {
      seen.add(m.linearOrg);
      orgs.push(m.linearOrg);
    }
  }
  return orgs;
}

interface LinearDispatchIssue {
  id: string;
  identifier: string;
  title: string;
  description: string;
  url: string;
  state: { name: string };
  project: { id: string; name: string } | null;
  labels: { nodes: Array<{ id: string; name: string }> };
  _orgKey?: string | null;
}

async function listDispatchCandidates(): Promise<LinearDispatchIssue[]> {
  const allIssues: LinearDispatchIssue[] = [];
  for (const orgKey of listLinearOrgs()) {
    if (!hasLinearCredentials(orgKey)) continue;
    const cfg = linearConfig(orgKey);
    if (!cfg.teamId) continue;
    try {
      const data = await linearRequest(
        `query DispatchIssues($teamId: String!) {
          team(id: $teamId) {
            issues(first: 50, filter: { state: { name: { in: ["Todo", "Backlog"] } } }) {
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
      ) as Record<string, unknown>;
      const issues = ((data?.team as Record<string, unknown>)?.issues as Record<string, unknown>)?.nodes as LinearDispatchIssue[] || [];
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

function chooseKind(issue: LinearDispatchIssue): string {
  const labels = (issue.labels?.nodes || []).map((l) => String(l.name).toLowerCase());
  if (labels.includes('deploy')) return 'deploy';
  if (labels.includes('runtime')) return 'runtime';
  if (labels.includes('regression')) return 'regression';
  if (labels.includes('bug')) return 'bug';
  if (labels.includes('feature')) return 'feature';
  return issue.project?.name === 'Reliability / Incidents' ? 'bug' : 'feature';
}

function issueToPacket(issue: LinearDispatchIssue): JobPacket {
  const mapping: RepoMapping | null = findRepoMapping({
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

async function moveIssueToInProgress(issueId: string, orgKey: string | null | undefined): Promise<unknown> {
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
  ) as Record<string, unknown>;
  const nodes = ((states?.team as Record<string, unknown>)?.states as Record<string, unknown>)?.nodes as Array<{ id: string; name: string }> || [];
  const match = nodes.find((s) => s.name === (cfg.defaultStates?.running || 'In Progress'));
  if (!match) return null;
  return linearRequest(
    `mutation IssueUpdate($id: String!, $input: IssueUpdateInput!) {
      issueUpdate(id: $id, input: $input) { success }
    }`,
    { id: issueId, input: { stateId: match.id } },
    orgKey,
  );
}

async function dispatchLinearIssues(): Promise<DispatchResult[]> {
  const { createJob } = require('./jobs');
  const state = readState();
  const issues = await listDispatchCandidates();
  const out: DispatchResult[] = [];

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

export { dispatchLinearIssues, listDispatchCandidates, issueToPacket, readState };
