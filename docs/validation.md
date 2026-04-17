# Post-worker validation

Per-repo validation that runs **after** the coding agent exits, independent of
whatever the worker claims in its self-reported summary. Prevents the common
failure mode where the worker says `verified: yes` but the code doesn't actually
compile, typecheck, or pass tests.

## How it works

1. Worker finishes (tmux session exits).
2. `finalizeJob` computes the repo proof (commit, branch, dirty state).
3. If the job reached a productive terminal state (`coded`, `done`, `verified`),
   and the repo mapping in `configs/repos.json` has a `validation` block, the
   validator runs each configured step sequentially in the repo's `localPath`.
4. The full per-step stdout/stderr stream is tee'd to `jobs/<id>/validation.log`.
5. A compact `ValidationReport` is attached to `jobs/<id>/result.json` under
   the `validation` key.
6. A one-line summary is appended to `worker.log` and to the final Discord
   message (e.g. `validation:ok (pass=3 fail=0 42s)`).

**Phase 2a (default): informational only.** A failing validation does NOT change
the job state. The report is attached to `result.json` and a `validation:…` tag
shows up in the final Discord message, but the job still finishes as `coded`/
`done`/`verified`.

**Phase 2b (opt-in via `validation.gate: true` per repo, or global
`CCP_VALIDATION_GATE=true`):** a failing **required** step will:
- set `result.state` to `blocked`
- set `result.blocker_type` to `'validation-failed'`
- populate `result.failed_checks` with synthetic `validation:<step>` entries
- auto-spawn a `__valfix` remediation job (suffix added to the original job id)
  whose packet targets the existing branch, inherits the original goal, and
  carries the failing steps' command + trailing stderr as `review_feedback`

The `__valfix` job is gated behind the same `CCP_PR_REMEDIATE_ENABLED` flag
that the PR-review remediation already uses. Remediation is refused when the
job id already ends in `__valfix|__reviewfix|__deployfix` to bound recursion.

## Configuring a repo

Add a `validation` block to any entry in `configs/repos.json`:

```json
{
  "key": "papyrx",
  "ownerRepo": "kyan12/Papyrx",
  "localPath": "/Users/crab/repos/Papyrx",
  "autoMerge": true,
  "validation": {
    "steps": [
      { "name": "install", "cmd": "npm ci --no-audit --no-fund", "timeoutSec": 300 },
      { "name": "typecheck", "cmd": "npm run typecheck", "timeoutSec": 300 },
      { "name": "lint", "cmd": "npm run lint", "timeoutSec": 180, "required": false },
      { "name": "test", "cmd": "npm test -- --run", "timeoutSec": 900 },
      { "name": "build", "cmd": "npm run build", "timeoutSec": 600 }
    ]
  }
}
```

### Top-level fields

| Field | Required | Default | Purpose |
|-------|----------|---------|---------|
| `enabled` | no | true when `steps` present | Per-repo kill switch. |
| `gate` | no | false | Phase 2b: when true, a failing required step promotes the job to `blocked` and spawns `__valfix`. Leave false while you're still building trust in the signal. |
| `steps` | yes | — | Ordered list of step definitions. |

### Step fields

| Field | Required | Default | Purpose |
|-------|----------|---------|---------|
| `name` | yes | — | Short identifier shown in dashboard/Discord. |
| `cmd` | yes | — | Shell command run via `sh -lc` from the repo root. |
| `timeoutSec` | no | 600 | Per-step timeout. Step is killed with SIGTERM if exceeded. |
| `required` | no | true | If false, failure is reported but doesn't fail overall validation. |
| `env` | no | — | Extra env vars injected into this step only. |

### Design notes

- **Sequential, no fail-fast.** Every step runs even if an earlier required step
  failed, so the agent sees the full picture in a single pass (don't want to fix
  typecheck, then re-run, then discover tests also fail).
- **Non-required steps** (e.g. lint) are surfaced in the report as `warn`s but
  never fail validation on their own. Use this for steps you want visibility on
  but which you don't want blocking merges.
- **The step command runs with `cwd = mapping.localPath`** and inherits the
  ambient env plus any per-step `env`. Use `package.json` scripts (`npm run
  typecheck`) where possible so the commands stay in source control.
- **Output caps:** 32 MiB per step (spawnSync maxBuffer). Trailing ~4 KB of
  stdout + stderr is kept in `result.validation.steps[*].{stdoutExcerpt,
  stderrExcerpt}`; the full stream is in `validation.log`.

## Globally disabling

Set `CCP_VALIDATION_ENABLED=false` in the supervisor environment to short-circuit
all validation runs. Useful for emergency rollback if a misconfigured step is
eating cycle budget.

Per-repo, set `validation.enabled: false` or simply omit the `validation` block.

## Gate override (Phase 2b)

`CCP_VALIDATION_GATE` is a global override for the per-repo `validation.gate`
flag:

| Value (case-insensitive) | Effect |
|---|---|
| unset | Use `validation.gate` on each repo (default: false) |
| `true` / `1` / `on` / `yes` | Gate ON for **every** repo with a validation config, regardless of per-repo setting |
| `false` / `0` / `off` / `no` | Gate OFF globally, even if a repo opts in |

Recommended rollout: turn on `validation.gate: true` for one repo at a time
once Phase 2a noise has been quiet for a few days. Keep `CCP_VALIDATION_GATE`
unset so an emergency can be handled with a single env flip.

## When validation is skipped

| Condition | Reason |
|-----------|--------|
| `CCP_VALIDATION_ENABLED=false` | Global kill switch |
| Final state is **not** `coded`, `done`, or `verified` | For `blocked`/`failed`/`dirty-repo` the finalize path has already run `cleanRepoIfDirty`, which discards the worker's uncommitted work and returns the repo to `main` — validating that would give a bogus report |
| No repo mapping for `packet.repo` | Can't look up config |
| Mapping has no `validation` block | Not opted in |
| `validation.enabled === false` | Per-repo opt-out |
| `steps` array is empty or all malformed | Nothing to run |

Skipped validation shows up in the report as `{ ok: true, skipped: true, reason: "..." }`.

## Operational checklist (before enabling per repo)

1. Make sure the commands work locally from the repo root with a clean checkout.
   `sh -lc 'npm ci && npm run typecheck'` etc.
2. Time the slowest step and set `timeoutSec` to ~2× that wall clock budget.
3. Start with a small pipeline (`install` + `typecheck`) and add steps as you
   gain confidence — this keeps false-positive noise low while Phase 2a is still
   informational.
4. Watch the Discord status channel for `validation:FAIL` tags on jobs that
   otherwise merged cleanly — those are exactly the gaps Phase 2b will close.
