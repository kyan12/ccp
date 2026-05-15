import assert = require('assert');
import fs = require('fs');
import os = require('os');
import path = require('path');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ccp-pr-policy-'));
process.env.CCP_ROOT = root;
process.env.CCP_PR_AUTOMERGE = 'false';

fs.mkdirSync(path.join(root, 'configs'), { recursive: true });
fs.writeFileSync(path.join(root, 'configs', 'repos.json'), JSON.stringify({
  mappings: [
    {
      key: 'normal',
      localPath: path.join(root, 'normal'),
      autoMerge: true,
      mergeMethod: 'squash',
    },
    {
      key: 'nightly-off',
      localPath: path.join(root, 'nightly-off'),
      autoMerge: true,
      mergeMethod: 'squash',
      nightly: { enabled: true, autoMerge: false },
    },
    {
      key: 'nightly-on',
      localPath: path.join(root, 'nightly-on'),
      autoMerge: false,
      mergeMethod: 'merge',
      nightly: { enabled: true, autoMerge: true },
    },
  ],
}, null, 2) + '\n');

const { prReviewPolicy } = require('./pr-policy') as typeof import('./pr-policy');

console.log('\nTest: prReviewPolicy honors nightly autoMerge override only for nightly jobs');
{
  const normal = prReviewPolicy(path.join(root, 'normal'));
  assert.equal(normal.autoMerge, true);

  const inherited = prReviewPolicy(path.join(root, 'nightly-off'));
  assert.equal(inherited.autoMerge, true, 'non-nightly jobs use normal repo autoMerge');

  const nightlyOff = prReviewPolicy(path.join(root, 'nightly-off'), { isNightly: true });
  assert.equal(nightlyOff.autoMerge, false, 'nightly override can disable autoMerge');

  const nightlyOn = prReviewPolicy(path.join(root, 'nightly-on'), { isNightly: true });
  assert.equal(nightlyOn.autoMerge, true, 'nightly override can enable autoMerge');
  assert.equal(nightlyOn.mergeMethod, 'merge', 'nightly override does not change merge method');
}

fs.rmSync(root, { recursive: true, force: true });
console.log('pr-policy tests passed');
