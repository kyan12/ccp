import assert = require('assert');
import fs = require('fs');
import path = require('path');
import type { RepoMapping } from '../types';
const { loadConfig } = require('./config') as typeof import('./config');
const { findRepoMapping, enrichPayloadWithRepo } = require('./repos') as typeof import('./repos');

const LEGACY_PREFIX = '/Users/crab/';
const CANONICAL_REPO_PREFIX = '/Users/kyan/code-crab/repos/';
const CANONICAL_CCP_PATH = '/Users/kyan/code-crab/coding-control-plane';
const VALIDATE_LOCAL_PATHS = process.env.CCP_VALIDATE_LOCAL_REPO_PATHS === '1';

type ReposConfigShape = { mappings?: RepoMapping[] };

const cfg = loadConfig<ReposConfigShape>('repos', { mappings: [] });
const mappings = cfg.mappings || [];

console.log('\nTest: production repo mappings use canonical Mac Studio local paths');
{
  assert.equal(mappings.length, 28, 'expected 28 production repo mappings');

  for (const mapping of mappings) {
    assert.ok(mapping.key, 'mapping has a key');
    assert.ok(mapping.localPath, `${mapping.key} has a localPath`);
    assert.ok(
      !mapping.localPath.startsWith(LEGACY_PREFIX),
      `${mapping.key} localPath must not retain retired Mini prefix ${LEGACY_PREFIX}: ${mapping.localPath}`,
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

console.log('\nTest: high-volume repos use isolated two-job worktrees');
{
  for (const key of ['proteusx-os', 'papyrx', 'gslogistics', 'licatesi-law', 'licatesi-law-ai-workspace']) {
    const mapping = mappings.find((entry) => entry.key === key);
    assert.ok(mapping, `${key} mapping exists`);
    assert.equal(mapping?.worktree, true, `${key} enables per-job worktrees`);
    assert.equal(mapping?.parallelJobs, 2, `${key} allows two concurrent CCP jobs`);
  }
}

console.log('\nTest: attention-pipeline-ios mapping is present, locked down, and resolves to an existing git repo');
{
  const mapping = mappings.find((entry) => entry.key === 'attention-pipeline-ios') as (RepoMapping & { baseBranch?: string }) | undefined;
  assert.ok(mapping, 'attention-pipeline-ios mapping exists');
  assert.equal(mapping?.ownerRepo, 'ProteusX-Consulting/attention-pipeline-ios');
  assert.equal(mapping?.gitUrl, 'git@github.com:ProteusX-Consulting/attention-pipeline-ios.git');
  assert.equal(mapping?.localPath, '/Users/kyan/code-crab/repos/attention-pipeline-ios');
  assert.equal(mapping?.baseBranch, 'main');
  assert.equal(mapping?.mergeMethod, 'squash');
  assert.equal(mapping?.autoMerge, false, 'attention-pipeline-ios auto-merge stays disabled');
  assert.equal(mapping?.nightly?.enabled, false, 'attention-pipeline-ios nightly automation stays disabled');
  assert.deepEqual(mapping?.aliases, [
    'attention pipeline',
    'attention-pipeline-ios',
    'ProteusX Cockpit',
    'proteusx-cockpit',
    'cockpit',
    'attention app',
  ]);
  for (const alias of [
    'attention pipeline',
    'attention-pipeline-ios',
    'ProteusX Cockpit',
    'proteusx-cockpit',
    'cockpit',
    'attention app',
    'ProteusX-Consulting/attention-pipeline-ios',
  ]) {
    const resolved = findRepoMapping({ repo: alias });
    assert.equal(resolved?.key, 'attention-pipeline-ios', `${alias} resolves to attention-pipeline-ios`);
  }

  const enriched = enrichPayloadWithRepo({ repo: 'attention app' });
  assert.equal(enriched.repoKey, 'attention-pipeline-ios');
  assert.equal(enriched.repo, '/Users/kyan/code-crab/repos/attention-pipeline-ios');

  if (VALIDATE_LOCAL_PATHS) {
    assert.equal(enriched.repoResolved, true, 'attention app resolves to an existing checkout');
    assert.ok(fs.existsSync(path.join(mapping!.localPath, '.git')), 'attention-pipeline-ios localPath is an existing git repo');
  }
}

console.log('\nTest: partner-service-broker mapping is present, locked down, and resolves by key, owner/name, and aliases');
{
  const mapping = mappings.find((entry) => entry.key === 'partner-service-broker') as (RepoMapping & { baseBranch?: string }) | undefined;
  assert.ok(mapping, 'partner-service-broker mapping exists');
  assert.equal(mapping?.ownerRepo, 'ProteusX-Consulting/partner-service-broker');
  assert.equal(mapping?.gitUrl, 'git@github.com:ProteusX-Consulting/partner-service-broker.git');
  assert.equal(mapping?.localPath, '/Users/kyan/code-crab/repos/partner-service-broker');
  assert.equal(mapping?.baseBranch, 'main');
  assert.equal(mapping?.mergeMethod, 'squash');
  assert.equal(mapping?.autoMerge, false, 'partner-service-broker auto-merge stays disabled');
  assert.deepEqual(mapping?.aliases, [
    'partner service broker',
    'partner-service-broker',
    'service broker',
    'moshi service broker',
  ]);

  for (const repo of [
    'partner-service-broker',
    'ProteusX-Consulting/partner-service-broker',
    'partner service broker',
    'service broker',
    'moshi service broker',
  ]) {
    const resolved = findRepoMapping({ repo });
    assert.equal(resolved?.key, 'partner-service-broker', `${repo} resolves to partner-service-broker`);
    assert.equal(resolved?.localPath, '/Users/kyan/code-crab/repos/partner-service-broker', `${repo} resolves to canonical checkout`);
  }

  const enriched = enrichPayloadWithRepo({ repo: 'moshi service broker' });
  assert.equal(enriched.repoKey, 'partner-service-broker');
  assert.equal(enriched.ownerRepo, 'ProteusX-Consulting/partner-service-broker');
  assert.equal(enriched.repo, '/Users/kyan/code-crab/repos/partner-service-broker');

  if (VALIDATE_LOCAL_PATHS) {
    assert.equal(enriched.repoResolved, true, 'moshi service broker resolves to an existing checkout');
    assert.ok(fs.existsSync(path.join(mapping!.localPath, '.git')), 'partner-service-broker localPath is an existing git repo');
  }
}

console.log('\nTest: myfont-ai mapping is present, isolated, locked down, and resolves by key, owner/name, and aliases');
{
  const mapping = mappings.find((entry) => entry.key === 'myfont-ai') as (RepoMapping & { baseBranch?: string }) | undefined;
  assert.ok(mapping, 'myfont-ai mapping exists');
  assert.equal(mapping?.ownerRepo, 'ProteusX-Consulting/myfont-ai');
  assert.equal(mapping?.gitUrl, 'git@github.com:ProteusX-Consulting/myfont-ai.git');
  assert.equal(mapping?.localPath, '/Users/kyan/code-crab/repos/myfont-ai');
  assert.equal(mapping?.baseBranch, 'main');
  assert.equal(mapping?.worktree, true, 'myfont-ai uses isolated per-job worktrees');
  assert.equal(mapping?.parallelJobs, 1, 'myfont-ai permits one CCP job at a time');
  assert.equal(mapping?.mergeMethod, 'squash');
  assert.equal(mapping?.autoMerge, false, 'myfont-ai auto-merge stays disabled');
  assert.equal(mapping?.nightly?.enabled, false, 'myfont-ai nightly automation stays disabled');
  assert.deepEqual(mapping?.aliases, ['myfont-ai', 'myfont ai', 'myfont', 'myfont.ai']);

  for (const repo of [
    'myfont-ai',
    'ProteusX-Consulting/myfont-ai',
    'myfont ai',
    'myfont',
    'myfont.ai',
  ]) {
    const resolved = findRepoMapping({ repo });
    assert.equal(resolved?.key, 'myfont-ai', `${repo} resolves to myfont-ai`);
    assert.equal(resolved?.localPath, '/Users/kyan/code-crab/repos/myfont-ai', `${repo} resolves to canonical checkout`);
  }

  const enriched = enrichPayloadWithRepo({ repo: 'myfont.ai' });
  assert.equal(enriched.repoKey, 'myfont-ai');
  assert.equal(enriched.ownerRepo, 'ProteusX-Consulting/myfont-ai');
  assert.equal(enriched.repo, '/Users/kyan/code-crab/repos/myfont-ai');

  if (VALIDATE_LOCAL_PATHS) {
    assert.equal(enriched.repoResolved, true, 'myfont.ai resolves to an existing checkout');
    assert.ok(fs.existsSync(path.join(mapping!.localPath, '.git')), 'myfont-ai localPath is an existing git repo');
  }
}

if (VALIDATE_LOCAL_PATHS) {
  console.log('\nTest: canonical Mac Studio repo mapping paths exist and are git repositories');
  for (const mapping of mappings) {
    const gitDir = path.join(mapping.localPath, '.git');
    assert.ok(fs.existsSync(mapping.localPath), `${mapping.key} path exists: ${mapping.localPath}`);
    assert.ok(fs.existsSync(gitDir), `${mapping.key} path is a git repo: ${gitDir}`);
  }
} else {
  console.log('\nSkipping host-local repo existence checks; set CCP_VALIDATE_LOCAL_REPO_PATHS=1 on the canonical host to enable.');
}

console.log('repo-config tests passed');
