/**
 * T3o primary stage action (t3o-06, D18; t3o-15). The detail pane's forward
 * button is a human gate — and the build-role stage has none, because Building
 * -> Code review is board-driven, not a click. This pins that: every advance is
 * human-initiated, and no UI affordance auto-advances a card out of the build
 * role. Derived generically now from the user-defined stage list.
 */
import { BOARD_SEED_STAGE_IDS, BOARD_SEED_STAGES } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { boardStagePrimaryAction, isBoardStageManuallySelectable } from "./boardStageActions";

const stages = BOARD_SEED_STAGES;

describe("boardStagePrimaryAction", () => {
  it("moves a card to the next stage in order", () => {
    expect(boardStagePrimaryAction(stages, BOARD_SEED_STAGE_IDS.backlog)).toEqual({
      label: "Move to Sprint",
      toStage: BOARD_SEED_STAGE_IDS.sprint,
      emphasised: false,
    });
    expect(boardStagePrimaryAction(stages, BOARD_SEED_STAGE_IDS.sprint)).toEqual({
      label: "Move to Planning",
      toStage: BOARD_SEED_STAGE_IDS.planning,
      emphasised: false,
    });
    expect(boardStagePrimaryAction(stages, BOARD_SEED_STAGE_IDS.planning)).toEqual({
      label: "Move to Ready",
      toStage: BOARD_SEED_STAGE_IDS.ready,
      emphasised: false,
    });
    // The gate into the build role — "Begin build" — is the crossing that must
    // never be automatic; it is a human click here, nothing more, and the one
    // emphasised action.
    expect(boardStagePrimaryAction(stages, BOARD_SEED_STAGE_IDS.ready)).toEqual({
      label: "Begin build",
      toStage: BOARD_SEED_STAGE_IDS.building,
      emphasised: true,
    });
    expect(boardStagePrimaryAction(stages, BOARD_SEED_STAGE_IDS.review)).toEqual({
      label: "Move to Ready for merge",
      toStage: BOARD_SEED_STAGE_IDS.merge,
      emphasised: false,
    });
    expect(boardStagePrimaryAction(stages, BOARD_SEED_STAGE_IDS.merge)).toEqual({
      label: "Move to Done",
      toStage: BOARD_SEED_STAGE_IDS.done,
      emphasised: false,
    });
  });

  it("offers NO forward button from the build role or the last stage", () => {
    // Building -> Code review is board-driven (build success), never a click —
    // a forward button here would be a D18 violation. Done is terminal.
    expect(boardStagePrimaryAction(stages, BOARD_SEED_STAGE_IDS.building)).toBeNull();
    expect(boardStagePrimaryAction(stages, BOARD_SEED_STAGE_IDS.done)).toBeNull();
  });

  it("no primary action ever targets the build role except the explicit gate before it", () => {
    for (const stage of stages) {
      const action = boardStagePrimaryAction(stages, stage.stageId);
      if (action?.toStage === BOARD_SEED_STAGE_IDS.building) {
        expect(stage.stageId).toBe(BOARD_SEED_STAGE_IDS.ready);
      }
    }
  });

  it("lets a human choose only the stages before the build role", () => {
    // Everything before the build role is a person's to set; the build role
    // onward is granted by the forward gate, a build result or a review verdict,
    // so the ladder must not offer them as a click.
    expect(
      stages
        .filter((stage) => isBoardStageManuallySelectable(stages, stage.stageId))
        .map((stage) => stage.stageId),
    ).toEqual([
      BOARD_SEED_STAGE_IDS.backlog,
      BOARD_SEED_STAGE_IDS.sprint,
      BOARD_SEED_STAGE_IDS.planning,
      BOARD_SEED_STAGE_IDS.ready,
    ]);
  });
});
