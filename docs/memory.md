# Per-repo persistent memory (Phase 5a)

Every job's worker prompt can be prepended with a repo-specific memory
file so operators don't have to restate project conventions, known
pitfalls, or architectural notes in every Linear ticket. Think of it
as `CLAUDE.md` / `AGENTS.md` but wired into CCP's prompt assembler
directly — independent of any specific agent's conventions.

## Where it lives

By default CCP reads `.ccp/memory.md` at the repo checkout root.
Override via `memoryFile` in `configs/repos.json`:

```jsonc
{
  "mappings": [
    {
      "key": "my-app",
      "localPath": "/home/user/repos/my-app",
      // Relative path — resolved against localPath.
      "memoryFile": "docs/ccp-memory.md"
      // Absolute paths also work:
      // "memoryFile": "/srv/ccp/memory/my-app.md"
    }
  ]
}
```

If the path is unset **and** the default `.ccp/memory.md` doesn't
exist, the job runs without a memory section — no error, no warning.
The field is fully opt-in.

## What the agent sees

When memory is present, the prompt starts with:

```
Repository context (persistent memory — read this first, then the ticket):
--- BEGIN REPOSITORY MEMORY ---
<contents of the memory file>
--- END REPOSITORY MEMORY ---

Ticket: ...
Goal: ...
```

The ticket goal, acceptance criteria, verification steps, and review
comments still follow — they're more specific and appear later on
purpose, so they take precedence when they conflict with the memory.

## Size cap

Memory is capped at **16KB** (~4k tokens). Oversized files are
truncated with a visible marker:

```
[... memory file truncated at 16KB; split into smaller files to keep all context ...]
```

The cap is deliberately conservative. Long irrelevant context hurts
agent performance more than it helps, so if you're bumping the ceiling
that's a signal to split the memory file up (e.g. keep CCP memory
focused on "things every job must know" and leave detailed
subsystem-specific notes in regular docs the agent can grep for).

## What to put in it

Good memory content:

- Code conventions that aren't obvious from the source (e.g. "use
  Volta, not nvm" — the supervisor repo's README says this).
- Branch / PR workflow (e.g. "always branch from main, never from a
  feature branch", or "PRs must have squash merges enabled").
- Areas of the codebase that are fragile or off-limits (e.g. "don't
  touch the deprecated `legacy/` tree — it's scheduled for deletion").
- Secrets workflow (e.g. "this repo uses 1Password CLI via `op read`,
  not .env files").
- Testing conventions (e.g. "run `npm test -- --run` in Vitest; never
  `npm test` alone because that starts watch mode").

Bad memory content:

- The full project README (the agent can read that file itself).
- Task-specific instructions — those go in the Linear ticket.
- PII, credentials, or anything you wouldn't commit to the repo.

## Runtime visibility

Each job's `worker.log` records whether memory was loaded and whether
it was truncated:

```
[2026-04-17T...Z] repo memory loaded: /repo/.ccp/memory.md (1024 bytes)
[2026-04-17T...Z] repo memory loaded: /repo/.ccp/memory.md (16442 bytes, truncated)
```

## Precedence note for worktrees (Phase 3)

The default `.ccp/memory.md` path resolves against `packet.repo`,
which is the repo's `localPath` today. When Phase 3 adds git worktrees
for parallel jobs, memory will naturally follow the worktree's branch
— a branch-specific memory override would be picked up automatically
if one exists on disk at that checkout. No changes to this module are
needed for that.

## LLM-driven compaction (Phase 5c)

By default the loader simply truncates oversized memory files at 16KB
with a visible marker — safe but lossy. Phase 5c adds an opt-in
compaction path: when the memory file grows past a configurable cap,
the supervisor asks the repo's configured agent (Claude or Codex) to
produce a condensed rewrite, archives the pre-compaction content, and
overwrites the memory file in place. The next worker sees the dense
rewrite instead of the truncated original.

### Enable

Add a `memoryCompaction` block to `configs/repos.json`:

```jsonc
{
  "mappings": [
    {
      "key": "my-app",
      "localPath": "/home/user/repos/my-app",
      "memoryFile": ".ccp/memory.md",
      "memoryCompaction": {
        "enabled": true,
        "maxBytes": 16384,
        "targetBytes": 8192,
        "timeoutSec": 300
      }
    }
  ]
}
```

All four fields are optional and default to the values above (opt-in
via `enabled: true`). Leaving the block out — or setting
`enabled: false` — preserves the Phase 5a truncation behavior.

You can pin compaction to a specific agent (e.g. always Claude Haiku
for cheap summarization, regardless of which agent does the main
coding work) by adding `"agent": "claude-code"` to the block.

### When it runs

On every dispatch, just before `loadRepoMemory()`, the supervisor:

1. Resolves the memory file path (same rules as Phase 5a).
2. Stats the file. If size ≤ `maxBytes`, compaction is skipped.
3. Archives the current contents to
   `.ccp/memory.archive/<ISO-timestamp>.md`.
4. Spawns the resolved agent CLI with a fixed summarization prompt
   and the original file piped on stdin.
5. If the agent returns within `timeoutSec` with non-empty output
   smaller than the original, the memory file is atomically replaced.
6. Any failure (timeout, non-zero exit, empty stdout, output larger
   than original, missing binary) leaves the memory file untouched.
   The archive still exists so nothing is lost.

Compaction runs inside the dispatch path (synchronously, before the
worker starts) so the very next run sees the compacted file. Keep
`timeoutSec` tight so a hung agent can't stall the loop.

### Archive

`.ccp/memory.archive/<ISO-timestamp>.md` is written before the
overwrite attempt, so even a crash between archive and rename leaves
a recoverable copy. Operators can delete old archive entries at any
time — they're purely a safety net.

Archive filenames use colons→dashes in the ISO timestamp to stay
Windows-friendly (e.g. `2026-04-17T05-03-00-000Z.md`).

### Runtime visibility

Each dispatch writes compaction outcomes to `worker.log`:

```
[2026-04-17T...Z] memory compaction triggered: memory file 20480B > maxBytes 16384B
[2026-04-17T...Z] memory compaction compacted: compacted 20480B → 4096B via claude-code
```

Failure example:

```
[2026-04-17T...Z] memory compaction triggered: memory file 20480B > maxBytes 16384B
[2026-04-17T...Z] memory compaction agent-timeout: agent 'claude-code' did not finish within 300s
```

Possible `status` values:

- `compacted` — success, file rewritten.
- `skipped` — file under threshold / compaction disabled / no memory
  configured. No archive written.
- `agent-missing` — preflight failed (binary not on PATH, auth
  broken). No archive written.
- `agent-timeout` — subprocess exceeded `timeoutSec`. Archive
  written, memory file untouched.
- `agent-failed` — subprocess exited non-zero. Archive written,
  memory file untouched.
- `empty-output` — agent returned whitespace only. Archive written,
  memory file untouched.
- `oversized-output` — agent returned content larger than the
  original (or > 32KB hard cap). Archive written, memory file
  untouched.
- `io-error` — filesystem error (archive dir not writable, rename
  failed). Archive written when possible; memory file untouched.

### Manual runs

Run a compaction pass outside the dispatch loop with:

```
ccp-jobs compact-memory <repoKey>           # respects size gate
ccp-jobs compact-memory <repoKey> --force   # bypasses size gate
```

This uses the same codepath as dispatch and prints the outcome as
JSON. Useful for cron jobs, one-off cleanup, or operator testing.
Exit code 0 on success or "skipped", 3 on any error status.
