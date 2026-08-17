import { describe, expect, it } from "vitest";
import { testing } from "./openai-transport-stream.js";

describe("isStalePreviousResponseIdError", () => {
  const staleCases: Array<{ name: string; error: unknown }> = [
    {
      name: "recognizes Ark nested error codes",
      error: {
        status: 400,
        error: {
          code: "InvalidParameter.PreviousResponseNotFound",
          message: "Previous response with id resp_invalid not found.",
          param: "previous_response_id",
        },
      },
    },
    {
      name: "recognizes Ark JSON response bodies",
      error: {
        status: 400,
        body: JSON.stringify({
          error: {
            code: "InvalidParameter.PreviousResponseNotFound",
            message: "Previous response with id resp_invalid not found.",
            param: "previous_response_id",
          },
        }),
      },
    },
    {
      name: "recognizes Ark response.data errors",
      error: {
        response: {
          status: 400,
          data: {
            error: {
              code: "InvalidParameter.PreviousResponseNotFound",
              message: "Previous response with id resp_invalid not found.",
            },
          },
        },
      },
    },
    {
      name: "preserves Bailian nested message matching",
      error: {
        status: 400,
        error: { message: "Not found previous_response_id: resp_invalid." },
      },
    },
    {
      name: "preserves Bailian JSON body matching",
      error: {
        status: 400,
        body: JSON.stringify({
          error: { message: "Not found previous_response_id: resp_invalid." },
        }),
      },
    },
    {
      name: "recognizes expired previous_response_id parameters",
      error: {
        status: 400,
        param: "previous_response_id",
        message: "The previous response has expired.",
      },
    },
    {
      name: "recognizes previous_response_id values that no longer exist",
      error: {
        status: 400,
        error: {
          param: "previous_response_id",
          message: "The referenced response no longer exists.",
        },
      },
    },
  ];

  const nonStaleCases: Array<{ name: string; error: unknown }> = [
    {
      name: "rejects schema validation errors",
      error: {
        status: 400,
        error: {
          code: "InvalidParameter",
          message: "patternProperties is not supported",
          param: "tools",
        },
      },
    },
    {
      name: "rejects unauthorized errors",
      error: { status: 401, message: "Unauthorized" },
    },
    {
      name: "rejects rate limit errors",
      error: { status: 429, message: "Rate limit exceeded" },
    },
    {
      name: "rejects unrelated invalid parameters",
      error: {
        status: 400,
        error: {
          code: "InvalidParameter",
          message: "Model not found",
          param: "model",
        },
      },
    },
    {
      name: "rejects previous_response_id errors without stale semantics",
      error: {
        status: 400,
        error: {
          code: "InvalidParameter",
          message: "The parameter format is invalid",
          param: "previous_response_id",
        },
      },
    },
    {
      name: "rejects server errors",
      error: { status: 500, message: "Internal server error" },
    },
    {
      name: "rejects invalid JSON bodies",
      error: { status: 400, body: "{not-json" },
    },
  ];

  it.each(staleCases)("$name", ({ error }) => {
    expect(testing.isStalePreviousResponseIdError(error)).toBe(true);
  });

  it.each(nonStaleCases)("$name", ({ error }) => {
    expect(testing.isStalePreviousResponseIdError(error)).toBe(false);
  });
});
