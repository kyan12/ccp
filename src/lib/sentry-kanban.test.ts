import assert = require('node:assert/strict');
import test = require('node:test');
import type { IntakePayload, RepoMapping } from '../types';
import {
  SentryKanbanIntakeError,
  buildSentryKanbanTask,
  extractSentryEvidence,
  sentryIdempotencyKey,
  submitSentryToKanban,
} from './sentry-kanban';

const repo: RepoMapping = {
  key: 'proteusx-os',
  ownerRepo: 'ProteusX-Consulting/proteusx-os',
  localPath: '/Users/kyan/code-crab/repos/proteusx-os',
};

function sentryPayload(overrides: Record<string, unknown> = {}): IntakePayload {
  return {
    action: 'created',
    data: {
      issue: {
        id: '7641350456',
        shortId: 'PROTEUSX-OS-29',
        title: 'Error: encrypted storage key is required',
        culprit: 'POST /api/social/postiz/connect',
        level: 'error',
        status: 'unresolved',
        project: { slug: 'proteusx-os' },
        permalink: 'https://proteusx-consulting.sentry.io/issues/7641350456/',
        count: '2',
        firstSeen: '2026-07-30T01:09:24.015000Z',
        lastSeen: '2026-07-30T01:09:43.405000Z',
      },
      event: {
        eventID: 'evt-123',
        transaction: 'POST /api/social/postiz/connect',
        release: { version: 'release-sha' },
        environment: 'production',
        request: { headers: { authorization: 'must-not-leak' } },
      },
      ...overrides,
    },
  };
}

test('extracts exact allowlisted Sentry identity without copying raw request data', () => {
  const evidence = extractSentryEvidence(sentryPayload());
  assert.deepEqual(evidence, {
    action: 'created',
    organization: 'proteusx-consulting',
    project: 'proteusx-os',
    issueId: '7641350456',
    shortId: 'PROTEUSX-OS-29',
    title: 'Error: encrypted storage key is required',
    culprit: 'POST /api/social/postiz/connect',
    level: 'error',
    status: 'unresolved',
    count: '2',
    firstSeen: '2026-07-30T01:09:24.015000Z',
    lastSeen: '2026-07-30T01:09:43.405000Z',
    permalink: 'https://proteusx-consulting.sentry.io/issues/7641350456/',
    eventId: 'evt-123',
    transaction: 'POST /api/social/postiz/connect',
    release: 'release-sha',
    environment: 'production',
  });
  assert.equal(JSON.stringify(evidence).includes('must-not-leak'), false);
});

test('redacts sensitive telemetry and keeps dedupe stable across project-shape changes', () => {
  const payload = sentryPayload();
  const data = payload.data as Record<string, unknown>;
  const issue = data.issue as Record<string, unknown>;
  const event = data.event as Record<string, unknown>;
  issue.title = 'Failure for person@example.com token=ghp_abcdefghijklmnopqrstuvwxyz';
  issue.culprit = 'GET https://service.example/customer/123?api_key=customer-secret';
  event.transaction = 'customer 4f92cb77-0c5e-4f13-a5cb-6df0c51fd26d password=hunter2';

  const evidence = extractSentryEvidence(payload);
  const serialized = JSON.stringify(evidence);
  assert.match(evidence.title, /\[REDACTED_EMAIL\]/);
  assert.match(evidence.title, /token=\[REDACTED\]/);
  assert.match(evidence.culprit, /https:\/\/service\.example\/customer\/123/);
  assert.doesNotMatch(evidence.culprit, /customer-secret/);
  assert.match(evidence.transaction, /\[REDACTED_ID\]/);
  assert.match(evidence.transaction, /password=\[REDACTED\]/);
  assert.doesNotMatch(serialized, /person@example\.com|hunter2|abcdefghijklmnopqrstuvwxyz/);

  const renamedProject = { ...evidence, project: 'renamed-project' };
  const missingProject = { ...evidence, project: '' };
  assert.equal(sentryIdempotencyKey(renamedProject), sentryIdempotencyKey(missingProject));
  assert.equal(sentryIdempotencyKey(evidence), 'sentry:proteusx-consulting:7641350456');
});

test('builds deterministic native Kanban task with repository and writeback policy', () => {
  let routingPayload: IntakePayload | undefined;
  const task = buildSentryKanbanTask(sentryPayload(), {
    resolveRepo: (payload) => {
      routingPayload = payload;
      return repo;
    },
  });
  assert.equal(task.title, '[Sentry PROTEUSX-OS-29] production issue');
  assert.equal(task.idempotencyKey, 'sentry:proteusx-consulting:7641350456');
  assert.equal(task.repo, repo);
  assert.match(task.body, /Sentry issue ID: 7641350456/);
  assert.match(task.body, /Canonical checkout: \/Users\/kyan\/code-crab\/repos\/proteusx-os/);
  assert.match(task.body, /Do not resolve or ignore the Sentry issue merely because a task or PR exists/);
  assert.doesNotMatch(task.body, /must-not-leak/);
  assert.deepEqual(routingPayload, { repo: 'proteusx-os', project: 'proteusx-os' });
});

test('routes only exact trusted Sentry project identities, never telemetry text', () => {
  const payload = sentryPayload();
  const data = payload.data as Record<string, unknown>;
  const issue = data.issue as Record<string, unknown>;
  issue.project = { slug: 'unknown-project' };
  issue.title = 'SEO production failure in proteusx-os';
  issue.culprit = 'app.proteusx.ai/api/private';

  let resolverInput: IntakePayload | undefined;
  const task = buildSentryKanbanTask(payload, {
    resolveRepo: (candidate) => {
      resolverInput = candidate;
      return repo;
    },
  });

  assert.deepEqual(resolverInput, { repo: 'unknown-project', project: 'unknown-project' });
  assert.equal(task.repo, null);
  assert.match(task.body, /Canonical checkout: unresolved/);
  assert.doesNotMatch(task.body, /\/Users\/kyan\/code-crab\/repos\/proteusx-os/);
});

test('keeps sanitized evidence bounded and inert in task placement', () => {
  const payload = sentryPayload();
  const data = payload.data as Record<string, unknown>;
  const issue = data.issue as Record<string, unknown>;
  issue.title = `\n# override\u0000 token=secret-value ${'x'.repeat(2_000)}`;
  issue.culprit = `authorization: Bearer private-token ${'y'.repeat(2_000)}`;

  const task = buildSentryKanbanTask(payload, { resolveRepo: () => repo });
  const evidence = extractSentryEvidence(payload);
  assert.equal(task.title, '[Sentry PROTEUSX-OS-29] production issue');
  assert.ok(evidence.title.length <= 500);
  assert.ok(evidence.culprit.length <= 500);
  assert.doesNotMatch(task.body, /secret-value|private-token/);
  assert.match(task.body, /token=\[REDACTED\]|authorization=\[REDACTED\]/);
});

test('submits to explicit board with worktree isolation and deterministic dedupe', async () => {
  const calls: string[][] = [];
  let release: (() => void) | undefined;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const runHermes = async (args: string[]): Promise<{ stdout: string }> => {
    calls.push(args);
    await gate;
    return { stdout: JSON.stringify({ id: 't_deadbeef', status: 'ready' }) };
  };
  const options = { board: 'proteusx-engineering', assignee: 'code-crab', resolveRepo: () => repo, runHermes };
  const first = submitSentryToKanban(sentryPayload(), options);
  const retry = submitSentryToKanban(sentryPayload(), options);
  release?.();
  const [one, two] = await Promise.all([first, retry]);

  assert.equal(calls.length, 1);
  assert.deepEqual(one, two);
  assert.equal(one.taskId, 't_deadbeef');
  const args = calls[0];
  assert.deepEqual(args.slice(0, 4), ['kanban', '--board', 'proteusx-engineering', 'create']);
  assert.equal(args[args.indexOf('--assignee') + 1], 'code-crab');
  assert.equal(args[args.indexOf('--workspace') + 1], 'worktree:/Users/kyan/code-crab/repos/proteusx-os');
  assert.equal(args[args.indexOf('--idempotency-key') + 1], 'sentry:proteusx-consulting:7641350456');
  assert.equal(args.includes('linear'), false);
});

test('keeps unresolved repo incidents visible in a scratch task instead of dropping them', async () => {
  let captured: string[] = [];
  const result = await submitSentryToKanban(sentryPayload(), {
    resolveRepo: () => null,
    runHermes: async (args) => {
      captured = args;
      return { stdout: JSON.stringify({ id: 't_cafebabe' }) };
    },
  });
  assert.equal(result.ok, true);
  assert.equal(captured[captured.indexOf('--workspace') + 1], 'scratch');
  assert.match(captured[captured.indexOf('--body') + 1], /Mapping resolved: no/);
});

test('rejects malformed issue payloads and invalid CLI responses', async () => {
  assert.throws(
    () => extractSentryEvidence({ action: 'created', data: {} }),
    (error: unknown) => error instanceof SentryKanbanIntakeError && error.statusCode === 422,
  );
  await assert.rejects(
    submitSentryToKanban(sentryPayload(), {
      resolveRepo: () => repo,
      runHermes: async () => ({ stdout: JSON.stringify({ id: '../../bad' }) }),
    }),
    /invalid task id/,
  );
});
