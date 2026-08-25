---
summary: "Preserve Ark Kimi provider-issued Responses tool call IDs across session replay"
read_when:
  - You use an Ark-hosted Kimi model through the Responses API
  - Ark returns tool_call_id is not found during an incremental session
  - You need to configure preserveNativeResponsesToolCallIds safely
title: "Ark Kimi native Responses tool call IDs"
---

# Ark Kimi native Responses tool call IDs

Some Ark-hosted Kimi Responses models issue native tool call IDs such as
`read_0`, `exec_7`, or `process_57`. When the provider validates a later
`function_call_output.call_id` against its stored response, OpenClaw must replay
that ID byte-for-byte. Rewriting `read_0` to `call_read_0_<hash>` or stripping
the underscore causes Ark to reject the continuation with
`tool_call_id is not found`.

This is separate from an expired `previous_response_id`. A missing tool call ID
must not trigger stale-response full-history recovery.

## Configuration

Enable the capability only on a model verified to require provider-native IDs:

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
            },
          },
        ],
      },
    },
  },
}
```

Keep all existing provider, model, credential, header, and compatibility
fields. Merge only the new Boolean key into the intended model. Do not enable
it provider-wide or infer it from a model name.

When OpenClaw edits `openclaw.json`, it must:

1. Confirm that the target model uses a Responses-compatible API.
2. Preserve the existing provider and model objects.
3. Set `compat.preserveNativeResponsesToolCallIds` only on the verified model.
4. Validate the configuration before restarting the Gateway.
5. Never print or rewrite API keys while applying this change.

The default is `false`. Models without this explicit capability keep the normal
OpenClaw tool call ID sanitization path.

## Runtime behavior

When enabled for a Responses-compatible model, OpenClaw:

- skips the OpenAI-shape rewrite for replayed Responses tool call IDs;
- prevents the generic strict ID sanitizer from changing the provider-issued
  call ID;
- keeps tool-call/result pairing repair enabled;
- keeps reasoning-pair downgrade and `previous_response_id` handling enabled;
- lets an explicit provider plugin policy override the model capability.

The capability is included in the transcript-policy cache key, so policies for
different model configurations cannot share a stale cached decision.

## Verification

Use a temporary session and a read-only tool sequence:

1. Start a fresh Kimi Responses session and invoke two read-only tools.
2. Continue the same session and confirm incremental mode uses
   `previous_response_id`.
3. Restart the Gateway, resume the session, and invoke another read-only tool.
4. Confirm outbound `function_call_output.call_id` values retain forms such as
   `read_0` or `exec_7`.
5. Confirm there is no `tool_call_id is not found`, stale-response fallback, or
   repeated tool execution.
6. Run a Responses control model without the capability and confirm its normal
   `call_*` ID handling remains unchanged.

## Rollback

Remove `compat.preserveNativeResponsesToolCallIds` from the model, validate the
configuration, and restart the Gateway. Normal ID sanitization resumes. Leave
`supportsPreviousResponseId` unchanged unless session chaining itself must also
be disabled.
