---
summary: "Upgrade to responses-cache.6 and validate item-aware compaction for Responses input-item limits"
read_when:
  - You are upgrading from responses-cache.5 to responses-cache.6
  - You need to validate Responses input-item compaction near a provider hard limit
  - You need to verify compaction preserves tool-call and transcript boundaries
title: "Responses item-aware compaction .6 upgrade and acceptance"
---

# Upgrade and validate Responses item-aware compaction .6

The custom `v2026.7.1-2-responses-cache.6` build fixes item-triggered compaction
for Responses providers. The `.5` build could detect that an estimated input
reached the configured threshold, but the compaction cut point was primarily
token-based and did not guarantee that the rebuilt request fell below an
item-count target. A tool-heavy conversation could therefore compact and still
remain too close to the provider's hard limit.

The `.6` build keeps the `.5` provider, session-cache, native tool-call ID, stale
response ID, and overflow-recovery behavior. It remains based on official
OpenClaw `v2026.7.1-2` and is not an official OpenClaw release.

## Behavior

The existing configuration continues to define the provider limit and safety
margin:

```json5
{
  id: "ark-model",
  api: "openai-responses",
  compat: {
    responsesMaxInputItems: 1000,
    responsesInputItemsSafetyMargin: 150,
  },
}
```

For this example:

1. preemptive compaction starts when the estimate reaches
   `1000 - 150 = 850` items;
2. the item-aware cut point targets `850 - 150 = 700` retained items;
3. the cut point must also satisfy the normal recent-token policy;
4. complete messages and tool-call/result pairs remain intact;
5. the old `previous_response_id` chain is cleared, and the next provider
   request performs a full stored rebuild.

The retained count can be slightly lower than the computed target when a
complete boundary must move earlier. The compactor must not split a tool call
from its result to match the target exactly. With a configured safety margin of
zero or one, the runtime still reserves two transcript items so that adding the
pending prompt stays below the inclusive trigger threshold.

No new `openclaw.json` field is required. Models without a resolved
`responsesMaxInputItems` remain unaffected and continue to use token-based
compaction only.

## Upgrade from .5

Back up the running application and active configuration, then fetch and check
out the immutable tag:

```bash
git fetch origin --tags
git checkout v2026.7.1-2-responses-cache.6
git rev-parse HEAD
```

Use the development branch only when intentionally testing changes newer than
the tag:

```bash
git fetch origin
git switch ark-custom-2026.7.1-2-responses-cache.6
git pull --ff-only
git rev-parse HEAD
```

Install and build from source:

```bash
corepack enable
corepack prepare pnpm@11.2.2 --activate
pnpm install --no-frozen-lockfile
pnpm build
pnpm tsgo:prod
```

Use Node.js 22.22.3+, 24.15+, or 25.9+; Node.js 24 is recommended. Validate the
configuration and restart the Gateway after replacing the running build.

## Focused source validation

Run the focused tests from the source checkout:

```bash
pnpm test \
  packages/agent-core/src/harness/compaction/compaction.test.ts \
  src/agents/embedded-agent-runner/run/responses-input-items-limit.test.ts \
  src/agents/embedded-agent-runner/run/preemptive-compaction.test.ts \
  src/agents/embedded-agent-runner/run.overflow-compaction.test.ts \
  src/agents/embedded-agent-runner/run/attempt.spawn-workspace.context-engine.test.ts
```

The exact assertion count can change as the branch gains tests. The command's
exit status and named regression cases are authoritative.

## Production-parameter acceptance

Use a disposable session on a Responses model that has the documented 1000-item
hard limit. Keep the production values `responsesMaxInputItems: 1000` and
`responsesInputItemsSafetyMargin: 150`; do not lower them just to make the test
shorter.

Verify all of the following:

1. 849 estimated history items plus the next input produce an estimate of 850.
2. The decision reports `shouldCompactByItems=true` and route
   `compact_items_overflow` before a provider request is sent.
3. Exactly one item-triggered compaction runs for that crossing.
4. The compaction request carries a post-compaction target of approximately 700
   items.
5. The retained transcript contains the latest compaction summary and recent
   context without duplicating the current user prompt.
6. Every retained tool result still has its matching tool call.
7. The first provider request after compaction performs a full stored rebuild
   without the old `previous_response_id`.
8. A later successful turn resumes incremental chaining with the new response
   ID.
9. A control Responses model without an item limit does not enter the
   item-triggered route.
10. Gateway health, process identity, configuration, and unrelated sessions are
    unchanged after the test.

Record only sanitized provider/model names, counts, routes, timing, and pass/fail
results. Do not record credentials, full response IDs, or production prompts.

## Rollback

To disable only item-limit protection, remove `responsesMaxInputItems` and
`responsesInputItemsSafetyMargin` from the affected model or provider, validate
the configuration, and restart the Gateway. This returns the model to ordinary
token-based compaction.

To roll back the entire build, restore the application backup or rebuild the
immutable `.5` tag:

```bash
git fetch origin --tags
git checkout v2026.7.1-2-responses-cache.5
pnpm install --no-frozen-lockfile
pnpm build
```

Conversation history does not need to be rewritten.

## See also

- [OpenClaw custom openclaw.json configuration summary](https://github.com/lisheguo/openclaw/blob/ark-custom-2026.7.1-2-responses-cache.6/OPENCLAW_JSON_CUSTOM_CONFIG.zh-CN.md)
- [Ark Kimi Responses cache .5 upgrade and acceptance](/providers/ark-kimi-responses-v2026.7.1-2-responses-cache.5)
- [DashScope Responses session cache](/providers/dashscope-responses-session-cache)
- [Configuration](/gateway/configuration)
