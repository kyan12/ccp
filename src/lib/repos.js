const fs = require('fs');
const path = require('path');
const { loadConfig } = require('./config');

function repoConfig() {
  return loadConfig('repos', { mappings: [] });
}

function normalize(text) {
  return String(text || '').toLowerCase();
}

function findRepoMapping(payload = {}) {
  const cfg = repoConfig();
  const haystacks = [
    payload.repo,
    payload.repoKey,
    payload.repoName,
    payload.goal,
    payload.title,
    payload.summary,
    payload.description,
    payload.metadata?.repo,
    payload.metadata?.title,
    payload.metadata?.culprit,
  ].filter(Boolean).map(normalize);

  for (const mapping of cfg.mappings || []) {
    const candidates = [mapping.key, mapping.ownerRepo, mapping.gitUrl, mapping.localPath, ...(mapping.aliases || [])]
      .filter(Boolean)
      .map(normalize);
    if (candidates.some((candidate) => haystacks.some((hay) => hay.includes(candidate)))) {
      return mapping;
    }
  }
  return null;
}

function enrichPayloadWithRepo(payload = {}) {
  const mapping = findRepoMapping(payload);
  if (!mapping) return { ...payload, repoResolved: false };
  return {
    ...payload,
    repo: mapping.localPath,
    repoKey: mapping.key,
    ownerRepo: mapping.ownerRepo,
    gitUrl: mapping.gitUrl,
    repoResolved: fs.existsSync(mapping.localPath),
  };
}

function findRepoByPath(repoPath) {
  if (!repoPath) return null;
  const cfg = repoConfig();
  const normalized = path.resolve(repoPath);
  for (const mapping of cfg.mappings || []) {
    if (mapping.localPath && path.resolve(mapping.localPath) === normalized) return mapping;
  }
  return null;
}

module.exports = {
  repoConfig,
  findRepoMapping,
  findRepoByPath,
  enrichPayloadWithRepo,
};
