/**
 * outage.ts — per-agent API outage circuit breaker.
 *
 * Tracks consecutive API failures per agent driver. When an agent's threshold
 * is hit, the supervisor pauses dispatch for that agent (and probes it each
 * cycle until it recovers) — other agents remain dispatchable.
 *
 * State layout:
 *   configs/outage-<agent>.json   — one file per registered agent
 *   configs/outage.json           — legacy singleton (claude-code); auto-
 *                                    migrated to outage-claude-code.json on
 *                                    first read, then left in place as a
 *                                    tombstone so rollback is non-destructive.
 *
 * Pattern + probe detection delegates to the AgentDriver's failurePatterns /
 * probe() via the agent registry — this module is now agent-agnostic.
 */

import fs = require('fs');
import path = require('path');
import { getAgent, claudeCodeDriver, AGENTS } from './agents';
import type { AgentDriver } from './agents';

const ROOT: string = path.resolve(process.env.CCP_ROOT || path.join(__dirname, '..', '..'));
const CONFIGS_DIR: string = path.join(ROOT, 'configs');
const LEGACY_OUTAGE_PATH: string = path.join(CONFIGS_DIR, 'outage.json');
const DEFAULT_AGENT = 'claude-code';

function statePathFor(agent: string): string {
  return path.join(CONFIGS_DIR, `outage-${agent}.json`);
}

function resolveDriver(agent: string | null | undefined): AgentDriver {
  if (!agent) return claudeCodeDriver;
  return getAgent(agent) || claudeCodeDriver;
}

// How many consecutive API failures before pausing dispatch
const FAILURE_THRESHOLD = 2;

interface OutageState {
  outage: boolean;
  consecutiveApiFailures: number;
  lastFailureAt: string | null;
  outageSince: string | null;
  lastProbeAt: string | null;
  lastProbeResult: 'ok' | 'fail' | null;
  /** ISO timestamp when rate limit resets — dispatch pauses until this time */
  rateLimitResetAt: string | null;
  rateLimitReason: string | null;
  /** Which agent this state tracks (denormalized for easier debugging). */
  agent?: string;
}

const DEFAULT_STATE: OutageState = {
  outage: false,
  consecutiveApiFailures: 0,
  lastFailureAt: null,
  outageSince: null,
  lastProbeAt: null,
  lastProbeResult: null,
  rateLimitResetAt: null,
  rateLimitReason: null,
};

function loadState(agent: string = DEFAULT_AGENT): OutageState {
  const target = statePathFor(agent);

  // Backward-compat: one-time migration of the legacy outage.json (which
  // only ever tracked claude-code) to outage-claude-code.json.
  if (
    agent === DEFAULT_AGENT &&
    !fs.existsSync(target) &&
    fs.existsSync(LEGACY_OUTAGE_PATH)
  ) {
    try {
      const legacyRaw = fs.readFileSync(LEGACY_OUTAGE_PATH, 'utf8');
      const legacy = JSON.parse(legacyRaw) as OutageState;
      fs.mkdirSync(CONFIGS_DIR, { recursive: true });
      fs.writeFileSync(target, JSON.stringify({ ...legacy, agent }, null, 2));
    } catch (err) {
      console.error(
        `[outage] failed to migrate legacy ${LEGACY_OUTAGE_PATH}: ${(err as Error).message}`,
      );
    }
  }

  if (!fs.existsSync(target)) return { ...DEFAULT_STATE, agent };
  try {
    return { ...JSON.parse(fs.readFileSync(target, 'utf8')), agent };
  } catch (err) {
    console.error(`[outage] failed to parse ${target}: ${(err as Error).message}`);
    return { ...DEFAULT_STATE, agent };
  }
}

function saveState(state: OutageState, agent: string = DEFAULT_AGENT): void {
  const target = statePathFor(agent);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, JSON.stringify({ ...state, agent }, null, 2));
}

/**
 * Detect whether a worker log contains patterns the given agent treats as
 * transient API errors. When agent is omitted (legacy callers), scan every
 * registered driver's patterns — keeps behavior compatible with the pre-PR-B
 * "did claude blow up?" single-path check.
 */
export function isApiOutageLog(logText: string, agent?: string | null): boolean {
  if (agent) {
    const driver = resolveDriver(agent);
    return driver.failurePatterns.apiError.some(re => re.test(logText));
  }
  // No agent supplied → be permissive, check all known drivers so the cycle
  // loop's generic "was this an API failure?" question still answers yes.
  const seen = new Set<AgentDriver>();
  for (const d of Object.values(AGENTS)) {
    if (seen.has(d)) continue;
    seen.add(d);
    if (d.failurePatterns.apiError.some(re => re.test(logText))) return true;
  }
  return false;
}

/** Rate-limit patterns (original Anthropic-oriented ones, retained here as
 * the Anthropic reset-time format is the only one we can currently parse
 * into a wall-clock reset). OpenAI's "try again in 30s" shape is best-effort
 * scanned but not used for pause-until-timestamp yet. */
const RATE_LIMIT_PATTERNS: RegExp[] = [
  /hit your limit.*resets?\s+(\d{1,2}(?::\d{2})?\s*(?:am|pm)?)\s*(?:\(([^)]+)\))?/i,
  /rate.?limit.*reset.*?(\d{1,2}(?::\d{2})?\s*(?:am|pm)?)/i,
  /usage.*limit.*reset.*?(\d{1,2}(?::\d{2})?\s*(?:am|pm)?)/i,
];

/**
 * Detect rate limit in worker log and extract the reset time.
 * Returns the parsed ISO reset timestamp, or null if no rate limit detected.
 */
export function detectRateLimit(logText: string): { resetAt: string; reason: string } | null {
  for (const re of RATE_LIMIT_PATTERNS) {
    const match = logText.match(re);
    if (match) {
      const timeStr = (match[1] || '').trim();
      const tz = (match[2] || 'America/New_York').trim();
      const resetAt = parseResetTime(timeStr, tz);
      if (resetAt) {
        return { resetAt, reason: match[0].trim().slice(0, 120) };
      }
    }
  }
  return null;
}

/**
 * Parse a human time like "2pm" or "2:00 PM" into an ISO timestamp.
 * If the parsed time is in the past, assume it means tomorrow.
 */
function parseResetTime(timeStr: string, tz: string): string | null {
  try {
    // Parse hour/minute from strings like "2pm", "2:00 PM", "14:00"
    const m = timeStr.match(/^(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/i);
    if (!m) return null;
    let hour = parseInt(m[1], 10);
    const minute = m[2] ? parseInt(m[2], 10) : 0;
    const ampm = (m[3] || '').toLowerCase();
    if (ampm === 'pm' && hour < 12) hour += 12;
    if (ampm === 'am' && hour === 12) hour = 0;

    // Build a date in the given timezone
    const now = new Date();
    // Use Intl to get the current date in the target timezone
    const formatter = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', hour12: false,
    });
    const parts = formatter.formatToParts(now);
    const pv = (type: string) => parts.find(p => p.type === type)?.value || '';
    const year = parseInt(pv('year'), 10);
    const month = parseInt(pv('month'), 10) - 1;
    const day = parseInt(pv('day'), 10);
    const nowHour = parseInt(pv('hour'), 10);
    const nowMinute = parseInt(pv('minute'), 10);

    // Create the reset time. If it's already past, add a day.
    let resetDate = new Date(Date.UTC(year, month, day, hour, minute));
    // Adjust for timezone offset: we need to convert from tz local to UTC
    const tzOffset = getTimezoneOffset(tz, resetDate);
    resetDate = new Date(resetDate.getTime() + tzOffset);

    // If reset time is in the past (within same timezone), push to next day
    if (hour < nowHour || (hour === nowHour && minute <= nowMinute)) {
      resetDate = new Date(resetDate.getTime() + 24 * 60 * 60 * 1000);
    }

    return resetDate.toISOString();
  } catch {
    return null;
  }
}

/** Get timezone offset in milliseconds (local time -> UTC) */
function getTimezoneOffset(tz: string, date: Date): number {
  const utcStr = date.toLocaleString('en-US', { timeZone: 'UTC' });
  const tzStr = date.toLocaleString('en-US', { timeZone: tz });
  return new Date(utcStr).getTime() - new Date(tzStr).getTime();
}

/**
 * Record a rate limit event. Rate limits stay on the default agent's state
 * for now (OpenAI's reset format isn't wall-clock parseable yet — Codex rate
 * limits are still recorded as generic API failures via recordJobOutcome).
 */
export function recordRateLimit(resetAt: string, reason: string, agent: string = DEFAULT_AGENT): void {
  const state = loadState(agent);
  state.rateLimitResetAt = resetAt;
  state.rateLimitReason = reason;
  saveState(state, agent);
}

/**
 * Check if dispatch should be paused due to rate limiting on `agent`.
 */
export function isRateLimited(agent: string = DEFAULT_AGENT): { paused: true; resetAt: string; reason: string | null } | { paused: false } {
  const state = loadState(agent);
  if (!state.rateLimitResetAt) return { paused: false };
  const resetTime = new Date(state.rateLimitResetAt).getTime();
  const now = Date.now();
  if (now >= resetTime) {
    // Rate limit window has passed — clear it
    state.rateLimitResetAt = null;
    state.rateLimitReason = null;
    saveState(state, agent);
    return { paused: false };
  }
  return { paused: true, resetAt: state.rateLimitResetAt, reason: state.rateLimitReason };
}

/**
 * Call after a job finishes. If it failed due to an API error, increment the
 * counter and potentially trigger outage mode for the given agent.
 *
 * @returns true if we just entered outage mode (caller should alert Discord)
 */
export function recordJobOutcome(
  wasApiFailure: boolean,
  agent: string = DEFAULT_AGENT,
): { enteredOutage: boolean; state: OutageState } {
  const state = loadState(agent);

  if (wasApiFailure) {
    state.consecutiveApiFailures++;
    state.lastFailureAt = new Date().toISOString();
    if (!state.outage && state.consecutiveApiFailures >= FAILURE_THRESHOLD) {
      state.outage = true;
      state.outageSince = new Date().toISOString();
      saveState(state, agent);
      return { enteredOutage: true, state };
    }
  } else {
    // Clean run — reset consecutive counter (but keep outage flag; that clears via probe)
    if (!state.outage) {
      state.consecutiveApiFailures = 0;
    }
  }

  saveState(state, agent);
  return { enteredOutage: false, state };
}

/**
 * Probe the given agent's API with a minimal request. Delegates to the
 * AgentDriver.probe() implementation so each provider chooses its own
 * cheapest health check.
 */
export function probeAgent(agent: string = DEFAULT_AGENT): boolean {
  const driver = resolveDriver(agent);
  return driver.probe().ok;
}

/**
 * Backward-compat alias — callers that still say "probeAnthropicApi" are
 * implicitly talking about the default (claude-code) agent.
 * @deprecated Prefer probeAgent(name).
 */
export function probeAnthropicApi(): boolean {
  return probeAgent(DEFAULT_AGENT);
}

/**
 * Run probe and update state. If recovering from outage, clears the flag.
 * @returns { wasOutage, nowRecovered } — caller sends Discord alert if nowRecovered
 */
export function runOutageProbe(
  agent: string = DEFAULT_AGENT,
): { wasOutage: boolean; nowRecovered: boolean; state: OutageState } {
  const state = loadState(agent);
  if (!state.outage) {
    return { wasOutage: false, nowRecovered: false, state };
  }

  state.lastProbeAt = new Date().toISOString();
  const ok = probeAgent(agent);
  state.lastProbeResult = ok ? 'ok' : 'fail';

  if (ok) {
    state.outage = false;
    state.consecutiveApiFailures = 0;
    state.outageSince = null;
  }

  saveState(state, agent);
  return { wasOutage: true, nowRecovered: ok, state };
}

/**
 * Check current outage status for the given agent without modifying state.
 */
export function getOutageStatus(agent: string = DEFAULT_AGENT): OutageState {
  return loadState(agent);
}

/**
 * Aggregate outage status for every registered agent (unique drivers).
 * Useful for the dashboard and for scheduling decisions that need to
 * answer "is there ANY usable agent right now?"
 */
export function getAllOutageStatuses(): Record<string, OutageState> {
  const seen = new Set<AgentDriver>();
  const result: Record<string, OutageState> = {};
  for (const [name, driver] of Object.entries(AGENTS)) {
    if (seen.has(driver)) continue;
    seen.add(driver);
    result[name] = loadState(name);
  }
  return result;
}

/**
 * Manually clear outage state for the given agent (e.g. operator override).
 */
export function clearOutage(agent: string = DEFAULT_AGENT): void {
  const state = loadState(agent);
  state.outage = false;
  state.consecutiveApiFailures = 0;
  state.outageSince = null;
  saveState(state, agent);
}
