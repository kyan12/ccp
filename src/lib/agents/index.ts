/**
 * Agent registry + resolver.
 *
 * Single source of truth for which AgentDriver runs a given job. Precedence
 * (highest wins):
 *
 *   1. JobPacket.agent        — explicit per-job override (Linear label, dashboard)
 *   2. RepoMapping.agent      — per-repo default from configs/repos.json
 *   3. process.env.CCP_AGENT  — global default (ops override)
 *   4. 'claude-code'          — built-in default
 *
 * Resolver falls back to the claude-code driver if the requested agent name
 * is unknown (with a warning on stderr), so a typo in repos.json never hard-
 * blocks dispatch.
 */

import type { JobPacket, RepoMapping } from '../../types';
import type { AgentDriver } from './types';
import { claudeCodeDriver } from './claude';

export const AGENTS: Record<string, AgentDriver> = {
  'claude-code': claudeCodeDriver,
  // Aliases accepted in configs
  claude: claudeCodeDriver,
};

export function listAgents(): string[] {
  // Return canonical names only (dedupe alias pointers).
  const seen = new Set<AgentDriver>();
  const names: string[] = [];
  for (const [name, driver] of Object.entries(AGENTS)) {
    if (seen.has(driver)) continue;
    seen.add(driver);
    names.push(name);
  }
  return names;
}

export function getAgent(name: string | null | undefined): AgentDriver | null {
  if (!name) return null;
  return AGENTS[name.toLowerCase().trim()] ?? null;
}

export interface AgentResolution {
  driver: AgentDriver;
  /** Where the choice came from: 'packet' | 'repo' | 'env' | 'default'. */
  source: 'packet' | 'repo' | 'env' | 'default';
  /** The raw name that was requested (may be unknown → fell back to default). */
  requested: string | null;
  /** True iff `requested` was non-null but unknown. */
  fellBack: boolean;
}

export function resolveAgent(
  packet: Pick<JobPacket, 'agent'> | null | undefined,
  repo: Pick<RepoMapping, 'agent'> | null | undefined,
): AgentResolution {
  const envRaw = process.env.CCP_AGENT;
  const envName = typeof envRaw === 'string' ? envRaw.trim() : '';

  const candidates: Array<{ source: AgentResolution['source']; name: string }> = [];
  if (packet?.agent) candidates.push({ source: 'packet', name: packet.agent });
  if (repo?.agent) candidates.push({ source: 'repo', name: repo.agent });
  if (envName) candidates.push({ source: 'env', name: envName });

  for (const c of candidates) {
    const driver = getAgent(c.name);
    if (driver) return { driver, source: c.source, requested: c.name, fellBack: false };
  }

  // Requested an agent but it's unknown → fall back to claude-code but tell us.
  if (candidates.length > 0) {
    const requested = candidates[0].name;
    // eslint-disable-next-line no-console
    console.warn(
      `[agents] unknown agent '${requested}' requested (source=${candidates[0].source}); ` +
        `falling back to claude-code. known: ${listAgents().join(', ')}`,
    );
    return { driver: claudeCodeDriver, source: 'default', requested, fellBack: true };
  }

  return { driver: claudeCodeDriver, source: 'default', requested: null, fellBack: false };
}

export type { AgentDriver, AgentBuildContext, AgentCommand, AgentPreflight, AgentProbeResult, AgentFailurePatterns } from './types';
export { claudeCodeDriver };
