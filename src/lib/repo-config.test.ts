import assert = require('assert');
import fs = require('fs');
import path = require('path');
import type { RepoMapping } from '../types';
const { loadConfig } = require('./config') as typeof import('./config');
const { findRepoMapping, enrichPayloadWithRepo } = require('./repos') as typeof import('./repos');

const LEGACY_PREFIX = '/Users/kyan/code-crab/';
const CANONICAL_REPO_PREFIX = '/Users/crab/repos/';
const CANONICAL_CCP_PATH = '/Users/crab/coding-control-plane';
const VALIDATE_LOCAL_PATHS = process.env.CCP_VALIDATE_LOCAL_REPO_PATHS === '1';

type ReposConfigShape = { mappings?: RepoMapping[] };

const cfg = loadConfig<ReposConfigShape>('repos', { mappings: [] });
const mappings = cfg.mappings || [];

console.log('\nTest: production repo mappings use canonical Mac mini local paths');
{
  assert.equal(mappings.length, 26, 'expected 26 production repo mappings');

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

console.log('\nTest: attention-pipeline-ios mapping is present, locked down, and resolves to an existing git repo');
{
  const mapping = mappings.find((entry) => entry.key === 'attention-pipeline-ios') as (RepoMapping & { baseBranch?: string }) | undefined;
  assert.ok(mapping, 'attention-pipeline-ios mapping exists');
  assert.equal(mapping?.ownerRepo, 'ProteusX-Consulting/attention-pipeline-ios');
  assert.equal(mapping?.gitUrl, 'git@github.com:ProteusX-Consulting/attention-pipeline-ios.git');
  assert.equal(mapping?.localPath, '/Users/crab/repos/attention-pipeline-ios');
  assert.equal(mapping?.baseBranch, 'main');
  assert.equal(mapping?.autoMerge, true, "attention-pipeline-ios auto-merge is enabled after explicit approval");
  assert.equal(mapping?.nightly?.enabled, false, 'attention-pipeline-ios nightly automation stays disabled');
  assert.deepEqual(mapping?.aliases, [
    'attention pipeline',
    'attention-pipeline-ios',
    'hermes attention pipeline',
    'supervisor ios',
    'attention app',
  ]);
  for (const alias of [
    'attention pipeline',
    'attention-pipeline-ios',
    'hermes attention pipeline',
    'supervisor ios',
    'attention app',
    'ProteusX-Consulting/attention-pipeline-ios',
  ]) {
    const resolved = findRepoMapping({ repo: alias });
    assert.equal(resolved?.key, 'attention-pipeline-ios', `${alias} resolves to attention-pipeline-ios`);
  }

  const enriched = enrichPayloadWithRepo({ repo: 'attention app' });
  assert.equal(enriched.repoResolved, true, 'attention app resolves to an existing checkout');
  assert.equal(enriched.repoKey, 'attention-pipeline-ios');
  assert.equal(enriched.repo, '/Users/crab/repos/attention-pipeline-ios');

  if (VALIDATE_LOCAL_PATHS) {
    assert.ok(fs.existsSync(path.join(mapping!.localPath, '.git')), 'attention-pipeline-ios localPath is an existing git repo');
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
