/**
 * Planning's Auto-build forward rewrite (T3O-25): Begin build when the
 * reactor will start this card after Ready, and the HIL hide while Auto-build
 * owns the build.
 */
import {
  BOARD_SEED_STAGE_IDS,
  BOARD_SEED_STAGES,
  BoardStageId,
  type BoardStageDefinition,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  boardCardAutomationForwardAction,
  boardCardHumanInLoopProp,
  boardPlanningExitConfirmCopyForMove,
} from "./boardCardAutomationForward";
import { boardStagePrimaryAction, type BoardStagePrimaryAction } from "./boardStageActions";

const stages = BOARD_SEED_STAGES.filter((stage) => stage.stageId !== BOARD_SEED_STAGE_IDS.ci);

const autoBuildOn = { value: true, waitingForGroupStart: false } as const;
const autoBuildOff = { value: false, waitingForGroupStart: false } as const;
const autoBuildWaiting = { value: false, waitingForGroupStart: true } as const;

function rewrite(
  stage: (typeof BOARD_SEED_STAGE_IDS)[keyof typeof BOARD_SEED_STAGE_IDS],
  autoBuild: { readonly value: boolean; readonly waitingForGroupStart: boolean },
  extra?: { readonly unmetCount?: number; readonly isGroup?: boolean },
) {
  return boardCardAutomationForwardAction(boardStagePrimaryAction(stages, stage), {
    stages,
    stage,
    autoBuild,
    unmetCount: extra?.unmetCount ?? 0,
    isGroup: extra?.isGroup ?? false,
  });
}

describe("boardCardAutomationForwardAction", () => {
  it("relabels Planning as Begin build when Auto-build will start and deps are met", () => {
    expect(rewrite(BOARD_SEED_STAGE_IDS.planning, autoBuildOn)).toEqual({
      kind: "move",
      label: "Begin build",
      toStage: BOARD_SEED_STAGE_IDS.ready,
      emphasised: true,
    });
  });

  it("keeps Move to Ready when Auto-build is on but a dependency is unmet", () => {
    expect(rewrite(BOARD_SEED_STAGE_IDS.planning, autoBuildOn, { unmetCount: 1 })).toEqual({
      kind: "move",
      label: "Move to Ready",
      toStage: BOARD_SEED_STAGE_IDS.ready,
      emphasised: false,
    });
  });

  it("keeps Move to Ready when Auto-build is off", () => {
    expect(rewrite(BOARD_SEED_STAGE_IDS.planning, autoBuildOff)).toEqual({
      kind: "move",
      label: "Move to Ready",
      toStage: BOARD_SEED_STAGE_IDS.ready,
      emphasised: false,
    });
  });

  it("keeps Move to Ready while inherited Auto-build waits for the group to start", () => {
    expect(rewrite(BOARD_SEED_STAGE_IDS.planning, autoBuildWaiting)).toEqual({
      kind: "move",
      label: "Move to Ready",
      toStage: BOARD_SEED_STAGE_IDS.ready,
      emphasised: false,
    });
  });

  it("does not relabel when waitingForGroupStart is set even if value is true", () => {
    // The resolver never emits this pair, but the helper must not promise a
    // start if a caller did.
    expect(
      rewrite(BOARD_SEED_STAGE_IDS.planning, { value: true, waitingForGroupStart: true }),
    ).toEqual({
      kind: "move",
      label: "Move to Ready",
      toStage: BOARD_SEED_STAGE_IDS.ready,
      emphasised: false,
    });
  });

  it("leaves Ready's Begin build untouched", () => {
    expect(rewrite(BOARD_SEED_STAGE_IDS.ready, autoBuildOn)).toEqual({
      kind: "move",
      label: "Begin build",
      toStage: BOARD_SEED_STAGE_IDS.building,
      emphasised: true,
    });
  });

  it("leaves Backlog and Sprint Move to … labels untouched", () => {
    expect(rewrite(BOARD_SEED_STAGE_IDS.backlog, autoBuildOn)).toEqual({
      kind: "move",
      label: "Move to Sprint",
      toStage: BOARD_SEED_STAGE_IDS.sprint,
      emphasised: false,
    });
    expect(rewrite(BOARD_SEED_STAGE_IDS.sprint, autoBuildOn)).toEqual({
      kind: "move",
      label: "Move to Planning",
      toStage: BOARD_SEED_STAGE_IDS.planning,
      emphasised: false,
    });
  });

  it("never relabels a group card", () => {
    expect(rewrite(BOARD_SEED_STAGE_IDS.planning, autoBuildOn, { isGroup: true })).toEqual({
      kind: "move",
      label: "Move to Ready",
      toStage: BOARD_SEED_STAGE_IDS.ready,
      emphasised: false,
    });
  });

  it("detects plan → stage-before-build on a customised pipeline", () => {
    const custom: ReadonlyArray<BoardStageDefinition> = BOARD_SEED_STAGES.filter(
      (stage) => stage.stageId !== BOARD_SEED_STAGE_IDS.ci,
    ).map((stage) => ({
      ...stage,
      stageId: BoardStageId.make(`x-${stage.stageId}`),
    }));
    const plan = BoardStageId.make("x-planning");
    const ready = BoardStageId.make("x-ready");
    const primary = boardStagePrimaryAction(custom, plan);
    expect(primary).toEqual({
      kind: "move",
      label: "Move to Ready",
      toStage: ready,
      emphasised: false,
    } satisfies BoardStagePrimaryAction);
    expect(
      boardCardAutomationForwardAction(primary, {
        stages: custom,
        stage: plan,
        autoBuild: autoBuildOn,
        unmetCount: 0,
        isGroup: false,
      }),
    ).toEqual({
      kind: "move",
      label: "Begin build",
      toStage: ready,
      emphasised: true,
    });
  });
});

describe("boardPlanningExitConfirmCopyForMove", () => {
  const cardKey = "T3O-25";
  const readyLabel = "Ready";

  it("uses Begin build when Auto-build will start and deps are met", () => {
    expect(
      boardPlanningExitConfirmCopyForMove({
        cardKey,
        toStageLabel: readyLabel,
        stages,
        fromStage: BOARD_SEED_STAGE_IDS.planning,
        toStage: BOARD_SEED_STAGE_IDS.ready,
        autoBuild: autoBuildOn,
        unmetCount: 0,
        isGroup: false,
      }),
    ).toEqual({
      title: "Begin build for T3O-25 without a plan?",
      confirmLabel: "Begin build",
      extra: "Auto-build will start the card once it reaches Ready.",
    });
  });

  it("keeps Move to Ready when Auto-build is off", () => {
    expect(
      boardPlanningExitConfirmCopyForMove({
        cardKey,
        toStageLabel: readyLabel,
        stages,
        fromStage: BOARD_SEED_STAGE_IDS.planning,
        toStage: BOARD_SEED_STAGE_IDS.ready,
        autoBuild: autoBuildOff,
        unmetCount: 0,
        isGroup: false,
      }),
    ).toEqual({
      title: "Move T3O-25 to Ready without a plan?",
      confirmLabel: "Move to Ready",
      extra: null,
    });
  });

  it("keeps Move to Ready when a dependency is unmet", () => {
    expect(
      boardPlanningExitConfirmCopyForMove({
        cardKey,
        toStageLabel: readyLabel,
        stages,
        fromStage: BOARD_SEED_STAGE_IDS.planning,
        toStage: BOARD_SEED_STAGE_IDS.ready,
        autoBuild: autoBuildOn,
        unmetCount: 1,
        isGroup: false,
      }).confirmLabel,
    ).toBe("Move to Ready");
  });

  it("does not relabel a hop that is not Planning to Ready", () => {
    expect(
      boardPlanningExitConfirmCopyForMove({
        cardKey,
        toStageLabel: "Building",
        stages,
        fromStage: BOARD_SEED_STAGE_IDS.planning,
        toStage: BOARD_SEED_STAGE_IDS.building,
        autoBuild: autoBuildOn,
        unmetCount: 0,
        isGroup: false,
      }),
    ).toEqual({
      title: "Move T3O-25 to Building without a plan?",
      confirmLabel: "Move to Building",
      extra: null,
    });
  });
});

describe("boardCardHumanInLoopProp", () => {
  const assembled = { value: true, explicit: false, basis: "plan" as const };

  it("hides Human in the loop while resolved Auto-build is on", () => {
    expect(boardCardHumanInLoopProp({ autoBuildValue: true, humanInLoop: assembled })).toBeNull();
    expect(boardCardHumanInLoopProp({ autoBuildValue: true, humanInLoop: null })).toBeNull();
  });

  it("passes the assembled Human in the loop through when Auto-build is off", () => {
    expect(boardCardHumanInLoopProp({ autoBuildValue: false, humanInLoop: assembled })).toBe(
      assembled,
    );
    expect(boardCardHumanInLoopProp({ autoBuildValue: false, humanInLoop: null })).toBeNull();
  });
});
