#!/usr/bin/env node
import fs = require('fs');
import path = require('path');
import type { SupervisorCycleSummary } from '../types';
const { ROOT, runSupervisorCycle, recoverOrphanedJobs } = require('../lib/jobs');

const args: string[] = process.argv.slice(2);

function getArg(name: string, fallback: string | number | null = null): string | number | null {
  const prefix = `${name}=`;
  const exact = args.find((arg) => arg.startsWith(prefix));
  return exact ? exact.slice(prefix.length) : fallback;
}

function hasFlag(flag: string): boolean {
  return args.includes(flag);
}

const intervalMs: number = Number(getArg('--interval', process.env.CCP_SUPERVISOR_INTERVAL_MS || 15000));
const maxConcurrent: number = Number(getArg('--max-concurrent', process.env.CCP_MAX_CONCURRENT || 1));
const once: boolean = hasFlag('--once');
const stateDir: string = path.join(ROOT, 'supervisor', 'daemon');
const heartbeatFile: string = path.join(stateDir, 'heartbeat.json');
const shutdownFile: string = path.join(stateDir, 'shutdown.json');

fs.mkdirSync(stateDir, { recursive: true });

// ── Graceful shutdown handling ──
// On SIGTERM/SIGINT: stop scheduling new cycles, write a shutdown marker,
// and let any in-flight cycle finish before exiting.
let shuttingDown = false;
let cycleInProgress = false;

function writeShutdownMarker(signal: string): void {
  const marker = {
    signal,
    pid: process.pid,
    at: new Date().toISOString(),
    cycleWasInProgress: cycleInProgress,
  };
  fs.writeFileSync(shutdownFile, JSON.stringify(marker, null, 2) + '\n');
  process.stdout.write(`[supervisor] shutdown marker written: ${JSON.stringify(marker)}\n`);
}

function handleShutdown(signal: string): void {
  if (shuttingDown) {
    process.stdout.write(`[supervisor] already shutting down, ignoring ${signal}\n`);
    return;
  }
  shuttingDown = true;
  process.stdout.write(`[supervisor] received ${signal} — stopping after current cycle completes\n`);
  writeShutdownMarker(signal);
  if (!cycleInProgress) {
    process.stdout.write('[supervisor] no cycle in progress, exiting now\n');
    process.exit(0);
  }
  // If a cycle is in progress, it will check `shuttingDown` and exit after completing
}

process.on('SIGTERM', () => handleShutdown('SIGTERM'));
process.on('SIGINT', () => handleShutdown('SIGINT'));

function writeHeartbeat(payload: SupervisorCycleSummary): void {
  fs.writeFileSync(heartbeatFile, JSON.stringify(payload, null, 2) + '\n');
}

async function cycle(): Promise<SupervisorCycleSummary> {
  cycleInProgress = true;
  const result: SupervisorCycleSummary = await runSupervisorCycle({ maxConcurrent });
  writeHeartbeat(result);
  process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  cycleInProgress = false;
  return result;
}

// ── Startup: recover orphaned jobs from previous unclean shutdown ──
async function startupRecovery(): Promise<void> {
  // Check for shutdown marker from previous run
  if (fs.existsSync(shutdownFile)) {
    try {
      const marker = JSON.parse(fs.readFileSync(shutdownFile, 'utf8'));
      process.stdout.write(`[supervisor] previous shutdown detected: ${JSON.stringify(marker)}\n`);
    } catch { /* ignore corrupt marker */ }
    // Remove the marker — we're starting fresh
    try { fs.unlinkSync(shutdownFile); } catch { /* ignore */ }
  }

  // Sweep all running jobs and finalize any with dead tmux sessions
  try {
    const recovered = await recoverOrphanedJobs();
    if (recovered.length > 0) {
      process.stdout.write(`[supervisor] startup recovery: finalized ${recovered.length} orphaned job(s): ${recovered.join(', ')}\n`);
    }
  } catch (err) {
    process.stderr.write(`[supervisor] startup recovery error: ${(err as Error).message}\n`);
  }
}

startupRecovery().then(() => {
  cycle().then(() => {
    if (shuttingDown) {
      process.stdout.write('[supervisor] shutdown complete after cycle\n');
      process.exit(0);
    }
    if (!once) scheduleNext();
  }).catch((error: Error) => {
    process.stderr.write(`${error.stack || error.message}\n`);
    process.exit(1);
  });
}).catch((error: Error) => {
  process.stderr.write(`[supervisor] startup recovery failed: ${error.stack || error.message}\n`);
  process.exit(1);
});

function scheduleNext(): void {
  if (shuttingDown) {
    process.stdout.write('[supervisor] shutdown requested, not scheduling next cycle\n');
    process.exit(0);
  }
  setTimeout(() => {
    if (shuttingDown) {
      process.stdout.write('[supervisor] shutdown requested, exiting\n');
      process.exit(0);
    }
    cycle().then(() => {
      if (shuttingDown) {
        process.stdout.write('[supervisor] shutdown complete after cycle\n');
        process.exit(0);
      }
      scheduleNext();
    }).catch((error: Error) => {
      process.stderr.write(`${error.stack || error.message}\n`);
      if (shuttingDown) process.exit(1);
      scheduleNext();
    });
  }, intervalMs);
}
