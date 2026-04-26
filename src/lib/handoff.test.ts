import { buildIncidentPacket } from './intake-runner';
import { issueToPacket } from './linear-dispatch';
import { normalizeJobToLinearIssue } from './linear';
import type { JobPacket, IntakePayload } from '../types';

// Access buildPrompt via require since it's not directly exported in all builds
const jobs = require('./jobs');
const buildPrompt: (packet: JobPacket, memory?: string | null, plan?: string | null) => string = jobs.buildPrompt;

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
    completion_routing: 'direct',
    writeback_required: [
      'Update project page if architecture changes',
      'Record postmortem for durable bugs',
    ],
    ...overrides,
  };
}

// ── Intake → JobPacket ─────────────────────────────────────────

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
  assert(packet.exact_deliverable === 'Merged implementation with callback semantics.', 'packet preserves exact_deliverable');
  assert(packet.completion_routing === 'direct', 'packet preserves completion_routing');
}

console.log('\nTest: intake validates missing handoff fields');
{
  const packet = buildIncidentPacket('manual', makePayload({
    completion_routing: undefined,
    exact_deliverable: undefined,
    // Provide acceptance_criteria to skip AI enrichment (which would generate verification_steps)
    acceptance_criteria: ['test criterion'],
  })) as JobPacket;
  const meta = packet.metadata as Record<string, unknown>;
  const warnings = meta.handoff_warnings as string[];
  assert(Array.isArray(warnings), 'warnings array exists on metadata');
  assert(warnings.includes('completion_routing'), 'warns about missing completion_routing');
  assert(warnings.includes('exact_deliverable'), 'warns about missing exact_deliverable');
  assert(warnings.includes('verification_steps'), 'warns about missing verification_steps');
}

console.log('\nTest: intake does not warn when all handoff fields present');
{
  const packet = buildIncidentPacket('manual', makePayload({
    verification_steps: ['npm test'],
  })) as JobPacket;
  const meta = packet.metadata as Record<string, unknown>;
  assert(!meta.handoff_warnings, 'no warnings when all fields present');
}

// ── Linear serialization round-trip ────────────────────────────

console.log('\nTest: Linear description contains structured handoff sections');
{
  const packet = buildIncidentPacket('manual', makePayload()) as JobPacket;
  const issue = normalizeJobToLinearIssue(packet);
  const description = String(issue.description || '');
  assert(description.includes('## Handoff'), 'Linear description includes handoff section');
  assert(description.includes('Handoff ID: hc_20260423_001'), 'Linear description includes handoff_id');
  assert(description.includes('Completion routing: direct'), 'Linear description includes completion_routing');
  assert(description.includes('Exact deliverable: Merged implementation'), 'Linear description includes exact_deliverable');
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
      '- Handoff ID: hc_20260423_001',
      '- Origin: discord:#business-code-handoff',
      '- Requestor: Kevin',
      '- Why it matters: So business context is preserved across agents.',
      '- Exact deliverable: Merged implementation with callback semantics.',
      '- Callback required: yes',
      '- Completion routing: relay',
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

  assert(packet.handoff_id === 'hc_20260423_001', 'dispatch packet reconstructs handoff_id');
  assert(packet.origin === 'discord:#business-code-handoff', 'dispatch packet reconstructs origin');
  assert(packet.requestor === 'Kevin', 'dispatch packet reconstructs requestor');
  assert(packet.why_it_matters === 'So business context is preserved across agents.', 'dispatch packet reconstructs why_it_matters');
  assert(packet.exact_deliverable === 'Merged implementation with callback semantics.', 'dispatch packet reconstructs exact_deliverable');
  assert(packet.callback_required === true, 'dispatch packet reconstructs callback requirement');
  assert(packet.completion_routing === 'relay', 'dispatch packet reconstructs completion_routing');
  assert(Array.isArray(packet.context_refs) && packet.context_refs.length === 2, 'dispatch packet reconstructs context_refs');
  assert(Array.isArray(packet.writeback_required) && packet.writeback_required.length === 2, 'dispatch packet reconstructs writeback requirements');
}

// ── Prompt inclusion ───────────────────────────────────────────

console.log('\nTest: buildPrompt includes handoff context section');
{
  const packet: JobPacket = {
    job_id: 'test_prompt_001',
    ticket_id: 'PRO-700',
    repo: 'test/repo',
    goal: 'Test handoff prompt inclusion',
    source: 'manual',
    kind: 'feature',
    label: 'test',
    handoff_id: 'hc_prompt_001',
    origin: 'discord:#test-channel',
    requestor: 'Kevin',
    why_it_matters: 'Testing prompt output',
    exact_deliverable: 'Passing tests',
    completion_routing: 'relay',
    callback_required: true,
    context_refs: ['brain://test/context'],
    writeback_required: ['Update docs'],
  };
  const prompt = buildPrompt(packet);
  assert(prompt.includes('--- BEGIN HANDOFF ---'), 'prompt has handoff begin marker');
  assert(prompt.includes('--- END HANDOFF ---'), 'prompt has handoff end marker');
  assert(prompt.includes('Handoff ID: hc_prompt_001'), 'prompt includes handoff_id');
  assert(prompt.includes('Origin: discord:#test-channel'), 'prompt includes origin');
  assert(prompt.includes('Requestor: Kevin'), 'prompt includes requestor');
  assert(prompt.includes('Exact deliverable: Passing tests'), 'prompt includes exact_deliverable');
  assert(prompt.includes('Completion routing: relay'), 'prompt includes completion_routing');
  assert(prompt.includes('Callback required: yes'), 'prompt includes callback flag');
  assert(prompt.includes('brain://test/context'), 'prompt includes context refs');
  assert(prompt.includes('Update docs'), 'prompt includes writeback requirements');
}

console.log('\nTest: buildPrompt omits handoff section when no handoff_id');
{
  const packet: JobPacket = {
    job_id: 'test_noh_001',
    ticket_id: 'PRO-701',
    repo: 'test/repo',
    goal: 'Regular non-handoff job',
    source: 'manual',
    kind: 'bug',
    label: 'test',
  };
  const prompt = buildPrompt(packet);
  assert(!prompt.includes('--- BEGIN HANDOFF ---'), 'no handoff section in non-handoff prompt');
}

// ── Callback routing ───────────────────────────────────────────

console.log('\nTest: callback payload uses explicit routing from packet');
{
  const { buildHandoffPayload } = require('./handoff-callback');
  const packet: JobPacket = {
    job_id: 'test_cb_001',
    ticket_id: 'PRO-800',
    repo: 'test/repo',
    goal: 'Test callback routing',
    source: 'manual',
    kind: 'feature',
    label: 'test',
    handoff_id: 'hc_route_001',
    completion_routing: 'relay',
    requestor: 'Kevin',
  };
  const payload = buildHandoffPayload({
    packet,
    status: 'done' as const,
    summary: 'Feature shipped',
    relay_message: 'Hey Kevin, the feature is live!',
    target_audience: 'Kevin',
  });
  assert(payload.completion_routing === 'relay', 'callback payload has relay routing');
  assert(payload.target_audience === 'Kevin', 'callback payload has target_audience for relay');
  assert(payload.relay_message === 'Hey Kevin, the feature is live!', 'callback payload has relay_message');
  assert(Array.isArray(payload.blockers), 'callback payload has blockers array');
  assert(Array.isArray(payload.writeback_notes), 'callback payload has writeback_notes array');
}

console.log('\nTest: callback payload defaults to direct routing');
{
  const { buildHandoffPayload } = require('./handoff-callback');
  const packet: JobPacket = {
    job_id: 'test_cb_002',
    ticket_id: 'PRO-801',
    repo: 'test/repo',
    goal: 'Test default routing',
    source: 'manual',
    kind: 'bug',
    label: 'test',
    handoff_id: 'hc_route_002',
  };
  const payload = buildHandoffPayload({
    packet,
    status: 'done' as const,
    summary: 'Bug fixed',
  });
  assert(payload.completion_routing === 'direct', 'callback defaults to direct routing');
  assert(!payload.target_audience, 'no target_audience for direct routing');
  assert(!payload.relay_message, 'no relay_message for direct routing');
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
