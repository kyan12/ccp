# Coding Agent Drivers

CCP runs the actual code-writing step inside a tmux worker. Historically that
worker was hardcoded to invoke Claude Code (`cat prompt | claude --print
--permission-mode bypassPermissions`). As of Phase 1 PR A that invocation
goes through a pluggable **AgentDriver** interface so additional agents
(Codex, Aider, etc.) slot in without touching the supervisor. Phase 1 PR B
lights up the OpenAI Codex driver, per-repo fallback orchestration, and
Linear label mapping.

## Resolver precedence

The supervisor picks the driver for a job with this precedence (highest
first):

1. `JobPacket.agent` — per-job override (set by Linear `agent:<name>` label,
   Discord command, or dashboard)
2. `RepoMapping.agent` — per-repo default in `configs/repos.json`
3. `process.env.CCP_AGENT` — global default
4. `'claude-code'` — built-in default

An unknown agent name falls back to `claude-code` with a warning on stderr,
so a typo in `repos.json` never hard-blocks dispatch.

## Fallback (PR B)

When a repo opts in via `agentFallback`, the resolver will swap the
**primary** driver for the fallback driver at dispatch time **iff** the
primary's outage circuit is open *and* the fallback's circuit is closed.

Important nuances:

- **Opt-in only, per repo.** There is no global `CCP_AGENT_FALLBACK` env
  var — a repo without `agentFallback` never swaps, even during outage.
- **Explicit packet overrides win.** If a job was explicitly routed to an
  agent via `JobPacket.agent` (Linear label, Discord retry, dashboard), the
  resolver respects that choice even if the circuit is open. This is so
  operators can force a retry on a known-broken provider to drive the
  probe cycle.
- **Never swaps mid-run.** Fallback is resolved once, when preflight runs.
  A job that started on Claude never gets a new tmux worker running Codex —
  the supervisor only remediates via a fresh `__valfix` / review-remediation
  / retry cycle.
- **Both circuits open ⇒ keep primary.** If both primary and fallback are
  out, the resolver keeps the primary and logs a warning, so whichever
  provider's next probe comes back first will drive recovery.

The fallback swap is logged to `worker.log` as:

```
agent-fallback: primary 'claude-code' circuit open → dispatching via fallback 'codex'
```

## Registered drivers

| name          | aliases                                | binary required                          |
|---------------|----------------------------------------|------------------------------------------|
| `claude-code` | `claude`                               | `claude-opus` or `claude` on `PATH`      |
| `codex`       | `openai-codex`, `codex-cli`            | `codex` on `PATH` (`@openai/codex`)      |

### Claude-code driver specifics

- **Binary**: prefers `claude-opus` (if that symlink is on `PATH`), falls
  back to `claude`.
- **Command**: `cat <prompt> | <binary> --print --permission-mode bypassPermissions`
- **Probe**: `claude --print --model claude-haiku-4-5 "Reply with the word PONG only."`
- **Outage patterns**: 503/529, `overloaded_error`, `ECONNRESET`,
  "hit your limit / resets at …", etc.

### Codex driver specifics

Upstream: [openai/codex](https://github.com/openai/codex) — the Rust binary
installed via `npm i -g @openai/codex` (or Homebrew / GitHub release
tarballs).

- **Binary**: `codex` on `PATH`.
- **Command**: `cat <prompt> | codex exec --color never --sandbox
  workspace-write --skip-git-repo-check`
  - `exec` runs headless (no TUI).
  - `--color never` keeps `worker.log` free of ANSI escape sequences.
  - `--sandbox workspace-write` restricts writes to the per-job repo
    checkout — mirrors how Claude is run with `--permission-mode
    bypassPermissions` inside its cwd.
  - `--skip-git-repo-check` keeps Codex from bailing because the cwd isn't
    the exact git root it would prefer.
- **Auth**: the supervisor box must be pre-authenticated via `codex login`
  (ChatGPT OAuth) or `OPENAI_API_KEY`. The driver doesn't touch creds.
- **Probe**: `codex --version`. This is intentionally shallow — a full
  round-trip through `codex exec` would consume real quota every probe
  cycle. Once `codex login status` stabilizes its exit codes, we can layer
  an auth check on top.
- **Outage patterns**: OpenAI SDK `APIError: 5xx`, generic `openai …
  unavailable` / `service unavailable`, Cloudflare 502/503/504 shapes,
  and shared network faults (`ECONNRESET`, `ETIMEDOUT`, `EAI_AGAIN`).
- **Rate-limit patterns**: best-effort — OpenAI's "try again in N seconds"
  phrasing is matched but *not* translated into a wall-clock pause yet
  (unlike Claude's "resets 2pm (ET)" format). Codex rate-limit hits
  currently fall through to the generic API-error circuit.

## Per-repo configuration

In `configs/repos.json`:

```json
{
  "mappings": [
    {
      "key": "my-app",
      "localPath": "/home/me/repos/my-app",
      "agent": "claude-code",
      "agentFallback": "codex"
    }
  ]
}
```

- `agent` — default driver for jobs targeting this repo.
- `agentFallback` — opt-in fallback driver (PR B). Only triggers when the
  primary's circuit breaker is open.

## Global override

```bash
export CCP_AGENT=claude-code
```

This sets the default driver for every job that doesn't have a per-job or
per-repo override. Unknown values log a warning and fall back to
`claude-code`.

## Linear label mapping (PR B)

Attach a Linear label with the pattern `agent:<name>` to flip one ticket to
a specific driver without editing any config:

- `agent:codex` → route this ticket's job to the Codex driver.
- `agent:claude-code` → pin it back to Claude Code even if the repo default
  is Codex.

Labels are case-insensitive (`Agent:Codex` works). The first `agent:<name>`
label wins if multiple are present. The extracted value is written into
`JobPacket.agent`, which is the highest-precedence agent selector — so a
Linear label beats both `repos.json` and `CCP_AGENT`.

## Per-agent outage state (PR B)

Each driver has its own circuit breaker state file at
`configs/outage-<agent>.json` (e.g. `outage-claude-code.json`,
`outage-codex.json`). Flipping Claude's circuit no longer pauses Codex jobs
and vice versa. The legacy `configs/outage.json` (which only ever tracked
Claude) is migrated to `outage-claude-code.json` on first read and left in
place as a non-destructive tombstone.

Inspect state with:

```ts
import { getAllOutageStatuses } from './src/lib/outage';
console.log(getAllOutageStatuses());
```

or look on disk directly under `configs/outage-*.json`.

## Adding a new driver

1. Create `src/lib/agents/<name>.ts` exporting a `const <name>Driver:
   AgentDriver = { ... }`.
2. Register it in `src/lib/agents/index.ts` under the `AGENTS` map (and
   re-export it from the module).
3. Add tests to `src/lib/agents.test.ts` (at minimum: `buildCommand` shape,
   `failurePatterns` against sample strings, `preflight` shape).

The driver is responsible for:

- `buildCommand(ctx)` — returns the shell command string (plus optional env
  vars) that will be appended to the generated `worker.sh`.
- `preflight()` — checks for required binaries on `PATH`; returns the
  resolved binary path, failure messages, and (optionally) a version string.
- `probe()` — a lightweight "am I up?" call used by the outage circuit
  breaker.
- `failurePatterns.{apiError, rateLimit}` — regexes used by `outage.ts` to
  detect provider API failures and rate-limit reset times.

## Roadmap

- **Deferred from PR B**: Discord `/ccp retry <jobId> --agent <name>`,
  dashboard dropdown selector.
- **Phase 3**: git worktrees for parallel jobs on the same repo — unblocks
  running Claude + Codex side-by-side on different tickets.
- **Phase 5b**: planner step that runs before the worker; planner can be a
  different driver than the executor.
