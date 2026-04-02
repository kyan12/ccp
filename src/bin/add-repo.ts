#!/usr/bin/env node
'use strict';

/**
 * ccp add-repo — One command to wire a new repo into the control plane.
 *
 * Usage:
 *   node src/bin/add-repo.js --repo owner/name [options]
 *
 * Options:
 *   --repo owner/name          GitHub owner/repo (required)
 *   --key short-name           Short key for job IDs (default: repo name)
 *   --path /local/path         Local clone path (default: ~/repos/<name>)
 *   --aliases "a,b,c"          Comma-separated aliases
 *   --auto-merge               Enable auto-merge (default: false)
 *   --merge-method squash      Merge method: squash|merge|rebase (default: squash)
 *   --nightly                  Enable nightly runs
 *   --sentry-project slug      Sentry project slug to map
 *   --vercel-project id        Vercel project ID to map
 *   --linear-team PRO          Linear team key for routing
 *   --skip-clone               Don't clone the repo
 *   --skip-webhook             Don't create GitHub webhook
 *   --dry-run                  Show what would be done without doing it
 */

import fs = require('fs');
import path = require('path');
import { spawnSync } from 'child_process';

const ROOT = path.resolve(__dirname, '../..');
const CONFIGS = path.join(ROOT, 'configs');

interface RunResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

function run(cmd: string, args: string[], opts: Record<string, unknown> = {}): RunResult {
  const r = spawnSync(cmd, args, { encoding: 'utf8', ...opts });
  return { status: r.status, stdout: (r.stdout || '').trim(), stderr: (r.stderr || '').trim() };
}

interface AddRepoOpts {
  repo?: string;
  key?: string;
  path?: string;
  aliases?: string;
  autoMerge?: boolean;
  mergeMethod?: string;
  nightly?: boolean;
  sentryProject?: string;
  vercelProject?: string;
  linearTeam?: string;
  skipClone?: boolean;
  skipWebhook?: boolean;
  dryRun?: boolean;
}

function parseArgs(): AddRepoOpts {
  const args = process.argv.slice(2);
  const opts: Record<string, unknown> = {};
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--dry-run') { opts.dryRun = true; continue; }
    if (arg === '--auto-merge') { opts.autoMerge = true; continue; }
    if (arg === '--nightly') { opts.nightly = true; continue; }
    if (arg === '--skip-clone') { opts.skipClone = true; continue; }
    if (arg === '--skip-webhook') { opts.skipWebhook = true; continue; }
    if (arg.startsWith('--') && i + 1 < args.length) {
      const key = arg.slice(2).replace(/-([a-z])/g, (_: string, c: string) => c.toUpperCase());
      opts[key] = args[++i];
    }
  }
  return opts as AddRepoOpts;
}

function loadJson(filePath: string): Record<string, unknown> | null {
  try { return JSON.parse(fs.readFileSync(filePath, 'utf8')); }
  catch { return null; }
}

function saveJson(filePath: string, data: unknown): void {
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2) + '\n');
}

interface Step {
  name: string;
  run: () => string;
}

function main(): void {
  const opts = parseArgs();

  if (!opts.repo) {
    console.error('Usage: node src/bin/add-repo.js --repo owner/name [options]');
    process.exit(1);
  }

  const [owner, name] = opts.repo.split('/');
  if (!owner || !name) {
    console.error('Error: --repo must be in owner/name format');
    process.exit(1);
  }

  const key = opts.key || name.toLowerCase();
  const localPath = opts.path || path.join(process.env.HOME || '/tmp', 'repos', name);
  const aliases = opts.aliases ? opts.aliases.split(',').map(a => a.trim()) : [name.toLowerCase()];
  const mergeMethod = opts.mergeMethod || 'squash';
  const dryRun = opts.dryRun || false;

  const steps: Step[] = [];

  // 1. Clone repo
  if (!opts.skipClone && !fs.existsSync(localPath)) {
    steps.push({
      name: 'Clone repo',
      run: () => {
        const gitUrl = `git@github.com:${opts.repo}.git`;
        console.log(`  Cloning ${gitUrl} → ${localPath}`);
        const r = run('git', ['clone', gitUrl, localPath]);
        if (r.status !== 0) throw new Error(`git clone failed: ${r.stderr}`);
        return `Cloned to ${localPath}`;
      }
    });
  } else if (fs.existsSync(localPath)) {
    console.log(`✓ Repo already cloned at ${localPath}`);
  }

  // 2. Add to repos.json
  steps.push({
    name: 'Add to repos.json',
    run: () => {
      const reposFile = path.join(CONFIGS, 'repos.json');
      const repos = (loadJson(reposFile) || { mappings: [] }) as { mappings: Record<string, unknown>[] };

      const existing = repos.mappings.find((m: Record<string, unknown>) => m.key === key);
      if (existing) return `Already exists as '${key}'`;

      const entry: Record<string, unknown> = {
        key,
        ownerRepo: opts.repo,
        gitUrl: `git@github.com:${opts.repo}.git`,
        localPath,
        aliases,
        autoMerge: opts.autoMerge || false,
        mergeMethod,
      };
      if (opts.nightly) {
        entry.nightly = { enabled: true, branch: 'main', timeoutSec: 1200 };
      }

      repos.mappings.push(entry);
      saveJson(reposFile, repos);
      return `Added '${key}' (${opts.repo})`;
    }
  });

  // 3. Create GitHub webhook
  if (!opts.skipWebhook) {
    steps.push({
      name: 'Create GitHub webhook',
      run: () => {
        const funnelUrl = process.env.CCP_FUNNEL_URL || '';
        if (!funnelUrl) return 'Skipped (set CCP_FUNNEL_URL env var)';
        const webhookUrl = `${funnelUrl}/webhook/github`;

        const existing = run('gh', ['api', `repos/${opts.repo}/hooks`, '--jq',
          `[.[] | select(.config.url == "${webhookUrl}")] | length`]);
        if (existing.stdout !== '0') return 'Webhook already exists';

        const payload = JSON.stringify({
          name: 'web', active: true,
          events: ['check_run', 'pull_request'],
          config: { url: webhookUrl, content_type: 'json' }
        });

        const r = run('gh', ['api', `repos/${opts.repo}/hooks`, '--method', 'POST', '--input', '-'], { input: payload });
        if (r.status !== 0) throw new Error(`Webhook creation failed: ${r.stderr}`);
        try {
          const id = JSON.parse(r.stdout).id;
          return `Created webhook #${id} → ${webhookUrl}`;
        } catch { return `Created webhook → ${webhookUrl} (could not parse response)`; }
      }
    });
  }

  // 4. Auto-discover Sentry project
  steps.push({
    name: 'Discover Sentry project',
    run: () => {
      const sentryFile = path.join(CONFIGS, 'sentry.json');
      const sentry = (loadJson(sentryFile) || { projects: {} }) as { org?: string; projects: Record<string, unknown> };

      if (opts.sentryProject) {
        sentry.projects[opts.sentryProject] = { repoKey: key };
        saveJson(sentryFile, sentry);
        return `Mapped '${opts.sentryProject}' → '${key}'`;
      }

      const sentryToken = process.env.SENTRY_AUTH_TOKEN;
      if (!sentryToken) return 'Skipped (no SENTRY_AUTH_TOKEN)';
      const sentryOrg = sentry.org || '';
      if (!sentryOrg) return 'Skipped (no sentry org in config)';

      const r = run('curl', ['-sf', '-H', `Authorization: Bearer ${sentryToken}`,
        `https://sentry.io/api/0/organizations/${sentryOrg}/projects/`]);
      if (r.status !== 0) return 'Skipped (Sentry API error)';

      try {
        const projects = JSON.parse(r.stdout) as { slug: string; name: string }[];
        const match = projects.find(p => p.slug === name.toLowerCase() || p.slug === key);
        if (match) {
          sentry.projects[match.slug] = { repoKey: key };
          saveJson(sentryFile, sentry);
          return `Auto-discovered '${match.slug}' → '${key}'`;
        }
        return `No match found (${projects.length} projects checked)`;
      } catch { return 'Skipped (parse error)'; }
    }
  });

  // 5. Auto-discover Vercel project
  steps.push({
    name: 'Discover Vercel project',
    run: () => {
      const vercelFile = path.join(CONFIGS, 'vercel.json');
      const vercel = (loadJson(vercelFile) || { projects: {} }) as { teamId?: string; projects: Record<string, unknown> };

      if (opts.vercelProject) {
        vercel.projects[opts.vercelProject] = { repoKey: key };
        saveJson(vercelFile, vercel);
        return `Mapped '${opts.vercelProject}' → '${key}'`;
      }

      const vercelToken = process.env.VERCEL_TOKEN;
      if (!vercelToken) return 'Skipped (no VERCEL_TOKEN)';
      const teamParam = vercel.teamId ? `&teamId=${vercel.teamId}` : '';

      const r = run('curl', ['-sf', '-H', `Authorization: Bearer ${vercelToken}`,
        `https://api.vercel.com/v9/projects?limit=100${teamParam}`]);
      if (r.status !== 0) return 'Skipped (Vercel API error)';

      try {
        const data = JSON.parse(r.stdout) as { projects: { id: string; name: string; link?: { repo?: string } }[] };
        const match = data.projects.find(p =>
          (p.link?.repo?.toLowerCase() === `${owner}/${name}`.toLowerCase()) ||
          p.name === name.toLowerCase() || p.name === key
        );
        if (match) {
          vercel.projects[match.id] = { repoKey: key, name: match.name };
          saveJson(vercelFile, vercel);
          return `Auto-discovered '${match.name}' (${match.id}) → '${key}'`;
        }
        return `No match found (${data.projects.length} projects checked)`;
      } catch { return 'Skipped (parse error)'; }
    }
  });

  // 6. Enable auto-delete branch on merge
  steps.push({
    name: 'Enable auto-delete branch on GitHub',
    run: () => {
      const r = run('gh', ['repo', 'edit', opts.repo!, '--delete-branch-on-merge=true']);
      if (r.status !== 0) return `Warning: ${r.stderr}`;
      return 'Enabled';
    }
  });

  // 7. Enable allow_auto_merge if requested
  if (opts.autoMerge) {
    steps.push({
      name: 'Enable allow_auto_merge on GitHub',
      run: () => {
        const r = run('gh', ['api', `repos/${opts.repo}`, '--method', 'PATCH', '--field', 'allow_auto_merge=true']);
        if (r.status !== 0) return `Warning: ${r.stderr}`;
        return 'Enabled';
      }
    });
  }

  // Execute
  console.log(`\n☭ CCP — Adding repo: ${opts.repo}\n`);

  if (dryRun) {
    console.log('DRY RUN — would execute:\n');
    for (const step of steps) console.log(`  [ ] ${step.name}`);
    console.log(`\nRun without --dry-run to execute.`);
    return;
  }

  let failed = false;
  for (const step of steps) {
    try {
      const result = step.run();
      console.log(`  ✓ ${step.name}: ${result}`);
    } catch (err) {
      console.error(`  ✗ ${step.name}: ${(err as Error).message}`);
      failed = true;
    }
  }

  console.log(failed ? '\n⚠️  Completed with errors.' : '\n✅ Done. Repo is wired into the control plane.');
}

main();
