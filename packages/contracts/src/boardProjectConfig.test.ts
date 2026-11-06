import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import {
  BOARD_SEED_STAGES,
  BoardClientCommand,
  BoardCommand,
  BoardSettingsClientCommand,
  DEFAULT_BOARD_SETTINGS,
  EMPTY_BOARD_PROJECT_STAGE_CONFIG,
  EMPTY_BOARD_STATE,
  boardCiStepGroups,
  boardCiStepsRefusal,
  boardNewStageOrderKey,
  boardProjectConfigVersion,
  boardProjectDeltaNewTexts,
  boardProjectStageConfigShell,
  boardStageOrderViolation,
  normalizeBoardProjectDelta,
  type BoardCiStep,
  type BoardStageDefinition,
} from "./index.ts";

const script = (id: string, parallel = false): BoardCiStep => ({
  kind: "script",
  id,
  name: id,
  parallel,
  command: `run ${id}`,
  timeoutMinutes: 30,
});
const agent = (id: string): BoardCiStep => ({
  kind: "agent",
  id,
  name: id,
  parallel: false,
  prompt: `check ${id}`,
  model: null,
  timeoutMinutes: 30,
});

describe("CI step lists", () => {
  it("groups consecutive parallel scripts and runs every other step alone", () => {
    const groups = boardCiStepGroups([
      script("a"),
      script("b", true),
      script("c", true),
      agent("d"),
      script("e"),
    ]);
    expect(groups.map((group) => group.map((step) => step.id))).toEqual([
      ["a", "b", "c"],
      ["d"],
      ["e"],
    ]);
  });

  it("refuses parallel off a non-script, duplicate ids, too many steps and unsupported kinds", () => {
    expect(boardCiStepsRefusal([script("a"), script("b", true)])).toBeNull();
    expect(boardCiStepsRefusal([agent("a"), script("b", true)])).toContain("can't run in parallel");
    expect(boardCiStepsRefusal([script("a", true)])).toContain("can't run in parallel");
    expect(boardCiStepsRefusal([script("a"), script("a")])).toContain("share the id");
    expect(
      boardCiStepsRefusal(Array.from({ length: 13 }, (_, index) => script(`s${index}`))),
    ).toContain("at most 12");
    expect(boardCiStepsRefusal([agent("a")], { scriptOnly: true })).toContain("only script");
  });
});

describe("stage order", () => {
  const stage = (stageId: string, orderKey: string): BoardStageDefinition => ({
    stageId: stageId as never,
    label: stageId,
    role: null,
    orderKey,
    createdAt: "x",
    updatedAt: "x",
    projectId: null,
  });

  it("refuses a role-less stage between CI and the merge stage", () => {
    expect(boardStageOrderViolation(BOARD_SEED_STAGES)).toBeNull();
    expect(boardStageOrderViolation([...BOARD_SEED_STAGES, stage("late", "mm")])).toContain(
      "between Continuous integration",
    );
  });

  it("places a new stage just before CI", () => {
    const key = boardNewStageOrderKey(EMPTY_BOARD_STATE)!;
    expect(key > "l" && key < "m").toBe(true);
  });
});

describe("normalization and version", () => {
  it("drops switches equal to the default, unswitchable stages and overrides equal to global", () => {
    const normalized = normalizeBoardProjectDelta({
      board: EMPTY_BOARD_STATE,
      settings: DEFAULT_BOARD_SETTINGS,
      delta: {
        stageSwitches: { backlog: true, sprint: false, review: false, ready: false, nope: true },
        overrides: {
          ci: { maxFixAttempts: 2, maxRoundTrips: 5 },
          building: { prompt: DEFAULT_BOARD_SETTINGS.pipeline.building?.prompt ?? "x" },
          nope: { autoExecute: true },
        },
        ci: { steps: [] },
      },
    });
    expect(normalized.stageSwitches).toEqual({ sprint: false });
    expect(normalized.overrides.ci).toEqual({ maxRoundTrips: 5 });
    // A prompt override is kept even when it matches: it pins the text.
    expect(normalized.overrides.building).toHaveProperty("prompt");
    expect(normalized.overrides).not.toHaveProperty("nope");
  });

  it("hashes the delta only, whatever order its keys were built in", () => {
    const a = boardProjectConfigVersion({
      stageSwitches: { a: true, b: false },
      overrides: {},
      ci: { steps: [] },
    });
    const b = boardProjectConfigVersion({
      stageSwitches: { b: false, a: true },
      overrides: {},
      ci: { steps: [] },
    });
    expect(a).toBe(b);
    expect(a).not.toBe(EMPTY_BOARD_PROJECT_STAGE_CONFIG.version);
  });

  it("strips prompts and step bodies from the shell", () => {
    const shell = boardProjectStageConfigShell({
      ...EMPTY_BOARD_PROJECT_STAGE_CONFIG,
      overrides: { review: { prompt: "secret", rounds: 2, phases: { triage: { prompt: "p" } } } },
      ci: { steps: [script("a")] },
    });
    expect(shell.overrides).toEqual({ review: { rounds: 2, phases: { triage: {} } } });
    expect(shell.ciSteps).toEqual([{ id: "a", name: "a", kind: "script", parallel: false }]);
  });

  it("lists every new command and prompt for the import confirmation", () => {
    const texts = boardProjectDeltaNewTexts(
      { stageSwitches: {}, overrides: {}, ci: { steps: [script("a")] } },
      {
        stageSwitches: {},
        overrides: { building: { prompt: "Build carefully" } },
        ci: { steps: [script("a"), script("b")] },
      },
    );
    expect(texts).toEqual([
      { where: 'CI step "b"', kind: "command", text: "run b" },
      { where: "building", kind: "prompt", text: "Build carefully" },
    ]);
  });
});

describe("settings commands", () => {
  const command = {
    type: "board.project.set-stage-switch",
    commandId: "c1",
    projectId: "p1",
    stageId: "sprint",
    on: false,
    createdAt: "2026-01-01T00:00:00.000Z",
  };

  it("never decode through board.dispatchCommand", () => {
    expect(Schema.decodeUnknownOption(BoardClientCommand)(command)._tag).toBe("None");
    expect(Schema.decodeUnknownOption(BoardSettingsClientCommand)(command)._tag).toBe("Some");
    expect(Schema.decodeUnknownOption(BoardCommand)(command)._tag).toBe("Some");
    const stageCreate = {
      type: "board.stage.create",
      commandId: "c2",
      stageId: "qa",
      label: "QA",
      orderKey: "k",
      createdAt: "2026-01-01T00:00:00.000Z",
    };
    expect(Schema.decodeUnknownOption(BoardClientCommand)(stageCreate)._tag).toBe("None");
  });

  it("leave the actor for the server to stamp", () => {
    const decoded = Schema.decodeUnknownSync(BoardSettingsClientCommand)(command);
    expect("actor" in decoded).toBe(false);
  });
});
