import { buildIncidentPacket } from './intake-runner';
import { issueToPacket } from './linear-dispatch';
import { normalizeJobToLinearIssue } from './linear';
import type { JobPacket, IntakePayload } from '../types';

let passed = 0;
let failed = 0;

function assert(condition: boolean, msg: string) {
  if (condition) {
    passed++;
    console.log(`  PASS: ${msg}`);
  } else {
    failed++;
    console.error(`  FAIL: ${msg}`);
  }
}

function makePayload(overrides: Partial<IntakePayload> = {}): IntakePayload {
  return {
    title: 'Implement shared-brain handoff flow',
    description: 'Business Crab needs Code Crab to implement a structured handoff flow.',
    repo: 'ProteusX-Consulting/proteusx-labs',
    kind: 'feature',
    handoff_id: 'hc_20260423_001',
    origin: 'discord:#business-code-handoff',
    requestor: 'Kevin',
    objective: 'Implement the shared-brain handoff flow',
    why_it_matters: 'So business context is preserved across agents.',
    context_refs: ['brain://projects/shared-brain', 'linear://PRO-600'],
    exact_deliverable: 'Merged implementation with callback semantics.',
    callback_required: true,
    callback_url: 'http://127.0.0.1:8644/webhooks/code-crab-completion',
    writeback_required: [
      'Update project page if architecture changes',
      'Record postmortem for durable bugs',
    ],
    ...overrides,
  };
}

console.log('\nTest: manual intake preserves structured handoff fields');
{
  const packet = buildIncidentPacket('manual', makePayload()) as JobPacket;
  assert(packet.origin === 'discord:#business-code-handoff', 'packet preserves origin');
  assert(packet.requestor === 'Kevin', 'packet preserves requestor');
  assert(packet.why_it_matters === 'So business context is preserved across agents.', 'packet preserves why-it-matters');
  assert(Array.isArray(packet.context_refs) && packet.context_refs.length === 2, 'packet preserves context refs');
  assert(packet.callback_required === true, 'packet preserves callback requirement');
  assert(packet.handoff_id === 'hc_20260423_001', 'packet preserves handoff_id');
  assert(packet.callback_url === 'http://127.0.0.1:8644/webhooks/code-crab-completion', 'packet preserves callback_url');
}

console.log('\nTest: Linear description contains structured handoff sections');
{
  const packet = buildIncidentPacket('manual', makePayload()) as JobPacket;
  const issue = normalizeJobToLinearIssue(packet);
  const description = String(issue.description || '');
  assert(description.includes('## Handoff'), 'Linear description includes handoff section');
  assert(description.includes('## Context References'), 'Linear description includes context references section');
  assert(description.includes('## Writeback Required'), 'Linear description includes writeback section');
}

console.log('\nTest: Linear dispatch reconstructs structured handoff fields');
{
  const packet = issueToPacket({
    id: 'issue-1',
    identifier: 'PRO-600',
    title: 'Implement shared-brain handoff flow',
    description: [
      '**Repo:** ProteusX-Consulting/proteusx-labs',
      '## Description',
      '- Implement the shared-brain handoff flow',
      '## Acceptance Criteria',
      '- Shared-brain handoff works end-to-end',
      '## Validation',
      '- Run npm test',
      '## Constraints',
      '- Keep the handoff explicit',
      '## Handoff',
      '- Origin: discord:#business-code-handoff',
      '- Requestor: Kevin',
      '- Why it matters: So business context is preserved across agents.',
      '- Exact deliverable: Merged implementation with callback semantics.',
      '- Callback required: yes',
      '## Context References',
      '- brain://projects/shared-brain',
      '- linear://PRO-600',
      '## Writeback Required',
      '- Update project page if architecture changes',
      '- Record postmortem for durable bugs',
    ].join('\n'),
    url: 'https://linear.app/proteusx/issue/PRO-600/test',
    state: { name: 'Todo' },
    project: { id: 'project-1', name: 'Product / Delivery' },
    labels: { nodes: [] },
  } as any) as JobPacket;

  assert(packet.origin === 'discord:#business-code-handoff', 'dispatch packet reconstructs origin');
  assert(packet.requestor === 'Kevin', 'dispatch packet reconstructs requestor');
  assert(packet.callback_required === true, 'dispatch packet reconstructs callback requirement');
  assert(Array.isArray(packet.writeback_required) && packet.writeback_required.length === 2, 'dispatch packet reconstructs writeback requirements');
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
