import { BOARD_SEED_STAGES, EMPTY_BOARD_STATE, type BoardCiStep } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  boardCiParallelBlock,
  boardCiSharedWorktreeWarnings,
  boardImportSummaryChips,
  boardProjectStageState,
  moveBoardCiStep,
  removeBoardCiStep,
} from "./boardProjectSettings.logic";

const script = (id: string, parallel = false): BoardCiStep => ({
  kind: "script",
  id,
  name: id,
  parallel,
  command: id,
  timeoutMinutes: 30,
});
const agent = (id: string): BoardCiStep => ({
  kind: "agent",
  id,
  name: id,
  parallel: false,
  prompt: id,
  model: null,
  timeoutMinutes: 30,
});

describe("the CI step editor", () => {
  it("allows parallel only on a script after a script", () => {
    const steps = [script("a"), script("b"), agent("c"), script("d")];
    expect(boardCiParallelBlock(steps, 0)).toContain("first step");
    expect(boardCiParallelBlock(steps, 1)).toBeNull();
    expect(boardCiParallelBlock(steps, 2)).toContain("run on their own");
    expect(boardCiParallelBlock(steps, 3)).toContain("run on their own");
  });

  it("clears a parallel flag a move or removal breaks", () => {
    const steps = [script("a"), script("b", true), agent("c")];
    expect(moveBoardCiStep(steps, 1, -1).map((step) => [step.id, step.parallel])).toEqual([
      ["b", false],
      ["a", false],
      ["c", false],
    ]);
    expect(removeBoardCiStep([agent("x"), ...steps.slice(1)], 0)[0]).toMatchObject({
      id: "b",
      parallel: false,
    });
  });

  it("warns once per group of scripts sharing a worktree", () => {
    expect(
      boardCiSharedWorktreeWarnings([
        script("a"),
        script("b", true),
        script("c", true),
        script("d"),
      ]),
    ).toEqual([{ firstIndex: 0, names: ["a", "b", "c"] }]);
  });
});

describe("the Pipeline tab", () => {
  const stage = (id: string) => BOARD_SEED_STAGES.find((candidate) => candidate.stageId === id)!;

  it("locks role stages and the stage before build, and marks switches against the default", () => {
    expect(boardProjectStageState(EMPTY_BOARD_STATE, stage("review"), {}).kind).toBe("always-on");
    expect(boardProjectStageState(EMPTY_BOARD_STATE, stage("ready"), {}).kind).toBe("always-on");
    expect(boardProjectStageState(EMPTY_BOARD_STATE, stage("sprint"), { sprint: false })).toEqual({
      kind: "switchable",
      on: false,
      defaultOn: true,
      switched: true,
    });
    expect(boardProjectStageState(EMPTY_BOARD_STATE, stage("ci"), {})).toMatchObject({
      on: false,
      switched: false,
    });
  });
});

describe("import summary chips", () => {
  it("counts stages, CI steps, overrides and ignored entries", () => {
    expect(
      boardImportSummaryChips({
        delta: {
          stageSwitches: { qa: true, ci: true },
          overrides: { review: { rounds: 3 }, building: { prompt: "x" } },
          ci: { steps: [script("a"), script("b"), script("c")] },
          warnings: ["stages.review.round isn't a known setting"],
        },
        createStages: [{ stageId: "qa" as never, label: "QA" }],
        texts: [],
      }),
    ).toEqual(["+1 stage", "1 stage switch", "CI · 3 steps", "2 overrides", "1 ignored entry"]);
  });
});
