import type { Model } from "../../../llm/types.js";

export type ResponsesInputItemsLimit =
  | { maxInputItems: number; source: "model" | "provider" | "legacy-agent" }
  | { maxInputItems?: undefined; source: "disabled" };

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

/**
 * Resolves the Responses input-item hard limit at the selected model boundary.
 * Non-Responses models stay disabled even when a misplaced capability exists.
 */
export function resolveResponsesMaxInputItems(params: {
  model: Model;
  provider?: { responsesMaxInputItems?: unknown };
  legacyAgentMaxInputItems?: unknown;
}): ResponsesInputItemsLimit {
  if (!RESPONSES_APIS.has(params.model.api)) {
    return { source: "disabled" };
  }

  const modelLimit = normalizePositiveInteger(
    (params.model.compat as { responsesMaxInputItems?: unknown } | undefined)
      ?.responsesMaxInputItems,
  );
  if (modelLimit !== undefined) {
    return { maxInputItems: modelLimit, source: "model" };
  }

  const providerLimit = normalizePositiveInteger(params.provider?.responsesMaxInputItems);
  if (providerLimit !== undefined) {
    return { maxInputItems: providerLimit, source: "provider" };
  }

  const legacyLimit = normalizePositiveInteger(params.legacyAgentMaxInputItems);
  return legacyLimit === undefined
    ? { source: "disabled" }
    : { maxInputItems: legacyLimit, source: "legacy-agent" };
}
