import { describe, expect, it } from "vite-plus/test";

import { boardSplitRecommendationFallback } from "./boardGroups.ts";

describe("boardSplitRecommendationFallback (T3O-31)", () => {
  it("recommends today's sub-board when every child is planned", () => {
    expect(
      boardSplitRecommendationFallback({
        plans: [{}, { planned: true }],
        underIntegrationBranch: false,
      }),
    ).toEqual({ autoBuild: true, mergeTarget: "own" });
  });

  it("recommends an epic breakdown when any child needs planning", () => {
    expect(
      boardSplitRecommendationFallback({
        plans: [{}, { planned: false }],
        underIntegrationBranch: false,
      }),
    ).toEqual({ autoBuild: false, mergeTarget: "inherit" });
  });

  it("prefers inherit under an ancestor with its own branch", () => {
    expect(
      boardSplitRecommendationFallback({ plans: [{}, {}], underIntegrationBranch: true }),
    ).toEqual({ autoBuild: true, mergeTarget: "inherit" });
  });
});
