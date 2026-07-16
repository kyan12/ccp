import fs = require('fs');
import path = require('path');
import type { JobPacket, JobResult, JobStatus } from '../types';
const { createJobIfAbsent, loadStatus, readJson, packetPath, resultPath, statusPath } = require('./jobs');
const { buildIncidentPacket } = require('./intake-runner');

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

const SUCCESSFUL_KANBAN_COMPLETE_STATES = new Set(['done', 'verified']);
const BLOCKING_KANBAN_STATES = new Set(['blocked', 'failed', 'dirty-repo', 'harness-failure']);
const LEGACY_LINEAR_MIGRATION_MARKER = 'Imported from Linear for local Hermes execution.';
const LEGACY_LINEAR_MIGRATION_VALUE = 'linear-migration';
type KanbanHandoffAction = 'complete' | 'block' | 'wait';

function isSuccessfulNoOp(status: JobStatus, result: JobResult | null): boolean {
  const statusState = String(status?.state || '');
  if (statusState !== 'no-op') return false;
  if (status?.exit_code !== 0) return false;
  if (typeof result?.worker_exit_code === 'number' && result.worker_exit_code !== 0) return false;
  return true;
}

function kanbanHandoffAction(status: JobStatus, result: JobResult | null, blocker: string | null): KanbanHandoffAction {
  const statusState = String(status?.state || '');
  const resultState = String(result?.state || '');
  if (blocker || BLOCKING_KANBAN_STATES.has(statusState) || BLOCKING_KANBAN_STATES.has(resultState)) return 'block';
  if (SUCCESSFUL_KANBAN_COMPLETE_STATES.has(statusState) || isSuccessfulNoOp(status, result)) return 'complete';
  return 'wait';
}

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


function metadataValue(input: KanbanSubmitInput, key: string): string {
  return String((input.metadata || {})[key] || '').trim().toLowerCase();
}

function assertNotLegacyLinearMigration(input: KanbanSubmitInput): void {
  const text = [input.body, input.worker_context].map((value) => String(value || '')).join('\n');
  const createdBy = metadataValue(input, 'created_by');
  const source = metadataValue(input, 'source');
  if (
    text.includes(LEGACY_LINEAR_MIGRATION_MARKER) ||
    createdBy === LEGACY_LINEAR_MIGRATION_VALUE ||
    source === LEGACY_LINEAR_MIGRATION_VALUE
  ) {
    throw new Error(
      'Blocked legacy Linear migration envelope: archive/recreate this Kanban card natively. ' +
      'Linear migration history is not task context and must not be executed through CCP.'
    );
  }
}

function stripLegacyLinearCommentsSection(value: unknown): string {
  const text = String(value || '');
  if (!text) return '';
  return text
    .replace(/(^|\n)#{1,6}\s*Linear comments\s*\n[\s\S]*?(?=\n#{1,6}\s|$)/gi, '$1')
    .trim();
}

function containsLegacyLinearMigrationMarker(value: unknown): boolean {
  return String(value || '').includes(LEGACY_LINEAR_MIGRATION_MARKER);
}

function isLegacyLinearComment(comment: unknown): boolean {
  if (comment == null) return false;
  if (typeof comment === 'string') {
    return /^\s*(?:#{1,6}\s*)?Linear comments\b/i.test(comment) || containsLegacyLinearMigrationMarker(comment);
  }
  if (typeof comment !== 'object') return false;
  const record = comment as Record<string, unknown>;
  for (const key of ['heading', 'title', 'label', 'source', 'created_by']) {
    const value = String(record[key] || '').trim().toLowerCase();
    if (value === 'linear comments' || value === LEGACY_LINEAR_MIGRATION_VALUE) return true;
  }
  for (const key of ['body', 'text', 'content']) {
    if (containsLegacyLinearMigrationMarker(record[key])) return true;
  }
  return false;
}

function sanitizeKanbanComments(comments: unknown): unknown[] {
  if (!Array.isArray(comments)) return [];
  return comments.filter((comment) => !isLegacyLinearComment(comment));
}

function buildKanbanJobPacket(input: KanbanSubmitInput): JobPacket {
  assertNotLegacyLinearMigration(input);
  const taskId = String(input.task_id || '').trim();
  if (!taskId) throw new Error('Kanban task_id is required');

  const body = stripLegacyLinearCommentsSection(input.body || input.worker_context || '');
  const workerContext = stripLegacyLinearCommentsSection(input.worker_context || '');
  const kanbanBody = stripLegacyLinearCommentsSection(input.body || '');
  const acceptance = normalizeStringArray(input.acceptance_criteria);
  const verification = normalizeStringArray(input.verification_steps);
  const constraints = normalizeStringArray(input.constraints);
  const basePacket: JobPacket = buildIncidentPacket('manual', {
    source: 'hermes-kanban',
    kind: input.kind || 'task',
    label: input.label || 'kanban',
    title: input.title || input.goal || `Hermes Kanban task ${taskId}`,
    summary: body || input.title || `Hermes Kanban task ${taskId}`,
    description: body,
    repo: input.repo || input.repoKey || input.ownerRepo || undefined,
    repoKey: input.repoKey || undefined,
    ownerRepo: input.ownerRepo || undefined,
    gitUrl: input.gitUrl || undefined,
    goal: input.goal || input.title || `Hermes Kanban task ${taskId}`,
    acceptance_criteria: acceptance.length ? acceptance : (body ? [body] : [`Complete Hermes Kanban task ${taskId}`]),
    verification_steps: verification,
    constraints,
    metadata: input.metadata || {},
  });

  const metadata: Record<string, unknown> = {
    ...(basePacket.metadata || {}),
    ...(input.metadata || {}),
    source_transport: 'hermes-kanban',
    hermes_kanban_task_id: taskId,
    kanban_title: input.title || null,
    kanban_body: kanbanBody || null,
    kanban_worker_context: workerContext || null,
    kanban_comments: sanitizeKanbanComments(input.comments),
  };

  const packet: JobPacket = {
    ...basePacket,
    job_id: kanbanJobId(taskId),
    ticket_id: taskId,
    repo: basePacket.repo || input.repo || null,
    repoKey: basePacket.repoKey || input.repoKey || null,
    ownerRepo: basePacket.ownerRepo || input.ownerRepo || null,
    gitUrl: basePacket.gitUrl || input.gitUrl || null,
    repoResolved: !!basePacket.repoResolved,
    goal: input.goal || input.title || basePacket.goal || `Hermes Kanban task ${taskId}`,
    source: 'hermes-kanban',
    kind: input.kind || basePacket.kind || 'task',
    label: input.label || basePacket.label || 'kanban',
    acceptance_criteria: acceptance.length ? acceptance : (basePacket.acceptance_criteria || (body ? [body] : [])),
    constraints: constraints.length ? constraints : (basePacket.constraints || []),
    verification_steps: verification.length ? verification : (basePacket.verification_steps || []),
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
  const created = createJobIfAbsent(packet);
  return {
    ok: true,
    job_id: created.jobId,
    state: created.status.state,
    created: created.created,
    existing: !created.created,
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
  const verification = result?.verified || status.last_output_excerpt || 'not yet';
  const blocker = result?.blocker || (BLOCKING_KANBAN_STATES.has(status.state) ? status.last_output_excerpt : null);
  const action = kanbanHandoffAction(status, result, blocker || null);
  const terminal = action !== 'wait';
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
    evidence: {
      repository: {
        repo: packet.repo || null,
        repoKey: packet.repoKey || null,
        ownerRepo: packet.ownerRepo || null,
        gitUrl: packet.gitUrl || null,
        workdir: status.workdir || packet.repo || null,
        branch: result?.branch || null,
        commit: result?.commit || null,
        pushed: result?.pushed || null,
        proof: result?.proof || null,
      },
      tests: {
        verification,
        validation: result?.validation || null,
        failed_checks: result?.failed_checks || [],
        smoke: result?.smoke || status.integrations?.smoke || null,
      },
      pr: {
        url: result?.pr_url || null,
        preview_url: result?.preview_url || null,
        review: status.integrations?.prReview || null,
      },
      merge: {
        state: result?.state || status.state,
        auto_remediation: result?.autoRemediation || status.integrations?.autoRemediation || null,
      },
      deploy: {
        prod: result?.prod || null,
        preview_url: result?.preview_url || null,
        smoke: result?.smoke || status.integrations?.smoke || null,
      },
      logs: {
        worker_log_path: path.join(path.dirname(statusPath(jobId)), 'worker.log'),
        last_output_excerpt: status.last_output_excerpt || '',
      },
      human_decision: status.integrations?.decision || null,
    },
    handoff: {
      action,
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
