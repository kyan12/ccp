/**
 * Phase 6e: shared usage-parsing helpers for AgentDriver.parseUsage().
 *
 * Agent CLIs emit token / cost information in a handful of well-known
 * shapes depending on which output flag the caller picked. We accept
 * all of them in a best-effort, total-function way:
 *
 *   - Claude Code (`--output-format=json` / `stream-json`): emits a
 *     `"total_cost_usd"` JSON value alongside a `"usage"` object with
 *     `input_tokens` / `output_tokens` / `cache_read_input_tokens`.
 *   - OpenAI Codex (`exec` mode): emits `{"type":"turn.completed",
 *     "usage":{...}}` NDJSON events in the log; the last event carries
 *     the cumulative session totals. Current Codex releases do NOT
 *     self-report a dollar cost, so costUsd is left absent.
 *
 * A parser that finds no recognisable signal returns `null`. Callers
 * (finalizeJob) persist `usage: undefined` in that case and the
 * telemetry rollup skips the job from per-agent token / cost sums.
 *
 * These helpers are pure wrt IO (read-only string parsing + caller-
 * supplied clock), so unit tests exercise every branch without touching
 * disk or the network. See agents-usage.test.ts.
 */

import type { AgentUsage } from './types';

/** ISO timestamp factory, overridable from tests. */
type Clock = () => string;

const defaultClock: Clock = () => new Date().toISOString();

/**
 * Scan a Claude Code worker log for a `--output-format=json` (or
 * `stream-json`) usage block and return the canonical AgentUsage.
 *
 * Handles both:
 *   - Single final JSON object (from `--output-format=json`): the log
 *     is (or ends with) one JSON object containing `total_cost_usd`
 *     and `usage`.
 *   - NDJSON stream (from `--output-format=stream-json`): the last
 *     `{"type":"result"}` event carries the totals. Intermediate
 *     `{"type":"assistant"}` events may also have per-turn `usage`
 *     blocks — we pick the final `result` event deliberately so the
 *     number matches what Claude Code itself displays.
 *
 * Returns null when the log contains no `total_cost_usd` field, no
 * `usage` block, OR when the values cannot be coerced to finite
 * numbers. Never throws.
 */
export function parseClaudeUsage(
  log: string,
  agentName: string,
  clock: Clock = defaultClock,
): AgentUsage | null {
  if (!log || typeof log !== 'string') return null;

  // Prefer a `result`-type NDJSON event if present — it carries the
  // cumulative total for the whole session. Fall back to any object
  // that mentions `total_cost_usd` (plain `--output-format=json`).
  const resultObj = findLastJsonObjectWith(log, /"type"\s*:\s*"result"/);
  const candidate = resultObj ?? findLastJsonObjectWith(log, /"total_cost_usd"/);
  if (!candidate) return null;

  const cost = pickNumber(candidate.total_cost_usd);
  const usageObj = isRecord(candidate.usage) ? candidate.usage : null;

  const inputTokens = pickNumber(usageObj?.input_tokens);
  const outputTokens = pickNumber(usageObj?.output_tokens);
  const cachedInputTokens = pickNumber(usageObj?.cache_read_input_tokens);
  const cacheCreationTokens = pickNumber(usageObj?.cache_creation_input_tokens);
  const totalTokensRaw = pickNumber(usageObj?.total_tokens);

  // If none of the useful fields came through, this is not a cost
  // block — don't fabricate a usage record.
  if (
    cost == null &&
    inputTokens == null &&
    outputTokens == null &&
    cachedInputTokens == null &&
    cacheCreationTokens == null &&
    totalTokensRaw == null
  ) {
    return null;
  }

  const totalTokens =
    totalTokensRaw ??
    sumDefined(inputTokens, outputTokens, cachedInputTokens, cacheCreationTokens);

  const model = pickString(candidate.model) ?? pickString(candidate.modelId);

  const out: AgentUsage = {
    agent: agentName,
    capturedAt: clock(),
    source: 'claude-code:json',
  };
  if (model) out.model = model;
  if (inputTokens != null) out.inputTokens = inputTokens;
  if (outputTokens != null) out.outputTokens = outputTokens;
  if (cachedInputTokens != null) out.cachedInputTokens = cachedInputTokens;
  if (cacheCreationTokens != null) out.cacheCreationTokens = cacheCreationTokens;
  if (totalTokens != null) out.totalTokens = totalTokens;
  if (cost != null) out.costUsd = cost;
  return out;
}

/**
 * Scan an OpenAI Codex `exec` worker log for the last recognisable
 * token-usage event. Supported shapes (in priority order):
 *
 *   1. `{"type":"turn.completed","usage":{...}}` NDJSON events (the
 *      headless `codex exec` JSONL form). The LAST event wins because
 *      `usage` is cumulative across tool calls within a session.
 *   2. `{"type":"event_msg","payload":{"type":"token_count","info":{
 *      "total_token_usage":{...}}}}` — the rollout JSONL shape
 *      documented by openai/codex-action (same fields, deeper nest).
 *   3. Plain-text summary lines like:
 *        "tokens used: 12345 in / 678 out (cached 900)"
 *        "Total tokens: 12345 input, 678 output"
 *      Either Codex or a wrapper script may emit these; we accept
 *      both so operators who pipe through a formatter still get data.
 *
 * Codex (as of 2026-Q1) does not self-report a dollar cost, so
 * `costUsd` is left absent. Downstream consumers that want USD can
 * apply a pricing table to the persisted token counts.
 */
export function parseCodexUsage(
  log: string,
  agentName: string,
  clock: Clock = defaultClock,
): AgentUsage | null {
  if (!log || typeof log !== 'string') return null;

  // Priority 1/2: NDJSON events. Scan for the LAST object whose
  // shape matches either known carrier; that's the most-recent
  // cumulative total.
  const turnEvent = findLastJsonObjectWith(log, /"type"\s*:\s*"turn\.completed"/);
  const tokenCountEvent = findLastJsonObjectWith(log, /"type"\s*:\s*"token_count"/);

  let usageSource = '';
  let usageBlock: Record<string, unknown> | null = null;
  let model: string | null = null;

  if (turnEvent && isRecord(turnEvent.usage)) {
    usageBlock = turnEvent.usage;
    usageSource = 'codex:turn.completed';
    model = pickString(turnEvent.model) ?? pickString(turnEvent.modelId);
  } else if (tokenCountEvent) {
    // token_count events are wrapped: { payload: { type: 'token_count',
    //   info: { total_token_usage: { input_tokens, output_tokens,
    //   cached_input_tokens } } } }. We also accept the flatter
    // rollout-file shape.
    const payload = isRecord(tokenCountEvent.payload) ? tokenCountEvent.payload : tokenCountEvent;
    const info = isRecord(payload.info) ? payload.info : null;
    const total = info && isRecord(info.total_token_usage) ? info.total_token_usage : null;
    if (total) {
      usageBlock = total;
      usageSource = 'codex:token_count';
      model = pickString(info?.model) ?? null;
    }
  }

  if (usageBlock) {
    const inputTokens = pickNumber(usageBlock.input_tokens);
    const outputTokens = pickNumber(usageBlock.output_tokens);
    const cachedInputTokens = pickNumber(usageBlock.cached_input_tokens);
    const totalTokensRaw = pickNumber(usageBlock.total_tokens);

    if (
      inputTokens == null &&
      outputTokens == null &&
      cachedInputTokens == null &&
      totalTokensRaw == null
    ) {
      // usage block existed but every field is missing/non-numeric —
      // fall through to the text-summary scan below.
    } else {
      const totalTokens =
        totalTokensRaw ?? sumDefined(inputTokens, outputTokens, cachedInputTokens);
      const out: AgentUsage = {
        agent: agentName,
        capturedAt: clock(),
        source: usageSource,
      };
      if (model) out.model = model;
      if (inputTokens != null) out.inputTokens = inputTokens;
      if (outputTokens != null) out.outputTokens = outputTokens;
      if (cachedInputTokens != null) out.cachedInputTokens = cachedInputTokens;
      if (totalTokens != null) out.totalTokens = totalTokens;
      return out;
    }
  }

  // Priority 3: plain-text summary line. Tolerant to number formatting
  // (with/without commas) and ordering variants.
  const textMatch =
    log.match(/tokens?\s*used[^\d-]*([\d,]+)\s*in[^\d-]*([\d,]+)\s*out(?:[^\d-]*(?:cached?|cache)[^\d-]*([\d,]+))?/i) ??
    log.match(/total\s*tokens?[^\d-]*([\d,]+)\s*input[^\d-]*([\d,]+)\s*output(?:[^\d-]*(?:cached?|cache)[^\d-]*([\d,]+))?/i);
  if (textMatch) {
    const inputTokens = parseIntClean(textMatch[1]);
    const outputTokens = parseIntClean(textMatch[2]);
    const cachedInputTokens = textMatch[3] != null ? parseIntClean(textMatch[3]) : null;
    if (inputTokens == null && outputTokens == null) return null;
    const totalTokens = sumDefined(inputTokens, outputTokens, cachedInputTokens);
    const out: AgentUsage = {
      agent: agentName,
      capturedAt: clock(),
      source: 'codex:text-summary',
    };
    if (inputTokens != null) out.inputTokens = inputTokens;
    if (outputTokens != null) out.outputTokens = outputTokens;
    if (cachedInputTokens != null) out.cachedInputTokens = cachedInputTokens;
    if (totalTokens != null) out.totalTokens = totalTokens;
    return out;
  }

  return null;
}

// ── helpers ────────────────────────────────────────────────────────

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function pickNumber(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string') {
    const cleaned = v.replace(/,/g, '').trim();
    // Number('') === 0 in JS, which would silently fabricate a
    // zero-valued usage record from an empty JSON string. Treat
    // an empty-after-strip as absent instead.
    if (cleaned === '') return null;
    const n = Number(cleaned);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function pickString(v: unknown): string | null {
  if (typeof v === 'string' && v.trim()) return v.trim();
  return null;
}

function parseIntClean(raw: string | undefined): number | null {
  if (!raw) return null;
  const n = Number.parseInt(raw.replace(/,/g, ''), 10);
  return Number.isFinite(n) ? n : null;
}

function sumDefined(...values: Array<number | null | undefined>): number | null {
  const present = values.filter((v): v is number => typeof v === 'number' && Number.isFinite(v));
  if (present.length === 0) return null;
  return present.reduce((a, b) => a + b, 0);
}

/**
 * Find the LAST JSON object in `text` whose string form matches
 * `tag` (e.g. a regex for a `"type":"result"` marker). Tolerates
 * mixed text/JSON output by scanning right-to-left for `{` and
 * greedily growing to a balanced `}`.
 *
 * Returns `null` when no matching object parses cleanly. Never
 * throws; malformed JSON just yields `null`.
 */
function findLastJsonObjectWith(
  text: string,
  tag: RegExp,
): Record<string, unknown> | null {
  // Walk every `{…}` candidate from the end of the string backwards.
  // We cap the number of attempts so a pathological log can't stall
  // finalize (agent logs in practice are bounded by process memory,
  // but a defensive cap keeps worst-case bounded).
  const maxAttempts = 2000;
  let attempts = 0;
  let searchEnd = text.length;
  while (searchEnd > 0 && attempts < maxAttempts) {
    attempts++;
    const closeIdx = text.lastIndexOf('}', searchEnd - 1);
    if (closeIdx < 0) return null;
    const openIdx = findMatchingOpenBrace(text, closeIdx);
    if (openIdx < 0) {
      searchEnd = closeIdx;
      continue;
    }
    const slice = text.slice(openIdx, closeIdx + 1);
    if (tag.test(slice)) {
      try {
        const parsed = JSON.parse(slice);
        if (isRecord(parsed)) return parsed;
      } catch {
        // not valid JSON on its own — keep scanning further left.
      }
    }
    searchEnd = openIdx;
  }
  return null;
}

/**
 * Walk left from `closeIdx` (pointing at a `}`) until the matching
 * `{` is found, ignoring braces that appear inside JSON string
 * literals. Returns -1 if no balanced match is found.
 */
function findMatchingOpenBrace(text: string, closeIdx: number): number {
  let depth = 1;
  let i = closeIdx - 1;
  while (i >= 0) {
    const ch = text[i];
    if (ch === '"') {
      // Skip over a string literal. JSON strings may contain escaped
      // quotes; walk backwards counting backslashes.
      const stringEnd = i;
      let j = stringEnd - 1;
      while (j >= 0) {
        if (text[j] === '"') {
          // Count preceding backslashes to decide if this quote is escaped.
          let backslashes = 0;
          let k = j - 1;
          while (k >= 0 && text[k] === '\\') {
            backslashes++;
            k--;
          }
          if (backslashes % 2 === 0) break; // unescaped — string start
        }
        j--;
      }
      i = j - 1;
      continue;
    }
    if (ch === '}') depth++;
    else if (ch === '{') {
      depth--;
      if (depth === 0) return i;
    }
    i--;
  }
  return -1;
}
