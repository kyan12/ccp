import fs = require('fs');
import path = require('path');
import type { JobPacket, JobResult, JobStatus } from '../types';
const { createJob, loadStatus, readJson, packetPath, resultPath, statusPath } = require('./jobs');
const { enrichPayloadWithRepo } = require('./repos');

interface KanbanSubmitInput {
  task_id: string;
  title?: string;
  body?: string;
  worker_context?: string;
  comments?: unknown[];
  repo?: string | null;
  repoKey?: string | null;
  ownerRepo?: string | null;
  gitUrl?: string | null;
  goal?: string;
  kind?: string;
  label?: string;
  acceptance_criteria?: string[];
  constraints?: string[];
  verification_steps?: string[];
  metadata?: Record<string, unknown>;
  agent?: string;
  decisionMode?: JobPacket['decisionMode'];
}

interface KanbanSubmitResult {
  ok: boolean;
  job_id: string;
  state: string;
  created: boolean;
  existing: boolean;
  packet: JobPacket;
  status: JobStatus;
}

const TERMINAL_STATES = new Set(['done', 'verified', 'blocked', 'failed', 'coded', 'deployed', 'dirty-repo', 'harness-failure']);

function sanitizeTaskId(taskId: string): string {
  const clean = String(taskId || '').trim().toLowerCase().replace(/[^a-z0-9_-]+/g, '_').replace(/^_+|_+$/g, '');
  if (!clean) throw new Error('Kanban task_id is required');
  return clean;
}

function kanbanJobId(taskId: string): string {
  return `kanban_${sanitizeTaskId(taskId)}`;
}

function normalizeStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map((item) => String(item || '').trim()).filter(Boolean);
}

function buildKanbanJobPacket(input: KanbanSubmitInput): JobPacket {
  const taskId = String(input.task_id || '').trim();
  if (!taskId) throw new Error('Kanban task_id is required');

  const enriched = enrichPayloadWithRepo({
    repo: input.repo || input.repoKey || input.ownerRepo || undefined,
    repoKey: input.repoKey || undefined,
    title: input.title || input.goal,
    description: input.body || input.worker_context,
    metadata: input.metadata || {},
  });

  const acceptance = normalizeStringArray(input.acceptance_criteria);
  const verification = normalizeStringArray(input.verification_steps);
  const constraints = normalizeStringArray(input.constraints);
  const metadata: Record<string, unknown> = {
    ...(input.metadata || {}),
    source_transport: 'hermes-kanban',
    hermes_kanban_task_id: taskId,
    kanban_title: input.title || null,
    kanban_body: input.body || null,
    kanban_worker_context: input.worker_context || null,
    kanban_comments: Array.isArray(input.comments) ? input.comments : [],
  };

  const goal = input.goal || input.title || `Hermes Kanban task ${taskId}`;
  const body = input.body || input.worker_context || '';
  const packet: JobPacket = {
    job_id: kanbanJobId(taskId),
    ticket_id: taskId,
    repo: enriched.repo || input.repo || null,
    repoKey: enriched.repoKey || input.repoKey || null,
    ownerRepo: enriched.ownerRepo || input.ownerRepo || null,
    gitUrl: enriched.gitUrl || input.gitUrl || null,
    repoResolved: !!enriched.repoResolved,
    goal,
    source: 'hermes-kanban',
    kind: input.kind || 'task',
    label: input.label || 'kanban',
    acceptance_criteria: acceptance.length ? acceptance : (body ? [body] : []),
    constraints,
    verification_steps: verification,
    metadata,
    handoff_id: taskId,
    origin: 'hermes-kanban',
    requestor: 'Hermes Kanban',
    completion_routing: 'relay',
    callback_required: false,
    exact_deliverable: 'Complete the Kanban task and return CCP evidence for kanban_complete or a precise kanban_block reason.',
  };
  if (input.agent) packet.agent = input.agent;
  if (input.decisionMode) packet.decisionMode = input.decisionMode;
  return packet;
}

function submitKanbanJob(input: KanbanSubmitInput): KanbanSubmitResult {
  const packet = buildKanbanJobPacket(input);
  if (fs.existsSync(statusPath(packet.job_id))) {
    return {
      ok: true,
      job_id: packet.job_id,
      state: loadStatus(packet.job_id).state,
      created: false,
      existing: true,
      packet: readJson(packetPath(packet.job_id)) as unknown as JobPacket,
      status: loadStatus(packet.job_id),
    };
  }
  const created = createJob(packet);
  return {
    ok: true,
    job_id: created.jobId,
    state: created.status.state,
    created: true,
    existing: false,
    packet: created.packet,
    status: created.status,
  };
}

function loadResultSafe(jobId: string): JobResult | null {
  const file = resultPath(jobId);
  if (!fs.existsSync(file)) return null;
  return readJson(file) as unknown as JobResult;
}

function serializeKanbanJobResult(jobId: string): Record<string, unknown> {
  const status = loadStatus(jobId);
  const packet = readJson(packetPath(jobId)) as unknown as JobPacket;
  const result = loadResultSafe(jobId);
  const taskId = String(packet.metadata?.hermes_kanban_task_id || packet.ticket_id || '').trim();
  const terminal = TERMINAL_STATES.has(status.state) || TERMINAL_STATES.has(String(result?.state || ''));
  const verification = result?.verified || status.last_output_excerpt || 'not yet';
  const blocker = result?.blocker || (['blocked', 'failed', 'dirty-repo', 'harness-failure'].includes(status.state) ? status.last_output_excerpt : null);
  const summaryBits = [
    `CCP job ${jobId} for Kanban task ${taskId || '(unknown)'}`,
    `state=${result?.state || status.state}`,
    result?.pr_url ? `PR=${result.pr_url}` : null,
    result?.commit ? `commit=${result.commit}` : null,
    verification ? `verified=${verification}` : null,
    blocker ? `blocker=${blocker}` : null,
  ].filter(Boolean);

  return {
    ok: true,
    terminal,
    kanban: {
      task_id: taskId || null,
      source_transport: packet.metadata?.source_transport || packet.source,
    },
    ccp: {
      job_id: jobId,
      status_path: statusPath(jobId),
      packet_path: packetPath(jobId),
      result_path: resultPath(jobId),
    },
    status,
    packet,
    result,
    handoff: {
      summary: summaryBits.join(' | '),
      block_reason: blocker || null,
      metadata: {
        ccp_job_id: jobId,
        ccp_state: result?.state || status.state,
        ccp_commit: result?.commit || null,
        ccp_branch: result?.branch || null,
        ccp_pr_url: result?.pr_url || null,
        ccp_prod: result?.prod || null,
        tests_or_verification: verification,
        ccp_blocker: blocker || null,
        ccp_result_path: resultPath(jobId),
        ccp_status_path: statusPath(jobId),
      },
    },
  };
}

function readJsonFromStdin(): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => { data += chunk; });
    process.stdin.on('end', () => {
      try { resolve(JSON.parse(data || '{}')); } catch (error) { reject(error); }
    });
    process.stdin.on('error', reject);
  });
}

module.exports = {
  buildKanbanJobPacket,
  submitKanbanJob,
  serializeKanbanJobResult,
  kanbanJobId,
  readJsonFromStdin,
};

export {
  buildKanbanJobPacket,
  submitKanbanJob,
  serializeKanbanJobResult,
  kanbanJobId,
  readJsonFromStdin,
};
