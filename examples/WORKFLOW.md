---
agent: claude-code
timeout: 1200
auto_merge: true
merge_method: squash
constraints:
  - Always run the test suite before committing
  - Never modify database migrations directly
  - Keep PR scope minimal — one concern per PR
  - Use conventional commit messages (feat:, fix:, refactor:, etc.)
---

# {{repo}} — Task: {{ticket}}

## Goal
{{goal}}

## Constraints
{{constraints}}

## Acceptance Criteria
{{acceptance_criteria}}

## Verification Steps
{{verification_steps}}

## Review Feedback
{{review_feedback}}

## Instructions

You are working on branch `{{branch}}` in the {{repo}} repository.

Make only the minimum necessary changes for this task. Follow the repo's existing code style and patterns.

When done, output a final compact summary with these exact labels on separate lines:
- State: <coded/deployed/verified/blocked>
- Commit: <hash or none>
- Prod: <yes/no>
- Verified: <exact test or not yet>
- Blocker: <reason or none>

Do not claim pushed or deployed unless it actually happened. If you make code changes, you must push a branch for review — do not stop at a local-only commit.
