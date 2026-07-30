import assert = require('node:assert/strict');
import fs = require('node:fs');
import os = require('node:os');
import path = require('node:path');
import test = require('node:test');
import type { JobPacket, JobResult, JobStatus } from '../types';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ccp-github-kanban-drain-'));
const binDir = path.join(root, 'bin');
const ghLog = path.join(root, 'gh.log');
fs.mkdirSync(binDir, { recursive: true });
fs.writeFileSync(path.join(binDir, 'gh'), `#!/bin/sh
printf '%s\\n' "$*" >> "$GH_LOG"
case "$*" in
  *"pull/11"*|*" 11 "*) state=MERGED; number=11 ;;
  *"pull/12"*|*" 12 "*) state=OPEN; number=12 ;;
  *) state=OPEN; number=13 ;;
esac
printf '{"number":%s,"state":"%s","isDraft":false,"mergeable":"MERGEABLE","reviewDecision":"APPROVED","statusCheckRollup":[{"__typename":"CheckRun","status":"COMPLETED","conclusion":"SUCCESS","name":"ci","detailsUrl":"https://preview-%s.vercel.app"}],"headRefName":"feature","baseRefName":"main","url":"https://github.com/example/repo/pull/%s","title":"green","comments":[]}' "$number" "$state" "$number" "$number"
`);
fs.chmodSync(path.join(binDir, 'gh'), 0o755);
process.env.CCP_ROOT = root;
process.env.CCP_PR_REVIEW_ENABLED = 'true';
process.env.CCP_PR_AUTOMERGE = 'true';
process.env.GH_LOG = ghLog;
process.env.PATH = `${binDir}:${process.env.PATH || ''}`;

const {
  createJob,
  maybeReviewPr,
  readJson,
  resultPath,
  statusPath,
} = require('./jobs') as typeof import('./jobs');
const { collectWatchableJobs, runPrWatcherCycle } = require('./pr-watcher') as typeof import('./pr-watcher');

const DRAIN_IDS = [
  'nightly_proteusx-os_2026-07-11',
  'nightly_papyrx_2026-05-19',
] as const;

function writeJson(file: string, data: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data, null, 2) + '\n');
}

function seedJob(jobId: string, prNumber: number): void {
  const packet: JobPacket = {
    job_id: jobId,
    ticket_id: jobId,
    repo: '/tmp/example',
    goal: 'historical drain',
    source: 'nightly',
    kind: 'task',
    label: 'nightly',
  };
  createJob(packet);
  const status = readJson(statusPath(jobId)) as unknown as JobStatus;
  writeJson(statusPath(jobId), { ...status, state: 'coded' });
  const result: Partial<JobResult> = {
    job_id: jobId,
    state: 'coded',
    pr_url: `https://github.com/example/repo/pull/${prNumber}`,
    preview_url: null,
  };
  writeJson(resultPath(jobId), result);
}

test('initial finalization review is read-only even when auto-merge policy is enabled', () => {
  seedJob('finalization-green', 13);
  fs.writeFileSync(ghLog, '');

  const review = maybeReviewPr('finalization-green', readJson(resultPath('finalization-green')) as unknown as JobResult);
  assert.equal(review.ok, true);
  assert.equal(review.disposition, 'approve');

  const commands = fs.readFileSync(ghLog, 'utf8').trim().split('\n').filter(Boolean);
  assert.equal(commands.length, 1);
  assert.match(commands[0], /^pr view /);
  assert.doesNotMatch(commands.join('\n'), /\bpr (review|merge)\b/);
});

test('drain watcher scopes exactly two historical jobs and performs status-only reconciliation', async () => {
  seedJob(DRAIN_IDS[0], 11);
  seedJob(DRAIN_IDS[1], 12);
  seedJob('unrelated_ccp_job', 99);

  const unrelatedStatusBefore = fs.readFileSync(statusPath('unrelated_ccp_job'));
  const unrelatedResultBefore = fs.readFileSync(resultPath('unrelated_ccp_job'));
  const drainResultsBefore = new Map(DRAIN_IDS.map((id) => [id, fs.readFileSync(resultPath(id))]));
  fs.writeFileSync(ghLog, '');

  assert.deepEqual(collectWatchableJobs().map((item: { status: JobStatus }) => item.status.job_id).sort(), [...DRAIN_IDS].sort());

  const cycle = await runPrWatcherCycle();
  assert.equal(cycle.watchedCount, 2);
  const actions = (cycle.actions || []) as Array<{ job_id?: string }>;
  assert.deepEqual(actions.map((entry) => entry.job_id).sort(), [...DRAIN_IDS].sort());

  const mergedStatus = readJson(statusPath(DRAIN_IDS[0])) as unknown as JobStatus;
  const openStatus = readJson(statusPath(DRAIN_IDS[1])) as unknown as JobStatus;
  assert.equal(mergedStatus.state, 'done');
  assert.equal(openStatus.state, 'coded');
  assert.equal((mergedStatus.integrations?.prReview as { merged?: boolean })?.merged, true);
  assert.equal((openStatus.integrations?.prReview as { disposition?: string })?.disposition, 'approve');

  for (const id of DRAIN_IDS) {
    assert.deepEqual(fs.readFileSync(resultPath(id)), drainResultsBefore.get(id));
    assert.equal(fs.existsSync(path.join(root, 'jobs', `${id}__reviewfix`)), false);
    assert.equal(fs.existsSync(path.join(root, 'jobs', `${id}__deployfix`)), false);
  }
  assert.deepEqual(fs.readFileSync(statusPath('unrelated_ccp_job')), unrelatedStatusBefore);
  assert.deepEqual(fs.readFileSync(resultPath('unrelated_ccp_job')), unrelatedResultBefore);

  const commands = fs.readFileSync(ghLog, 'utf8').trim().split('\n').filter(Boolean);
  assert.equal(commands.length, 2);
  assert.ok(commands.every((command) => /^pr view /.test(command)));
  assert.doesNotMatch(commands.join('\n'), /\bpr (review|merge)\b/);

  const watcherSource = fs.readFileSync(path.join(__dirname, 'pr-watcher.js'), 'utf8');
  assert.doesNotMatch(watcherSource, /fireWebhookCallback|sendDiscordMessage|runSmoke|maybeEnqueue|attemptAutoRebase|appendLog/);
});
