import { describe, expect, it } from "vite-plus/test";

import type { BoardCardGroup, BoardCardId, BoardStageId } from "./board.ts";
import {
  boardShellMergesIntoIntegrationBranch,
  boardSplitRecommendationFallback,
} from "./boardGroups.ts";

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

describe("boardShellMergesIntoIntegrationBranch (T3O-31)", () => {
  const id = (value: string) => value as BoardCardId;
  const group = (target: BoardCardGroup["target"]): BoardCardGroup => ({
    target,
    autoBuild: false,
    autoMerge: false,
    autoPlan: false,
    started: false,
    placed: "planning" as BoardStageId,
    prevStage: null,
    heading: false,
    integrated: false,
  });
  const ownGroup = group("own");
  const inheritGroup = group("inherit");

  it("is false for a top-level card", () => {
    expect(boardShellMergesIntoIntegrationBranch([], {})).toBe(false);
  });

  it("is false for a child of a top-level inherit group, which lands on trunk", () => {
    const shells = [{ cardId: id("epic"), group: inheritGroup }];
    expect(boardShellMergesIntoIntegrationBranch(shells, { parentCardId: id("epic") })).toBe(false);
  });

  it("is true under an own-branch ancestor, through an inherit group", () => {
    const shells = [
      { cardId: id("root"), group: ownGroup },
      { cardId: id("mid"), parentCardId: id("root"), group: inheritGroup },
    ];
    expect(boardShellMergesIntoIntegrationBranch(shells, { parentCardId: id("mid") })).toBe(true);
  });

  it("treats a legacy parent with no group settings as cutting its own branch", () => {
    const shells = [{ cardId: id("legacy") }];
    expect(boardShellMergesIntoIntegrationBranch(shells, { parentCardId: id("legacy") })).toBe(
      true,
    );
  });
});
