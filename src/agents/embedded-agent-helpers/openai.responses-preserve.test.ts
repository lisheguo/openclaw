// Covers preserveNativeResponsesToolCallIds opt-out for Responses id normalization.
import type { AgentMessage } from "openclaw/plugin-sdk/agent-core";
import { describe, expect, it } from "vitest";
import { castAgentMessages } from "../test-helpers/agent-message-fixtures.js";
import { normalizeOpenAIResponsesToolCallIds } from "./openai.js";

const nativePairing = "functions.read:0|fc_kimi-item-1";

const buildInput = () =>
  castAgentMessages([
    {
      role: "assistant",
      content: [{ type: "toolCall", id: nativePairing, name: "read", arguments: {} }],
    },
    {
      role: "toolResult",
      toolCallId: nativePairing,
      toolName: "read",
      content: [{ type: "text", text: "ok" }],
    },
  ]);

describe("normalizeOpenAIResponsesToolCallIds preserveNativeResponsesToolCallIds", () => {
  it("rewrites non-OpenAI-shape ids by default", () => {
    const input = buildInput();

    const out = normalizeOpenAIResponsesToolCallIds(input);

    expect(out).not.toBe(input);
    const assistant = out[0] as Extract<AgentMessage, { role: "assistant" }>;
    const block = assistant.content[0] as { id?: string };
    expect(block.id).not.toBe(nativePairing);
  });

  it("returns messages unchanged when preserveNativeResponsesToolCallIds is true", () => {
    const input = buildInput();

    const out = normalizeOpenAIResponsesToolCallIds(input, {
      preserveNativeResponsesToolCallIds: true,
    });

    expect(out).toBe(input);
  });
});
