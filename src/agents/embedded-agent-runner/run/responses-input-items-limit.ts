import type { Model } from "../../../llm/types.js";

export type ResponsesInputItemsLimit =
  | {
      maxInputItems: number;
      inputItemsSafetyMargin: number;
      source: "model" | "provider" | "legacy-agent";
    }
  | {
      maxInputItems?: undefined;
      inputItemsSafetyMargin?: undefined;
      source: "disabled";
    };

const DEFAULT_INPUT_ITEMS_SAFETY_MARGIN = 150;

const RESPONSES_APIS = new Set([
  "openai-responses",
  "azure-openai-responses",
  "openai-chatgpt-responses",
  "openclaw-openai-responses-transport",
]);

function normalizePositiveInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 1
    ? Math.floor(value)
    : undefined;
}

function normalizeNonNegativeInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? Math.floor(value)
    : undefined;
}

/**
 * Resolves the Responses input-item hard limit at the selected model boundary.
 * Non-Responses models stay disabled even when a misplaced capability exists.
 */
export function resolveResponsesMaxInputItems(params: {
  model: Model;
  provider?: {
    responsesMaxInputItems?: unknown;
    responsesInputItemsSafetyMargin?: unknown;
  };
  legacyAgentMaxInputItems?: unknown;
}): ResponsesInputItemsLimit {
  if (!RESPONSES_APIS.has(params.model.api)) {
    return { source: "disabled" };
  }

  const modelCompat = params.model.compat as
    | {
        responsesMaxInputItems?: unknown;
        responsesInputItemsSafetyMargin?: unknown;
      }
    | undefined;
  const inputItemsSafetyMargin =
    normalizeNonNegativeInteger(modelCompat?.responsesInputItemsSafetyMargin) ??
    normalizeNonNegativeInteger(params.provider?.responsesInputItemsSafetyMargin) ??
    DEFAULT_INPUT_ITEMS_SAFETY_MARGIN;
  const modelLimit = normalizePositiveInteger(modelCompat?.responsesMaxInputItems);
  if (modelLimit !== undefined) {
    return { maxInputItems: modelLimit, inputItemsSafetyMargin, source: "model" };
  }

  const providerLimit = normalizePositiveInteger(params.provider?.responsesMaxInputItems);
  if (providerLimit !== undefined) {
    return { maxInputItems: providerLimit, inputItemsSafetyMargin, source: "provider" };
  }

  const legacyLimit = normalizePositiveInteger(params.legacyAgentMaxInputItems);
  return legacyLimit === undefined
    ? { source: "disabled" }
    : { maxInputItems: legacyLimit, inputItemsSafetyMargin, source: "legacy-agent" };
}

/**
 * Leaves one additional safety-margin window after item-triggered compaction.
 * The two-item minimum keeps the pending prompt below the inclusive threshold.
 */
export function resolveResponsesCompactionInputItemsTarget(params: {
  maxInputItems?: number;
  inputItemsSafetyMargin?: number;
}): number | undefined {
  const maxInputItems = normalizePositiveInteger(params.maxInputItems);
  if (maxInputItems === undefined) {
    return undefined;
  }
  const safetyMargin = normalizeNonNegativeInteger(params.inputItemsSafetyMargin) ?? 0;
  const triggerThreshold = Math.max(1, maxInputItems - safetyMargin);
  const recoveryHeadroom = Math.max(2, Math.min(safetyMargin, triggerThreshold - 1));
  return Math.max(1, triggerThreshold - recoveryHeadroom);
}
