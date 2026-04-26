/**
 * Unit tests for pr-review.ts — currently focused on Phase 4 PR A's
 * `extractPreviewUrl` helper. We intentionally test it as a pure function
 * with synthetic `checks` / `comments` inputs instead of shelling out to
 * `gh pr view` so the tests run offline and deterministically.
 *
 * Run: `npm test` (this file is included in package.json's test script).
 */

import type { CheckInfo } from '../types';

// Use require() so we get the CommonJS export table (including
// extractPreviewUrl, which isn't re-exported via the TS `export { ... }`
// footer). This mirrors how the rest of the codebase consumes pr-review.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { extractPreviewUrl, classifyPr } = require('./pr-review');

let passed = 0;
let failed = 0;

function assert(cond: unknown, label: string): void {
  if (cond) {
    passed += 1;
    console.log(`  PASS: ${label}`);
  } else {
    failed += 1;
    console.log(`  FAIL: ${label}`);
  }
}

function check(
  name: string,
  state: string = 'SUCCESS',
  url: string | null = null,
): CheckInfo {
  return { name, state, url };
}

console.log('Test: extractPreviewUrl — returns null when nothing matches');
{
  const url = extractPreviewUrl({ checks: [], comments: [] });
  assert(url === null, 'empty inputs → null');

  const url2 = extractPreviewUrl({
    checks: [check('lint'), check('build')],
    comments: [{ author: { login: 'kyan12' }, body: 'LGTM' }],
  });
  assert(url2 === null, 'no vercel signal → null');
}

console.log('Test: extractPreviewUrl — parses Vercel bot comment body');
{
  const url = extractPreviewUrl({
    checks: [],
    comments: [
      {
        author: { login: 'vercel[bot]' },
        body: 'Preview: https://my-app-abc123.vercel.app',
      },
    ],
  });
  assert(url === 'https://my-app-abc123.vercel.app', 'plain preview URL extracted');
}

console.log('Test: extractPreviewUrl — handles markdown-wrapped URL');
{
  const body = [
    '| Name | Status | Preview | Updated |',
    '| --- | --- | --- | --- |',
    '| my-app | ✅ Ready | [Visit Preview](https://my-app-git-feature.vercel.app) | now |',
  ].join('\n');
  const url = extractPreviewUrl({
    checks: [],
    comments: [{ author: { login: 'vercel[bot]' }, body }],
  });
  assert(url === 'https://my-app-git-feature.vercel.app', 'URL extracted from markdown table');
}

console.log('Test: extractPreviewUrl — URL with path segments');
{
  const url = extractPreviewUrl({
    checks: [],
    comments: [
      {
        author: { login: 'vercel[bot]' },
        body: 'Latest deployment ready at https://my-app-abc.vercel.app/dashboard/42',
      },
    ],
  });
  assert(
    url === 'https://my-app-abc.vercel.app/dashboard/42',
    'path segments preserved',
  );
}

console.log('Test: extractPreviewUrl — ignores non-Vercel bot comments');
{
  const url = extractPreviewUrl({
    checks: [],
    comments: [
      {
        author: { login: 'kyan12' },
        body: 'Preview is at https://my-app-abc.vercel.app',
      },
    ],
  });
  assert(url === null, 'non-bot comment with Vercel URL → null');
}

console.log('Test: extractPreviewUrl — scans newest comment first');
{
  const url = extractPreviewUrl({
    checks: [],
    comments: [
      { author: { login: 'vercel[bot]' }, body: 'Preview: https://old-abc.vercel.app' },
      { author: { login: 'kyan12' }, body: 'pushed new commit' },
      { author: { login: 'vercel[bot]' }, body: 'Preview: https://new-xyz.vercel.app' },
    ],
  });
  assert(
    url === 'https://new-xyz.vercel.app',
    'latest vercel[bot] comment wins over earlier one',
  );
}

console.log('Test: extractPreviewUrl — vercel-bot author variant');
{
  const url = extractPreviewUrl({
    checks: [],
    comments: [
      { author: { login: 'vercel-bot' }, body: 'Preview: https://my-app.vercel.app' },
    ],
  });
  assert(url === 'https://my-app.vercel.app', 'vercel-bot login recognised');
}

console.log('Test: extractPreviewUrl — case-insensitive author match');
{
  const url = extractPreviewUrl({
    checks: [],
    comments: [
      { author: { login: 'Vercel[bot]' }, body: 'Preview: https://my-app.vercel.app' },
    ],
  });
  assert(url === 'https://my-app.vercel.app', 'Vercel[bot] (capital V) recognised');
}

console.log('Test: extractPreviewUrl — falls back to Vercel check URL');
{
  const url = extractPreviewUrl({
    checks: [
      check('Vercel – my-app', 'SUCCESS', 'https://my-app-abc.vercel.app'),
    ],
    comments: [],
  });
  assert(
    url === 'https://my-app-abc.vercel.app',
    'check fallback extracts *.vercel.app URL',
  );
}

console.log('Test: extractPreviewUrl — ignores vercel.com dashboard URLs in checks');
{
  const url = extractPreviewUrl({
    checks: [
      check(
        'Vercel – my-app',
        'SUCCESS',
        'https://vercel.com/team/my-app/deployments/dpl_xxx',
      ),
    ],
    comments: [],
  });
  assert(url === null, 'dashboard URL not treated as preview');
}

console.log('Test: extractPreviewUrl — ignores non-Vercel named checks');
{
  const url = extractPreviewUrl({
    checks: [
      check('ci/circle', 'SUCCESS', 'https://ci.example.com/builds/1.vercel.app'),
    ],
    comments: [],
  });
  assert(url === null, 'check must be named /vercel/i');
}

console.log('Test: extractPreviewUrl — ignores checks with null URL');
{
  const url = extractPreviewUrl({
    checks: [check('Vercel – my-app', 'SUCCESS', null)],
    comments: [],
  });
  assert(url === null, 'null url skipped');
}

console.log('Test: extractPreviewUrl — bot comment beats check URL');
{
  const url = extractPreviewUrl({
    checks: [
      check('Vercel – my-app', 'SUCCESS', 'https://check-url.vercel.app'),
    ],
    comments: [
      {
        author: { login: 'vercel[bot]' },
        body: 'Preview: https://comment-url.vercel.app',
      },
    ],
  });
  assert(
    url === 'https://comment-url.vercel.app',
    'comment URL preferred over check URL',
  );
}

console.log('Test: extractPreviewUrl — null / missing fields tolerated');
{
  // Missing author / missing body — should not throw.
  const url = extractPreviewUrl({
    checks: [],
    comments: [
      { author: null, body: 'Preview: https://my-app.vercel.app' },
      { author: { login: null }, body: null },
      { author: { login: 'vercel[bot]' }, body: null },
    ],
  });
  assert(url === null, 'null fields tolerated, no match produces null');

  const url2 = extractPreviewUrl({
    checks: [],
    comments: null,
  });
  assert(url2 === null, 'null comments tolerated');

  const url3 = extractPreviewUrl({
    checks: [{ name: null as unknown as string, state: 'SUCCESS', url: null }],
    comments: [],
  });
  assert(url3 === null, 'check with null name ignored');
}

console.log('Test: extractPreviewUrl — strips trailing punctuation cleanly');
{
  const url = extractPreviewUrl({
    checks: [],
    comments: [
      {
        author: { login: 'vercel[bot]' },
        body: 'Preview: (https://my-app-abc.vercel.app) is live',
      },
    ],
  });
  assert(
    url === 'https://my-app-abc.vercel.app',
    'trailing ) excluded from URL',
  );
}

console.log('Test: classifyPr — closed unmerged PR is terminal, not remediable');
{
  const result = classifyPr({
    state: 'CLOSED',
    isDraft: false,
    mergeable: 'CONFLICTING',
    reviewDecision: '',
    statusCheckRollup: [
      { __typename: 'CheckRun', status: 'COMPLETED', conclusion: 'FAILURE', name: 'Vercel' },
    ],
  });
  assert(result.disposition === 'closed', 'closed PR disposition is closed');
  assert(result.blockerType === 'closed', 'closed PR blocker type is closed');
  assert(result.blockers.length === 1 && result.blockers[0] === 'pr is closed', 'stale conflicts/check failures ignored on closed PR');
  assert(result.failedChecks.length === 0, 'closed PR failed checks are not remediated');
}

console.log('Test: classifyPr — open conflicting PR remains remediable');
{
  const result = classifyPr({
    state: 'OPEN',
    isDraft: false,
    mergeable: 'CONFLICTING',
    reviewDecision: '',
    statusCheckRollup: [],
  });
  assert(result.disposition === 'block', 'open conflict still blocks');
  assert(result.blockerType === 'merge', 'open conflict keeps merge blocker type');
  assert(result.blockers.includes('merge conflicts'), 'open conflict records merge conflict');
}

console.log(`pr-review.test: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
