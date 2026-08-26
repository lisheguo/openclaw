---
summary: "Upgrade to OpenClaw responses-cache.5 and validate Ark Kimi tool IDs, input-item protection, and compaction recovery"
read_when:
  - You are upgrading from responses-cache.4 to responses-cache.5
  - You need an Ark Kimi and control-model acceptance checklist
  - You need to validate native Responses tool call IDs, input-item limits, or compaction recovery
title: "Ark Kimi Responses cache .5 upgrade and acceptance"
---

# Upgrade and validate Ark Kimi Responses cache .5

This guide upgrades the custom OpenClaw Responses cache build from
`v2026.7.1-2-responses-cache.4` to the `.5` development branch and validates
the `.5` changes:

- provider-native Responses tool call IDs can be preserved for an explicitly
  configured Ark Kimi model;
- overflow compaction resumes from the persisted transcript and restores its
  retry budget after a non-overflow attempt;
- Responses input-item limits and their safety margin can be configured at the
  model or provider boundary without affecting other Responses models;
- item estimation includes the current inbound prompt, and compaction summaries
  remain valid conversation anchors across repeated compactions.

The custom build remains based on official OpenClaw `v2026.7.1-2`. It is not an
official OpenClaw release. Until the `.5` Git tag is published, use the named
development branch and record the checked-out commit before deployment.

## Before you begin

Prepare:

- Node.js 22.22.3+, 24.15+, or 25.9+; Node.js 24 is recommended;
- pnpm 11.2.2 through Corepack;
- a backup of the running application directory and active `openclaw.json`;
- an Ark Kimi Responses model that reproduces provider-native tool call IDs;
- an Ark Responses control model, such as a working Doubao model, that keeps
  the default tool call ID policy;
- a temporary test session that cannot affect production conversations.

Do not copy API keys into test reports or shell history. Use the installation's
existing auth profile or secret provider.

## Upgrade from .4

Fetch and check out the development branch:

```bash
git fetch origin
git switch ark-custom-2026.7.1-2-responses-cache.5
git pull --ff-only
git rev-parse HEAD
```

Record the commit printed by `git rev-parse HEAD`. After the `.5` tag is
published, prefer the immutable tag instead:

```bash
git fetch origin --tags
git checkout v2026.7.1-2-responses-cache.5
```

Install and build from source:

```bash
corepack enable
corepack prepare pnpm@11.2.2 --activate
pnpm install --no-frozen-lockfile
pnpm build
pnpm tsgo:prod
```

The inherited `v2026.7.1-2` dependency metadata requires
`--no-frozen-lockfile` in a disposable build checkout. Do not commit an
installation-generated lockfile unless the dependency change is intentional
and reviewed.

## Configure the affected Ark model

Merge the capability into the verified Kimi model. Preserve every existing
provider, model, header, credential, and compatibility field:

```json5
{
  models: {
    providers: {
      "volcengine-agent-plan": {
        models: [
          {
            id: "kimi-k3",
            api: "openai-responses",
            compat: {
              supportsPreviousResponseId: true,
              preserveNativeResponsesToolCallIds: true,
              responsesMaxInputItems: 1000,
              responsesInputItemsSafetyMargin: 150,
            },
          },
        ],
      },
    },
  },
}
```

Do not enable `preserveNativeResponsesToolCallIds` provider-wide. Leave the
control model unset or explicitly `false`, so it continues using normal
OpenClaw tool call ID sanitization.

Configure `responsesMaxInputItems` only for a Responses model with a documented
hard input-item limit. `responsesInputItemsSafetyMargin` defaults to `150` when
a limit is active and may be set to `0` or another non-negative integer. For a
limit of `1000`, the default margin starts preemptive compaction at an estimated
`850` items; a margin of `200` starts it at `800`.

Both fields may be set on the provider as model defaults. Model values override
provider values. The legacy `agents.defaults.compaction.maxInputItems` remains a
last-resort compatibility fallback for the limit; it is not the recommended
configuration surface. A margin without a resolved limit has no effect, and
non-Responses models remain disabled.

Validate before restarting:

```bash
openclaw config validate
openclaw models status --json
openclaw gateway restart
openclaw status
```

The package version remains the official base version `2026.7.1`. Identify the
custom build by its Git tag or recorded commit, not by `openclaw --version`
alone.

## Run source regression tests

Run the focused `.5` suite from the source checkout:

```bash
pnpm test \
  src/config/zod-schema.models.test.ts \
  src/config/schema.help.quality.test.ts \
  src/config/schema.hints.test.ts \
  src/config/runtime-schema.test.ts \
  src/agents/embedded-agent-helpers/openai.responses-preserve.test.ts \
  src/agents/transcript-policy.test.ts \
  src/agents/embedded-agent-runner.sanitize-session-history.test.ts \
  src/agents/compaction-real-conversation.test.ts \
  src/agents/embedded-agent-runner/compact.hooks.test.ts \
  src/agents/embedded-agent-runner/run/attempt.tool-call-normalization.test.ts \
  src/agents/embedded-agent-runner/run/preemptive-compaction.test.ts \
  src/agents/embedded-agent-runner/run/responses-input-items-limit.test.ts \
  src/agents/embedded-agent-runner/run.overflow-compaction.loop.test.ts \
  src/agents/embedded-agent-runner/run.overflow-compaction.test.ts
```

Record the checked-out commit and command result. Treat the current run as
authoritative because the assertion count can change as the `.5` branch gains
additional regression coverage.

## Validate Ark Kimi end to end

Use one new temporary session for all four rounds.

### Round 1: establish the chain

1. Ask Kimi to run a harmless read-only tool and return a unique marker.
2. Confirm the request succeeds and the assistant stores a response ID.
3. Confirm the tool result is paired with the provider-issued call ID.

### Round 2: continue incrementally

1. Ask Kimi to recall the marker and run a second read-only tool.
2. Confirm the request uses `previous_response_id` and incremental input.
3. Confirm outbound `function_call_output.call_id` retains the native value,
   such as `read_0` or `exec_7`, byte-for-byte.
4. Confirm there is no `tool_call_id is not found`, stale-response rebuild, or
   repeated tool execution.

### Round 3: restart and replay

1. Restart the Gateway without deleting the temporary session.
2. Resume the same session and request another read-only tool call.
3. Confirm replay still preserves the provider-native call ID and the original
   marker remains available.

### Round 4: run the control model

1. Start a separate temporary session on the Ark control model.
2. Run the same two-tool sequence without enabling the new capability.
3. Confirm normal `call_*` ID handling still works and no Kimi-specific policy
   leaks into the control model.

## Validate overflow compaction

Run this validation only in a disposable session or controlled test fixture.

1. Exercise a context-overflow path where the current inbound message has
   already been persisted by in-attempt compaction.
2. Confirm the retry resumes from the transcript instead of appending the
   original prompt again.
3. Confirm the session contains one copy of the user message and one result for
   each tool call.
4. Allow one non-overflow retry to reach normal handling, then trigger a new
   overflow chain.
5. Confirm the new chain receives a fresh compaction budget while each
   uninterrupted overflow chain remains capped at three attempts.

The focused automated proof lives in
`src/agents/embedded-agent-runner/run.overflow-compaction.loop.test.ts`.

## Validate input-item protection and summary continuity

Run this validation on an Ark Responses model whose documented input-item limit
matches `responsesMaxInputItems`. Do not copy Ark's limit to unrelated Responses
models.

1. Start a disposable session below the configured threshold and confirm normal
   model requests continue without item-triggered compaction.
2. Grow the tool-heavy conversation until the estimated count reaches
   `responsesMaxInputItems - responsesInputItemsSafetyMargin`.
3. Confirm the decision reports the configured `inputItemsLimit`, effective
   `inputItemsSafetyMargin`, and `shouldCompactByItems=true` with route
   `compact_items_overflow`.
4. Confirm `estimatedInputItems` includes the current inbound prompt, so a prompt
   that crosses the threshold compacts before the provider request.
5. Confirm the item-triggered compaction breaks the old `previous_response_id`
   chain, performs a full stored rebuild, and saves a new response ID.
6. Continue the same session through a second compaction. Confirm the non-empty
   `compactionSummary` remains a conversation anchor, recent tool results remain
   paired, and the original prompt is not duplicated.

If no model/provider limit is configured, confirm item-count compaction remains
disabled while normal token-based compaction continues unchanged.

## Check retained .4 behavior

The `.5` build must retain the `.4` recovery and DashScope behavior:

- an invalid Ark `previous_response_id` triggers exactly one
  `mode=full-rebuild reason=stale-response-id` request;
- the fallback request omits the invalid ID and stores a new response ID;
- a normal Schema 400 is not classified as a stale response ID;
- a DashScope model can continue using the session-cache header, schema profile,
  and incremental response chain.

See [Ark stale response ID recovery](/providers/ark-responses-stale-response-id-v2026.7.1-2-responses-cache.4)
and [DashScope Responses session cache](/providers/dashscope-responses-session-cache)
for the provider-specific checks.

## Acceptance record

Record only sanitized evidence:

- checked-out commit or published `.5` tag;
- Node.js and pnpm versions;
- Gateway start time and health status;
- provider and model IDs without credentials;
- the four Ark Kimi/control rounds and their pass/fail result;
- whether incremental mode and native call IDs were observed;
- overflow compaction assertion results;
- the resolved input-item limit source, limit, safety margin, estimated count,
  and item-trigger route;
- whether the current prompt was counted and repeated compaction retained the
  latest summary anchor without duplicating the prompt;
- focused test, build, and production type-check results;
- any remaining warnings or untested live path.

Do not record API keys, auth tokens, complete response IDs, private prompts, or
production conversation contents.

## Roll back

If Kimi alone fails, remove
`compat.preserveNativeResponsesToolCallIds`, validate the config, and restart
the Gateway. Leave `supportsPreviousResponseId` unchanged unless the provider's
session chaining must also be disabled.

To disable input-item protection, remove `responsesMaxInputItems` and
`responsesInputItemsSafetyMargin` from the affected model or provider. Remove
the legacy Agent-level fallback only after every affected model has migrated.

If the `.5` build must be removed, restore the application backup or return to
the immutable `.4` tag:

```bash
git fetch origin --tags
git checkout v2026.7.1-2-responses-cache.4
pnpm install --no-frozen-lockfile
pnpm build
```

Validate the config and Gateway after rollback. Conversation history does not
need to be rewritten.

## See also

- [Ark Kimi native Responses tool call IDs](/providers/ark-kimi-native-responses-tool-call-ids)
- [Ark stale response ID recovery](/providers/ark-responses-stale-response-id-v2026.7.1-2-responses-cache.4)
- [DashScope Responses session cache](/providers/dashscope-responses-session-cache)
- [Configuration](/gateway/configuration)
- [Troubleshooting](/gateway/troubleshooting)
