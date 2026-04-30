/**
 * Agent registry + resolver.
 *
 * Single source of truth for which AgentDriver runs a given job. Precedence
 * (highest wins):
 *
 *   1. JobPacket.agent        — explicit per-job override (Linear `agent:<name>`
 *                               label, dashboard, /ccp retry --agent ...)
 *   2. RepoMapping.agent      — per-repo default from configs/repos.json
 *   3. process.env.CCP_AGENT  — global default (ops override)
 *   4. 'claude-code'          — built-in default
 *
 * Resolver falls back to the claude-code driver if the requested agent name
 * is unknown (with a warning on stderr), so a typo in repos.json never hard-
 * blocks dispatch.
 *
 * Fallback (PR B): when `opts.checkCircuit(name) === true` for the resolved
 * primary AND `repo.agentFallback` is set to a known agent whose circuit is
 * closed, the resolver swaps to the fallback. This only triggers for repos
 * that explicitly opted in — a missing `agentFallback` never causes a swap.
 * Fallback is never applied when the primary was chosen via `packet.agent`
 * (explicit per-job overrides win even during outage, so operators can force
 * a retry on the known-broken agent if they want to).
 */

import type { JobPacket, RepoMapping } from '../../types';
import type { AgentDriver } from './types';
import { claudeCodeDriver } from './claude';
import { codexDriver } from './codex';
import { devinDriver } from './devin';

export const AGENTS: Record<string, AgentDriver> = {
  'claude-code': claudeCodeDriver,
  // Aliases accepted in configs
  claude: claudeCodeDriver,
  codex: codexDriver,
  'openai-codex': codexDriver,
  'codex-cli': codexDriver,
  devin: devinDriver,
  'devin-ai': devinDriver,
  'cognition-devin': devinDriver,
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
  /** True iff the circuit-breaker flipped us from primary to repo.agentFallback. */
  fellBackDueToOutage: boolean;
  /** If `fellBackDueToOutage`, the primary driver we swapped away from. */
  primaryDriver?: AgentDriver;
}

export interface ResolveAgentOptions {
  /**
   * Called with an agent name; return true if the agent's circuit breaker
   * is currently open. When omitted, no fallback swap is ever applied
   * (pure static resolution — used by tests and the `ccp-jobs doctor` CLI).
   */
  checkCircuit?: (name: string) => boolean;
}

export function resolveAgent(
  packet: Pick<JobPacket, 'agent'> | null | undefined,
  repo: Pick<RepoMapping, 'agent' | 'agentFallback'> | null | undefined,
  opts: ResolveAgentOptions = {},
): AgentResolution {
  const envRaw = process.env.CCP_AGENT;
  const envName = typeof envRaw === 'string' ? envRaw.trim() : '';

  const candidates: Array<{ source: AgentResolution['source']; name: string }> = [];
  if (packet?.agent) candidates.push({ source: 'packet', name: packet.agent });
  if (repo?.agent) candidates.push({ source: 'repo', name: repo.agent });
  if (envName) candidates.push({ source: 'env', name: envName });

  let primary: AgentResolution | null = null;
  for (const c of candidates) {
    const driver = getAgent(c.name);
    if (driver) {
      primary = {
        driver,
        source: c.source,
        requested: c.name,
        fellBack: false,
        fellBackDueToOutage: false,
      };
      break;
    }
  }

  if (!primary && candidates.length > 0) {
    // Requested an agent but it's unknown → fall back to claude-code but tell us.
    const requested = candidates[0].name;
    // eslint-disable-next-line no-console
    console.warn(
      `[agents] unknown agent '${requested}' requested (source=${candidates[0].source}); ` +
        `falling back to claude-code. known: ${listAgents().join(', ')}`,
    );
    primary = {
      driver: claudeCodeDriver,
      source: 'default',
      requested,
      fellBack: true,
      fellBackDueToOutage: false,
    };
  }

  if (!primary) {
    primary = {
      driver: claudeCodeDriver,
      source: 'default',
      requested: null,
      fellBack: false,
      fellBackDueToOutage: false,
    };
  }

  // Fallback-due-to-outage: only applied for repo/env/default primaries, not
  // explicit packet overrides (manual retries win). Requires both a known
  // fallback and a closed fallback circuit.
  if (
    opts.checkCircuit &&
    primary.source !== 'packet' &&
    repo?.agentFallback &&
    opts.checkCircuit(primary.driver.name)
  ) {
    const fallbackDriver = getAgent(repo.agentFallback);
    if (!fallbackDriver) {
      // eslint-disable-next-line no-console
      console.warn(
        `[agents] repo.agentFallback '${repo.agentFallback}' is not a registered ` +
          `driver; keeping primary '${primary.driver.name}' despite open circuit. ` +
          `known: ${listAgents().join(', ')}`,
      );
    } else if (fallbackDriver === primary.driver) {
      // Configured fallback is the same driver (e.g. alias). Nothing to swap.
    } else if (opts.checkCircuit(fallbackDriver.name)) {
      // eslint-disable-next-line no-console
      console.warn(
        `[agents] both primary '${primary.driver.name}' and fallback ` +
          `'${fallbackDriver.name}' have open circuits; dispatching to primary anyway ` +
          `so recordJobOutcome drives the probe cycle.`,
      );
    } else {
      return {
        driver: fallbackDriver,
        source: primary.source,
        requested: primary.requested,
        fellBack: primary.fellBack,
        fellBackDueToOutage: true,
        primaryDriver: primary.driver,
      };
    }
  }

  return primary;
}

export type {
  AgentDriver,
  AgentBuildContext,
  AgentCommand,
  AgentPreflight,
  AgentProbeResult,
  AgentFailurePatterns,
  AgentUsage,
  AgentUsageParseContext,
} from './types';
export { claudeCodeDriver, codexDriver, devinDriver };
export { parseClaudeUsage, parseCodexUsage } from './usage';
