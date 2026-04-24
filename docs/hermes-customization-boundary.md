# Hermes customization boundary

## Rule

Do not patch or PR to `NousResearch/hermes-agent` for ProteusX/CCP-specific behavior.

Only open upstream Hermes PRs when the change is a generally useful Hermes framework contribution that should survive for all Hermes users.

## Why

Hermes should remain updateable from upstream without carrying a long-lived local fork. ProteusX-specific workflow behavior belongs in the Coding Control Plane (CCP), external sidecars, configuration, skills, or MCP servers.

## Preferred extension points

1. **CCP-owned code** for workflow orchestration, dispatch, return routing, Linear state, PR lifecycle, and ProteusX-specific policy.
2. **Hermes configuration/profiles** for model/tool/platform setup.
3. **Skills and memory** for behavior/instructions that do not require code.
4. **MCP servers or sidecars** for custom tools/services that Hermes can call without modifying Hermes core.
5. **Upstream Hermes PRs** only for non-specific framework improvements.

## Handoff return path decision

For Business Crab / Code Crab handoffs, return completion messages from CCP directly to the stored origin Discord thread/channel using CCP's Discord transport.

Avoid adding a custom `/webhooks/code-crab-completion` route to Hermes core. That route is ProteusX-specific and would create update friction.

Current implementation direction:
- CCP job packets carry `handoff_id` and origin metadata (`origin_channel_id`, `origin_thread_id`, `origin_message_id`).
- CCP finalization maps the job result into a structured handoff return payload.
- CCP posts to `origin_thread_id` first, falling back to `origin_channel_id`.
- Hermes remains unmodified upstream code.

## Local cleanup note

The abandoned Hermes receiver work was closed upstream and stashed locally as:

`stash@{0}: On feat/handoff-completion-callback: proteusx-local-custom-handoff-work-do-not-upstream`

Do not reapply it unless explicitly reviving the sidecar idea outside Hermes core.
