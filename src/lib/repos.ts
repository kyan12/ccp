import fs = require('fs');
import path = require('path');
import type { RepoMapping, ReposConfig, IntakePayload } from '../types';
const { loadConfig } = require('./config');

function repoConfig(): ReposConfig {
  return loadConfig('repos', { mappings: [] }) as ReposConfig;
}

function normalize(text: unknown): string {
  return String(text || '').toLowerCase();
}

function findRepoMapping(payload: IntakePayload = {}): RepoMapping | null {
  const cfg = repoConfig();
  const haystacks: string[] = [
    payload.repo,
    payload.repoKey,
    payload.repoName,
    payload.goal,
    payload.title,
    payload.summary,
    payload.description,
    (payload.metadata as Record<string, unknown>)?.repo as string,
    (payload.metadata as Record<string, unknown>)?.title as string,
    (payload.metadata as Record<string, unknown>)?.culprit as string,
  ].filter(Boolean).map(normalize) as string[];

  // Pass 1: exact match on key, ownerRepo, or aliases (prevents "dida" matching "didahairstudio")
  for (const mapping of cfg.mappings || []) {
    const exactCandidates: string[] = [mapping.key, mapping.ownerRepo, ...(mapping.aliases || [])]
      .filter(Boolean)
      .map(normalize) as string[];
    if (exactCandidates.some((candidate) => haystacks.some((hay) => hay === candidate))) {
      return mapping;
    }
  }

  // Pass 2: substring match (fuzzy fallback). Prefer the most-specific
  // candidate globally so broad aliases/domains like "proteusx.ai" do not
  // steal requests for subdomains like "arbs.proteusx.ai".
  const fuzzyCandidates = (cfg.mappings || []).flatMap((mapping) =>
    [mapping.key, mapping.ownerRepo, mapping.gitUrl, mapping.localPath, ...(mapping.aliases || [])]
      .filter(Boolean)
      .map((raw) => ({ mapping, candidate: normalize(raw) })),
  ).sort((a, b) => b.candidate.length - a.candidate.length);
  for (const { mapping, candidate } of fuzzyCandidates) {
    if (haystacks.some((hay) => hay.includes(candidate))) {
      return mapping;
    }
  }
  return null;
}

function enrichPayloadWithRepo(payload: IntakePayload = {}): IntakePayload & { repoResolved: boolean } {
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

function findRepoByPath(repoPath: string): RepoMapping | null {
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

export { repoConfig, findRepoMapping, findRepoByPath, enrichPayloadWithRepo };
