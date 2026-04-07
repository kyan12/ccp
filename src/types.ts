import type { SpawnSyncReturns } from 'child_process';

// ── Run result (spawnSync wrapper) ──

export interface RunResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

// ── Repo mapping ──

export interface RepoMapping {
  key: string;
  ownerRepo?: string;
  gitUrl?: string;
  localPath: string;
  aliases?: string[];
  autoMerge?: boolean;
  mergeMethod?: 'squash' | 'merge' | 'rebase';
  linearOrg?: string;
  nightly?: NightlyConfig;
  /** Max job duration in seconds before auto-interrupt (default: 1800 = 30 min) */
  maxJobDurationSec?: number;
  /** Max conversation turns for the worker (default: 200 = Claude CLI default) */
  maxTurns?: number;
}

export interface NightlyConfig {
  enabled?: boolean;
  branch?: string;
  timeoutSec?: number;
}

export interface ReposConfig {
  mappings: RepoMapping[];
}

// ── Job packet ──

export interface JobPacket {
  job_id: string;
  ticket_id: string | null;
  repo: string | null;
  repoKey?: string | null;
  ownerRepo?: string | null;
  gitUrl?: string | null;
  repoResolved?: boolean;
  goal: string;
  source: string;
  kind: string;
  label: string;
  acceptance_criteria?: string[];
  constraints?: string[];
  verification_steps?: string[];
  review_feedback?: string[];
  working_branch?: string | null;
  base_branch?: string | null;
  metadata?: Record<string, unknown>;
  created_at?: string;
  nightly?: NightlyConfig;
  /** How many times this job has been retried (0 = original run) */
  retryCount?: number;
  /** Max retries allowed for transient failures (default: 1) */
  maxRetries?: number;
  /** Job priority: 1=urgent, 2=high, 3=normal (default), 4=low */
  priority?: number;
}

// ── Job status ──

export interface JobNotifications {
  start: boolean;
  final: boolean;
}

export interface LinearIntegration {
  attempted_at: string | null;
  ok: boolean;
  skipped: boolean;
  reason: string | null;
  issueId?: string | null;
  identifier?: string | null;
  url?: string | null;
  state?: string | null;
}

export interface PrReviewIntegration {
  ok: boolean;
  skipped: boolean;
  disposition?: string;
  blockerType?: string;
  blockers?: string[];
  failedChecks?: CheckInfo[];
  merged?: boolean;
  autoMergeEnabled?: boolean;
  watchedAt?: string;
  reason?: string;
}

export interface JobIntegrations {
  linear?: LinearIntegration;
  prReview?: PrReviewIntegration;
  remediation?: RemediationResult;
}

export interface JobStatus {
  job_id: string;
  ticket_id: string | null;
  repo: string | null;
  state: string;
  started_at: string | null;
  updated_at: string;
  elapsed_sec: number;
  tmux_session: string | null;
  last_heartbeat_at: string | null;
  last_output_excerpt: string;
  exit_code: number | null;
  notifications?: JobNotifications;
  integrations?: JobIntegrations;
  discord_thread_id?: string | null;
  /** Path to git worktree used by this job (cleaned up on finalize) */
  worktree_path?: string | null;
}

// ── Job result ──

export interface RepoProof {
  repoExists: boolean;
  git: boolean;
  dirty: boolean;
  commitExists: boolean;
  branch: string | null;
  pushed: boolean | null;
  upstream: string | null;
  ahead: number | null;
  behind: number | null;
}

export interface JobResult {
  job_id: string;
  state: string;
  commit: string;
  branch?: string;
  pushed?: string;
  pr_url?: string | null;
  prod: string;
  verified: string;
  blocker: string | null;
  blocker_type?: string | null;
  failed_checks?: CheckInfo[];
  risk?: string | null;
  summary?: string | null;
  tmux_session?: string | null;
  worker_exit_code?: number;
  proof?: RepoProof;
  updated_at: string;
}

// ── PR review ──

export interface CheckInfo {
  name: string;
  state: string;
  url: string | null;
}

export interface ChecksSummary {
  checks: CheckInfo[];
  hasPending: boolean;
  hasFailure: boolean;
  hasSuccess: boolean;
}

export interface PRClassification {
  disposition: string;
  blockers: string[];
  blockerType: string;
  failedChecks: CheckInfo[];
  pendingChecks: CheckInfo[];
  mergeable: string;
  reviewDecision: string;
  checks: ChecksSummary;
}

export interface PRReviewResult {
  ok: boolean;
  prUrl: string;
  ownerRepo: string;
  number: number;
  title: string;
  headRefName: string;
  baseRefName: string;
  mergeable: string;
  reviewDecision: string;
  disposition: string;
  blockers: string[];
  blockerType: string;
  failedChecks: CheckInfo[];
  pendingChecks: CheckInfo[];
  checks: CheckInfo[];
  merged: boolean;
  autoMergeEnabled: boolean;
}

// ── Intake ──

export interface NormalizedIncident {
  source: string;
  kind: string;
  label: string;
  title: string;
  summary: string;
  repo?: string;
  metadata: Record<string, unknown>;
}

export interface IntakePayload {
  source?: string;
  kind?: string;
  label?: string;
  title?: string;
  summary?: string;
  description?: string;
  repo?: string;
  repoKey?: string;
  repoName?: string;
  goal?: string;
  ticket_id?: string;
  constraints?: string[];
  acceptance_criteria?: string[];
  verification_steps?: string[];
  metadata?: Record<string, unknown>;
  name?: string;
  error?: string;
  message?: string;
  data?: Record<string, unknown>;
  action?: string;
  issue?: Record<string, unknown>;
  culprit?: string;
  issueTitle?: string;
  project?: string;
  [key: string]: unknown;
}

// ── Linear ──

export interface LinearConfig {
  teamId?: string;
  apiKeyEnv?: string;
  projects?: Record<string, { id: string; name: string }>;
  defaultStates?: Record<string, string>;
}

export interface LinearIssue {
  id: string;
  identifier: string;
  title: string;
  url: string;
  project?: { id: string; name: string } | null;
  team?: { id: string; key: string; name: string } | null;
}

export interface LinearJobLink {
  issueId: string;
  identifier: string;
  url: string;
  projectName: string | null;
}

export interface LinearSyncResult {
  ok: boolean;
  skipped?: boolean;
  reason?: string;
  issueId?: string;
  identifier?: string;
  url?: string;
  state?: string;
  projectName?: string | null;
}

// ── Discord ──

export interface DiscordMessageResult {
  ok: boolean;
  stdout: string;
  stderr: string;
  messageId: string | null;
}

export interface DiscordThreadResult {
  ok: boolean;
  threadId: string | null;
  stdout: string;
  stderr: string;
}

// ── Remediation ──

export interface RemediationResult {
  ok: boolean;
  skipped: boolean;
  reason?: string;
  job_id?: string;
  branch?: string | null;
  blockerType?: string;
}

// ── Supervisor ──

export interface SupervisorCycleSummary {
  started_at: string;
  finished_at?: string;
  max_concurrent: number;
  linearDispatched: unknown[];
  reconciled: unknown[];
  started: unknown[];
  skipped: unknown[];
  errors: unknown[];
  prWatcher?: unknown;
  archived?: string[];
  snapshot?: unknown;
}

// ── Preflight ──

export interface PreflightResult {
  ok: boolean;
  tmux: string;
  claude: string;
  failures: string[];
  environment: Record<string, unknown>;
}

// ── 1Password config ──

export interface OnePasswordConfig {
  vault: string;
  items: Record<string, { itemId: string; field?: string }>;
}

// ── Intake runner ──

export interface IntakeToLinearResult {
  ok: boolean;
  issueId: string;
  identifier: string;
  url: string;
  project: string | null;
  state: string;
  packet: JobPacket;
  dispatch: unknown;
  supervisor: unknown;
}

// ── PR watcher ──

export interface PrWatcherCycleResult {
  ok: boolean;
  skipped?: boolean;
  reason?: string;
  watchedCount?: number;
  actions?: unknown[];
}

// ── Linear dispatch ──

export interface DispatchState {
  dispatchedIssueIds: Record<string, { identifier: string; job_id: string; at: string }>;
  updatedAt: string | null;
}

export interface DispatchResult {
  identifier: string;
  skipped?: boolean;
  reason?: string;
  job_id?: string;
  queued?: boolean;
}
