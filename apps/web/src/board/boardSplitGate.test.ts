import { BoardPlanId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { boardSplitGateRecommended, boardSplitGateView } from "./boardSplitGate";

const plan = (key: string, input?: { planned?: boolean; after?: ReadonlyArray<string> }) => ({
  planId: BoardPlanId.make(`card::${key}`),
  title: `Plan ${key}`,
  dependsOn: (input?.after ?? []).map((dependency) => BoardPlanId.make(`card::${dependency}`)),
  ...(input?.planned === undefined ? {} : { planned: input.planned }),
});

const base = {
  ownBranch: "board/t3-190",
  landsOn: "main",
  readyLabel: "Ready",
  backlogLabel: "Backlog",
};

describe("boardSplitGateView", () => {
  it("numbers rows, maps dependencies and lands each child by its Planned flag", () => {
    const view = boardSplitGateView({
      ...base,
      plans: [
        plan("a"),
        plan("b", { planned: false, after: ["a"] }),
        plan("c", { after: ["a", "b"] }),
      ],
      recommendation: { autoBuild: false, mergeTarget: "inherit" },
      settings: { autoBuild: false, mergeTarget: "inherit" },
    });
    expect(view.rows.map((row) => [row.number, row.after, row.planned, row.lands])).toEqual([
      ["#1", null, true, "→ Ready"],
      ["#2", "after #1", false, "→ Backlog"],
      ["#3", "after #1, #2", true, "→ Ready"],
    ]);
    expect(view.count).toBe("3 cards");
    expect(view.mix).toBe("2 planned, 1 need planning");
    expect(view.resolved).toBe("→ main");
  });

  it("states the recommendation until the human edits it, then says so", () => {
    const recommendation = { autoBuild: true, mergeTarget: "own" } as const;
    const plans = [plan("a"), plan("b")];
    const untouched = boardSplitGateView({
      ...base,
      plans,
      recommendation,
      settings: recommendation,
    });
    expect(untouched.edited).toBe(false);
    expect(untouched.mix).toBe("all planned");
    expect(untouched.resolved).toBe("board/t3-190 → main");
    expect(untouched.foot).toBe(
      "Agent recommends auto-build on, own branch. Approving creates the cards. Nothing starts until you start it.",
    );

    const edited = boardSplitGateView({
      ...base,
      plans,
      recommendation,
      settings: { autoBuild: true, mergeTarget: "inherit" },
    });
    expect(edited.edited).toBe(true);
    expect(edited.foot).toMatch(
      /^Changed from the agent's recommendation \(auto-build on, own branch\)\./,
    );
  });

  it("reads an all-brief split as all needing planning", () => {
    const view = boardSplitGateView({
      ...base,
      plans: [plan("a", { planned: false }), plan("b", { planned: false })],
      recommendation: { autoBuild: false, mergeTarget: "inherit" },
      settings: { autoBuild: false, mergeTarget: "inherit" },
    });
    expect(view.mix).toBe("all need planning");
    expect(view.autoBuildNote).toBe("You start each child yourself.");
  });

  it("pre-selects inherit when an own-branch recommendation has a child still to plan", () => {
    const recommendation = { autoBuild: true, mergeTarget: "own" } as const;
    expect(
      boardSplitGateRecommended({
        plans: [plan("a"), plan("b", { planned: false })],
        recommendation,
      }),
    ).toEqual({ autoBuild: true, mergeTarget: "inherit" });
    expect(boardSplitGateRecommended({ plans: [plan("a"), plan("b")], recommendation })).toEqual(
      recommendation,
    );
  });
});
