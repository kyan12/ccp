/**
 * Tests for Linear `agent:<name>` label mapping.
 *
 * The full issueToPacket path touches linear API config and repo mapping
 * files, so we test the pure label-parsing helper (chooseAgentLabel) in
 * isolation — that's where the PR B behavior actually lives.
 */

import {
  chooseAgentLabel,
  normalizeLinearOrgKeys,
  shouldSkipOrgForRateLimit,
  markOrgRateLimited,
  shouldSkipOrgForPollInterval,
  markOrgPolled,
} from './linear-dispatch';
const { parseRateLimitReset } = require('./linear');

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

console.log('\nTest: normalizeLinearOrgKeys de-dupes default org aliases');
{
  const orgs = normalizeLinearOrgKeys([null, 'default', 'smartadvocateai', 'default', 'smartadvocateai']);
  assert(JSON.stringify(orgs) === JSON.stringify([null, 'smartadvocateai']), 'null/default collapse to one default poll and other orgs are unique');
}

console.log('\nTest: rate-limit backoff skips only until the recorded reset time');
{
  const state = { dispatchedIssueIds: {}, updatedAt: null };
  markOrgRateLimited(state, 'default', 1_000, 10_000, 'test');
  const skipped = shouldSkipOrgForRateLimit(state, 'default', 5_000);
  assert(skipped.skip === true && /until/.test(skipped.reason || ''), 'org is skipped before reset');
  const allowed = shouldSkipOrgForRateLimit(state, 'default', 10_001);
  assert(allowed.skip === false, 'org is allowed after reset');
  const other = shouldSkipOrgForRateLimit(state, 'smartadvocateai', 5_000);
  assert(other.skip === false, 'backoff is scoped to the org key');
}

console.log('\nTest: rate-limit backoff falls back when Linear omits reset headers');
{
  const state = { dispatchedIssueIds: {}, updatedAt: null };
  markOrgRateLimited(state, null, 2_000, null, 'missing header');
  const skipped = shouldSkipOrgForRateLimit(state, null, 2_001);
  assert(skipped.skip === true, 'missing reset still creates conservative backoff');
  const allowed = shouldSkipOrgForRateLimit(state, null, 2_000 + 60 * 60 * 1000 + 1);
  assert(allowed.skip === false, 'fallback backoff expires after one hour');
}

console.log('\nTest: dispatch polling interval skips repeated supervisor polls but allows force');
{
  const state = { dispatchedIssueIds: {}, updatedAt: null };
  markOrgPolled(state, null, 20_000);
  const skipped = shouldSkipOrgForPollInterval(state, null, 30_000, 60_000, false);
  assert(skipped.skip === true && /last polled/.test(skipped.reason || ''), 'recent default-org poll is skipped');
  const forced = shouldSkipOrgForPollInterval(state, null, 30_000, 60_000, true);
  assert(forced.skip === false, 'forced dispatch bypasses poll interval');
  const elapsed = shouldSkipOrgForPollInterval(state, null, 80_001, 60_000, false);
  assert(elapsed.skip === false, 'poll interval expires');
}

console.log('\nTest: parseRateLimitReset converts seconds to milliseconds');
{
  // Unix epoch seconds (~1.7e9) should be converted to ms
  const seconds = 1717500000;
  const result = parseRateLimitReset({ 'x-ratelimit-requests-reset': String(seconds) });
  assert(result === seconds * 1000, 'seconds value is multiplied by 1000');
}

console.log('\nTest: parseRateLimitReset passes through millisecond values');
{
  // Already in ms (~1.7e12) should be returned as-is
  const ms = 1717500000000;
  const result = parseRateLimitReset({ 'x-ratelimit-complexity-reset': String(ms) });
  assert(result === ms, 'millisecond value is returned unchanged');
}

console.log('\nTest: parseRateLimitReset returns null for missing/invalid headers');
{
  assert(parseRateLimitReset({}) === null, 'empty headers → null');
  assert(parseRateLimitReset({ 'x-ratelimit-requests-reset': '0' }) === null, 'zero → null');
  assert(parseRateLimitReset({ 'x-ratelimit-requests-reset': 'abc' }) === null, 'non-numeric → null');
  assert(parseRateLimitReset({ 'x-ratelimit-requests-reset': '-1' }) === null, 'negative → null');
}

console.log('\nTest: parseRateLimitReset handles array header values');
{
  const seconds = 1717500000;
  const result = parseRateLimitReset({ 'x-ratelimit-requests-reset': [String(seconds), '999'] });
  assert(result === seconds * 1000, 'uses first element of array and converts from seconds');
}

console.log(`\nTotal: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
