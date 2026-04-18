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
  validation?: ValidationConfig;
  /**
   * Phase 1 (PR A): default coding agent for jobs targeting this repo. When
   * unset, falls back to CCP_AGENT, then the built-in 'claude-code' driver.
   * Known values: 'claude-code' | 'claude'. Additional drivers (e.g. 'codex')
   * slot in via the agents registry in follow-up PRs.
   */
  agent?: string;
  /**
   * Phase 1 (PR B, reserved field): if set, the supervisor may route jobs
   * to this agent when the primary agent's circuit breaker is open.
   * Ignored in PR A (no fallback orchestration is wired yet).
   */
  agentFallback?: string;
  /**
   * Phase 5a: path to a per-repo memory/context file that is prepended
   * to every worker prompt for this repo. Persistent project knowledge
   * — conventions, architectural notes, known pitfalls, "don't touch X"
   * warnings — lives here so operators don't have to restate them in
   * every Linear ticket.
   *
   * Accepted forms:
   *   - absolute path (e.g. "/srv/ccp/memory/my-app.md")
   *   - path relative to the repo checkout (e.g. "docs/ccp-memory.md")
   *
   * When unset, the loader looks for `.ccp/memory.md` at the repo root.
   * Missing files are silently ignored (not an error — just means no
   * memory for this repo yet). Content is capped at 16KB; anything
   * beyond that is truncated with a visible marker so operators notice
   * and split the file up.
   */
  memoryFile?: string;
  /**
   * Phase 3: when true, each job runs in its own `git worktree` instead of
   * the canonical `localPath` checkout. The worktree lives under
   *   <CCP_ROOT>/worktrees/<mapping.key>/<job_id>
   * and is destroyed when the job finalises. Opt-in because it changes
   * the on-disk shape of the repo (two checkouts instead of one) and
   * downstream finalize steps must cope with a path that isn't
   * `localPath`. When false (default), jobs use `localPath` directly —
   * same behavior as before Phase 3.
   */
  worktree?: boolean;
  /**
   * Phase 3: max number of jobs the supervisor will run concurrently
   * against this repo. Default 1 (serial, matches pre-Phase-3 behavior).
   * Values > 1 only take effect when `worktree: true` — otherwise the
   * worktrees would collide on the single `localPath` checkout.
   */
  parallelJobs?: number;
  /**
   * Phase 5b: optional pre-worker planning pass. When `enabled: true`,
   * the supervisor runs a short planning prompt through the resolved
   * agent before dispatching the main worker, then injects the plan
   * into the worker's prompt. Opt-in per repo because the pass costs
   * an extra round-trip (~1 planning prompt + 1 completion) per job.
   * Skipped automatically for remediation jobs and branch-continuation
   * jobs — they already have explicit feedback and a plan would be
   * redundant.
   */
  planner?: PlannerConfig;
  /**
   * Phase 4 (PR B): optional HTTP smoke test against the PR's preview
   * deployment URL. When `enabled: true`, after the pr-watcher resolves
   * the preview URL the supervisor sends a GET to `url + path`, asserts
   * the response status is in `expectStatus` (default `[200]`), and
   * optionally matches a `<title>` regex. Informational in this PR —
   * failures are logged and persisted but don't gate the job state.
   *
   * Opt-in per repo: there's no universal "is this app healthy" probe,
   * so the repo owner decides whether the default `GET /` returns
   * something sensible.
   */
  smoke?: SmokeConfig;
}

/**
 * Phase 4 (PR B): per-repo smoke-test configuration. Kept as its own type
 * so later PRs can extend it (Playwright spec path, auth header support,
 * multi-URL checks) without churning `RepoMapping`.
 */
export interface SmokeConfig {
  /** If false or omitted, the smoke step is skipped. Default: false. */
  enabled?: boolean;
  /**
   * URL path to probe. Default: `/`. Joined to the preview URL so a repo
   * with a healthcheck at `/api/health` sets `path: '/api/health'`.
   */
  path?: string;
  /**
   * Acceptable HTTP status codes. Default: `[200]`. Sites that redirect
   * the root to a login page can set `[200, 302]`.
   */
  expectStatus?: number[];
  /**
   * Optional `<title>` regex. When set, the response body must contain a
   * `<title>` element whose content matches this pattern. Applied as
   * `new RegExp(titleRegex, 'i')`.
   */
  titleRegex?: string;
  /** Per-request timeout. Default: 15 (15 seconds). */
  timeoutSec?: number;
  /** User-Agent header. Default: `ccp-smoke/0.1`. */
  userAgent?: string;
}

/**
 * Phase 4 (PR B): smoke-test result, persisted on
 * `status.integrations.smoke` and mirrored onto `JobResult.smoke`.
 */
export interface SmokeResult {
  /** Whether the smoke passed (status + title regex both OK). */
  ok: boolean;
  /** The URL that was probed (preview URL + configured path). */
  url: string;
  /** HTTP status code, when the request reached the server. */
  status?: number;
  /** Extracted `<title>` text, when present and parseable. */
  title?: string | null;
  /** Wall-clock duration of the GET request. */
  durationMs: number;
  /** ISO timestamp of completion, for dashboard display. */
  finishedAt: string;
  /**
   * When `ok: false`, describes which assertion failed.
   * `kind: 'timeout'`   → the request exceeded `timeoutSec`.
   * `kind: 'network'`   → DNS / TCP / TLS / socket error before response.
   * `kind: 'status'`    → status code not in `expectStatus`.
   * `kind: 'title'`     → body did not match `titleRegex`.
   * `kind: 'skipped'`   → smoke config disabled or preview URL missing.
   * `kind: 'unknown'`   → catch-all for unexpected exceptions.
   */
  failure?: {
    kind: 'timeout' | 'network' | 'status' | 'title' | 'skipped' | 'unknown';
    message: string;
    /** First N bytes of the response body (when available). */
    bodyExcerpt?: string;
  };
}

/**
 * Phase 5b: per-repo planner configuration. Kept as its own type so
 * future fields (agent override, prompt template path, etc.) can be
 * added without churning `RepoMapping`.
 */
export interface PlannerConfig {
  /** If false or omitted, the planner step is skipped. Default: false. */
  enabled?: boolean;
  /**
   * Per-planner-pass timeout. Default: 300 (5 minutes). The planner is
   * run synchronously on the supervisor host so a runaway agent would
   * stall the entire dispatch loop; keep this tight.
   */
  timeoutSec?: number;
}

// ── Validation ──

/** A single post-worker validation step (typecheck, test, build, etc.). */
export interface ValidationStep {
  /** Short identifier shown in dashboard/Discord (e.g. 'typecheck', 'test'). */
  name: string;
  /** Shell command run via `sh -lc` from the repo root. */
  cmd: string;
  /** Per-step timeout. Default: 600 (10 min). */
  timeoutSec?: number;
  /** If false, step failure does NOT fail overall validation. Default: true. */
  required?: boolean;
  /** Extra env vars to inject into this step only. */
  env?: Record<string, string>;
}

export interface ValidationConfig {
  /** If false, skip validation for this repo entirely. Default: true when steps present. */
  enabled?: boolean;
  /**
   * Phase 2b: when true, a failing required step promotes the job to `blocked`
   * with `blocker_type: 'validation-failed'` and spawns a `__valfix` remediation
   * job. Default: false (Phase 2a behavior — informational only).
   *
   * Can be overridden globally with CCP_VALIDATION_GATE=true|false.
   */
  gate?: boolean;
  steps: ValidationStep[];
}

export interface ValidationStepResult {
  name: string;
  cmd: string;
  required: boolean;
  ok: boolean;
  /** If true, step was not executed (e.g. earlier required step failed & fail-fast, or disabled). */
  skipped?: boolean;
  /** If true, step was killed by the timeout. */
  timedOut?: boolean;
  exitCode: number | null;
  durationMs: number;
  /** Trailing excerpt of stdout (for diagnostics in result.json / dashboard). */
  stdoutExcerpt: string;
  stderrExcerpt: string;
}

export interface ValidationReport {
  /** true iff every required step exited 0 (non-required failures ignored). */
  ok: boolean;
  /** true if validation was not executed for this job (no config, no commit, etc.). */
  skipped?: boolean;
  /** Populated when skipped=true. */
  reason?: string;
  steps: ValidationStepResult[];
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  /** Echo the git commit the validation was run against, for reproducibility. */
  commit?: string | null;
  branch?: string | null;
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
  reviewComments?: ReviewComment[];
  working_branch?: string | null;
  base_branch?: string | null;
  metadata?: Record<string, unknown>;
  created_at?: string;
  nightly?: NightlyConfig;
  /**
   * Phase 1 (PR A): per-job override of the coding agent. Highest precedence
   * in the resolver. Set via Linear labels, Discord command, or dashboard.
   */
  agent?: string;
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
  /**
   * Phase 4 (PR A): mirrors `PRReviewResult.previewUrl`. Persisted by the
   * pr-watcher cycle AND by `finalizeJob`'s spread of `PRReviewResult`
   * into the integration record. Null when no preview is detected yet.
   */
  previewUrl?: string | null;
}

export interface JobIntegrations {
  linear?: LinearIntegration;
  prReview?: PrReviewIntegration;
  remediation?: RemediationResult;
  /** Phase 2b: record of the __valfix remediation spawn attempt (if any). */
  validationRemediation?: RemediationResult;
  /**
   * Phase 4 (PR B): most recent smoke-test result for this job's preview
   * URL. Updated each pr-watcher cycle once the preview URL is known.
   * Null when smoke is disabled for the repo or no preview has been
   * detected yet.
   */
  smoke?: SmokeResult;
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
  /** Resolved agent driver name for this job (set at dispatch time). */
  agent?: string;
  /**
   * Phase 3: filesystem path the job is actually running against. When
   * the repo is worktree-enabled this is the worktree path (`<ROOT>/
   * worktrees/<mapping.key>/<job_id>`); otherwise it's absent and
   * `packet.repo` is authoritative. Stored on status so finalizeJob /
   * validator / cleanup can all find the right working tree after
   * the supervisor restarts.
   */
  workdir?: string | null;
  notifications?: JobNotifications;
  integrations?: JobIntegrations;
  discord_thread_id?: string | null;
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
  /**
   * Phase 4 (PR A): PR's live preview deployment URL (extracted from the
   * Vercel bot comment or Vercel checks). Populated by the pr-watcher cycle
   * when a preview is detected; null when no preview exists yet. Mirrors
   * `integrations.prReview.previewUrl` on the status so downstream tools can
   * discover it without loading status.json.
   */
  preview_url?: string | null;
  /**
   * Phase 4 (PR B): most recent smoke-test result for this job's preview
   * URL. Populated by the pr-watcher cycle when smoke is enabled for the
   * repo AND a preview URL has been detected; absent otherwise. Mirrors
   * `integrations.smoke` so downstream tools can find it on the stable
   * per-job record without loading status.json.
   */
  smoke?: SmokeResult;
  prod: string;
  verified: string;
  blocker: string | null;
  blocker_type?: string | null;
  failed_checks?: CheckInfo[];
  risk?: string | null;
  summary?: string | null;
  addressedComments?: AddressedComment[];
  tmux_session?: string | null;
  worker_exit_code?: number;
  proof?: RepoProof;
  validation?: ValidationReport;
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
  /**
   * Phase 4 (PR A): the PR's live preview deployment URL (currently extracted
   * from Vercel bot comments + Vercel checks). Null when the PR has no
   * preview deployment yet, or the extractor couldn't recognise one.
   * Informational in this PR; later Phase 4 PRs will feed this URL into a
   * browser smoke runner.
   */
  previewUrl?: string | null;
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

// ── Review comments ──

export interface ReviewComment {
  commentId: number;
  threadId?: number | null;
  path: string;
  line: number | null;
  side?: string;
  body: string;
  author?: string;
  inReplyToId?: number | null;
}

export interface AddressedComment {
  commentId: number;
  status: 'fixed' | 'not_fixed' | 'partial';
  explanation: string;
  commitSha?: string | null;
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
  /**
   * Resolved coding-agent binary path. Named `claude` for backward compat
   * with existing callers; the field may in fact point to a different
   * agent's binary once non-claude drivers are registered.
   */
  claude: string;
  /** Phase 1 (PR A): which agent driver resolved for this job. */
  agent?: string;
  failures: string[];
  /**
   * Phase 1 (PR B): preflight wants the supervisor to defer this job to a
   * later cycle rather than marking it blocked. Set when the resolved
   * driver's circuit is open and no viable fallback exists, so we don't
   * burn quota on a known-failing agent while still letting jobs with
   * healthy agents run this cycle. Mutually exclusive with ok=false +
   * failures.
   */
  deferred?: boolean;
  deferReason?: string;
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
