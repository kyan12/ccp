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
