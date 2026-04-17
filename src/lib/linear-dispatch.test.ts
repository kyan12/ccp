/**
 * Tests for Linear `agent:<name>` label mapping.
 *
 * The full issueToPacket path touches linear API config and repo mapping
 * files, so we test the pure label-parsing helper (chooseAgentLabel) in
 * isolation — that's where the PR B behavior actually lives.
 */

import { chooseAgentLabel } from './linear-dispatch';

let passed = 0;
let failed = 0;

function assert(condition: boolean, msg: string): void {
  if (condition) {
    passed++;
    console.log(`  PASS: ${msg}`);
  } else {
    failed++;
    console.error(`  FAIL: ${msg}`);
  }
}

function issue(labels: string[]): { labels: { nodes: Array<{ id: string; name: string }> } } {
  return { labels: { nodes: labels.map((n, i) => ({ id: String(i), name: n })) } };
}

console.log('\nTest: chooseAgentLabel extracts agent name from "agent:<name>" label');
{
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  assert(chooseAgentLabel(issue(['agent:codex']) as any) === 'codex', 'agent:codex → codex');
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  assert(chooseAgentLabel(issue(['bug', 'agent:codex', 'urgent']) as any) === 'codex', 'finds agent: among others');
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  assert(chooseAgentLabel(issue(['agent:claude-code']) as any) === 'claude-code', 'agent:claude-code hyphenated name');
}

console.log('\nTest: chooseAgentLabel is case-insensitive');
{
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  assert(chooseAgentLabel(issue(['Agent:Codex']) as any) === 'codex', 'mixed case label lowercased');
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  assert(chooseAgentLabel(issue(['AGENT:CODEX']) as any) === 'codex', 'upper case label lowercased');
}

console.log('\nTest: chooseAgentLabel returns undefined when no agent: label');
{
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  assert(chooseAgentLabel(issue([]) as any) === undefined, 'no labels → undefined');
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  assert(chooseAgentLabel(issue(['bug', 'feature', 'runtime']) as any) === undefined, 'no agent: prefix → undefined');
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  assert(chooseAgentLabel(issue(['agent:']) as any) === undefined, 'empty value after prefix → undefined');
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  assert(chooseAgentLabel(issue(['agent:  ']) as any) === undefined, 'whitespace value → undefined');
}

console.log('\nTest: chooseAgentLabel picks the first agent: label when multiple exist');
{
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const a = chooseAgentLabel(issue(['agent:codex', 'agent:claude-code']) as any);
  assert(a === 'codex', 'first label wins');
}

console.log('\nTest: chooseAgentLabel handles missing labels.nodes gracefully');
{
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  assert(chooseAgentLabel({} as any) === undefined, 'missing .labels → undefined');
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  assert(chooseAgentLabel({ labels: {} } as any) === undefined, 'missing .nodes → undefined');
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  assert(chooseAgentLabel({ labels: { nodes: [] } } as any) === undefined, 'empty .nodes → undefined');
}

console.log(`\nTotal: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
