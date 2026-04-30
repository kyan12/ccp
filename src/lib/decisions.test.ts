import assert = require('assert');
import type { JobPacket, RepoMapping } from '../types';
import {
  buildDecisionInstructions,
  createDecisionContinuationPacket,
  formatDecisionRequestForDiscord,
  parseDecisionRequest,
  resolveDecisionPolicy,
} from './decisions';

function packet(overrides: Partial<JobPacket> = {}): JobPacket {
  return {
    job_id: 'job_test',
    ticket_id: 'PRO-1',
    repo: '/tmp/repo',
    goal: 'Implement something ambiguous',
    source: 'test',
    kind: 'task',
    label: 'test',
    ...overrides,
  };
}

console.log('\nTest: decision policy resolves default and overrides');
{
  const old = process.env.CCP_DECISION_MODE;
  delete process.env.CCP_DECISION_MODE;
  const def = resolveDecisionPolicy(packet(), null);
  assert.equal(def.mode, 'hybrid');
  assert.equal(def.confidenceThreshold, 0.75);

  const repo: RepoMapping = { key: 'r', localPath: '/tmp/repo', decisionPolicy: { mode: 'ask', confidenceThreshold: 0.9 } };
  assert.equal(resolveDecisionPolicy(packet(), repo).mode, 'ask');
  assert.equal(resolveDecisionPolicy(packet(), repo).confidenceThreshold, 0.9);

  assert.equal(resolveDecisionPolicy(packet({ decisionMode: 'auto' }), repo).mode, 'auto');

  process.env.CCP_DECISION_MODE = 'never-block';
  assert.equal(resolveDecisionPolicy(packet(), repo).mode, 'never-block');
  if (old === undefined) delete process.env.CCP_DECISION_MODE; else process.env.CCP_DECISION_MODE = old;
}

console.log('Test: prompt instructions differ for auto vs ask');
{
  const ask = buildDecisionInstructions({ mode: 'ask', promptOn: ['architecture_choice'], confidenceThreshold: 0.75, timeoutMinutes: 60, defaultTimeoutAction: 'recommended' });
  assert(ask.includes('DecisionRequest:'), 'ask mode tells worker to emit a decision request');
  assert(ask.includes('ccp-jobs decide'), 'ask mode includes operator command');

  const auto = buildDecisionInstructions({ mode: 'auto', promptOn: [], confidenceThreshold: 0.75, timeoutMinutes: 60, defaultTimeoutAction: 'recommended' });
  assert(auto.includes('make your best judgment'), 'auto mode keeps worker non-blocking');
  assert(!auto.includes('DecisionRequest:'), 'auto mode must not invite blocking requests');
}

console.log('Test: parse DecisionRequest JSON from worker log');
{
  const log = `some output\nDecisionRequest: {"question":"Patch or refactor?","options":[{"id":"A","label":"Patch"},{"id":"B","label":"Refactor"}],"recommended":"A","risk":"medium","confidence":0.62,"reason":"touches shared auth"}\nState: blocked\n`;
  const req = parseDecisionRequest(log, 'job_1', '2026-01-01T00:00:00.000Z');
  assert(req, 'request parsed');
  assert.equal(req!.job_id, 'job_1');
  assert.equal(req!.question, 'Patch or refactor?');
  assert.equal(req!.options.length, 2);
  assert.equal(req!.recommended, 'A');
  assert.equal(req!.status, 'pending');
}

console.log('Test: Discord formatting includes reply command');
{
  const req = parseDecisionRequest('DecisionRequest: {"question":"Q?","options":[{"id":"A","label":"One"}],"recommended":"A"}', 'job_2', '2026-01-01T00:00:00.000Z')!;
  const rendered = formatDecisionRequestForDiscord(req);
  assert(rendered.includes('Decision needed'));
  assert(rendered.includes('ccp-jobs decide job_2 A'));
}

console.log('Test: decision continuation packet carries selected answer and disables re-prompting by default');
{
  const original = packet({ job_id: 'job_parent', working_branch: 'feat/x', acceptance_criteria: ['do it'] });
  const child = createDecisionContinuationPacket({
    packet: original,
    parentJobId: 'job_parent',
    choice: 'B',
    note: 'Prefer cleaner long-term path',
    request: parseDecisionRequest('DecisionRequest: {"question":"Q?","options":[{"id":"A","label":"Patch"},{"id":"B","label":"Refactor"}],"recommended":"A"}', 'job_parent', '2026-01-01T00:00:00.000Z')!,
  });
  assert.equal(child.job_id, 'job_parent__decision_B');
  assert.equal(child.working_branch, 'feat/x');
  assert.equal(child.decisionMode, 'auto');
  assert(child.review_feedback?.some((line) => line.includes('Human decision: B')));
  assert(child.acceptance_criteria?.includes('do it'));
}

console.log('Test: sanitized decision option IDs do not collide');
{
  const original = packet({ job_id: 'job_collision' });
  const request = parseDecisionRequest('DecisionRequest: {"question":"Q?","options":[{"id":"A/B","label":"Slash"},{"id":"A_B","label":"Underscore"}]}', 'job_collision', '2026-01-01T00:00:00.000Z')!;
  const slash = createDecisionContinuationPacket({ packet: original, parentJobId: 'job_collision', choice: 'A/B', request });
  const underscore = createDecisionContinuationPacket({ packet: original, parentJobId: 'job_collision', choice: 'A_B', request });
  assert.notEqual(slash.job_id, underscore.job_id);
  assert.equal(underscore.job_id, 'job_collision__decision_A_B');
  assert(slash.job_id.startsWith('job_collision__decision_A_B_'));
}

console.log('decisions tests passed');
