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

interface OutageState {
  outage: boolean;
  consecutiveApiFailures: number;
  lastFailureAt: string | null;
  outageSince: string | null;
  lastProbeAt: string | null;
  lastProbeResult: 'ok' | 'fail' | null;
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
