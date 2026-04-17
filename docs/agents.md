# Coding Agent Drivers

CCP runs the actual code-writing step inside a tmux worker. Historically that
worker was hardcoded to invoke Claude Code (`cat prompt | claude --print
--permission-mode bypassPermissions`). As of Phase 1 (PR A) that invocation
goes through a pluggable **AgentDriver** interface so additional agents
(Codex, Aider, etc.) can slot in without touching the supervisor.

## Resolver precedence

The supervisor picks the driver for a job with this precedence (highest
first):

1. `JobPacket.agent` — per-job override (set by Linear label mapping, Discord
   command, or dashboard)
2. `RepoMapping.agent` — per-repo default in `configs/repos.json`
3. `process.env.CCP_AGENT` — global default
4. `'claude-code'` — built-in default

An unknown agent name falls back to `claude-code` with a warning on stderr,
so a typo in `repos.json` never hard-blocks dispatch.

## Registered drivers (PR A)

| name          | alias    | shipped in | binary required                     |
|---------------|----------|------------|--------------------------------------|
| `claude-code` | `claude` | PR A       | `claude-opus` or `claude` on `PATH` |

The `claude-code` driver builds the exact same shell command the worker used
before the refactor, so PR A is **behavior-neutral**: whatever worked before
still works. The refactor only adds the seam.

### Claude-code driver specifics

- **Binary**: prefers `claude-opus` (if that symlink is on `PATH`), falls
  back to `claude`.
- **Command**: `cat <prompt> | <binary> --print --permission-mode bypassPermissions`
- **Probe**: `claude --print --model claude-haiku-4-5 "Reply with the word PONG only."`
- **Outage patterns**: preserved verbatim from `src/lib/outage.ts` (503/529,
  `overloaded_error`, `ECONNRESET`, "hit your limit / resets at …", etc.)

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
- `agentFallback` — **reserved for PR B** (agent fallback orchestration is
  not wired yet). Listing it in PR A is safe; it is ignored until the
  fallback feature ships.

## Global override

```bash
export CCP_AGENT=claude-code
```

This sets the default driver for every job that doesn't have a per-job or
per-repo override. Unknown values log a warning and fall back to
`claude-code`.

## Adding a new driver

1. Create `src/lib/agents/<name>.ts` exporting a `const <name>Driver:
   AgentDriver = { ... }`.
2. Register it in `src/lib/agents/index.ts` under the `AGENTS` map.
3. Add tests to `src/lib/agents.test.ts` (at minimum: `buildCommand` shape,
   `failurePatterns` against sample strings).

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

- **PR B**: Codex driver + agent fallback orchestration + per-agent outage
  state. Once merged, `agentFallback` becomes live.
- **Later**: dashboard chip showing which driver ran each job; Linear-label →
  agent mapping; Discord `/ccp retry <jobId> --agent <name>`.
