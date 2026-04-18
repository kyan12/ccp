/**
 * Unit tests for the Phase 6b ambiguity classifier.
 *
 * The classifier is a pure function — no IO, no config, no clock — so
 * these tests are hermetic, fast, and deterministic. We exhaustively
 * exercise operator phrasings (which MUST NOT be auto-retried),
 * transient phrasings (which MAY be auto-retried), and the conservative
 * defaults for unknown or empty inputs.
 */

import { classifyAmbiguity, classifyAmbiguityOrDefault } from './blocker-classifier';
import assert from 'node:assert/strict';

type Case = [label: string, input: string, expected: string | null];

const OPERATOR_CASES: Case[] = [
  ['missing API key',                  'Missing API key for Linear integration',                                     'ambiguity-operator'],
  ['no credentials',                   'No credentials configured for the remote',                                   'ambiguity-operator'],
  ['authentication failed',            'Request failed: authentication failed on push',                              'ambiguity-operator'],
  ['HTTP 401',                         'Upstream returned HTTP 401 — unauthorized',                                   'ambiguity-operator'],
  ['HTTP 403',                         'HTTP 403 when pulling package — need access',                                 'ambiguity-operator'],
  ['status 403',                       'status: 403 forbidden from registry',                                         'ambiguity-operator'],
  ['need write permission',            'I need file write permission to proceed. Blocked on /etc/hosts write.',       'ambiguity-operator'],
  ['please clarify',                   'Please clarify whether to use Redux or Zustand for this feature',             'ambiguity-operator'],
  ['need clarification',               'Need clarification from the product team on acceptance criteria',             'ambiguity-operator'],
  ['ticket is ambiguous',              'The ticket is ambiguous — could mean either endpoint or service',             'ambiguity-operator'],
  ['underspecified',                   'Requirements are underspecified; cannot tell what success looks like',        'ambiguity-operator'],
  ['which approach',                   'Which approach should I take — patch the schema or migrate?',                 'ambiguity-operator'],
  ['cannot determine',                 'Cannot determine the correct parent case for this bill',                      'ambiguity-operator'],
  ['waiting for input',                'Waiting for operator input on payer ID override',                             'ambiguity-operator'],
  ['waiting for clarification',        'Waiting for clarification from the ticket author',                            'ambiguity-operator'],
  ['please provide',                   'Please provide the Jopari payer ID for this insurer',                         'ambiguity-operator'],
  ['please confirm',                   'Please confirm whether the DB migration should run in prod',                  'ambiguity-operator'],
  ['missing acceptance criteria',      'Missing acceptance criteria in the Linear ticket body',                       'ambiguity-operator'],
  ['ticket is empty',                  'The ticket is empty — no description or attachments',                         'ambiguity-operator'],
  ['unable to verify',                 'Blocker: unable to verify the end-to-end flow without sample data',           'ambiguity-operator'],
  ['i cannot proceed without',         'I cannot proceed without the test API key for QuickBooks',                    'ambiguity-operator'],
  ['would you like me to',             'Would you like me to scaffold a new FastAPI service for this?',               'ambiguity-operator'],
  ['should I use',                     'Should I use postgres or sqlite for this test fixture?',                      'ambiguity-operator'],
  ['could you provide',                'Could you provide the preferred branch naming convention here?',              'ambiguity-operator'],
];

const TRANSIENT_CASES: Case[] = [
  ['rate limit',                       'GitHub API request failed: rate limit exceeded, retry after 47s',             'ambiguity-transient'],
  ['rate-limited',                     'npm install failed because the registry rate-limited us',                     'ambiguity-transient'],
  ['HTTP 429',                         'Upstream returned HTTP 429 — throttled',                                      'ambiguity-transient'],
  ['too many requests',                'Anthropic replied 429 too many requests',                                     'ambiguity-transient'],
  ['quota exceeded',                   'Daily quota exceeded on the translation API',                                 'ambiguity-transient'],
  ['ETIMEDOUT',                        'Error: connect ETIMEDOUT 1.2.3.4:443 while cloning submodule',                'ambiguity-transient'],
  ['ECONNRESET',                       'socket hang up: ECONNRESET',                                                  'ambiguity-transient'],
  ['ECONNREFUSED',                     'Failed to bind: ECONNREFUSED localhost:5432',                                 'ambiguity-transient'],
  ['ENETUNREACH',                      'Network ENETUNREACH while fetching tarball',                                  'ambiguity-transient'],
  ['EAI_AGAIN',                        'DNS lookup EAI_AGAIN — transient resolver failure',                           'ambiguity-transient'],
  ['DNS lookup failed',                'DNS lookup failed for api.openai.com',                                        'ambiguity-transient'],
  ['getaddrinfo failed',               'getaddrinfo lookup failed (intermittent network drop)',                       'ambiguity-transient'],
  ['timed out (no operator word)',     'git push timed out after 30 seconds',                                         'ambiguity-transient'],
  ['network error',                    'Network error while contacting Sentry',                                       'ambiguity-transient'],
  ['fetch failed',                     'TypeError: fetch failed (likely transient)',                                  'ambiguity-transient'],
  ['connection reset',                 'Connection reset by peer while pushing to origin',                            'ambiguity-transient'],
  ['connection refused',               'Connection refused trying to reach the preview URL',                          'ambiguity-transient'],
  ['HTTP 503',                         'Vercel returned HTTP 503 — deploy still provisioning',                        'ambiguity-transient'],
  ['HTTP 504',                         'Upstream returned HTTP 504 gateway timeout',                                  'ambiguity-transient'],
  ['bad gateway',                      '502 bad gateway from the edge cache',                                         'ambiguity-transient'],
  ['service unavailable',              'Service unavailable: node provisioning',                                      'ambiguity-transient'],
  ['temporarily unavailable',          'The dashboard endpoint is temporarily unavailable',                           'ambiguity-transient'],
  ['try again later',                  'Please try again later — worker pool saturated',                              'ambiguity-transient'],
  ['another git process',              'fatal: Unable to create index.lock: another git process seems to be running', 'ambiguity-transient'],
  ['index.lock',                       'error: cannot acquire index.lock for writing',                                'ambiguity-transient'],
  ['unable to lock',                   'fatal: unable to lock refs/remotes/origin/main',                              'ambiguity-transient'],
  ['preview not ready',                'Preview deployment not yet ready — DNS still propagating',                    'ambiguity-transient'],
  ['deploy still building',            'Deployment still building for this commit',                                   'ambiguity-transient'],
  ['flaky test flag',                  'Flaky network call to stripe; previous run passed',                           'ambiguity-transient'],
  ['intermittent',                     'Intermittent 502 from the playwright browser runner',                         'ambiguity-transient'],
];

const UNKNOWN_CASES: Case[] = [
  ['completely unrelated',             'cat /etc/resolv.conf and then ran make install',                              null],
  ['empty string',                     '',                                                                            null],
  ['just whitespace',                  '   \n\t',                                                                     null],
];

let passed = 0;
const fail = (msg: string): never => {
  throw new Error(msg);
};

for (const [label, input, expected] of OPERATOR_CASES) {
  const got = classifyAmbiguity(input);
  assert.equal(got, expected, `operator: ${label} \u2014 expected ${expected}, got ${got} for input: ${input}`);
  passed++;
}

for (const [label, input, expected] of TRANSIENT_CASES) {
  const got = classifyAmbiguity(input);
  assert.equal(got, expected, `transient: ${label} \u2014 expected ${expected}, got ${got} for input: ${input}`);
  passed++;
}

for (const [label, input, expected] of UNKNOWN_CASES) {
  const got = classifyAmbiguity(input);
  assert.equal(got, expected, `unknown: ${label} \u2014 expected ${expected}, got ${got} for input: ${JSON.stringify(input)}`);
  passed++;
}

// Null / undefined inputs
assert.equal(classifyAmbiguity(null), null, 'null input should return null');
assert.equal(classifyAmbiguity(undefined), null, 'undefined input should return null');
assert.equal(classifyAmbiguity(123 as unknown as string), null, 'non-string input should return null');
passed += 3;

// classifyAmbiguityOrDefault collapses null / unknown to operator
assert.equal(classifyAmbiguityOrDefault(null), 'ambiguity-operator', 'null \u2192 operator');
assert.equal(classifyAmbiguityOrDefault(''), 'ambiguity-operator', 'empty \u2192 operator');
assert.equal(classifyAmbiguityOrDefault('asdfqwer'), 'ambiguity-operator', 'unknown \u2192 operator');
assert.equal(classifyAmbiguityOrDefault('Please clarify the tier'), 'ambiguity-operator', 'operator stays operator');
assert.equal(classifyAmbiguityOrDefault('ETIMEDOUT talking to api'), 'ambiguity-transient', 'transient stays transient');
passed += 5;

// Tie-breaker: when BOTH operator and transient phrases are present,
// operator MUST win. Safer to bother the human than silently retry.
const mixed1 = 'rate limit hit; please clarify whether we should wait or use fallback';
assert.equal(classifyAmbiguity(mixed1), 'ambiguity-operator', 'mixed: operator beats transient (clarify)');
const mixed2 = 'ETIMEDOUT talking to Linear — need clarification on which workspace to use';
assert.equal(classifyAmbiguity(mixed2), 'ambiguity-operator', 'mixed: operator beats transient (clarification)');
const mixed3 = 'ECONNRESET on push. Would you like me to retry with force?';
assert.equal(classifyAmbiguity(mixed3), 'ambiguity-operator', 'mixed: operator beats transient (would you like me to)');
passed += 3;

// Boundary / regression cases
// 1. "request timed out" with an operator word nearby should still be
//    operator (not hidden transient on a user-input question).
const reg1 = 'The request timed out but I also need clarification on retry semantics.';
assert.equal(classifyAmbiguity(reg1), 'ambiguity-operator', 'regression: operator word in mixed sentence wins');

// 2. A plain 429 without any operator words is transient.
const reg2 = 'Non-2xx response (429) from anthropic; backoff and retry.';
assert.equal(classifyAmbiguity(reg2), 'ambiguity-transient', 'regression: plain 429 is transient');

// 3. A very long input (>8192 chars) should still classify by the
//    first chunk without timing out or stack-overflowing. We pad the
//    input with benign noise; the operator phrase lives in the first 1k.
const bigOperator = 'please clarify the tier assignment\n' + 'a'.repeat(20000);
assert.equal(classifyAmbiguity(bigOperator), 'ambiguity-operator', 'bounded scan finds operator in big input');

// 4. Regression: "permission denied" is operator even without "please"
const reg4 = 'fatal: permission denied (publickey) while pushing to origin';
assert.equal(classifyAmbiguity(reg4), 'ambiguity-operator', 'regression: permission denied is operator');

// 5. Regression: "need permission" is operator
const reg5 = 'worker needs permission to the secrets store';
assert.equal(classifyAmbiguity(reg5), 'ambiguity-operator', 'regression: need permission is operator');

// 6. Regression: ETIMEDOUT alone is transient, even when embedded in verbose logs
const reg6 = '[2026-04-18T10:00:00Z] pushing to origin... \nError: connect ETIMEDOUT 1.2.3.4:443\nBailing.';
assert.equal(classifyAmbiguity(reg6), 'ambiguity-transient', 'regression: verbose ETIMEDOUT log is transient');

// 7. Regression: real-world "blocker: unable to verify" string from prompt is operator
const reg7 = 'Blocker: unable to verify changes (test environment not available)';
assert.equal(classifyAmbiguity(reg7), 'ambiguity-operator', 'regression: prompt-canonical unable-to-verify is operator');

passed += 7;

// Case-insensitivity sanity
assert.equal(classifyAmbiguity('PLEASE CLARIFY THE TIER'), 'ambiguity-operator', 'upper-case operator');
assert.equal(classifyAmbiguity('rate limit'), 'ambiguity-transient', 'lower-case transient');
assert.equal(classifyAmbiguity('Rate Limit Exceeded'), 'ambiguity-transient', 'mixed-case transient');
passed += 3;

console.log(`blocker-classifier.test.ts: all ${passed} assertions passed`);
