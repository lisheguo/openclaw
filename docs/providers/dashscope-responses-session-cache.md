---
summary: "Agent runbook for safely enabling DashScope Responses session chaining in openclaw.json"
title: "DashScope Responses session cache"
read_when:
  - You want to enable previous_response_id chaining for a DashScope Responses model
  - You are an agent asked to modify openclaw.json safely
  - You need to enable or roll back DashScope session cache
---

This page is both an operator guide and an execution contract for an OpenClaw agent that is asked to edit `openclaw.json`.

The feature is opt-in. Models that do not explicitly set `compat.supportsPreviousResponseId: true` keep sending full history and never send `previous_response_id`.

## Agent execution contract

When a user asks you to enable DashScope Responses session chaining, follow these steps in order.

1. Locate the active `openclaw.json` through OpenClaw's normal configuration discovery. Do not create a second config file when an active one already exists.
2. Read the complete file before editing. Preserve unrelated providers, models, comments, credentials, and formatting.
3. Identify the exact target model entry under `models.providers.<provider>.models[]`. Match the requested provider and model id. Do not modify every model.
4. Confirm that the target model uses `api: "openai-responses"`. If it uses another API, stop and explain that this capability is only implemented by the Responses transport.
5. Merge the following fields into that model entry without deleting its existing fields:

   ```json5
   {
     headers: {
       "x-dashscope-session-cache": "enable",
     },
     compat: {
       supportsPreviousResponseId: true,
     },
   }
   ```

6. If `headers` or `compat` already exists, merge keys into the existing object. Never replace the whole object.
7. Do not add `store`, `cache_control`, or a second cache header. Do not copy the setting to OpenAI, Azure, Volcengine, or unrelated models.
8. Validate the final structure, show the user the exact diff, then write the file when the user has authorized the configuration change.
9. Restart or reload the Gateway if the running installation does not automatically reload model configuration.
10. Run `openclaw models status --json` and confirm that the target provider and model remain usable. Never print API keys or auth-profile secrets.

## Required model patch

The following is an example target entry. Keep all existing model fields; the important additions are `headers.x-dashscope-session-cache` and `compat.supportsPreviousResponseId`.

```json5
{
  models: {
    providers: {
      dashscope: {
        // Keep the provider's existing baseUrl, apiKey, and other settings.
        models: [
          {
            id: "qwen-plus",
            api: "openai-responses",

            // Merge with existing model headers.
            headers: {
              "x-dashscope-session-cache": "enable",
            },

            // Merge with existing compatibility settings.
            compat: {
              supportsPreviousResponseId: true,
            },

            // Keep name, input, cost, contextWindow, maxTokens, and other fields.
          },
        ],
      },
    },
  },
}
```

The provider key does not need to be named `dashscope`. Runtime behavior is controlled by the model capability, not by a hard-coded provider name. Only enable it for an endpoint known to support OpenAI Responses `previous_response_id` semantics.

## Safe matching rules

OpenClaw reuses a previous response only when all of these values match the current request:

- provider id
- API id
- model id
- base URL
- session id
- auth profile id

The assistant message must also contain both a response id and matching provenance. Missing or mismatched data causes a safe fallback to full-history input.

After transcript compaction, the first request starts a new chain. A later request may chain from the first post-compaction response. Session branches use only the active branch context.

## Optional ARK item-limit protection

This setting is separate from DashScope session chaining:

```json5
{
  agents: {
    defaults: {
      compaction: {
        maxInputItems: 1000,
      },
    },
  },
}
```

Only add it when the user explicitly wants protection from a provider's 1000-item input cap. It is global under `agents.defaults`, so do not add it merely to enable DashScope session cache.

When configured as `1000`, the default safety margin is `150`, so item-based preemptive compaction starts at an estimated 850 input items. When `maxInputItems` is omitted, item-based compaction is disabled while token-based compaction continues unchanged.

## Verification checklist

After editing, verify all of the following:

- the target model still has `api: "openai-responses"`
- the target model has exactly one `x-dashscope-session-cache` header
- `compat.supportsPreviousResponseId` is `true` only on intended models
- existing `headers` and `compat` keys were preserved
- no `store` or `cache_control` field was added
- unrelated providers and models are unchanged
- no secret value is displayed in output or logs

At runtime, the first request sends full history. After a successful response returns an id, the next request can send `previous_response_id` plus only the incremental messages.

## Rollback

To disable session chaining for a model:

1. Remove `compat.supportsPreviousResponseId` or set it to `false`.
2. Remove `x-dashscope-session-cache` only when it is not used by another provider feature.
3. Leave existing response ids in transcript history untouched; they are ignored while the capability is disabled.
4. Remove `agents.defaults.compaction.maxInputItems` only if item-limit protection is no longer wanted.

Rollback returns the model to full-history requests without rewriting conversation history.
