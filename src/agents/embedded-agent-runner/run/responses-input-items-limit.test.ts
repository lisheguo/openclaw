import { describe, expect, it } from "vitest";
import type { Model } from "../../../llm/types.js";
import { shouldPreemptivelyCompactBeforePrompt } from "./preemptive-compaction.js";
import {
  resolveResponsesCompactionInputItemsTarget,
  resolveResponsesMaxInputItems,
} from "./responses-input-items-limit.js";

function createModel(params?: {
  api?: Model["api"];
  responsesMaxInputItems?: number;
  responsesInputItemsSafetyMargin?: number;
}): Model {
  return {
    id: "test-model",
    name: "Test model",
    api: params?.api ?? "openai-responses",
    provider: "test-provider",
    baseUrl: "https://example.test/v1",
    compat:
      params?.responsesMaxInputItems === undefined &&
      params?.responsesInputItemsSafetyMargin === undefined
        ? undefined
        : {
            responsesMaxInputItems: params.responsesMaxInputItems,
            responsesInputItemsSafetyMargin: params.responsesInputItemsSafetyMargin,
          },
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128_000,
    maxTokens: 8192,
  } as Model;
}

describe("resolveResponsesMaxInputItems", () => {
  it("leaves a second safety-margin window after item compaction", () => {
    expect(
      resolveResponsesCompactionInputItemsTarget({
        maxInputItems: 1000,
        inputItemsSafetyMargin: 150,
      }),
    ).toBe(700);
  });

  it("keeps the pending prompt below the threshold with a zero margin", () => {
    expect(
      resolveResponsesCompactionInputItemsTarget({
        maxInputItems: 1000,
        inputItemsSafetyMargin: 0,
      }),
    ).toBe(998);
  });

  it("keeps the pending prompt below the threshold with a one-item margin", () => {
    expect(
      resolveResponsesCompactionInputItemsTarget({
        maxInputItems: 1000,
        inputItemsSafetyMargin: 1,
      }),
    ).toBe(997);
  });

  it("uses a model-level Responses limit without an agent global", () => {
    expect(
      resolveResponsesMaxInputItems({
        model: createModel({ responsesMaxInputItems: 1000 }),
      }),
    ).toEqual({ maxInputItems: 1000, inputItemsSafetyMargin: 150, source: "model" });
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
    ).toEqual({ maxInputItems: 1000, inputItemsSafetyMargin: 150, source: "model" });
  });

  it("prefers provider over the legacy agent limit", () => {
    expect(
      resolveResponsesMaxInputItems({
        model: createModel(),
        provider: { responsesMaxInputItems: 900 },
        legacyAgentMaxInputItems: 800,
      }),
    ).toEqual({ maxInputItems: 900, inputItemsSafetyMargin: 150, source: "provider" });
  });

  it("preserves the legacy agent fallback and reports its source", () => {
    expect(
      resolveResponsesMaxInputItems({
        model: createModel(),
        legacyAgentMaxInputItems: 800,
      }),
    ).toEqual({ maxInputItems: 800, inputItemsSafetyMargin: 150, source: "legacy-agent" });
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

    expect(modelA).toEqual({
      maxInputItems: 1000,
      inputItemsSafetyMargin: 150,
      source: "model",
    });
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
    ).toEqual({ maxInputItems: 1000, inputItemsSafetyMargin: 150, source: "model" });
  });

  it("prefers a model safety margin over the provider default", () => {
    expect(
      resolveResponsesMaxInputItems({
        model: createModel({
          responsesMaxInputItems: 1000,
          responsesInputItemsSafetyMargin: 100,
        }),
        provider: {
          responsesMaxInputItems: 900,
          responsesInputItemsSafetyMargin: 200,
        },
      }),
    ).toEqual({ maxInputItems: 1000, inputItemsSafetyMargin: 100, source: "model" });
  });

  it("uses a provider safety margin when the model does not override it", () => {
    expect(
      resolveResponsesMaxInputItems({
        model: createModel({ responsesMaxInputItems: 1000 }),
        provider: { responsesInputItemsSafetyMargin: 120 },
      }),
    ).toEqual({ maxInputItems: 1000, inputItemsSafetyMargin: 120, source: "model" });
  });

  it("accepts a zero safety margin", () => {
    expect(
      resolveResponsesMaxInputItems({
        model: createModel({
          responsesMaxInputItems: 1000,
          responsesInputItemsSafetyMargin: 0,
        }),
      }),
    ).toEqual({ maxInputItems: 1000, inputItemsSafetyMargin: 0, source: "model" });
  });

  it("ignores a safety margin when no input-item limit is configured", () => {
    expect(
      resolveResponsesMaxInputItems({
        model: createModel({ responsesInputItemsSafetyMargin: 100 }),
      }),
    ).toEqual({ source: "disabled" });
  });

  it("routes compaction at the configured safety-margin threshold", () => {
    const resolved = resolveResponsesMaxInputItems({
      model: createModel({
        responsesMaxInputItems: 1000,
        responsesInputItemsSafetyMargin: 200,
      }),
    });
    expect(resolved.source).toBe("model");
    if (resolved.source === "disabled") {
      throw new Error("expected a resolved Responses input-item limit");
    }

    const result = shouldPreemptivelyCompactBeforePrompt({
      messages: Array.from({ length: 799 }, (_, index) => ({
        role: "user" as const,
        content: `message-${index}`,
        timestamp: index,
      })),
      prompt: "hello",
      contextTokenBudget: 128_000,
      reserveTokens: 32_000,
      maxInputItems: resolved.maxInputItems,
      inputItemsSafetyMargin: resolved.inputItemsSafetyMargin,
    });

    expect(result.estimatedInputItems).toBe(800);
    expect(result.route).toBe("compact_items_overflow");
    expect(result.shouldCompactByItems).toBe(true);
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
