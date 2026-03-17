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
  try {
    return JSON.parse(fs.readFileSync(SCHEDULING_CONFIG, 'utf8'));
  } catch {
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
 */
function canDispatchJobs(priority?: string): { allowed: boolean; reason: string } {
  // Check outage state first (takes priority over peak scheduling)
  try {
    const outageStatePath = path.join(ROOT, 'configs', 'outage.json');
    if (fs.existsSync(outageStatePath)) {
      const outageState = JSON.parse(fs.readFileSync(outageStatePath, 'utf8'));
      if (outageState.outage) {
        const since = outageState.outageSince
          ? ` since ${new Date(outageState.outageSince).toLocaleTimeString('en-US', { timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit' })}`
          : '';
        return { allowed: false, reason: `Anthropic API outage detected${since} — probing for recovery` };
      }
    }
  } catch { /* ignore, proceed normally */ }

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
