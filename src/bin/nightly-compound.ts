#!/usr/bin/env node
/**
 * Nightly Compound Dispatch
 */
import fs = require('fs');
import path = require('path');
import type { RepoMapping, JobPacket, NightlyConfig } from '../types';
const { createJob } = require('../lib/jobs');

const ROOT: string = path.resolve(process.env.CCP_ROOT || path.join(__dirname, '..', '..'));
const REPOS_FILE: string = path.join(ROOT, 'configs', 'repos.json');

function loadRepos(): { mappings: RepoMapping[] } {
  return JSON.parse(fs.readFileSync(REPOS_FILE, 'utf8'));
}

function buildCompoundPrompt(repo: RepoMapping): string {
  const branch = repo.nightly?.branch || 'main';
  return [
    `You are running a nightly compound review for the ${repo.key} project.`,
    '',
    '## Phase 1: Sync & Orientation',
    `1. Run: git fetch origin && git checkout ${branch} && git pull origin ${branch}`,
    '2. Read CLAUDE.md (or similar project docs) to understand priorities and conventions.',
    '3. Review the last 5-10 commits with: git log --oneline -10',
    '4. Check for any open PRs or recent CI failures if gh CLI is available.',
    '',
    '## Phase 2: Learning Extraction',
    '5. Review the recent commits and code changes. Identify:',
    '   - Patterns worth reinforcing (good practices)',
    '   - Mistakes or anti-patterns to avoid',
    '   - Incomplete work or TODO items left behind',
    '6. If a LEARNINGS.md or similar file exists, append new insights.',
    '   If not, create one with your findings.',
    '',
    '## Phase 3: Implementation',
    '7. Based on CLAUDE.md priorities, recent context, and your review:',
    '   - Pick the SINGLE highest-impact item you can complete in this session.',
    '   - Prefer: bug fixes > small features > refactors > documentation.',
    '   - Do NOT start work you cannot finish. Scope tightly.',
    `8. Create a feature branch from ${branch}: git checkout -b nightly/<short-description>`,
    '9. Implement the change with proper tests if the project has a test framework.',
    '10. Commit with a clear message referencing what you implemented and why.',
    '',
    '## Phase 4: Ship',
    '11. Push the branch: git push origin HEAD',
    '12. If gh CLI is available, create a draft PR with a clear description.',
    `13. Switch back to ${branch}: git checkout ${branch}`,
    '',
    '## Constraints',
    '- Make only the minimum necessary changes.',
    '- Do NOT modify CI/CD configs, deployment files, or environment configs unless that IS the priority.',
    '- If you cannot find anything meaningful to implement, just complete Phase 1-2 (learning extraction) and report.',
    '- If blocked on permissions or unclear requirements, report the blocker clearly.',
    '',
    '## Output',
    'At the end, output a final compact summary with these exact labels on separate lines:',
    'State: <coded/blocked>',
    'Commit: <hash or none>',
    'Prod: <yes/no>',
    'Verified: <exact test or not yet>',
    'Blocker: <reason or none>',
    'Learning: <one-line summary of key insight from review>',
    'Implemented: <one-line summary of what you built, or "review only">',
  ].join('\n');
}

function buildPacket(repo: RepoMapping): JobPacket {
  const now = new Date().toISOString();
  const dateStr = now.slice(0, 10);
  const jobId = `nightly_${repo.key}_${dateStr}`.replace(/[^a-zA-Z0-9_-]/g, '_');

  return {
    job_id: jobId,
    ticket_id: `NIGHTLY-${repo.key}`,
    repo: repo.localPath,
    repoKey: repo.key,
    ownerRepo: repo.ownerRepo || null,
    gitUrl: repo.gitUrl || null,
    repoResolved: true,
    goal: `Nightly compound: review recent work, extract learnings, implement top priority for ${repo.key}`,
    source: 'nightly',
    kind: 'compound',
    label: 'nightly',
    acceptance_criteria: [buildCompoundPrompt(repo)],
    constraints: [
      'Complete within timeout. Prefer shipping a small change over starting something large.',
      'Do not ask for approval or present options. Make the best decision and implement it.',
    ],
    verification_steps: [],
    created_at: now,
    nightly: {
      branch: repo.nightly?.branch || 'main',
      timeoutSec: repo.nightly?.timeoutSec || 900,
    },
  };
}

function main(): void {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const listOnly = args.includes('--list');
  const repoFlag = args.indexOf('--repo');
  const singleRepo = repoFlag >= 0 ? args[repoFlag + 1] : null;

  const { mappings } = loadRepos();
  const nightlyRepos = mappings.filter((r) => {
    if (!r.nightly?.enabled) return false;
    if (singleRepo) return r.key === singleRepo;
    return true;
  });

  if (listOnly) {
    console.log('Nightly-eligible repos:');
    for (const r of mappings) {
      const status = r.nightly?.enabled ? '✅ enabled' : '❌ disabled';
      const branch = r.nightly?.branch || 'n/a';
      console.log(`  ${r.key}: ${status} (branch: ${branch})`);
    }
    return;
  }

  if (nightlyRepos.length === 0) {
    console.log('No nightly-eligible repos found.');
    if (singleRepo) console.log(`Repo "${singleRepo}" not found or nightly not enabled.`);
    process.exit(0);
  }

  const today = new Date().toISOString().slice(0, 10);
  const JOBS_DIR = path.join(ROOT, 'jobs');
  const existingToday = new Set<string>();
  if (fs.existsSync(JOBS_DIR)) {
    for (const d of fs.readdirSync(JOBS_DIR)) {
      if (d.startsWith('nightly_') && d.includes(today)) {
        existingToday.add(d);
      }
    }
  }

  const results: Array<Record<string, unknown>> = [];

  for (const repo of nightlyRepos) {
    const packet = buildPacket(repo);

    if (existingToday.has(packet.job_id)) {
      console.log(`⏭ ${repo.key}: already dispatched today (${packet.job_id})`);
      results.push({ repo: repo.key, skipped: true, reason: 'already dispatched today' });
      continue;
    }

    if (!fs.existsSync(repo.localPath)) {
      console.log(`⚠ ${repo.key}: local path missing (${repo.localPath}), skipping`);
      results.push({ repo: repo.key, skipped: true, reason: 'local path missing' });
      continue;
    }

    if (dryRun) {
      console.log(`[dry-run] Would create job: ${packet.job_id}`);
      console.log(`  Repo: ${repo.localPath}`);
      console.log(`  Branch: ${packet.nightly!.branch}`);
      console.log(`  Timeout: ${packet.nightly!.timeoutSec}s`);
      results.push({ repo: repo.key, dryRun: true, job_id: packet.job_id });
      continue;
    }

    const created = createJob(packet);
    console.log(`✅ ${repo.key}: job created → ${created.jobId}`);
    results.push({ repo: repo.key, ok: true, job_id: created.jobId });
  }

  console.log('\n' + JSON.stringify({ dispatched: results }, null, 2));
}

main();
