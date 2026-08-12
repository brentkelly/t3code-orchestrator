/**
 * T3o primary stage action (t3o-06, D18). The detail pane's forward button is
 * a human gate — and Building has none, because Building -> Code review is
 * board-driven, not a click. This pins that: every advance is human-initiated,
 * and no UI affordance auto-advances a card out of Building.
 */
import { BOARD_STAGES } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { boardStagePrimaryAction, isBoardStageManuallySelectable } from "./boardStageActions";

describe("boardStagePrimaryAction", () => {
  it("offers each human-gated forward transition from D18", () => {
    expect(boardStagePrimaryAction("backlog")).toEqual({
      label: "Add to sprint",
      toStage: "sprint",
      emphasised: true,
    });
    expect(boardStagePrimaryAction("sprint")).toEqual({
      label: "Begin planning",
      toStage: "planning",
      emphasised: true,
    });
    // An approval is a quiet button, not the loud one.
    expect(boardStagePrimaryAction("planning")).toEqual({
      label: "Approve plan",
      toStage: "ready",
      emphasised: false,
    });
    // The Ready gate — "Begin build" — is the crossing that must never be
    // automatic; it is a human click here, nothing more.
    expect(boardStagePrimaryAction("ready")).toEqual({
      label: "Begin build",
      toStage: "building",
      emphasised: true,
    });
    expect(boardStagePrimaryAction("review")).toEqual({
      label: "Approve review",
      toStage: "merge",
      emphasised: false,
    });
    expect(boardStagePrimaryAction("merge")).toEqual({
      label: "Merge",
      toStage: "done",
      emphasised: true,
    });
  });

  it("offers NO forward button from Building or Done (board-driven / terminal)", () => {
    // Building -> Code review is board-driven (build success), never a click —
    // a forward button here would be a D18 violation.
    expect(boardStagePrimaryAction("building")).toBeNull();
    expect(boardStagePrimaryAction("done")).toBeNull();
  });

  it("no primary action ever targets Building except the explicit Ready gate", () => {
    for (const stage of BOARD_STAGES) {
      const action = boardStagePrimaryAction(stage);
      if (action?.toStage === "building") expect(stage).toBe("ready");
    }
  });

  it("lets a human choose only the three planning stages", () => {
    // Backlog, Sprint and Planning are a person's to set; Ready onward is
    // granted by the forward gate, a build result or a review verdict, so the
    // ladder must not offer them as a click.
    expect(BOARD_STAGES.filter(isBoardStageManuallySelectable)).toEqual([
      "backlog",
      "sprint",
      "planning",
    ]);
  });
});
