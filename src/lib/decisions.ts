import type {
  DecisionMode,
  DecisionOption,
  DecisionPolicyConfig,
  DecisionRequest,
  JobPacket,
  RepoMapping,
  ResolvedDecisionPolicy,
} from '../types';

const DEFAULT_PROMPT_ON = [
  'production_risk',
  'destructive_action',
  'architecture_choice',
  'scope_expansion',
  'low_confidence',
  'data_migration',
  'auth_or_billing',
  'secrets_or_credentials',
] as const;

function isDecisionMode(value: unknown): value is DecisionMode {
  return value === 'ask' || value === 'auto' || value === 'hybrid' || value === 'never-block';
}

function clampConfidenceThreshold(value: unknown, fallback: number): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(0, Math.min(1, n));
}

function positiveInt(value: unknown, fallback: number): number {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

function envMode(): DecisionMode | null {
  const raw = process.env.CCP_DECISION_MODE;
  if (!raw) return null;
  const normalized = raw.trim().toLowerCase();
  return isDecisionMode(normalized) ? normalized : null;
}

export function resolveDecisionPolicy(packet?: Partial<JobPacket> | null, repo?: Partial<RepoMapping> | null): ResolvedDecisionPolicy {
  const base: ResolvedDecisionPolicy = {
    mode: 'auto',
    promptOn: [...DEFAULT_PROMPT_ON],
    confidenceThreshold: 0.75,
    timeoutMinutes: 60,
    defaultTimeoutAction: 'recommended',
  };

  const layers: Array<DecisionPolicyConfig | undefined> = [repo?.decisionPolicy, packet?.decisionPolicy];
  let resolved: ResolvedDecisionPolicy = { ...base };
  for (const layer of layers) {
    if (!layer) continue;
    resolved = {
      ...resolved,
      mode: isDecisionMode(layer.mode) ? layer.mode : resolved.mode,
      promptOn: Array.isArray(layer.promptOn) ? [...layer.promptOn] : resolved.promptOn,
      confidenceThreshold: clampConfidenceThreshold(layer.confidenceThreshold, resolved.confidenceThreshold),
      timeoutMinutes: positiveInt(layer.timeoutMinutes, resolved.timeoutMinutes),
      defaultTimeoutAction: layer.defaultTimeoutAction === 'fail-closed' ? 'fail-closed' : (layer.defaultTimeoutAction === 'recommended' ? 'recommended' : resolved.defaultTimeoutAction),
    };
  }

  if (isDecisionMode(packet?.decisionMode)) resolved.mode = packet!.decisionMode!;
  const eMode = envMode();
  if (eMode) resolved.mode = eMode;
  resolved.confidenceThreshold = clampConfidenceThreshold(process.env.CCP_DECISION_CONFIDENCE_THRESHOLD, resolved.confidenceThreshold);
  resolved.timeoutMinutes = positiveInt(process.env.CCP_DECISION_TIMEOUT_MINUTES, resolved.timeoutMinutes);
  return resolved;
}

export function buildDecisionInstructions(policy: ResolvedDecisionPolicy): string {
  if (policy.mode === 'auto' || policy.mode === 'never-block') {
    return [
      `Decision policy: ${policy.mode}.`,
      'If an important choice is ambiguous, make your best judgment and continue without blocking.',
      'Log the decision and rationale in your final Summary/Risk, but do not ask the operator for clarification.',
    ].join('\n');
  }

  const modeText = policy.mode === 'ask'
    ? 'Ask mode: stop for any important ambiguous decision before making high-impact changes.'
    : `Hybrid mode: make low-risk calls yourself, but stop when a trigger applies or confidence is below ${policy.confidenceThreshold}.`;

  return [
    `Decision policy: ${policy.mode}.`,
    modeText,
    `Prompt triggers: ${policy.promptOn.join(', ')}.`,
    'When a human decision is needed, do NOT continue coding. Emit exactly one single-line JSON block prefixed with `DecisionRequest: `, then finish with `State: blocked` and `Blocker: Decision needed: <short question>`.',
    'DecisionRequest JSON schema: {"question":"...","options":[{"id":"A","label":"...","tradeoff":"..."}],"recommended":"A","risk":"low|medium|high","confidence":0.0,"reason":"..."}.',
    `Default timeout action: ${policy.defaultTimeoutAction}; timeout minutes: ${policy.timeoutMinutes}.`,
    'Operator reply path after you stop: ccp-jobs decide <job_id> <option-id> [note].',
  ].join('\n');
}

function normalizeOption(raw: unknown, index: number): DecisionOption | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const id = typeof r.id === 'string' && r.id.trim() ? r.id.trim() : String.fromCharCode(65 + index);
  const label = typeof r.label === 'string' && r.label.trim() ? r.label.trim() : null;
  if (!label) return null;
  const option: DecisionOption = { id, label };
  if (typeof r.tradeoff === 'string' && r.tradeoff.trim()) option.tradeoff = r.tradeoff.trim();
  return option;
}

export function parseDecisionRequest(logText: string, jobId: string, createdAt: string = new Date().toISOString()): DecisionRequest | null {
  const matches = [...logText.matchAll(/^DecisionRequest:\s*(\{.*\})\s*$/gmi)];
  if (!matches.length) return null;
  const rawJson = matches[matches.length - 1][1];
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(rawJson) as Record<string, unknown>;
  } catch {
    return null;
  }

  const question = typeof parsed.question === 'string' ? parsed.question.trim() : '';
  const options = Array.isArray(parsed.options)
    ? parsed.options.map((o, i) => normalizeOption(o, i)).filter((o): o is DecisionOption => !!o)
    : [];
  if (!question || options.length === 0) return null;

  const request: DecisionRequest = {
    id: `${jobId}#decision`,
    job_id: jobId,
    question,
    options,
    created_at: createdAt,
    status: 'pending',
  };
  if (typeof parsed.recommended === 'string' && parsed.recommended.trim()) request.recommended = parsed.recommended.trim();
  if (typeof parsed.risk === 'string' && parsed.risk.trim()) request.risk = parsed.risk.trim();
  if (typeof parsed.confidence === 'number' && Number.isFinite(parsed.confidence)) request.confidence = parsed.confidence;
  if (typeof parsed.reason === 'string' && parsed.reason.trim()) request.reason = parsed.reason.trim();
  return request;
}

export function formatDecisionRequestForDiscord(request: DecisionRequest): string {
  const lines = [`🧭 Decision needed for ${request.job_id}`, '', `Question: ${request.question}`, '', 'Options:'];
  for (const opt of request.options) {
    lines.push(`${opt.id}. ${opt.label}${opt.tradeoff ? ` — ${opt.tradeoff}` : ''}`);
  }
  if (request.recommended) lines.push('', `Recommended: ${request.recommended}`);
  if (request.risk) lines.push(`Risk: ${request.risk}`);
  if (request.confidence != null) lines.push(`Confidence: ${request.confidence}`);
  if (request.reason) lines.push(`Reason: ${request.reason}`);
  const exampleChoice = request.recommended || request.options[0]?.id || '<option-id>';
  lines.push('', `Reply command: ccp-jobs decide ${request.job_id} ${exampleChoice} [note]`);
  return lines.join('\n');
}

function safeChoiceForId(choice: string): string {
  const trimmed = choice.trim();
  const sanitized = trimmed.replace(/[^A-Za-z0-9_-]/g, '_');
  let hash = 2166136261;
  for (const ch of trimmed) {
    hash ^= ch.charCodeAt(0);
    hash = Math.imul(hash, 16777619) >>> 0;
  }
  const suffix = hash.toString(36).slice(0, 8);
  const needsSuffix = !sanitized || sanitized !== trimmed || sanitized.length > 32;
  const base = (sanitized || 'answer').slice(0, needsSuffix ? 23 : 32);
  return needsSuffix ? `${base}_${suffix}` : base;
}

export function createDecisionContinuationPacket(input: {
  packet: JobPacket;
  parentJobId: string;
  choice: string;
  note?: string;
  request?: DecisionRequest | null;
}): JobPacket {
  const choice = input.choice.trim();
  const note = input.note?.trim();
  const q = input.request?.question || 'operator decision';
  const selected = input.request?.options.find((o) => o.id.toLowerCase() === choice.toLowerCase());
  const feedback = [
    `Continuing after operator decision for ${input.parentJobId}.`,
    `Decision question: ${q}`,
    `Human decision: ${choice}${selected ? ` — ${selected.label}` : ''}`,
    note ? `Decision note: ${note}` : null,
    'Proceed using this decision. Do not re-ask the same question; make follow-on judgment calls unless a new unrelated hard blocker appears.',
  ].filter((line): line is string => !!line);

  return {
    ...input.packet,
    job_id: `${input.parentJobId}__decision_${safeChoiceForId(choice)}`,
    source: 'decision',
    label: input.packet.label || 'decision-continuation',
    kind: input.packet.kind || 'task',
    goal: `Continue ${input.packet.ticket_id || input.parentJobId} after operator decision: ${choice}`,
    decisionMode: 'auto',
    review_feedback: [...(input.packet.review_feedback || []), ...feedback],
    created_at: new Date().toISOString(),
  };
}

module.exports = {
  buildDecisionInstructions,
  createDecisionContinuationPacket,
  formatDecisionRequestForDiscord,
  parseDecisionRequest,
  resolveDecisionPolicy,
};
