/**
 * Auto-onboard a GitHub repo into CCP.
 * Clones the repo, adds to repos.json, creates GitHub webhook,
 * enables auto-merge + delete-branch-on-merge.
 */

import fs = require('fs');
import path = require('path');
import { execFile } from 'child_process';
import { promisify } from 'util';
const { loadConfig, saveConfig } = require('./config');

const execFileAsync = promisify(execFile);
const REPOS_DIR = process.env.CCP_REPOS_DIR || path.join(process.env.HOME || '/tmp', 'repos');

interface OnboardResult {
  ok: boolean;
  key: string;
  ownerRepo: string;
  localPath: string;
  steps: Array<{ name: string; result: string; ok: boolean }>;
  error?: string;
}

async function run(cmd: string, args: string[], opts: Record<string, unknown> = {}): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  try {
    const { stdout, stderr } = await execFileAsync(cmd, args, { timeout: 30_000, encoding: 'utf8', ...opts } as Parameters<typeof execFileAsync>[2]);
    return { ok: true, stdout: String(stdout || '').trim(), stderr: String(stderr || '').trim() };
  } catch (e: unknown) {
    const err = e as { stdout?: string; stderr?: string; message?: string };
    return { ok: false, stdout: (err.stdout || '').trim(), stderr: (err.stderr || err.message || '').trim() };
  }
}

export async function onboardRepo(ownerRepo: string): Promise<OnboardResult> {
  const [owner, name] = ownerRepo.split('/');
  if (!owner || !name) {
    return { ok: false, key: '', ownerRepo, localPath: '', steps: [], error: 'Invalid owner/repo format' };
  }

  const key = name.toLowerCase();
  const localPath = path.join(REPOS_DIR, name);
  const steps: OnboardResult['steps'] = [];

  // Check if already onboarded
  const repos = loadConfig('repos', { mappings: [] }) as { mappings: Array<Record<string, unknown>> };
  const existing = repos.mappings.find((m) => m.ownerRepo === ownerRepo || m.key === key);
  if (existing) {
    return {
      ok: true,
      key: existing.key as string,
      ownerRepo,
      localPath: existing.localPath as string,
      steps: [{ name: 'Check existing', result: `Already onboarded as '${existing.key}'`, ok: true }],
    };
  }

  // 1. Verify repo exists on GitHub
  const check = await run('gh', ['api', `repos/${ownerRepo}`, '--jq', '.full_name']);
  if (!check.ok || !check.stdout) {
    return { ok: false, key, ownerRepo, localPath, steps: [{ name: 'Verify repo', result: `Not found: ${check.stderr}`, ok: false }], error: `Repo not found on GitHub: ${ownerRepo}` };
  }
  steps.push({ name: 'Verify repo', result: `Found ${check.stdout}`, ok: true });

  // 2. Clone (use gh repo clone for HTTPS auth, fallback to SSH)
  if (!fs.existsSync(localPath)) {
    const clone = await run('gh', ['repo', 'clone', ownerRepo, localPath]);
    if (!clone.ok) {
      return { ok: false, key, ownerRepo, localPath, steps: [...steps, { name: 'Clone', result: clone.stderr, ok: false }], error: 'Clone failed' };
    }
    steps.push({ name: 'Clone', result: `Cloned to ${localPath}`, ok: true });
  } else {
    steps.push({ name: 'Clone', result: `Already exists at ${localPath}`, ok: true });
  }

  // 3. Add to repos.json
  repos.mappings.push({
    key,
    ownerRepo,
    gitUrl: `git@github.com:${ownerRepo}.git`,
    localPath,
    aliases: [key],
    autoMerge: true,
    mergeMethod: 'squash',
  });
  saveConfig('repos', repos);
  steps.push({ name: 'repos.json', result: `Added '${key}'`, ok: true });

  // 4. Enable auto-merge + delete-branch-on-merge
  const amResult = await run('gh', ['api', `repos/${ownerRepo}`, '-X', 'PATCH',
    '-F', 'allow_auto_merge=true', '-F', 'delete_branch_on_merge=true']);
  steps.push({ name: 'GitHub settings', result: amResult.ok ? 'Auto-merge + delete-branch enabled' : `Failed: ${amResult.stderr.slice(0, 100)}`, ok: amResult.ok });

  // 5. Create GitHub webhook
  const funnelUrl = process.env.CCP_FUNNEL_URL || '';
  if (funnelUrl) {
    const webhookUrl = `${funnelUrl}/webhook/github`;
    const existingHook = await run('gh', ['api', `repos/${ownerRepo}/hooks`, '--jq',
      `[.[] | select(.config.url == "${webhookUrl}")] | length`]);

    if (existingHook.stdout === '0') {
      const whResult = await run('gh', ['api', `repos/${ownerRepo}/hooks`, '--method', 'POST',
        '-f', 'name=web', '-F', 'active=true',
        '-f', 'events[]=check_run', '-f', 'events[]=pull_request',
        '-f', `config[url]=${webhookUrl}`, '-f', 'config[content_type]=json',
      ]);
      if (whResult.ok) {
        try { const id = JSON.parse(whResult.stdout).id; steps.push({ name: 'Webhook', result: `Created #${id}`, ok: true }); }
        catch { steps.push({ name: 'Webhook', result: 'Created', ok: true }); }
      } else {
        steps.push({ name: 'Webhook', result: `Failed: ${whResult.stderr.slice(0, 100)}`, ok: false });
      }
    } else {
      steps.push({ name: 'Webhook', result: 'Already exists', ok: true });
    }
  } else {
    steps.push({ name: 'Webhook', result: 'Skipped (no CCP_FUNNEL_URL)', ok: false });
  }

  console.log(`[onboard] ${ownerRepo}: ${steps.map(s => `${s.name}=${s.ok ? '✓' : '✗'}`).join(', ')}`);
  return { ok: true, key, ownerRepo, localPath, steps };
}

module.exports = { onboardRepo };
export { onboardRepo as default };
