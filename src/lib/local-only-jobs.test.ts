import fs = require('fs');
import os = require('os');
import path = require('path');
import assert = require('assert');
import { spawnSync } from 'child_process';
import type { JobPacket } from '../types';

function writeExecutable(file: string, body: string): void {
  fs.writeFileSync(file, body, { mode: 0o755 });
}

function git(repo: string, args: string[]): string {
  const out = spawnSync('git', args, { cwd: repo, encoding: 'utf8' });
  if (out.status !== 0) throw new Error(out.stderr || out.stdout || `git ${args.join(' ')} failed`);
  return (out.stdout || '').trim();
}

function loadJobs(root: string, repo: string, networkMarker: string) {
  const fakeBin = path.join(root, 'bin');
  fs.mkdirSync(fakeBin, { recursive: true });
  writeExecutable(path.join(fakeBin, 'tmux'), '#!/usr/bin/env bash\nexit 0\n');
  writeExecutable(path.join(fakeBin, 'claude'), '#!/usr/bin/env bash\nif [ "$1" = "--version" ]; then echo "claude fixture"; exit 0; fi\ncat >/dev/null\n');
  for (const command of ['gh', 'curl']) {
    writeExecutable(path.join(fakeBin, command), `#!/usr/bin/env bash\nprintf '%s\\n' ${command} >> ${JSON.stringify(networkMarker)}\nexit 97\n`);
  }

  fs.mkdirSync(path.join(root, 'configs'), { recursive: true });
  fs.writeFileSync(path.join(root, 'configs', 'repos.json'), JSON.stringify({
    mappings: [{
      key: 'fixture-local',
      localPath: repo,
      aliases: ['fixture local'],
      localOnly: true,
      worktree: false,
      parallelJobs: 1,
      autoMerge: false,
    }],
  }, null, 2) + '\n');

  const discordPath = require.resolve('./discord');
  const jobsPath = require.resolve('./jobs');
  const reposPath = require.resolve('./repos');
  const configPath = require.resolve('./config');
  for (const modulePath of [jobsPath, reposPath, configPath, discordPath]) delete require.cache[modulePath];
  require.cache[discordPath] = {
    id: discordPath,
    filename: discordPath,
    loaded: true,
    exports: {
      inspectDiscordTransport: () => ({ transport: 'none', apiOk: false, error: 'fixture transport disabled' }),
      hasDiscordTransport: () => false,
      sendDiscordMessage: () => ({ ok: false, stdout: '', stderr: 'fixture transport disabled', messageId: null }),
      createDiscordThread: () => ({ ok: false, stdout: '', stderr: 'fixture transport disabled', threadId: null }),
    },
  } as NodeJS.Module;

  process.env.CCP_ROOT = root;
  process.env.CCP_AGENT = 'claude-code';
  process.env.PATH = `${fakeBin}${path.delimiter}${process.env.PATH || ''}`;
  return require('./jobs') as typeof import('./jobs');
}

function makeHarness() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ccp-local-only-'));
  const repo = path.join(root, 'repo');
  const networkMarker = path.join(root, 'network-called.log');
  fs.mkdirSync(repo);
  git(repo, ['init', '-q', '-b', 'main']);
  git(repo, ['config', 'user.useConfigOnly', 'true']);
  git(repo, ['config', 'user.name', 'kyan12']);
  git(repo, ['config', 'user.email', 'kevyan1998@gmail.com']);
  fs.writeFileSync(path.join(repo, 'README.md'), 'fixture\n');
  git(repo, ['add', 'README.md']);
  git(repo, ['commit', '-qm', 'fixture init']);
  const jobs = loadJobs(root, repo, networkMarker);
  const create = (name: string): string => {
    const packet: JobPacket = {
      job_id: `local_${name}`,
      ticket_id: `LOCAL-${name}`,
      repo,
      repoKey: 'fixture-local',
      localOnly: true,
      goal: 'Deterministic local-only fixture',
      source: 'hermes-kanban',
      kind: 'task',
      label: 'fixture',
    };
    return jobs.createJob(packet).jobId;
  };
  return { root, repo, networkMarker, jobs, create };
}

async function main(): Promise<void> {
  const oldEnv = { ...process.env };
  try {
    const h = makeHarness();
    console.log('\nTest: local-only preflight rejects a dirty canonical checkout precisely');
    {
      const jobId = h.create('dirty');
      fs.writeFileSync(path.join(h.repo, 'uncommitted.txt'), 'dirty\n');
      const result = h.jobs.startJob(jobId) as { ok: boolean; blocked?: boolean; reason?: string };
      assert.equal(result.ok, false);
      assert.equal(result.blocked, true);
      assert.match(result.reason || '', /local-only repo must be clean before dispatch/);
      assert.match(result.reason || '', /uncommitted\.txt/);
      fs.unlinkSync(path.join(h.repo, 'uncommitted.txt'));
    }

    console.log('\nTest: local-only preflight rejects a configured Git remote');
    {
      const jobId = h.create('remote');
      git(h.repo, ['remote', 'add', 'origin', path.join(h.root, 'forbidden-remote.git')]);
      const result = h.jobs.startJob(jobId) as { ok: boolean; blocked?: boolean; reason?: string };
      assert.equal(result.ok, false);
      assert.equal(result.blocked, true);
      assert.match(result.reason || '', /local-only repo must not configure Git remotes: origin/);
      git(h.repo, ['remote', 'remove', 'origin']);
    }

    console.log('\nTest: local-only worker uses canonical identity and no remote bootstrap commands');
    {
      const jobId = h.create('shell');
      const result = h.jobs.startJob(jobId) as { ok: boolean };
      assert.equal(result.ok, true);
      const script = fs.readFileSync(path.join(h.root, 'jobs', jobId, 'worker.sh'), 'utf8');
      assert.match(script, /GIT_AUTHOR_NAME='kyan12'/);
      assert.match(script, /GIT_AUTHOR_EMAIL='kevyan1998@gmail\.com'/);
      assert.match(script, /GIT_CONFIG_KEY_0=user\.useConfigOnly/);
      assert.match(script, /GIT_CONFIG_VALUE_0=true/);
      assert.doesNotMatch(script, /git fetch|git reset --hard origin|git pull --ff-only|gh pr|git push/);
      assert.equal(h.jobs.loadStatus(jobId).localOnlyInitialHead, git(h.repo, ['rev-parse', 'HEAD']), 'dispatch persists the pre-worker HEAD');
      assert.equal(fs.existsSync(h.networkMarker), false, 'preflight/start performs no external network commands');
    }

    console.log('\nTest: deterministic local-only no-op finalizes with an explicit completion handoff');
    {
      const jobId = h.create('canary');
      const head = git(h.repo, ['rev-parse', 'HEAD']);
      h.jobs.saveStatus(jobId, {
        state: 'running',
        started_at: new Date().toISOString(),
        tmux_session: null,
        localOnlyInitialHead: head,
      });
      fs.appendFileSync(path.join(h.root, 'jobs', jobId, 'worker.log'), [
        'State: verified',
        'Commit: none',
        'Prod: no',
        'Verified: PASS',
        `TestEvidence: ${JSON.stringify({ command: 'fixture canary', exitCode: 0 })}`,
        'Review: PASS',
        `ReviewEvidence: ${JSON.stringify({ verdict: 'PASS', reviewer: 'independent fixture', sha: head })}`,
        'Blocker: none',
        'Risk: low',
        'Summary: No changes needed; fixture is already complete',
        'WORKER_EXIT_CODE: 0',
      ].join('\n') + '\n');
      const finalized = await h.jobs.finalizeJob(jobId);
      assert.equal(finalized.state, 'no-op');
      assert.deepEqual(finalized.result.handoff, {
        action: 'complete',
        repoPath: h.repo,
        commit: null,
        tests: JSON.stringify({ command: 'fixture canary', exitCode: 0 }),
        review: JSON.stringify({ verdict: 'PASS', reviewer: 'independent fixture', sha: head }),
      });
      assert.equal(finalized.result.pr_url, null);
      assert.equal(finalized.result.pushed, 'unknown');
      assert.equal(fs.existsSync(h.networkMarker), false, 'finalization performs no GitHub, deployment, or remote writes');
      const persisted = h.jobs.readJson(h.jobs.resultPath(jobId));
      assert.equal((persisted.handoff as Record<string, unknown>).action, 'complete');
    }

    console.log('\nTest: local-only blocked finalization preserves dirty user work');
    {
      const jobId = h.create('preserve-dirty');
      const userWork = path.join(h.repo, 'unfinished-user-work.txt');
      fs.writeFileSync(userWork, 'preserve me\n');
      h.jobs.saveStatus(jobId, { state: 'running', started_at: new Date().toISOString(), tmux_session: null });
      fs.appendFileSync(path.join(h.root, 'jobs', jobId, 'worker.log'), [
        'State: blocked',
        'Commit: none',
        'Prod: no',
        'Verified: not yet',
        'Review: not yet',
        'Blocker: local review could not be completed',
        'Risk: medium',
        'Summary: Work remains uncommitted for operator inspection',
        'WORKER_EXIT_CODE: 0',
      ].join('\n') + '\n');
      const finalized = await h.jobs.finalizeJob(jobId);
      assert.equal(finalized.state, 'blocked');
      assert.equal(fs.existsSync(userWork), true, 'local-only finalization never resets or stashes dirty user work');
      assert.match(fs.readFileSync(userWork, 'utf8'), /preserve me/);
      fs.unlinkSync(userWork);
    }

    console.log('\nTest: local-only claimed success is blocked when the canonical checkout ends dirty');
    {
      const jobId = h.create('dirty-success');
      const userWork = path.join(h.repo, 'left-behind-after-success.txt');
      fs.writeFileSync(userWork, 'still dirty\n');
      const commit = git(h.repo, ['rev-parse', 'HEAD']);
      h.jobs.saveStatus(jobId, { state: 'running', started_at: new Date().toISOString(), tmux_session: null });
      fs.appendFileSync(path.join(h.root, 'jobs', jobId, 'worker.log'), [
        'State: verified',
        `Commit: ${commit}`,
        'Prod: no',
        'Verified: PASS',
        `TestEvidence: ${JSON.stringify({ command: 'fixture tests', exitCode: 0 })}`,
        'Review: PASS',
        `ReviewEvidence: ${JSON.stringify({ verdict: 'PASS', reviewer: 'independent fixture', sha: commit })}`,
        'Blocker: none',
        'Risk: low',
        'Summary: Claimed complete despite uncommitted work',
        'WORKER_EXIT_CODE: 0',
      ].join('\n') + '\n');
      const finalized = await h.jobs.finalizeJob(jobId);
      assert.equal(finalized.state, 'blocked');
      assert.match(finalized.result.blocker || '', /local-only repo is dirty after worker execution/);
      assert.equal(finalized.result.handoff, undefined);
      assert.equal(fs.existsSync(userWork), true, 'dirty success blocker preserves the checkout');
      fs.unlinkSync(userWork);
    }

    console.log('\nTest: local-only completion is bound to actual HEAD and commit author');
    {
      const claimed = git(h.repo, ['rev-parse', 'HEAD']);
      const jobId = h.create('head-binding');
      h.jobs.saveStatus(jobId, {
        state: 'running',
        started_at: new Date().toISOString(),
        tmux_session: null,
        localOnlyInitialHead: claimed,
      });
      fs.writeFileSync(path.join(h.repo, 'unreviewed-commit.txt'), 'unreviewed\n');
      git(h.repo, ['add', 'unreviewed-commit.txt']);
      git(h.repo, ['-c', 'user.useConfigOnly=false', '-c', 'user.name=Mallory', '-c', 'user.email=mallory@example.com', 'commit', '-m', 'unreviewed commit']);
      const actual = git(h.repo, ['rev-parse', 'HEAD']);
      fs.appendFileSync(path.join(h.root, 'jobs', jobId, 'worker.log'), [
        'State: verified',
        `Commit: ${claimed}`,
        'Prod: no',
        'Verified: PASS',
        `TestEvidence: ${JSON.stringify({ command: 'fixture tests', exitCode: 0 })}`,
        'Review: PASS',
        `ReviewEvidence: ${JSON.stringify({ verdict: 'PASS', reviewer: 'independent fixture', sha: claimed })}`,
        'Blocker: none',
        'Risk: low',
        'Summary: Claimed the older reviewed commit',
        'WORKER_EXIT_CODE: 0',
      ].join('\n') + '\n');
      const finalized = await h.jobs.finalizeJob(jobId);
      assert.equal(finalized.state, 'blocked');
      assert.match(finalized.result.blocker || '', /actual HEAD/);
      assert.equal(finalized.result.handoff, undefined);
      assert.equal(git(h.repo, ['rev-parse', 'HEAD']), actual, 'blocked finalization preserves the unreviewed commit');
      git(h.repo, ['reset', '--hard', claimed]);
    }

    console.log('\nTest: nonzero worker exit cannot emit a local-only completion handoff');
    {
      const commit = git(h.repo, ['rev-parse', 'HEAD']);
      const jobId = h.create('nonzero-exit');
      h.jobs.saveStatus(jobId, { state: 'running', started_at: new Date().toISOString(), tmux_session: null });
      fs.appendFileSync(path.join(h.root, 'jobs', jobId, 'worker.log'), [
        'State: verified',
        `Commit: ${commit}`,
        'Prod: no',
        'Verified: PASS',
        `TestEvidence: ${JSON.stringify({ command: 'fixture tests', exitCode: 0 })}`,
        'Review: PASS',
        `ReviewEvidence: ${JSON.stringify({ verdict: 'PASS', reviewer: 'independent fixture', sha: commit })}`,
        'Blocker: none',
        'Risk: low',
        'Summary: Claimed success before crashing',
        'WORKER_EXIT_CODE: 7',
      ].join('\n') + '\n');
      const finalized = await h.jobs.finalizeJob(jobId);
      assert.equal(finalized.exitCode, 7);
      assert.equal(finalized.state, 'blocked');
      assert.match(finalized.result.blocker || '', /worker exited 7/);
      assert.equal(finalized.result.handoff, undefined);
    }

    console.log('\nTest: local-only no-op cannot hide a commit created after dispatch');
    {
      const initialHead = git(h.repo, ['rev-parse', 'HEAD']);
      const jobId = h.create('changed-head-no-op');
      h.jobs.saveStatus(jobId, {
        state: 'running',
        started_at: new Date().toISOString(),
        tmux_session: null,
        localOnlyInitialHead: initialHead,
      } as Parameters<typeof h.jobs.saveStatus>[1]);
      fs.writeFileSync(path.join(h.repo, 'hidden-commit.txt'), 'changed after dispatch\n');
      git(h.repo, ['add', 'hidden-commit.txt']);
      git(h.repo, ['commit', '-qm', 'hidden local-only commit']);
      const actualHead = git(h.repo, ['rev-parse', 'HEAD']);
      fs.appendFileSync(path.join(h.root, 'jobs', jobId, 'worker.log'), [
        'State: verified',
        'Commit: none',
        'Prod: no',
        'Verified: PASS',
        `TestEvidence: ${JSON.stringify({ command: 'fixture tests', exitCode: 0 })}`,
        'Review: PASS',
        `ReviewEvidence: ${JSON.stringify({ verdict: 'PASS', reviewer: 'independent fixture', sha: actualHead })}`,
        'Blocker: none',
        'Risk: low',
        'Summary: No changes needed; fixture is already complete',
        'WORKER_EXIT_CODE: 0',
      ].join('\n') + '\n');
      const finalized = await h.jobs.finalizeJob(jobId);
      assert.equal(finalized.state, 'blocked');
      assert.match(finalized.result.blocker || '', /claimed no-op.*HEAD changed/i);
      assert.equal(finalized.result.handoff, undefined);
      git(h.repo, ['reset', '--hard', initialHead]);
    }
  } finally {
    process.env = oldEnv;
  }
  console.log('local-only job tests passed');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
