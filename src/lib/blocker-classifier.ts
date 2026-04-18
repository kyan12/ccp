/**
 * Phase 6b — ambiguity blocker classifier.
 *
 * The auto-unblock watchdog (Phase 6a) is intentionally conservative:
 * it auto-retries `validation-failed` / `smoke-failed` / `pr-check-failed`
 * but ignores the catch-all "ambiguity" blockers that represent a worker
 * giving up for reasons we don't yet classify. Two very different things
 * land in that bucket:
 *
 *  1. **Operator input required** — the worker actually asked a human for
 *     a design decision, a credential, clarification on an acceptance
 *     criterion, or similar. Retrying the same prompt without answering
 *     the question burns tokens and may push a low-quality guess.
 *
 *  2. **Transient environmental noise** — a rate-limited API call, a
 *     network hiccup, a git lock held by another process, a 503 from a
 *     3rd-party service, an upstream CI pipeline that hadn't finished
 *     propagating. Re-running the same prompt a few minutes later will
 *     almost always succeed.
 *
 * This module classifies a blocker description string into one of those
 * two buckets. The split is a pure function (no IO) so it's safe to call
 * from finalizeJob and trivially testable.
 *
 * Design rules:
 *   - Operator patterns win ties. If BOTH operator and transient phrases
 *     are present, we classify as operator — better to bother the human
 *     than silently retry on a real question.
 *   - Unknown signals default to operator (`null` means "I couldn't
 *     classify"; callers map that to `ambiguity-operator`).
 *   - The regexes are intentionally broad. False positives that classify
 *     a transient issue as operator just mean no auto-retry (safe).
 *     False positives that classify an operator issue as transient mean
 *     wasted tokens + a fresh blocker on retry — but bounded by
 *     `maxRetries` so it's still cheap.
 */

export type AmbiguityKind = 'ambiguity-operator' | 'ambiguity-transient';

/**
 * Phrases that strongly signal "worker is waiting on a human".
 * Intentionally broad — a false positive here means "don't auto-retry",
 * which is the conservative choice.
 */
const OPERATOR_PATTERNS: RegExp[] = [
  // Direct credential / auth asks
  /\b(missing|no)\s+(api[\s_-]?key|credential|credentials|token|secret|password)\b/i,
  /\b(unauthorized|authentication\s+failed|auth\s+failed|access\s+denied|permission\s+denied)\b/i,
  /\bHTTP\s*40[13]\b/i,
  /\bstatus(?:\s+code)?\s*[:=]?\s*40[13]\b/i,
  /\b(need|needs|needed|require|requires|required)\s+.{0,40}?(permission|approval|credential|token|secret|key)\b/i,
  /\bneed\s+(file\s+)?write\s+permission\b/i,

  // Design / scope / ambiguity asks
  /\b(please\s+clarify|need\s+clarification|needs?\s+clarification|please\s+specify|please\s+provide|please\s+confirm)\b/i,
  /\b(ambiguous|unclear|underspecified|under[\s-]?specified)\b/i,
  /\b(which\s+(one|option|approach|branch|file|repo|environment))\b/i,
  /\b(cannot\s+determine|unable\s+to\s+decide|don'?t\s+know\s+which|not\s+sure\s+which)\b/i,
  /\b(waiting\s+for\s+(input|clarification|decision|operator|human))\b/i,
  /\b(awaiting\s+(operator|human|input|clarification))\b/i,
  /\b(please\s+(answer|let\s+me\s+know|tell\s+me|advise))\b/i,

  // Missing ticket metadata
  /\b(missing|no)\s+(acceptance\s+criteria|design|specification|spec|requirement|requirements)\b/i,
  /\b(ticket|issue)\s+(is\s+)?(empty|incomplete|underspecified)\b/i,

  // Explicit worker escape-hatch signals we tell them to use when truly blocked
  /\bunable\s+to\s+verify\b/i,
  /\b(?:I|the\s+worker)\s+(?:am|is)\s+blocked\s+on\b/i,
  /\b(?:I|we)\s+cannot\s+proceed\s+without\b/i,

  // Typical "give me X and I'll continue" phrasings
  /\bwould\s+you\s+like\s+me\s+to\b/i,
  /\bshould\s+I\s+(use|pick|go\s+with|implement)\b/i,
  /\bcould\s+you\s+(provide|share|send|tell\s+me)\b/i,
];

/**
 * Phrases that strongly signal "environmental / timing noise, same
 * prompt should succeed on retry". Only used when NO operator pattern
 * matched. Keep this list narrow — false positives here cost retries.
 */
const TRANSIENT_PATTERNS: RegExp[] = [
  // Rate limiting / quotas
  /\brate[\s-]?limit(?:ed|ing)?\b/i,
  /\bHTTP\s*429\b/i,
  /\bstatus(?:\s+code)?\s*[:=]?\s*429\b/i,
  /\(\s*429\s*\)/,
  /\btoo\s+many\s+requests\b/i,
  /\bquota\s+(?:exceeded|exhausted|limit)\b/i,
  /\bbackoff\s+(?:and\s+)?retry\b/i,
  /\bretry\s+after\b/i,
  /\bnon[\s-]?2xx\b/i,

  // Network / DNS / connectivity
  /\bETIMEDOUT\b/,
  /\bECONNRESET\b/,
  /\bECONNREFUSED\b/,
  /\bENETUNREACH\b/,
  /\bEAI_AGAIN\b/,
  /\b(DNS|getaddrinfo)\s+(lookup\s+)?(failed|timeout|error)\b/i,
  /\b(?<!request\s)(?:timed\s+out|timeout)\b(?!.*\b(decide|clarif|input|permission)\b)/i,
  /\bnetwork\s+(error|timeout|unreachable|hiccup)\b/i,
  /\bfetch\s+failed\b/i,
  /\bconnection\s+(reset|refused|closed|timed?\s+out)\b/i,

  // 5xx / transient upstream failures
  /\bHTTP\s*50[234]\b/i,
  /\bstatus(?:\s+code)?\s*[:=]?\s*50[234]\b/i,
  /\b(bad\s+gateway|gateway\s+timeout|service\s+unavailable)\b/i,
  /\btemporarily\s+unavailable\b/i,
  /\btry\s+again\s+later\b/i,

  // Git lock / concurrent-access noise
  /\banother\s+git\s+process\s+seems\s+to\s+be\s+running\b/i,
  /\bindex\.lock\b/i,
  /\bunable\s+to\s+lock\b/i,

  // Upstream CI / deploy propagation — common flake shape
  /\b(preview|deploy(?:ment)?)\s+(?:not\s+(?:yet\s+)?(?:ready|available)|still\s+(?:building|deploying))\b/i,
  /\b(remote|origin)\s+(?:not\s+)?(?:updated|propagated|synced)\b/i,

  // Explicit "transient" / "flake" call-outs from tools
  /\b(transient|flaky|intermittent)\b/i,
];

/**
 * Classify an inferred or worker-reported blocker string.
 *
 * Returns:
 *   - `'ambiguity-operator'` if any operator pattern matches.
 *   - `'ambiguity-transient'` if no operator pattern matches AND a
 *     transient pattern matches.
 *   - `null` if neither matches (caller should default to operator).
 *
 * Null vs. `'ambiguity-operator'` gives callers a hook to distinguish
 * "we saw an operator signal" from "we couldn't tell" for telemetry,
 * even though both map to the same blocker_type in practice.
 */
export function classifyAmbiguity(text: string | null | undefined): AmbiguityKind | null {
  if (!text || typeof text !== 'string') return null;
  const normalized = text.slice(0, 8192); // bound regex work on pathological inputs
  for (const pat of OPERATOR_PATTERNS) {
    if (pat.test(normalized)) return 'ambiguity-operator';
  }
  for (const pat of TRANSIENT_PATTERNS) {
    if (pat.test(normalized)) return 'ambiguity-transient';
  }
  return null;
}

/**
 * Convenience: classify and collapse `null` to the safe default.
 * Use this wherever you actually need a blocker_type value to persist.
 */
export function classifyAmbiguityOrDefault(text: string | null | undefined): AmbiguityKind {
  return classifyAmbiguity(text) || 'ambiguity-operator';
}
