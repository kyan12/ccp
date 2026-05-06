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
  /**
   * Canonical production URL for this repo's deployed application.
   * Used by smoke tests (as the base URL when no preview is available),
   * handoff callbacks (as the deploy_url artifact), and dashboard links.
   * Example: "https://g8events.com"
   */
  productionUrl?: string;
  /**
   * Default webhook callback URL for job completion notifications.
   * When a job for this repo completes and no per-job callback_url is
   * set on the packet, CCP POSTs a signed status payload here.
   * Example: "https://seo.proteusx.ai/api/fixes/webhook"
   */
  callbackUrl?: string;
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
   * Human decision policy for ambiguous/high-impact agent choices. Controls
   * whether workers should continue with their own judgment or stop with a
   * structured DecisionRequest for an operator to answer.
   */
  decisionPolicy?: DecisionPolicyConfig;
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
   * Phase 5c: optional LLM-driven compaction of the repo memory file.
   * When the memory file exceeds `maxBytes` and `enabled: true`, the
   * supervisor asks the configured agent (default: repo's resolved
   * agent) to summarize the file down to roughly `targetBytes` and
   * overwrites the file in place — archiving the pre-compaction
   * content to `.ccp/memory.archive/<ISO>.md` first so nothing is
   * lost. Opt-in per repo because compaction costs an extra LLM
   * round-trip and rewrites a file that lives in the repo checkout.
   */
  memoryCompaction?: MemoryCompactionConfig;
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
  /**
   * Phase 6a: optional watchdog that auto-retries certain `blocked` jobs
   * after a cool-down window. When a job lands in `blocked` with a
   * retry-eligible `blocker_type` and the configured `retryAfterSec`
   * has elapsed, the supervisor spawns a `__autoretry<N>` child job on
   * the same branch with a refined prompt. Bounded by `maxRetries` so a
   * genuinely stuck job never loops forever.
   *
   * Opt-in per repo. Default disabled — no repo auto-enables retries.
   * The existing one-shot `__valfix` / `__deployfix` / `__reviewfix`
   * remediations still fire immediately; this watchdog is the fallback
   * when those first-pass remediations themselves land in `blocked`.
   */
  autoUnblock?: AutoUnblockConfig;
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
   * Phase 4 (PR D): when true, a failing smoke result promotes the job to
   * `blocked` with `blocker_type: 'smoke-failed'` and spawns a `__deployfix`
   * remediation job. Default: false (Phase 4 PR B/C behavior —
   * informational only).
   *
   * Can be overridden globally with CCP_SMOKE_GATE=true|false. Any falsy
   * env value hard-disables gating across every repo; any truthy env
   * value forces gating on even for repos that have `gate: false`. When
   * the env var is unset (or ambiguous), the per-repo flag wins.
   */
  gate?: boolean;
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
  /**
   * Phase 4 (PR C): which runner to use. `http` is the dependency-free
   * fetch-based runner from PR B. `playwright` spawns a headless browser
   * in a subprocess and can evaluate JS assertions, wait for full page
   * load strategies, and capture a screenshot on failure. Default: `http`.
   *
   * Picking `playwright` requires `npm i -D playwright` on the supervisor
   * host AND `npx playwright install <browser>`. When the package is
   * missing the runner returns a `kind: 'unknown'` result with a clear
   * install-instructions message — it does NOT crash the watcher cycle.
   */
  runner?: 'http' | 'playwright' | 'agent-browser';
  /**
   * Playwright-runner-specific options. Ignored when `runner === 'http'`.
   * Kept in its own sub-object so the flat HTTP-runner config stays
   * forward-compatible.
   */
  playwright?: PlaywrightSmokeConfig;
  /** Agent-browser-runner-specific options. Ignored unless runner === 'agent-browser'. */
  agentBrowser?: AgentBrowserSmokeConfig;
}

export interface AgentBrowserSmokeArtifactsConfig {
  /** Capture a final PNG screenshot path from agent-browser. Default: true. */
  screenshot?: boolean;
  /** Persist browser console output JSON. Default: true. */
  console?: boolean;
  /** Persist browser errors JSON. Default: true. */
  errors?: boolean;
  /** Persist network HAR when supported/configured. Default: false. */
  har?: boolean;
  /** Persist browser trace when supported/configured. Default: false. */
  trace?: boolean;
}

export interface AgentBrowserSmokeConfig {
  /** CLI binary to execute. Default: agent-browser. */
  binary?: string;
  /** Capture accessibility snapshot evidence. Default: true. */
  snapshot?: boolean;
  /** Evidence artifacts to collect after navigation. */
  artifacts?: AgentBrowserSmokeArtifactsConfig;
  /** Extra CLI arguments appended to each agent-browser call. */
  extraArgs?: string[];
}


/**
 * Phase 4 (PR C): Playwright-runner-specific options. All fields
 * optional; sensible defaults are applied by `resolvePlaywrightConfig`.
 */
export interface PlaywrightSmokeConfig {
  /** Browser engine. Default: `chromium`. */
  browser?: 'chromium' | 'firefox' | 'webkit';
  /**
   * Which load event to wait for before running assertions.
   * Default: `load` (matches Playwright's own default).
   */
  waitUntil?: 'load' | 'domcontentloaded' | 'networkidle' | 'commit';
  /** Viewport for the page. Default: 1280x800. */
  viewport?: { width: number; height: number };
  /**
   * Optional JavaScript expression evaluated inside `page.evaluate()`.
   * Must return truthy for the smoke to pass; falsy returns produce a
   * `kind: 'title'` failure (reused for "assertion failure" so we
   * don't churn the `SmokeResult.failure.kind` enum in this PR).
   *
   * Example: `"!document.body.innerText.includes('Application error')"`
   */
  assertExpression?: string;
  /**
   * When true, the runner captures a PNG of the page on any failure
   * and writes it to `jobs/<id>/smoke-failure.png`. Default: true.
   */
  screenshotOnFailure?: boolean;
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
  artifacts?: SmokeArtifacts;
  failure?: {
    kind: 'timeout' | 'network' | 'status' | 'title' | 'skipped' | 'unknown';
    message: string;
    /** First N bytes of the response body (when available). */
    bodyExcerpt?: string;
    /**
     * Phase 4 PR C: absolute path to a failure screenshot, produced by
     * the Playwright runner when `screenshotOnFailure` is true and the
     * supervisor passed `playwrightOptions.jobId`. Never populated by
     * the HTTP runner.
     */
    screenshotPath?: string;
  };
}

export interface SmokeArtifacts {
  screenshotPath?: string;
  consolePath?: string;
  errorsPath?: string;
  harPath?: string;
  tracePath?: string;
  snapshotPath?: string;
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

/**
 * Phase 5c: LLM-driven memory-file compaction. When the memory file for
 * a repo grows past `maxBytes`, the supervisor asks an agent to produce
 * a condensed version and overwrites the file (archiving the original).
 * Opt-in per repo.
 */
export interface MemoryCompactionConfig {
  /** If false or omitted, compaction never runs. Default: false. */
  enabled?: boolean;
  /**
   * Trigger threshold in bytes. When the memory file's size exceeds this
   * value, compaction is scheduled on the next dispatch. Default: 16384
   * (16KB — same as MAX_MEMORY_BYTES, so compaction fires right when the
   * loader would start truncating).
   */
  maxBytes?: number;
  /**
   * Target size for the compacted output in bytes. The compactor asks the
   * agent to aim for this budget; real output may overshoot slightly, so
   * the caller rejects output larger than `maxBytes` and keeps the
   * original file. Default: 8192 (roughly half of maxBytes, leaving
   * plenty of headroom before the next compaction cycle).
   */
  targetBytes?: number;
  /**
   * Per-compaction subprocess timeout. Default: 300 (5 minutes).
   * Compaction runs synchronously inside the dispatch path; keep this
   * tight so a hung agent can't stall the loop.
   */
  timeoutSec?: number;
  /**
   * Which agent to use for compaction. When unset, the repo's resolved
   * primary agent (claude-code / codex) handles its own compaction. Set
   * this explicitly if you want every repo compacted with e.g. Claude
   * Haiku regardless of which agent does the main coding work.
   */
  agent?: string;
}

/**
 * Phase 6a: auto-unblock watchdog. When a job lands in `blocked` with a
 * retry-eligible `blocker_type`, the supervisor cycle re-queues it as a
 * `__autoretry<N>` child after `retryAfterSec`, up to `maxRetries` times.
 * Opt-in per repo; see `RepoMapping.autoUnblock`.
 */
export interface AutoUnblockConfig {
  /** If false or omitted, watchdog never runs. Default: false. */
  enabled?: boolean;
  /**
   * Seconds the job must have been in `blocked` (measured from the
   * status's `updated_at`) before the watchdog will spawn a retry.
   * Default: 600 (10 minutes). Prevents the watchdog from tripping
   * before the one-shot `__valfix` / `__deployfix` remediation has
   * had a chance to land its own fix.
   */
  retryAfterSec?: number;
  /**
   * Maximum number of auto-retries per original job. Default: 2, i.e.
   * 3 total attempts (original + 2 watchdog retries). Once exhausted,
   * the job stays in `blocked` and the watchdog stops touching it.
   */
  maxRetries?: number;
  /**
   * Which `blocker_type` values are eligible for auto-retry. Default:
   * `['validation-failed', 'smoke-failed', 'pr-check-failed',
   * 'ambiguity-transient']`.
   *
   * Phase 6b split the legacy catch-all `ambiguity` bucket into two:
   * - `ambiguity-operator`: worker is waiting on a human (missing
   *   credential, design decision, unclear spec, `please clarify`).
   *   NEVER put this in `eligibleTypes` — retrying without a human
   *   answer just burns tokens.
   * - `ambiguity-transient`: environmental noise (rate limits, ETIMEDOUT,
   *   HTTP 503, git lock contention). Safe to auto-retry after the
   *   cool-down; usually passes on the next attempt.
   *
   * The circuit-breaker `agent-outage` / `rate-limited` blockers are
   * also intentionally excluded (handled by the outage probe).
   */
  eligibleTypes?: string[];
  /**
   * When true AND Phase 5b planner is enabled for the repo, the
   * retry packet triggers a fresh planner pass with the prior
   * blocker's feedback as context. Default: false (cheaper — retry
   * reuses the original goal with an appended failure footer).
   */
  usePlannerRefresh?: boolean;
}

/**
 * Phase 6a: record of a single watchdog-driven retry attempt, persisted
 * on the parent job's status so operators can see every retry's reason
 * and outcome without crawling the jobs directory.
 */
export interface AutoUnblockAttempt {
  /** ISO timestamp at which the watchdog spawned the child job. */
  at: string;
  /** Child job id (parent id + `__autoretry<N>`). */
  childJobId: string;
  /** The blocker_type that triggered the retry. */
  priorBlockerType: string;
  /** The blocker detail text copied into the child's refined prompt. */
  priorBlockerDetail?: string;
  /** Attempt number (1-indexed, matches the suffix). */
  attemptNumber: number;
}

/**
 * Phase 6a: auto-unblock state tracked on the parent JobStatus.
 */
export interface AutoUnblockState {
  attempts: number;
  lastAttemptAt?: string;
  history?: AutoUnblockAttempt[];
  /**
   * True once the watchdog has hit `maxRetries` and stopped spawning
   * new retries. Flips only once per job so the "exhausted" Discord
   * ping doesn't fire on every subsequent supervisor cycle.
   */
  exhausted?: boolean;
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
  /** Per-job override for the decision policy mode. */
  decisionMode?: DecisionMode;
  /** Full per-job decision policy override. */
  decisionPolicy?: DecisionPolicyConfig;

  // ── Structured handoff fields (Hermes ↔ Code Crab) ──
  handoff_id?: string | null;
  origin?: string;
  requestor?: string;
  why_it_matters?: string;
  context_refs?: string[];
  callback_required?: boolean;
  callback_url?: string;
  writeback_required?: string[];
  /** Explicit deliverable expected from Code Crab. */
  exact_deliverable?: string;
  /**
   * How the completion result should be routed back:
   *  - 'direct': CCP fires callback straight to the requestor/origin.
   *  - 'relay':  CCP returns to Code Crab, who relays a human-readable
   *              message to the requestor via the origin channel.
   */
  completion_routing?: CompletionRouting;
}

/** Explicit routing enum — never inferred from other fields. */
export type CompletionRouting = 'direct' | 'relay';

export type DecisionMode = 'ask' | 'auto' | 'hybrid' | 'never-block';

export type DecisionTrigger =
  | 'production_risk'
  | 'destructive_action'
  | 'architecture_choice'
  | 'scope_expansion'
  | 'low_confidence'
  | 'data_migration'
  | 'auth_or_billing'
  | 'secrets_or_credentials';

export interface DecisionPolicyConfig {
  mode?: DecisionMode;
  promptOn?: DecisionTrigger[];
  confidenceThreshold?: number;
  timeoutMinutes?: number;
  defaultTimeoutAction?: 'recommended' | 'fail-closed';
}

export interface ResolvedDecisionPolicy {
  mode: DecisionMode;
  promptOn: DecisionTrigger[];
  confidenceThreshold: number;
  timeoutMinutes: number;
  defaultTimeoutAction: 'recommended' | 'fail-closed';
}

export interface DecisionOption {
  id: string;
  label: string;
  tradeoff?: string;
}

export interface DecisionRequest {
  id: string;
  job_id: string;
  question: string;
  options: DecisionOption[];
  recommended?: string;
  risk?: 'low' | 'medium' | 'high' | string;
  confidence?: number;
  reason?: string;
  created_at: string;
  status: 'pending' | 'answered' | 'auto' | 'cancelled';
  answer?: string;
  answered_at?: string;
  note?: string;
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

/**
 * PRO-583: stamped once when pr-watcher (or another reconciliation path)
 * has fired a structured Hermes handoff callback. Guarantees we don't
 * double-fire on subsequent watcher cycles. Absent on jobs that never
 * had a handoff_id or that were finalized through the regular finalizeJob
 * path (which fires the callback inline and never enters this branch).
 */
export interface HandoffCallbackIntegration {
  fired: boolean;
  at: string;
  via: 'pr-watcher' | 'finalize' | 'reconcile';
}

export interface JobIntegrations {
  linear?: LinearIntegration;
  prReview?: PrReviewIntegration;
  remediation?: RemediationResult;
  /** Phase 2b: record of the __valfix remediation spawn attempt (if any). */
  validationRemediation?: RemediationResult;
  /** PRO-583: idempotency record for handoff callbacks fired outside finalizeJob. */
  handoffCallback?: HandoffCallbackIntegration;
  /**
   * Phase 4 (PR B): most recent smoke-test result for this job's preview
   * URL. Updated each pr-watcher cycle once the preview URL is known.
   * Null when smoke is disabled for the repo or no preview has been
   * detected yet.
   */
  smoke?: SmokeResult;
  /** Current/past operator decision request for this job, if the worker paused for one. */
  decision?: DecisionRequest;
  /**
   * PRO-598: structured auto-remediation disposition mirrored on
   * status.json so the dashboard + notifiers can render it without
   * scraping prose from `blocker`. Updated by finalizeJob and
   * pr-watcher whenever they decide whether/how to enqueue a fix child.
   */
  autoRemediation?: AutoRemediationStatus;
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
  /**
   * Phase 6a: watchdog retry state. Populated only after the first
   * auto-unblock retry has been spawned for this job; absent otherwise.
   * Parent jobs accumulate history here; each child `__autoretryN`
   * job tracks its own (independent) state the same way.
   */
  autoUnblock?: AutoUnblockState;
  /**
   * Phase 6e: per-agent token / cost sample captured from the agent
   * CLI's self-report at finalize time. Absent when the CLI's output
   * format doesn't surface usage (Claude's default text `--print`) or
   * when the parser couldn't recognise any signal. See
   * `AgentDriver.parseUsage` + `docs/cost-accounting.md`.
   */
  usage?: import('./lib/agents/types').AgentUsage;
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
  /**
   * Machine-readable bucket for `blocker`. Known values:
   * - `'validation-failed'` (Phase 2b): static validator reported a
   *   required-step failure.
   * - `'smoke-failed'` (Phase 4 PR D): post-deploy smoke check failed.
   * - `'pr-check-failed'`: CI reported red on the generated PR.
   * - `'ambiguity-operator'` (Phase 6b): worker asked for human input
   *   (missing credential, design decision, "please clarify"). Never
   *   auto-retried by the Phase 6a watchdog.
   * - `'ambiguity-transient'` (Phase 6b): environmental noise (rate
   *   limit, ETIMEDOUT, HTTP 503, git lock contention). Watchdog-
   *   eligible by default.
   * - `'ambiguity'` (legacy, pre-Phase 6b): catch-all from older jobs;
   *   treated as operator-ambiguity by the watchdog for safety.
   * - `'agent-outage'` / `'rate-limited'`: handled by the outage
   *   circuit breaker; never auto-retried here.
   *
   * The classifier in `src/lib/blocker-classifier.ts` splits
   * `ambiguity` into `-operator`/`-transient` at finalize time based on
   * the `blocker` text.
   */
  blocker_type?: string | null;
  failed_checks?: CheckInfo[];
  risk?: string | null;
  summary?: string | null;
  addressedComments?: AddressedComment[];
  tmux_session?: string | null;
  worker_exit_code?: number;
  proof?: RepoProof;
  validation?: ValidationReport;
  /**
   * PRO-598: harness-failure subtype + PR/commit recovery status.
   * Populated when `state === 'harness-failure'` so notifiers don't
   * have to scrape the blocker prose to know whether a PR was
   * recovered. Absent on every other state.
   */
  harnessFailure?: HarnessFailureInfo;
  /**
   * PRO-598: structured auto-remediation disposition. Mirrors
   * `status.integrations.autoRemediation` onto the stable per-job
   * record so callers (notifier helpers, webhook/handoff callbacks)
   * read it from result.json. Notifier renders it as the
   * "Auto-remediation: ..." line; callbacks downgrade `failed`
   * statuses when `superseding=true`.
   */
  autoRemediation?: AutoRemediationStatus;
  /**
   * Phase 6e: per-agent token / cost sample captured from the agent
   * CLI's self-report at finalize time. Mirrors `status.usage` so
   * downstream consumers (telemetry, dashboard) can read cost off the
   * stable per-job record without loading status.json. Absent when
   * the CLI's output format doesn't surface usage (Claude's default
   * text `--print`) or when the parser couldn't recognise any
   * signal. See `AgentDriver.parseUsage` + `docs/cost-accounting.md`.
   */
  usage?: import('./lib/agents/types').AgentUsage;
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

/**
 * PRO-598: structured auto-remediation disposition for Discord error/blocked
 * notifications and downstream callbacks. Lets notifiers and the
 * handoff/webhook callbacks reason about whether CCP will retry without
 * scraping the prose blocker text.
 *
 * - `queued`         a `__reviewfix|__valfix|__deployfix` child was just
 *                    enqueued (`remediationJobId` populated).
 * - `existing`       an existing remediation child for the same parent is
 *                    already running.
 * - `pending-watcher` the job has a PR but the pr-watcher cycle hasn't
 *                    fired remediation yet — operator can wait one cycle.
 * - `depth-limit`    the remediation depth guard tripped (this job is
 *                    itself a remediation/auto-retry); no further auto
 *                    retries.
 * - `disabled`       remediation is globally off (CCP_PR_REMEDIATE_ENABLED).
 * - `not-applicable` no PR/blocking review/validation/smoke gate to act on.
 *                    Operator must rerun or refile. Harness-failure with
 *                    no recovered PR lands here.
 * - `superseded`     a replacement attempt is already active (operator
 *                    retried/restarted/repaired); this terminal callback
 *                    is therefore not authoritative.
 */
export type AutoRemediationDisposition =
  | 'queued'
  | 'existing'
  | 'pending-watcher'
  | 'depth-limit'
  | 'disabled'
  | 'not-applicable'
  | 'superseded';

export interface AutoRemediationStatus {
  disposition: AutoRemediationDisposition;
  /**
   * True when the disposition is 'superseded' OR when an active replacement
   * attempt makes this notification non-authoritative. Notifiers downgrade
   * webhook `failed → in_progress` and handoff `failed → blocked` when
   * `superseding=true` so we stop emitting misleading terminal callbacks.
   */
  superseding: boolean;
  /** Job id of the remediation child when disposition === 'queued'/'existing'. */
  remediationJobId?: string | null;
  /** Which remediation path produced this disposition. */
  source?: 'review' | 'validation' | 'smoke' | 'none';
  /** Free-form human reason, mirrored into the rendered Discord line. */
  reason?: string;
}

/**
 * PRO-598: harness-failure subtype. `state === 'harness-failure'` covers
 * the case where the worker exited 0 but did not emit CCP's final summary
 * contract. Notifiers need to distinguish *reporting-contract* failure
 * (CCP couldn't tell whether work happened) from *implementation* failure
 * (worker crashed mid-task), and also report whether PR/commit metadata
 * was recovered after the fact.
 */
export interface HarnessFailureInfo {
  /**
   * - `reporting-contract`           worker exited 0, no summary, no PR.
   *                                  Could be a silent success, a crash, or
   *                                  a stalled write — operator must
   *                                  inspect the repo + log.
   * - `reporting-contract-recovered` worker exited 0, no summary, but CCP
   *                                  recovered the PR/commit. The code
   *                                  change probably succeeded; only the
   *                                  reporting line failed.
   * - `implementation`               worker exited non-zero or wrote a
   *                                  blocker — actual code/test/run
   *                                  failure (currently unused, reserved
   *                                  for callers that want to reuse the
   *                                  type for non-zero-exit cases).
   */
  kind: 'reporting-contract' | 'reporting-contract-recovered' | 'implementation';
  prRecovered: boolean;
  commitRecovered: boolean;
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
  /**
   * Phase 6a: summary of the auto-unblock watchdog pass for this cycle.
   * Absent when the watchdog hasn't run (e.g. an error before the
   * tick). Individual retry spawns are recorded on each parent job's
   * status as well so operators can query per-job history.
   */
  autoUnblock?: {
    scanned: number;
    retried: Array<{ parent: string; child: string; attempt: number; blockerType: string }>;
    skipped: Array<{ job_id: string; reason: string }>;
    errors: Array<{ job_id?: string; error: string }>;
  };
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
