/**
 * repo-knowledge.ts — Per-repo knowledge persistence.
 *
 * Stores learned information about each managed repository so that
 * future jobs don't have to rediscover the same patterns. Knowledge
 * is auto-populated during repo context scanning and can be enriched
 * by workers during job execution.
 *
 * Storage: configs/repo-knowledge/<repo-key>.json
 */

import fs = require('fs');
import path = require('path');
const { ROOT } = require('./paths');

const KNOWLEDGE_DIR: string = path.join(ROOT, 'configs', 'repo-knowledge');

export interface RepoKnowledge {
  repoKey: string;
  ownerRepo: string | null;
  /** Auto-detected or manually overridden commands */
  commands: {
    lint: string | null;
    typecheck: string | null;
    test: string | null;
    build: string | null;
    dev: string | null;
    format: string | null;
  };
  /** Project metadata */
  projectType: string | null;
  packageManager: string | null;
  /** Known gotchas or tips discovered during jobs */
  notes: string[];
  /** Common failure patterns and their fixes */
  knownIssues: Array<{
    pattern: string;
    fix: string;
    addedAt: string;
  }>;
  /** Files the worker should always read before starting */
  requiredReading: string[];
  /** Custom prompt additions for this repo */
  promptAdditions: string[];
  updatedAt: string;
  createdAt: string;
}

function ensureDir(): void {
  fs.mkdirSync(KNOWLEDGE_DIR, { recursive: true });
}

function knowledgePath(repoKey: string): string {
  const safeKey = repoKey.replace(/[^a-zA-Z0-9_-]/g, '_');
  return path.join(KNOWLEDGE_DIR, `${safeKey}.json`);
}

export function loadKnowledge(repoKey: string): RepoKnowledge | null {
  const file = knowledgePath(repoKey);
  if (!fs.existsSync(file)) return null;
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    console.error(`[ccp] failed to parse repo knowledge for ${repoKey}: ${(err as Error).message}`);
    return null;
  }
}

export function saveKnowledge(knowledge: RepoKnowledge): void {
  ensureDir();
  const file = knowledgePath(knowledge.repoKey);
  knowledge.updatedAt = new Date().toISOString();
  fs.writeFileSync(file, JSON.stringify(knowledge, null, 2) + '\n');
}

export function createDefaultKnowledge(repoKey: string, ownerRepo: string | null): RepoKnowledge {
  const now = new Date().toISOString();
  return {
    repoKey,
    ownerRepo,
    commands: {
      lint: null,
      typecheck: null,
      test: null,
      build: null,
      dev: null,
      format: null,
    },
    projectType: null,
    packageManager: null,
    notes: [],
    knownIssues: [],
    requiredReading: [],
    promptAdditions: [],
    updatedAt: now,
    createdAt: now,
  };
}

/**
 * Get or create knowledge for a repo. Merges auto-detected context
 * (from repo-context.ts) with any manually persisted overrides.
 * Manual overrides always take precedence.
 */
export function getOrCreateKnowledge(
  repoKey: string,
  ownerRepo: string | null,
  autoDetected?: {
    commands?: Partial<RepoKnowledge['commands']>;
    projectType?: string;
    packageManager?: string;
  },
): RepoKnowledge {
  let knowledge = loadKnowledge(repoKey);
  const isNew = !knowledge;

  if (!knowledge) {
    knowledge = createDefaultKnowledge(repoKey, ownerRepo);
  }

  // Merge auto-detected values (only fill in nulls — manual overrides persist)
  if (autoDetected) {
    if (autoDetected.commands) {
      for (const [key, value] of Object.entries(autoDetected.commands)) {
        const cmdKey = key as keyof RepoKnowledge['commands'];
        if (value && !knowledge.commands[cmdKey]) {
          knowledge.commands[cmdKey] = value;
        }
      }
    }
    if (autoDetected.projectType && !knowledge.projectType) {
      knowledge.projectType = autoDetected.projectType;
    }
    if (autoDetected.packageManager && !knowledge.packageManager) {
      knowledge.packageManager = autoDetected.packageManager;
    }
  }

  // Persist if new or updated
  if (isNew || autoDetected) {
    saveKnowledge(knowledge);
  }

  return knowledge;
}

/**
 * Add a note to the repo's knowledge base.
 */
export function addNote(repoKey: string, note: string): void {
  const knowledge = loadKnowledge(repoKey);
  if (!knowledge) return;
  if (!knowledge.notes.includes(note)) {
    knowledge.notes.push(note);
    saveKnowledge(knowledge);
  }
}

/**
 * Add a known issue pattern and its fix.
 */
export function addKnownIssue(repoKey: string, pattern: string, fix: string): void {
  const knowledge = loadKnowledge(repoKey);
  if (!knowledge) return;
  const existing = knowledge.knownIssues.find((ki) => ki.pattern === pattern);
  if (!existing) {
    knowledge.knownIssues.push({ pattern, fix, addedAt: new Date().toISOString() });
    saveKnowledge(knowledge);
  }
}

/**
 * List all repos that have stored knowledge.
 */
export function listKnownRepos(): string[] {
  ensureDir();
  return fs.readdirSync(KNOWLEDGE_DIR)
    .filter((f) => f.endsWith('.json'))
    .map((f) => f.replace(/\.json$/, ''));
}

/**
 * Format knowledge into prompt sections for worker injection.
 */
export function formatKnowledgeForPrompt(knowledge: RepoKnowledge): string {
  const parts: string[] = [];

  // Known issues
  if (knowledge.knownIssues.length > 0) {
    const issues = knowledge.knownIssues.map((ki) => `- If you see "${ki.pattern}" → ${ki.fix}`).join('\n');
    parts.push(`## Known Issues for ${knowledge.repoKey}\n${issues}`);
  }

  // Notes
  if (knowledge.notes.length > 0) {
    parts.push(`## Notes for ${knowledge.repoKey}\n- ${knowledge.notes.join('\n- ')}`);
  }

  // Required reading
  if (knowledge.requiredReading.length > 0) {
    parts.push(`## Required Reading\nBefore starting, read these files:\n- ${knowledge.requiredReading.join('\n- ')}`);
  }

  // Custom prompt additions
  if (knowledge.promptAdditions.length > 0) {
    parts.push(knowledge.promptAdditions.join('\n\n'));
  }

  return parts.join('\n\n');
}

module.exports = {
  loadKnowledge,
  saveKnowledge,
  createDefaultKnowledge,
  getOrCreateKnowledge,
  addNote,
  addKnownIssue,
  listKnownRepos,
  formatKnowledgeForPrompt,
};
