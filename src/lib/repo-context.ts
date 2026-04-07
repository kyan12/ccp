/**
 * repo-context.ts — Scan a repository for useful context before launching a worker.
 *
 * Extracts:
 * - CLAUDE.md / AGENTS.md instructions
 * - Lint, typecheck, test, and build commands from package.json / Makefile / pyproject.toml
 * - Project type detection (Node/Python/Go/Rust/etc.)
 * - Pre-commit hook awareness
 * - README summary (first ~500 chars for orientation)
 */

import fs = require('fs');
import path = require('path');

export interface RepoCommands {
  lint: string | null;
  typecheck: string | null;
  test: string | null;
  build: string | null;
  dev: string | null;
  format: string | null;
}

export interface RepoContext {
  projectType: string;
  claudeMd: string | null;
  agentsMd: string | null;
  readmeExcerpt: string | null;
  commands: RepoCommands;
  hasPreCommitHooks: boolean;
  packageManager: string | null;
  /** Additional context files found (e.g. .eslintrc, tsconfig.json) */
  configFiles: string[];
  scannedAt: string;
}

function readFileIfExists(filePath: string, maxBytes: number = 8000): string | null {
  try {
    if (!fs.existsSync(filePath)) return null;
    const content = fs.readFileSync(filePath, 'utf8');
    return content.length > maxBytes ? content.slice(0, maxBytes) + '\n...(truncated)' : content;
  } catch {
    return null;
  }
}

function readFirstNChars(filePath: string, n: number): string | null {
  try {
    if (!fs.existsSync(filePath)) return null;
    const fd = fs.openSync(filePath, 'r');
    try {
      const buf = Buffer.alloc(n);
      const bytesRead = fs.readSync(fd, buf, 0, n, 0);
      return buf.toString('utf8', 0, bytesRead);
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return null;
  }
}

function detectPackageManager(repoPath: string): string | null {
  if (fs.existsSync(path.join(repoPath, 'bun.lockb')) || fs.existsSync(path.join(repoPath, 'bun.lock'))) return 'bun';
  if (fs.existsSync(path.join(repoPath, 'pnpm-lock.yaml'))) return 'pnpm';
  if (fs.existsSync(path.join(repoPath, 'yarn.lock'))) return 'yarn';
  if (fs.existsSync(path.join(repoPath, 'package-lock.json'))) return 'npm';
  if (fs.existsSync(path.join(repoPath, 'package.json'))) return 'npm';
  return null;
}

function detectProjectType(repoPath: string): string {
  if (fs.existsSync(path.join(repoPath, 'package.json'))) {
    if (fs.existsSync(path.join(repoPath, 'tsconfig.json'))) return 'typescript';
    return 'javascript';
  }
  if (fs.existsSync(path.join(repoPath, 'pyproject.toml')) || fs.existsSync(path.join(repoPath, 'setup.py'))) return 'python';
  if (fs.existsSync(path.join(repoPath, 'Cargo.toml'))) return 'rust';
  if (fs.existsSync(path.join(repoPath, 'go.mod'))) return 'go';
  if (fs.existsSync(path.join(repoPath, 'Gemfile'))) return 'ruby';
  if (fs.existsSync(path.join(repoPath, 'pom.xml')) || fs.existsSync(path.join(repoPath, 'build.gradle'))) return 'java';
  return 'unknown';
}

function extractNodeCommands(repoPath: string, pm: string): Partial<RepoCommands> {
  const commands: Partial<RepoCommands> = {};
  const pkgPath = path.join(repoPath, 'package.json');
  if (!fs.existsSync(pkgPath)) return commands;

  let pkg: Record<string, unknown>;
  try {
    pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
  } catch {
    return commands;
  }

  const scripts = (pkg.scripts || {}) as Record<string, string>;
  const run = pm === 'npm' || pm === 'bun' ? `${pm} run` : pm;

  // Lint: try lint, then eslint
  if (scripts.lint) commands.lint = `${run} lint`;
  else if (scripts['lint:fix']) commands.lint = `${run} lint:fix`;

  // Typecheck: try typecheck, then tsc
  if (scripts.typecheck) commands.typecheck = `${run} typecheck`;
  else if (scripts['type-check']) commands.typecheck = `${run} type-check`;
  else if (scripts.tsc) commands.typecheck = `${run} tsc`;
  else if (fs.existsSync(path.join(repoPath, 'tsconfig.json'))) {
    // Check if typescript is a dependency
    const deps = { ...(pkg.dependencies as Record<string, string> || {}), ...(pkg.devDependencies as Record<string, string> || {}) };
    if (deps.typescript) commands.typecheck = 'npx tsc --noEmit';
  }

  // Test
  if (scripts.test) commands.test = `${run} test`;

  // Build
  if (scripts.build) commands.build = `${run} build`;

  // Dev
  if (scripts.dev) commands.dev = `${run} dev`;
  else if (scripts.start) commands.dev = `${run} start`;

  // Format
  if (scripts.format) commands.format = `${run} format`;
  else if (scripts.prettier) commands.format = `${run} prettier`;

  return commands;
}

function extractMakefileCommands(repoPath: string): Partial<RepoCommands> {
  const commands: Partial<RepoCommands> = {};
  const makefile = readFileIfExists(path.join(repoPath, 'Makefile'), 4000);
  if (!makefile) return commands;

  const targets = new Set<string>();
  for (const line of makefile.split('\n')) {
    const m = line.match(/^([a-zA-Z_-]+)\s*:/);
    if (m) targets.add(m[1]);
  }

  if (targets.has('lint')) commands.lint = 'make lint';
  if (targets.has('typecheck')) commands.typecheck = 'make typecheck';
  if (targets.has('test')) commands.test = 'make test';
  if (targets.has('build')) commands.build = 'make build';
  if (targets.has('dev')) commands.dev = 'make dev';
  if (targets.has('format') || targets.has('fmt')) commands.format = targets.has('format') ? 'make format' : 'make fmt';

  return commands;
}

function extractPythonCommands(repoPath: string): Partial<RepoCommands> {
  const commands: Partial<RepoCommands> = {};

  // Check pyproject.toml for scripts
  const pyproject = readFileIfExists(path.join(repoPath, 'pyproject.toml'), 4000);
  if (pyproject) {
    if (/\[tool\.ruff\]/.test(pyproject) || /ruff/.test(pyproject)) {
      commands.lint = 'ruff check .';
      commands.format = 'ruff format .';
    } else if (/\[tool\.flake8\]/.test(pyproject)) {
      commands.lint = 'flake8 .';
    }
    if (/\[tool\.mypy\]/.test(pyproject)) {
      commands.typecheck = 'mypy .';
    }
    if (/\[tool\.pytest\]/.test(pyproject) || /pytest/.test(pyproject)) {
      commands.test = 'pytest';
    }
  }

  return commands;
}

function findConfigFiles(repoPath: string): string[] {
  const configPatterns = [
    '.eslintrc', '.eslintrc.js', '.eslintrc.json', '.eslintrc.yml', 'eslint.config.js', 'eslint.config.mjs',
    'tsconfig.json',
    '.prettierrc', '.prettierrc.js', '.prettierrc.json', 'prettier.config.js',
    'biome.json', 'biome.jsonc',
    '.editorconfig',
    'jest.config.js', 'jest.config.ts', 'vitest.config.ts', 'vitest.config.js',
    '.github/workflows', '.github/CODEOWNERS',
    'Dockerfile', 'docker-compose.yml', 'docker-compose.yaml',
  ];

  const found: string[] = [];
  for (const p of configPatterns) {
    if (fs.existsSync(path.join(repoPath, p))) found.push(p);
  }
  return found;
}

function hasPreCommitHooks(repoPath: string): boolean {
  return (
    fs.existsSync(path.join(repoPath, '.pre-commit-config.yaml')) ||
    fs.existsSync(path.join(repoPath, '.husky')) ||
    fs.existsSync(path.join(repoPath, '.lefthook.yml')) ||
    fs.existsSync(path.join(repoPath, '.lintstagedrc')) ||
    fs.existsSync(path.join(repoPath, '.lintstagedrc.js'))
  );
}

function findClaudeMd(repoPath: string): string | null {
  // Check multiple possible locations
  const candidates = [
    path.join(repoPath, 'CLAUDE.md'),
    path.join(repoPath, '.claude', 'CLAUDE.md'),
    path.join(repoPath, '.claude', 'instructions.md'),
  ];
  for (const c of candidates) {
    const content = readFileIfExists(c);
    if (content) return content;
  }
  return null;
}

function findAgentsMd(repoPath: string): string | null {
  const candidates = [
    path.join(repoPath, 'AGENTS.md'),
    path.join(repoPath, '.agents', 'AGENTS.md'),
    path.join(repoPath, '.github', 'AGENTS.md'),
  ];
  for (const c of candidates) {
    const content = readFileIfExists(c);
    if (content) return content;
  }
  return null;
}

/**
 * Scan a repository and return structured context for worker prompt enrichment.
 */
export function scanRepoContext(repoPath: string): RepoContext {
  if (!repoPath || !fs.existsSync(repoPath)) {
    return {
      projectType: 'unknown',
      claudeMd: null,
      agentsMd: null,
      readmeExcerpt: null,
      commands: { lint: null, typecheck: null, test: null, build: null, dev: null, format: null },
      hasPreCommitHooks: false,
      packageManager: null,
      configFiles: [],
      scannedAt: new Date().toISOString(),
    };
  }

  const projectType = detectProjectType(repoPath);
  const pm = detectPackageManager(repoPath);

  // Merge commands from multiple sources (package.json takes precedence)
  let commands: RepoCommands = { lint: null, typecheck: null, test: null, build: null, dev: null, format: null };
  const makeCommands = extractMakefileCommands(repoPath);
  const nodeCommands = pm ? extractNodeCommands(repoPath, pm) : {};
  const pyCommands = projectType === 'python' ? extractPythonCommands(repoPath) : {};

  commands = {
    lint: nodeCommands.lint || pyCommands.lint || makeCommands.lint || null,
    typecheck: nodeCommands.typecheck || pyCommands.typecheck || makeCommands.typecheck || null,
    test: nodeCommands.test || pyCommands.test || makeCommands.test || null,
    build: nodeCommands.build || makeCommands.build || null,
    dev: nodeCommands.dev || makeCommands.dev || null,
    format: nodeCommands.format || pyCommands.format || makeCommands.format || null,
  };

  // README excerpt (first 500 chars)
  const readme = readFirstNChars(path.join(repoPath, 'README.md'), 500)
    || readFirstNChars(path.join(repoPath, 'readme.md'), 500);

  return {
    projectType,
    claudeMd: findClaudeMd(repoPath),
    agentsMd: findAgentsMd(repoPath),
    readmeExcerpt: readme,
    commands,
    hasPreCommitHooks: hasPreCommitHooks(repoPath),
    packageManager: pm,
    configFiles: findConfigFiles(repoPath),
    scannedAt: new Date().toISOString(),
  };
}

/**
 * Format repo context into prompt sections for worker injection.
 */
export function formatContextForPrompt(ctx: RepoContext): string {
  const sections: string[] = [];

  // CLAUDE.md instructions (highest priority)
  if (ctx.claudeMd) {
    sections.push('## Repository Instructions (from CLAUDE.md)\n' + ctx.claudeMd);
  }

  // AGENTS.md instructions
  if (ctx.agentsMd) {
    sections.push('## Agent Instructions (from AGENTS.md)\n' + ctx.agentsMd);
  }

  // Project info
  sections.push(`## Project Info\n- Type: ${ctx.projectType}\n- Package manager: ${ctx.packageManager || 'unknown'}`);

  // Verification commands
  const verifyParts: string[] = [];
  if (ctx.commands.lint) verifyParts.push(`- Lint: \`${ctx.commands.lint}\``);
  if (ctx.commands.typecheck) verifyParts.push(`- Typecheck: \`${ctx.commands.typecheck}\``);
  if (ctx.commands.test) verifyParts.push(`- Test: \`${ctx.commands.test}\``);
  if (ctx.commands.build) verifyParts.push(`- Build: \`${ctx.commands.build}\``);
  if (ctx.commands.format) verifyParts.push(`- Format: \`${ctx.commands.format}\``);

  if (verifyParts.length > 0) {
    sections.push('## Verification Commands\nYou MUST run these before reporting State: coded/done/verified:\n' + verifyParts.join('\n'));
  }

  // Pre-commit hooks
  if (ctx.hasPreCommitHooks) {
    sections.push('## Pre-commit Hooks\nThis repo has pre-commit hooks. If a commit fails due to hook changes, review the changes and retry the commit once. Do not use --no-verify.');
  }

  return sections.join('\n\n');
}

module.exports = {
  scanRepoContext,
  formatContextForPrompt,
  detectProjectType,
  detectPackageManager,
  extractNodeCommands,
};

export { scanRepoContext as default };
