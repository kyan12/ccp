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
    autoMerge: false,
    mergeMethod: 'squash',
  });
  saveConfig('repos', repos);
  steps.push({ name: 'repos.json', result: `Added '${key}'`, ok: true });

  // GitHub lifecycle automation is native-Kanban-owned. Never mutate repo
  // auto-merge settings or install a hook back to the retired CCP endpoint.
  steps.push({ name: 'GitHub lifecycle', result: 'Skipped (owned by native Hermes Kanban)', ok: true });

  console.log(`[onboard] ${ownerRepo}: ${steps.map(s => `${s.name}=${s.ok ? '✓' : '✗'}`).join(', ')}`);
  return { ok: true, key, ownerRepo, localPath, steps };
}

module.exports = { onboardRepo };
export { onboardRepo as default };
