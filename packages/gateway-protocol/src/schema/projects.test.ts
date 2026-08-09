import { Value } from "typebox/value";
import { describe, expect, it } from "vitest";
import {
  PROJECTS_LIST_MAX_CHECKOUTS_PER_PROJECT,
  ProjectsListParamsSchema,
  ProjectsListResultSchema,
  validateProjectsListParams,
} from "../index.js";

describe("projects protocol schemas", () => {
  it("round-trips a derived project listing", () => {
    const result = {
      projects: [
        {
          name: "openclaw",
          originUrl: "https://github.com/openclaw/openclaw.git",
          checkouts: [{ runnerId: "gateway", path: "/src/openclaw" }],
          lastUsedAt: 123,
        },
      ],
    };

    expect(
      Value.Encode(ProjectsListResultSchema, Value.Decode(ProjectsListResultSchema, result)),
    ).toEqual(result);
  });

  it("bounds list limits", () => {
    expect(validateProjectsListParams({})).toBe(true);
    expect(validateProjectsListParams({ limit: 1 })).toBe(true);
    expect(validateProjectsListParams({ limit: 200 })).toBe(true);
    expect(Value.Check(ProjectsListParamsSchema, { limit: 0 })).toBe(false);
    expect(validateProjectsListParams({ limit: 201 })).toBe(false);
  });

  it("bounds checkouts within each project", () => {
    const project = {
      name: "openclaw",
      checkouts: Array.from(
        { length: PROJECTS_LIST_MAX_CHECKOUTS_PER_PROJECT + 1 },
        (_, index) => ({
          runnerId: "gateway",
          path: `/src/openclaw-${index}`,
        }),
      ),
      lastUsedAt: 123,
    };

    expect(Value.Check(ProjectsListResultSchema, { projects: [project] })).toBe(false);
  });
});
