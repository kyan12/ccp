# Coding Agent Drivers (historical CCP compatibility)

Native Hermes Kanban owns all new coding execution and provider routing. This
file documents the former CCP tmux-worker driver interface only for archived job
replay and bounded drain maintenance; it is not a current intake or routing
manual.

Legacy CCP workers originally invoked Claude Code directly, then added a
pluggable **AgentDriver** interface, Codex support, per-repository fallback, and
Linear label routing. No current producer creates jobs that consume those
Linear labels or driver settings.

## Resolver precedence

The supervisor picks the driver for a job with this precedence (highest
first):

1. `JobPacket.agent` — archived per-job override recorded by former Linear,
   Discord, or dashboard intake
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
- **Archived packet overrides win during compatibility replay.** If an old
  record contains `JobPacket.agent`, the resolver preserves that historical
  choice. Operators must not use this path to create or reroute new work.
- **Never swaps mid-run.** Fallback is resolved once, when preflight runs.
  A job that started on Claude never gets a new tmux worker running Codex.
  Native Hermes Kanban owns follow-up remediation after the CCP retirement.
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
| `devin`       | `devin-ai`, `cognition-devin`          | `devin` / `devin-ai` on `PATH`, or `CCP_DEVIN_BIN` |

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
- **Probe**: `codex exec --color never --skip-git-repo-check 'Reply with the
  word PONG only.'` — a real API round-trip, same pattern as the Claude
  driver, matched with a `PONG` regex. Consumes ~1 small completion per
  supervisor cycle while the circuit is open; that's the cost of a probe
  that can actually see outages (a `codex --version` check was rejected
  because it would oscillate the circuit breaker — the binary being
  installed tells us nothing about whether the OpenAI API is reachable).
  `codex --version` is still used as a pre-check to surface a useful
  install-problem message when the binary itself is missing.
- **Outage patterns**: OpenAI SDK `APIError: 5xx`, generic `openai …
  unavailable` / `service unavailable`, Cloudflare 502/503/504 shapes,
  and shared network faults (`ECONNRESET`, `ETIMEDOUT`, `EAI_AGAIN`).
- **Rate-limit patterns**: best-effort — OpenAI's "try again in N seconds"
  phrasing is matched but *not* translated into a wall-clock pause yet
  (unlike Claude's "resets 2pm (ET)" format). Codex rate-limit hits
  currently fall through to the generic API-error circuit.

### Devin driver specifics

This is a dormant terminal-bridge scaffold for Cognition Devin's terminal
feature. Registering it only makes CCP able to select Devin explicitly; the
built-in default stays `claude-code`, and no repo config is changed by this
support.

- **Binary**: prefers `CCP_DEVIN_BIN` when set, otherwise `devin` or
  `devin-ai` on `PATH`.
- **Default command**: `cat <prompt> | devin terminal run --cwd <repoPath>`.
- **Custom command**: set `CCP_DEVIN_COMMAND` when the local Devin terminal CLI
  shape differs. Supported template tokens are `{bin}`, `{repoPath}`,
  `{promptPath}`, and `{jobId}`; replacements are shell-quoted. A template that
  starts with literal `devin` is automatically rewritten to the resolved
  `{bin}` path.
- **Probe**: defaults to `<bin> --version` as a non-destructive readiness check
  until Devin exposes a stable non-interactive health probe. Operators can set
  `CCP_DEVIN_PROBE_COMMAND` to a command that returns `PONG` or `OK` for a real
  terminal/API health probe.
- **Outage patterns**: Devin/API 5xx strings, terminal session failures,
  temporary-unavailable strings, and shared network faults (`ECONNRESET`,
  `ETIMEDOUT`, `ECONNREFUSED`, `EAI_AGAIN`).

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

## Historical Linear label mapping (retired)

Archived packets may contain an `agent:<name>` label that was normalized into
`JobPacket.agent`. Linear intake and label polling are retired; adding or
changing such a label does not route current work. Use native Hermes Kanban
model/provider settings for new tasks.

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
