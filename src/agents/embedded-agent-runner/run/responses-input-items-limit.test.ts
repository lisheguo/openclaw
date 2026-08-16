import { describe, expect, it } from "vitest";
import type { Model } from "../../../llm/types.js";
import { shouldPreemptivelyCompactBeforePrompt } from "./preemptive-compaction.js";
import { resolveResponsesMaxInputItems } from "./responses-input-items-limit.js";

function createModel(params?: { api?: Model["api"]; responsesMaxInputItems?: number }): Model {
  return {
    id: "test-model",
    name: "Test model",
    api: params?.api ?? "openai-responses",
    provider: "test-provider",
    baseUrl: "https://example.test/v1",
    compat:
      params?.responsesMaxInputItems === undefined
        ? undefined
        : { responsesMaxInputItems: params.responsesMaxInputItems },
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128_000,
    maxTokens: 8192,
  } as Model;
}

describe("resolveResponsesMaxInputItems", () => {
  it("uses a model-level Responses limit without an agent global", () => {
    expect(
      resolveResponsesMaxInputItems({
        model: createModel({ responsesMaxInputItems: 1000 }),
      }),
    ).toEqual({ maxInputItems: 1000, source: "model" });
  });

  it("stays disabled when no limit is configured", () => {
    expect(resolveResponsesMaxInputItems({ model: createModel() })).toEqual({
      source: "disabled",
    });
  });

  it("prefers model over provider and legacy agent limits", () => {
    expect(
      resolveResponsesMaxInputItems({
        model: createModel({ responsesMaxInputItems: 1000 }),
        provider: { responsesMaxInputItems: 900 },
        legacyAgentMaxInputItems: 800,
      }),
    ).toEqual({ maxInputItems: 1000, source: "model" });
  });

  it("prefers provider over the legacy agent limit", () => {
    expect(
      resolveResponsesMaxInputItems({
        model: createModel(),
        provider: { responsesMaxInputItems: 900 },
        legacyAgentMaxInputItems: 800,
      }),
    ).toEqual({ maxInputItems: 900, source: "provider" });
  });

  it("preserves the legacy agent fallback and reports its source", () => {
    expect(
      resolveResponsesMaxInputItems({
        model: createModel(),
        legacyAgentMaxInputItems: 800,
      }),
    ).toEqual({ maxInputItems: 800, source: "legacy-agent" });
  });

  it("isolates limits between two models used by the same agent", () => {
    const legacyAgentMaxInputItems = undefined;
    const modelA = resolveResponsesMaxInputItems({
      model: createModel({ responsesMaxInputItems: 1000 }),
      legacyAgentMaxInputItems,
    });
    const modelB = resolveResponsesMaxInputItems({
      model: createModel(),
      legacyAgentMaxInputItems,
    });

    expect(modelA).toEqual({ maxInputItems: 1000, source: "model" });
    expect(modelB).toEqual({ source: "disabled" });
  });

  it("ignores the capability on non-Responses APIs", () => {
    expect(
      resolveResponsesMaxInputItems({
        model: createModel({
          api: "openai-completions",
          responsesMaxInputItems: 1000,
        }),
        provider: { responsesMaxInputItems: 900 },
        legacyAgentMaxInputItems: 800,
      }),
    ).toEqual({ source: "disabled" });
  });

  it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY])(
    "safely disables invalid runtime value %s",
    (responsesMaxInputItems) => {
      expect(
        resolveResponsesMaxInputItems({
          model: createModel({ responsesMaxInputItems }),
        }),
      ).toEqual({ source: "disabled" });
    },
  );

  it("floors a positive runtime value", () => {
    expect(
      resolveResponsesMaxInputItems({
        model: createModel({ responsesMaxInputItems: 1000.9 }),
      }),
    ).toEqual({ maxInputItems: 1000, source: "model" });
  });

  it("only applies the safety margin when a limit was resolved", () => {
    const messages = Array.from({ length: 10 }, (_, index) => ({
      role: "user" as const,
      content: `message-${index}`,
      timestamp: index,
    }));
    const disabled = shouldPreemptivelyCompactBeforePrompt({
      messages,
      prompt: "hello",
      contextTokenBudget: 128_000,
      reserveTokens: 32_000,
      inputItemsSafetyMargin: 150,
    });
    const enabled = shouldPreemptivelyCompactBeforePrompt({
      messages,
      prompt: "hello",
      contextTokenBudget: 128_000,
      reserveTokens: 32_000,
      maxInputItems: 1000,
      inputItemsSafetyMargin: 150,
    });

    expect(disabled.inputItemsLimit).toBeUndefined();
    expect(disabled.inputItemsSafetyMargin).toBeUndefined();
    expect(enabled.inputItemsLimit).toBe(1000);
    expect(enabled.inputItemsSafetyMargin).toBe(150);
  });
});
