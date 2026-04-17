/**
 * scheduling.ts — Peak/off-peak hour scheduling for job dispatch.
 *
 * Reads configs/scheduling.json to determine whether the supervisor
 * should start new jobs right now. Running jobs are never killed.
 */

import fs = require('fs');
import path = require('path');

const ROOT: string = path.resolve(process.env.CCP_ROOT || path.join(__dirname, '..', '..'));
const SCHEDULING_CONFIG: string = path.join(ROOT, 'configs', 'scheduling.json');

interface PeakWindow {
  days: string[];
  start: string; // "HH:MM"
  end: string;   // "HH:MM"
  label?: string;
}

interface SchedulingConfig {
  enabled: boolean;
  timezone: string;
  peakHours: {
    windows: PeakWindow[];
  };
  behavior: {
    duringPeak: 'queue' | 'drop' | 'allow';
    allowRunningJobsToFinish: boolean;
    allowUrgentOverride: boolean;
  };
}

function loadConfig(): SchedulingConfig | null {
  if (!fs.existsSync(SCHEDULING_CONFIG)) return null;
  try {
    return JSON.parse(fs.readFileSync(SCHEDULING_CONFIG, 'utf8'));
  } catch (err) {
    console.error(`[scheduling] failed to parse ${SCHEDULING_CONFIG}: ${(err as Error).message}`);
    return null;
  }
}

const DAY_MAP: Record<string, number> = {
  sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6,
};

function parseTime(hhmm: string): { hours: number; minutes: number } {
  const [h, m] = hhmm.split(':').map(Number);
  return { hours: h, minutes: m };
}

/**
 * Check if the current time falls within any peak window.
 * Returns the matching window label (or true) if in peak, null if off-peak.
 */
function isPeakHour(now?: Date): { peak: boolean; label: string | null; nextOffPeak: string | null } {
  const config = loadConfig();
  if (!config || !config.enabled) {
    return { peak: false, label: null, nextOffPeak: null };
  }

  // Get current time in the configured timezone
  const tz = config.timezone || 'America/New_York';
  const dateNow = now || new Date();
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    weekday: 'short',
    hour: 'numeric',
    minute: 'numeric',
    hour12: false,
  });
  const parts = formatter.formatToParts(dateNow);
  const weekday = parts.find(p => p.type === 'weekday')?.value?.toLowerCase().slice(0, 3) || '';
  const hour = Number(parts.find(p => p.type === 'hour')?.value || 0);
  const minute = Number(parts.find(p => p.type === 'minute')?.value || 0);
  const currentMinutes = hour * 60 + minute;
  const dayIndex = DAY_MAP[weekday] ?? -1;

  for (const window of config.peakHours.windows) {
    const windowDays = window.days.map(d => d.toLowerCase().slice(0, 3));
    if (!windowDays.includes(weekday)) continue;

    const start = parseTime(window.start);
    const end = parseTime(window.end);
    const startMin = start.hours * 60 + start.minutes;
    const endMin = end.hours * 60 + end.minutes;

    if (currentMinutes >= startMin && currentMinutes < endMin) {
      // Calculate next off-peak time
      const remainingMinutes = endMin - currentMinutes;
      const h = Math.floor(remainingMinutes / 60);
      const m = remainingMinutes % 60;
      const nextOffPeak = h > 0 ? `${h}h${m > 0 ? ` ${m}m` : ''}` : `${m}m`;

      return {
        peak: true,
        label: window.label || 'peak',
        nextOffPeak,
      };
    }
  }

  return { peak: false, label: null, nextOffPeak: null };
}

/**
 * Should the supervisor dispatch new jobs right now?
 *
 * Per-agent (PR B): this function used to default to the claude-code
 * circuit and pause ALL dispatch when Anthropic was down. After PR B every
 * registered agent has its own circuit + its own rate-limit window, so the
 * global gate only blocks dispatch when EVERY registered agent is in
 * outage (or rate limited). As long as at least one driver is healthy,
 * we let the queue through and the per-job preflight resolver picks the
 * right target (including fallback swaps for repos that opted in via
 * `repos.json: { agentFallback: '...' }`).
 */
function canDispatchJobs(priority?: string): { allowed: boolean; reason: string } {
  let outage: { getAllOutageStatuses?: () => Record<string, { outage: boolean; outageSince?: string | null; rateLimitResetAt?: string | null }>; getOutageStatus?: (agent?: string) => { outage: boolean; outageSince?: string | null }; isRateLimited?: (agent?: string) => { paused: boolean; resetAt?: string; reason?: string | null } } | null = null;
  try {
    outage = require('./outage');
  } catch (err) {
    console.error(`[scheduling] failed to load outage module: ${(err as Error).message}`);
  }

  // Enumerate every registered agent's status so we can answer
  // "is there ANY usable driver right now?"
  let statuses: Record<string, { outage: boolean; outageSince?: string | null; rateLimitResetAt?: string | null }> = {};
  try {
    statuses = outage?.getAllOutageStatuses?.() || {};
  } catch (err) {
    console.error(`[scheduling] failed to enumerate agent statuses: ${(err as Error).message}`);
  }
  const agentNames = Object.keys(statuses);

  // Rate limit takes priority over outage. Only block globally when every
  // known agent is currently rate-limited — otherwise a single driver's
  // quota wall shouldn't pause dispatch for healthy drivers.
  try {
    const rl = outage?.isRateLimited?.();
    if (rl?.paused) {
      const allLimited = agentNames.length > 0 && agentNames.every((name) => {
        try { return !!outage?.isRateLimited?.(name)?.paused; } catch { return false; }
      });
      if (allLimited || agentNames.length === 0) {
        const resetStr = new Date(rl.resetAt!).toLocaleTimeString('en-US', { timeZone: 'America/New_York', hour: 'numeric', minute: '2-digit' });
        return { allowed: false, reason: `rate limited — paused until ${resetStr} ET` };
      }
    }
  } catch (err) {
    console.error(`[scheduling] failed to check rate limit: ${(err as Error).message}`);
  }

  // Outage gate: block only when every registered agent is circuit-open.
  // When some agents are still healthy, the per-job preflight resolver
  // handles fallback swaps / skips non-dispatchable jobs.
  try {
    if (agentNames.length > 0) {
      const inOutage = agentNames.filter((name) => statuses[name]?.outage);
      const allOut = inOutage.length === agentNames.length;
      if (allOut) {
        const driverList = inOutage.join(', ');
        const since = statuses[inOutage[0]]?.outageSince
          ? ` since ${new Date(statuses[inOutage[0]]!.outageSince!).toLocaleTimeString('en-US', { timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit' })}`
          : '';
        return { allowed: false, reason: `all agents in outage (${driverList})${since} — probing for recovery` };
      }
    } else {
      // Legacy path: agent list unavailable, fall back to the default
      // agent's outage state (preserves pre-PR-B behavior on older installs).
      const outageState = outage?.getOutageStatus?.();
      if (outageState?.outage) {
        const since = outageState.outageSince
          ? ` since ${new Date(outageState.outageSince).toLocaleTimeString('en-US', { timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit' })}`
          : '';
        return { allowed: false, reason: `API outage detected${since} — probing for recovery` };
      }
    }
  } catch (err) {
    console.error(`[scheduling] failed to check outage status: ${(err as Error).message}`);
  }

  const config = loadConfig();
  if (!config || !config.enabled) {
    return { allowed: true, reason: 'scheduling disabled' };
  }

  const status = isPeakHour();

  if (!status.peak) {
    return { allowed: true, reason: 'off-peak' };
  }

  // During peak hours
  if (config.behavior.duringPeak === 'allow') {
    return { allowed: true, reason: 'peak but policy=allow' };
  }

  if (config.behavior.allowUrgentOverride && priority === 'urgent') {
    return { allowed: true, reason: 'urgent override during peak' };
  }

  return {
    allowed: false,
    reason: `peak hours (${status.label}) — off-peak in ${status.nextOffPeak}`,
  };
}

module.exports = { isPeakHour, canDispatchJobs, loadConfig };
export { isPeakHour, canDispatchJobs, loadConfig };
