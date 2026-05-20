import assert = require('assert');
import fs = require('fs');
import os = require('os');
import path = require('path');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ccp-repos-'));
process.env.CCP_ROOT = root;

fs.mkdirSync(path.join(root, 'configs'), { recursive: true });

const reposFile = path.join(root, 'configs', 'repos.json');
fs.writeFileSync(reposFile, JSON.stringify({
  mappings: {
    bad: {
      key: 'bad',
      localPath: path.join(root, 'bad'),
    },
  },
}, null, 2) + '\n');

const { repoConfig, findRepoMapping, findRepoByPath } = require('./repos') as typeof import('./repos');

console.log('\nTest: repoConfig treats malformed mappings as empty');
{
  const cfg = repoConfig();
  assert.deepEqual(cfg.mappings, []);
}

console.log('\nTest: repo lookups tolerate malformed mappings');
{
  assert.equal(findRepoMapping({ repo: 'bad' }), null);
  assert.equal(findRepoByPath(path.join(root, 'bad')), null);
}

fs.writeFileSync(reposFile, JSON.stringify({
  mappings: [
    {
      key: 'good',
      ownerRepo: 'owner/good',
      localPath: path.join(root, 'good'),
      aliases: ['good-app'],
    },
  ],
}, null, 2) + '\n');

console.log('\nTest: repo lookups still resolve valid mappings');
{
  const mapping = findRepoMapping({ repo: 'good-app' });
  assert(mapping !== null);
  assert.equal(mapping.key, 'good');
  assert.equal(findRepoByPath(path.join(root, 'good'))?.ownerRepo, 'owner/good');
}

fs.rmSync(root, { recursive: true, force: true });
console.log('repos tests passed');
