/**
 * outage.ts — Anthropic API outage circuit breaker.
 *
 * Tracks consecutive API failures. When a threshold is hit, the supervisor
 * pauses all new job dispatch and probes the API each cycle until it recovers.
 * Auto-resumes on recovery with a Discord notification.
 */

import fs = require('fs');
import path = require('path');
import { spawnSync } from 'child_process';

const ROOT: string = path.resolve(process.env.CCP_ROOT || path.join(__dirname, '..', '..'));
const OUTAGE_STATE_PATH: string = path.join(ROOT, 'configs', 'outage.json');

// Patterns in worker logs that indicate an Anthropic API error (not a code bug)
const API_ERROR_PATTERNS: RegExp[] = [
  /API Error: 5\d\d /i,
  /api_error.*internal server error/i,
  /"type":"api_error"/i,
  /overloaded_error/i,
  /529/,
  /ECONNRESET|ETIMEDOUT|ECONNREFUSED/,
  /anthropic.*unavailable/i,
  /service.*unavailable/i,
];

// How many consecutive API failures before pausing dispatch
const FAILURE_THRESHOLD = 2;

// Patterns that indicate a rate limit with a reset time
const RATE_LIMIT_PATTERNS: RegExp[] = [
  /hit your limit.*resets?\s+(\d{1,2}(?::\d{2})?\s*(?:am|pm)?)\s*(?:\(([^)]+)\))?/i,
  /rate.?limit.*reset.*?(\d{1,2}(?::\d{2})?\s*(?:am|pm)?)/i,
  /usage.*limit.*reset.*?(\d{1,2}(?::\d{2})?\s*(?:am|pm)?)/i,
];

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
}

function loadState(): OutageState {
  try {
    return JSON.parse(fs.readFileSync(OUTAGE_STATE_PATH, 'utf8'));
  } catch {
    return {
      outage: false,
      consecutiveApiFailures: 0,
      lastFailureAt: null,
      outageSince: null,
      lastProbeAt: null,
      lastProbeResult: null,
      rateLimitResetAt: null,
      rateLimitReason: null,
    };
  }
}

function saveState(state: OutageState): void {
  fs.mkdirSync(path.dirname(OUTAGE_STATE_PATH), { recursive: true });
  fs.writeFileSync(OUTAGE_STATE_PATH, JSON.stringify(state, null, 2));
}

/**
 * Detect whether a worker log contains Anthropic API error patterns.
 */
export function isApiOutageLog(logText: string): boolean {
  return API_ERROR_PATTERNS.some(re => re.test(logText));
}

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
 * Record a rate limit event. Sets the pause-until time.
 */
export function recordRateLimit(resetAt: string, reason: string): void {
  const state = loadState();
  state.rateLimitResetAt = resetAt;
  state.rateLimitReason = reason;
  saveState(state);
}

/**
 * Check if dispatch should be paused due to rate limiting.
 * Returns the reset time if still paused, null if clear.
 */
export function isRateLimited(): { paused: true; resetAt: string; reason: string | null } | { paused: false } {
  const state = loadState();
  if (!state.rateLimitResetAt) return { paused: false };
  const resetTime = new Date(state.rateLimitResetAt).getTime();
  const now = Date.now();
  if (now >= resetTime) {
    // Rate limit window has passed — clear it
    state.rateLimitResetAt = null;
    state.rateLimitReason = null;
    saveState(state);
    return { paused: false };
  }
  return { paused: true, resetAt: state.rateLimitResetAt, reason: state.rateLimitReason };
}

/**
 * Call after a job finishes. If it failed due to an API error, increment the
 * counter and potentially trigger outage mode.
 *
 * @returns true if we just entered outage mode (caller should alert Discord)
 */
export function recordJobOutcome(wasApiFailure: boolean): { enteredOutage: boolean; state: OutageState } {
  const state = loadState();

  if (wasApiFailure) {
    state.consecutiveApiFailures++;
    state.lastFailureAt = new Date().toISOString();
    if (!state.outage && state.consecutiveApiFailures >= FAILURE_THRESHOLD) {
      state.outage = true;
      state.outageSince = new Date().toISOString();
      saveState(state);
      return { enteredOutage: true, state };
    }
  } else {
    // Clean run — reset consecutive counter (but keep outage flag; that clears via probe)
    if (!state.outage) {
      state.consecutiveApiFailures = 0;
    }
  }

  saveState(state);
  return { enteredOutage: false, state };
}

/**
 * Probe the Anthropic API with a minimal request.
 * Uses the claude binary in the environment (same as workers use).
 * Returns true if the API responds successfully.
 */
export function probeAnthropicApi(): boolean {
  // Try a tiny claude call — just ask for a one-word response
  const result = spawnSync(
    'claude',
    ['--print', '--model', 'claude-haiku-4-5', 'Reply with the word PONG only.'],
    { encoding: 'utf8', timeout: 30000 }
  );
  return result.status === 0 && /PONG/i.test(result.stdout || '');
}

/**
 * Run probe and update state. If recovering from outage, clears the flag.
 * @returns { wasOutage, nowRecovered } — caller sends Discord alert if nowRecovered
 */
export function runOutageProbe(): { wasOutage: boolean; nowRecovered: boolean; state: OutageState } {
  const state = loadState();
  if (!state.outage) {
    return { wasOutage: false, nowRecovered: false, state };
  }

  state.lastProbeAt = new Date().toISOString();
  const ok = probeAnthropicApi();
  state.lastProbeResult = ok ? 'ok' : 'fail';

  if (ok) {
    state.outage = false;
    state.consecutiveApiFailures = 0;
    state.outageSince = null;
  }

  saveState(state);
  return { wasOutage: true, nowRecovered: ok, state };
}

/**
 * Check current outage status without modifying state.
 */
export function getOutageStatus(): OutageState {
  return loadState();
}

/**
 * Manually clear outage state (e.g. operator override).
 */
export function clearOutage(): void {
  const state = loadState();
  state.outage = false;
  state.consecutiveApiFailures = 0;
  state.outageSince = null;
  saveState(state);
}
