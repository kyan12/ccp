import assert = require('assert');
import fs = require('fs');
import path = require('path');
import type { RepoMapping } from '../types';
const { loadConfig } = require('./config') as typeof import('./config');

const LEGACY_PREFIX = '/Users/kyan/code-crab/';
const CANONICAL_REPO_PREFIX = '/Users/crab/repos/';
const CANONICAL_CCP_PATH = '/Users/crab/coding-control-plane';
const VALIDATE_LOCAL_PATHS = process.env.CCP_VALIDATE_LOCAL_REPO_PATHS === '1';

type ReposConfigShape = { mappings?: RepoMapping[] };

const cfg = loadConfig<ReposConfigShape>('repos', { mappings: [] });
const mappings = cfg.mappings || [];

console.log('\nTest: production repo mappings use canonical Mac mini local paths');
{
  assert.equal(mappings.length, 25, 'expected 25 production repo mappings');

  for (const mapping of mappings) {
    assert.ok(mapping.key, 'mapping has a key');
    assert.ok(mapping.localPath, `${mapping.key} has a localPath`);
    assert.ok(
      !mapping.localPath.startsWith(LEGACY_PREFIX),
      `${mapping.key} localPath must not retain legacy ${LEGACY_PREFIX}: ${mapping.localPath}`,
    );

    if (mapping.key === 'ccp') {
      assert.equal(mapping.localPath, CANONICAL_CCP_PATH, 'ccp maps to canonical control-plane checkout');
    } else {
      assert.ok(
        mapping.localPath.startsWith(CANONICAL_REPO_PREFIX),
        `${mapping.key} maps under ${CANONICAL_REPO_PREFIX}: ${mapping.localPath}`,
      );
    }
  }
}

if (VALIDATE_LOCAL_PATHS) {
  console.log('\nTest: canonical Mac mini repo mapping paths exist and are git repositories');
  for (const mapping of mappings) {
    const gitDir = path.join(mapping.localPath, '.git');
    assert.ok(fs.existsSync(mapping.localPath), `${mapping.key} path exists: ${mapping.localPath}`);
    assert.ok(fs.existsSync(gitDir), `${mapping.key} path is a git repo: ${gitDir}`);
  }
} else {
  console.log('\nSkipping host-local repo existence checks; set CCP_VALIDATE_LOCAL_REPO_PATHS=1 on the canonical Mac mini to enable.');
}

console.log('repo-config tests passed');
