import { describe, expect, it } from "vite-plus/test";

import {
  BOARD_SEED_STAGES,
  BOARD_SEED_STAGE_IDS,
  BoardCardId,
  BoardProjectStageConfig,
  BoardStageId,
  DEFAULT_BOARD_SETTINGS,
  DEFAULT_BOARD_REVIEW_PHASES,
  EMPTY_BOARD_STATE,
  ProjectId,
  areBoardStagesAdjacent,
  boardCardMoveRefusal,
  boardGroupRevertStage,
  boardNextStageId,
  boardNewPhaseHeadingStage,
  boardProjectDeltasEqual,
  boardProjectFirstStageId,
  boardProjectStagesInOrder,
  isBoardReviewStageExecution,
  normalizeBoardProjectDelta,
  resolveBoardStageExecution,
  withBoardProjectConfigVersion,
  type BoardCard,
  type BoardState,
} from "./index.ts";
import * as Schema from "effect/Schema";
import {
  buildT3oProjectFile,
  parseT3oProjectFile,
  resolveT3oProjectFile,
} from "./t3oProjectFile.ts";

const NOW = "2026-01-01T00:00:00.000Z";
const projectA = ProjectId.make("project-a");
const projectB = ProjectId.make("project-b");

const resolve = (raw: unknown, board: BoardState = EMPTY_BOARD_STATE) =>
  resolveT3oProjectFile({ raw, board, projectId: projectA, now: NOW });

/** The board after a project imports a file, as the projector would. */
const withFile = (
  raw: unknown,
  cards: ReadonlyArray<Pick<BoardCard, "stage" | "projectId">> = [],
) => {
  const resolved = resolve(raw);
  return {
    ...EMPTY_BOARD_STATE,
    cards: cards.map((card, index) => ({
      ...card,
      id: BoardCardId.make(`card-${index}`),
      archivedAt: null,
    })) as unknown as ReadonlyArray<BoardCard>,
    stages: [...BOARD_SEED_STAGES, ...resolved.createStages],
    projectStageConfigs: {
      [projectA]: withBoardProjectConfigVersion({
        ...resolved.delta,
        dismissedImportSha: null,
        lastChangedBy: null,
      }),
    },
  } satisfies BoardState;
};

const ids = (board: BoardState, projectId: ProjectId | null) =>
  boardProjectStagesInOrder(board, projectId).map((stage) =>
    stage.retired ? `${stage.stageId}(retired)` : String(stage.stageId),
  );

const security = BoardStageId.make("security");
const decodeConfig = Schema.decodeSync(BoardProjectStageConfig);

describe("resolveT3oProjectFile", () => {
  it("decodes removals, additions and settings into a delta", () => {
    const { delta, createStages } = resolve({
      $schema: "x",
      stages: {
        remove: ["sprint"],
        add: [
          {
            id: "security",
            label: "Security review",
            after: "review",
            autoExecute: true,
            autoAdvance: true,
            prompt: "Check it",
          },
        ],
        settings: {
          review: { phases: { triage: { prompt: "Only touched areas" } } },
          building: { prompt: "Build it" },
          security: { timeoutMs: 1000 },
        },
      },
    });
    expect(delta.stageSwitches).toEqual({ sprint: false, security: true });
    expect(createStages).toHaveLength(1);
    expect(createStages[0]).toMatchObject({
      stageId: security,
      label: "Security review",
      projectId: projectA,
      defaultForProjects: false,
    });
    expect(createStages[0]!.orderKey > "l" && createStages[0]!.orderKey < "m").toBe(true);
    expect(delta.overrides).toEqual({
      review: { phases: { triage: { prompt: "Only touched areas" } } },
      building: { prompt: "Build it" },
      security: { autoExecute: true, autoAdvance: true, prompt: "Check it", timeoutMs: 1000 },
    });
    expect(delta.warnings).toEqual([]);
  });

  it("keeps the valid keys of a partial entry and warns about the rest", () => {
    const { delta } = resolve({
      stages: {
        settings: {
          building: { prompt: "ok", timeoutMs: -5, rounds: 3, label: "Make", kind: "review" },
          review: { rounds: 2, phases: { triage: { prompt: 7, model: null }, bogus: {} } },
          planning: { planReview: { enabledByDefault: true, nope: 1 } },
          nowhere: { prompt: "x" },
        },
      },
    });
    expect(delta.overrides).toEqual({
      building: { prompt: "ok" },
      review: { rounds: 2, phases: { triage: { model: null } } },
      planning: { planReview: { enabledByDefault: true } },
    });
    expect(delta.warnings).toEqual(
      expect.arrayContaining([
        expect.stringContaining("building.timeoutMs: invalid"),
        expect.stringContaining("building.rounds: not a setting of this stage"),
        expect.stringContaining("building.label: stage labels can't be overridden"),
        expect.stringContaining("building.kind: not a setting"),
        expect.stringContaining("phases.triage.prompt: invalid"),
        expect.stringContaining("phases.bogus: not a review phase"),
        expect.stringContaining("planReview.nope"),
        expect.stringContaining('"nowhere" is not a stage'),
      ]),
    );
  });

  it("ignores switching a role stage, the stage before build, or an unknown stage", () => {
    const { delta } = resolve({
      stages: { remove: ["review", "done", "nope", "backlog", "ready", 4], enable: ["sprint"] },
    });
    expect(delta.stageSwitches).toEqual({ backlog: false, sprint: true });
    expect(delta.warnings).toHaveLength(5);
    expect(delta.warnings.join("\n")).toContain("holds the review role");
    expect(delta.warnings.join("\n")).toContain("where cards wait to build");
  });

  it("places a stage after the stage before build, CI or merge just before CI instead", () => {
    const { createStages, delta } = resolve({
      stages: {
        add: [
          { id: "gate", label: "Gate", after: "ready" },
          { id: "late", label: "Late", after: "ci" },
          { id: "early", label: "Early", after: "planning" },
        ],
      },
    });
    const ci = BOARD_SEED_STAGES.find((stage) => stage.stageId === "ci")!;
    const review = BOARD_SEED_STAGES.find((stage) => stage.stageId === "review")!;
    for (const id of ["gate", "late"]) {
      const stage = createStages.find((candidate) => candidate.stageId === id)!;
      expect(stage.orderKey > review.orderKey && stage.orderKey < ci.orderKey).toBe(true);
    }
    expect(delta.warnings.join("\n")).toContain("where cards wait to build");
    expect(delta.warnings.join("\n")).toContain("nothing can come after Continuous integration");
    expect(delta.warnings).toHaveLength(2);
  });

  it("reuses a stage with the same id and label, and ignores one whose label differs", () => {
    const board = withFile({
      stages: { add: [{ id: "security", label: "Security", after: "review" }] },
    });
    const again = resolve(
      {
        stages: {
          add: [
            { id: "security", label: "Security", after: "review" },
            { id: "review", label: "Clash" },
          ],
        },
      },
      board,
    );
    expect(again.createStages).toEqual([]);
    expect(again.delta.stageSwitches).toEqual({ security: true });
    expect(again.delta.warnings.join("\n")).toContain("with a different label");
  });

  it("reuses a T3O-43 project stage under its namespaced id", () => {
    const legacy = BoardStageId.make(`${projectA}:qa`);
    const board: BoardState = {
      ...EMPTY_BOARD_STATE,
      stages: [
        ...BOARD_SEED_STAGES,
        {
          stageId: legacy,
          label: "QA",
          role: null,
          orderKey: "k",
          createdAt: NOW,
          updatedAt: NOW,
          projectId: projectA,
        },
      ],
    };
    const { delta, createStages } = resolve(
      { stages: { add: [{ id: "qa", label: "QA", after: "building" }] } },
      board,
    );
    expect(createStages).toEqual([]);
    expect(delta.stageSwitches).toEqual({ [legacy]: true });
  });

  it("drops bad additions with a warning and keeps the good ones", () => {
    const { delta, createStages } = resolve({
      stages: {
        add: [
          { id: "bad id!", label: "X", after: "building" },
          { id: "nolabel", after: "building" },
          { id: "ok", label: "OK", after: "building" },
          { id: "ok", label: "Twice", after: "building" },
        ],
      },
    });
    expect(createStages.map((stage) => stage.label)).toEqual(["OK"]);
    expect(delta.stageSwitches).toEqual({ ok: true });
    expect(delta.warnings).toHaveLength(3);
  });

  it("reads v1 CI steps as legacy-numbered scripts, and v2 steps with their ids", () => {
    const v1 = resolve({
      stages: { settings: { ci: { steps: [{ name: "Check", command: "x" }], maxFixAttempts: 1 } } },
    });
    expect(v1.delta.ci.steps).toEqual([
      {
        kind: "script",
        id: "legacy-0",
        name: "Check",
        parallel: false,
        command: "x",
        timeoutMinutes: 30,
      },
    ]);
    expect(v1.delta.stageSwitches.ci).toBe(true);
    expect(v1.delta.overrides.ci).toEqual({ maxFixAttempts: 1 });
    expect(v1.delta.warnings).toEqual([]);

    const v2 = resolve({
      version: 2,
      ci: {
        steps: [
          { kind: "script", id: "lint", name: "Lint", command: "vp lint" },
          { id: "types", name: "Types", command: "vp run typecheck", parallel: true },
          { kind: "agent", id: "audit", name: "Audit", prompt: "Look" },
        ],
      },
    });
    expect(v2.delta.ci.steps.map((step) => [step.id, step.parallel])).toEqual([
      ["lint", false],
      ["types", true],
    ]);
    expect(v2.delta.warnings.join("\n")).toContain("agent steps aren't supported");
  });

  it("ignores CI steps that are invalid or too long, with a warning", () => {
    const resolved = resolve({
      ci: {
        steps: [
          { name: "Check", command: "x", timeoutMinutes: 40_000 },
          { name: "Huge", command: "x".repeat(5_000) },
          { name: "Ok", command: "x", timeoutMinutes: 1_440 },
        ],
      },
    });
    expect(resolved.delta.ci.steps.map((step) => step.name)).toEqual(["Ok"]);
    expect(resolved.delta.warnings).toHaveLength(2);
  });

  it("treats a non-object file or block as empty with a warning", () => {
    expect(resolve([1]).delta.warnings[0]).toContain("must be a JSON object");
    expect(resolve({ stages: 3 }).delta.warnings[0]).toContain("stages: expected an object");
    expect(resolve(null).delta).toEqual({
      stageSwitches: {},
      overrides: {},
      ci: { steps: [] },
      warnings: [],
    });
    expect(parseT3oProjectFile("{ nope").warning).toContain("not valid JSON");
  });
});

describe("export", () => {
  it("round-trips a delta through a v2 file", () => {
    const board = withFile({
      stages: {
        remove: ["sprint"],
        add: [{ id: "security", label: "Security", after: "review", prompt: "Check" }],
        settings: { building: { prompt: "Build it" } },
      },
      ci: { steps: [{ id: "lint", name: "Lint", command: "vp lint" }] },
    });
    const config = board.projectStageConfigs[projectA]!;
    const file = buildT3oProjectFile({ board, config });
    expect(file).toMatchObject({
      version: 2,
      stages: { remove: ["sprint"] },
      ci: { enabled: true },
    });
    const back = resolve(JSON.parse(JSON.stringify(file)), board);
    expect(back.createStages).toEqual([]);
    expect(boardProjectDeltasEqual(back.delta, config)).toBe(true);
  });
});

describe("legacy configs", () => {
  it("upcast a T3O-43/44 config into a delta, and an unchanged v1 file matches it", () => {
    const legacyQa = BoardStageId.make(`${projectA}:qa`);
    const legacy = {
      removedStageIds: ["sprint"],
      addedStageIds: [legacyQa],
      overrides: { ci: { maxFixAttempts: 1, steps: [], enabled: true } },
      warnings: [],
      source: { path: "/repo/t3o.json", commitSha: "abc" },
      ci: { steps: [{ name: "Check", command: "x", timeoutMinutes: 30 }], active: true },
    };
    const config = decodeConfig(legacy as never);
    expect(config.stageSwitches).toEqual({ sprint: false, [legacyQa]: true, ci: true });
    expect(config.overrides).toEqual({ ci: { maxFixAttempts: 1 } });
    expect(config.ci.steps.map((step) => step.id)).toEqual(["legacy-0"]);
    expect(config.version).toMatch(/^[0-9a-f]{16}$/);

    const board: BoardState = {
      ...EMPTY_BOARD_STATE,
      stages: [
        ...BOARD_SEED_STAGES,
        {
          stageId: legacyQa,
          label: "QA",
          role: null,
          orderKey: "k",
          createdAt: NOW,
          updatedAt: NOW,
          projectId: projectA,
        },
      ],
      projectStageConfigs: { [projectA]: config },
    };
    const file = {
      stages: {
        remove: ["sprint"],
        add: [{ id: "qa", label: "QA", after: "building" }],
        settings: { ci: { steps: [{ name: "Check", command: "x" }], maxFixAttempts: 1 } },
      },
    };
    const reread = resolve(file, board);
    const normalize = <D extends Parameters<typeof boardProjectDeltasEqual>[0]>(delta: D) =>
      normalizeBoardProjectDelta({ board, settings: DEFAULT_BOARD_SETTINGS, delta });
    expect(boardProjectDeltasEqual(normalize(reread.delta), normalize(config))).toBe(true);
  });
});

describe("boardProjectFirstStageId", () => {
  it("starts a project that switched Backlog off in its next stage, and no one else", () => {
    const board = withFile({ stages: { remove: ["backlog"] } });
    expect(boardProjectFirstStageId(board, projectA)).toBe("sprint");
    expect(boardNewPhaseHeadingStage(board, false, projectA)).toBe("sprint");
    expect(boardProjectFirstStageId(board, projectB)).toBe(BOARD_SEED_STAGE_IDS.backlog);
    expect(boardProjectFirstStageId(board, null)).toBe(BOARD_SEED_STAGE_IDS.backlog);
  });
});

describe("boardProjectStagesInOrder", () => {
  const file = {
    stages: { remove: ["sprint"], add: [{ id: "security", label: "Security", after: "review" }] },
  };

  it("drops switched-off stages and adds stages made for the project, for that project only", () => {
    const board = withFile(file);
    expect(ids(board, projectA)).toEqual([
      "backlog",
      "planning",
      "ready",
      "building",
      "review",
      "security",
      "merge",
      "done",
    ]);
    // CI is in no pipeline whose project hasn't switched it on with steps.
    expect(ids(board, projectB)).toEqual(
      BOARD_SEED_STAGES.filter((stage) => stage.stageId !== "ci").map((stage) =>
        String(stage.stageId),
      ),
    );
    expect(ids(board, null)).toEqual(ids(board, projectB));
  });

  it("keeps a switched-off stage, retired, while a live card of the project sits in it", () => {
    const board = withFile(file, [{ stage: BOARD_SEED_STAGE_IDS.sprint, projectId: projectA }]);
    expect(ids(board, projectA)).toContain("sprint(retired)");
    const other = withFile(file, [{ stage: BOARD_SEED_STAGE_IDS.sprint, projectId: projectB }]);
    expect(ids(other, projectA)).not.toContain("sprint(retired)");
  });

  it("reaches every project when a stage's default is on, unless switched off", () => {
    const board = withFile(file);
    const shared: BoardState = {
      ...board,
      stages: board.stages.map((stage) =>
        stage.stageId === security ? { ...stage, defaultForProjects: true } : stage,
      ),
    };
    expect(ids(shared, projectB)).toContain("security");
    const off: BoardState = {
      ...shared,
      projectStageConfigs: {
        [projectA]: withBoardProjectConfigVersion({
          ...board.projectStageConfigs[projectA]!,
          stageSwitches: { security: false },
        }),
      },
    };
    expect(ids(off, projectA)).not.toContain("security");
  });

  it("walks next stage and adjacency per project, never into a retired stage", () => {
    const board = withFile(file, [{ stage: BOARD_SEED_STAGE_IDS.sprint, projectId: projectA }]);
    expect(boardNextStageId(board, BOARD_SEED_STAGE_IDS.backlog, projectA)).toBe("planning");
    expect(boardNextStageId(board, BOARD_SEED_STAGE_IDS.backlog, projectB)).toBe("sprint");
    expect(boardNextStageId(board, BOARD_SEED_STAGE_IDS.sprint, projectA)).toBe("planning");
    expect(boardNextStageId(board, BOARD_SEED_STAGE_IDS.review, projectA)).toBe(security);
    expect(areBoardStagesAdjacent(board, "backlog" as never, "planning" as never, projectA)).toBe(
      true,
    );
    expect(areBoardStagesAdjacent(board, "backlog" as never, "planning" as never, projectB)).toBe(
      false,
    );
  });
});

describe("boardGroupRevertStage per project", () => {
  const triage = BoardStageId.make("triage");
  const file = {
    stages: { remove: ["sprint"], add: [{ id: "triage", label: "Triage", after: "backlog" }] },
  };
  const revert = (board: BoardState, prevStage: BoardStageId, projectId: ProjectId) =>
    boardGroupRevertStage(board, {
      stage: BOARD_SEED_STAGE_IDS.building,
      group: { prevStage } as never,
      projectId,
    });

  it("reverts into a stage made for the project before planning", () => {
    expect(revert(withFile(file), triage, projectA)).toBe(triage);
  });

  it("caps at the stage before planning in the card's own pipeline", () => {
    expect(revert(withFile(file), BOARD_SEED_STAGE_IDS.ready, projectA)).toBe(triage);
    expect(revert(withFile(file), BOARD_SEED_STAGE_IDS.ready, projectB)).toBe("sprint");
  });

  it("never reverts into a stage the card's project switched off", () => {
    expect(revert(withFile(file), BOARD_SEED_STAGE_IDS.sprint, projectA)).toBe(triage);
  });
});

describe("boardCardMoveRefusal", () => {
  const board = withFile({
    stages: { remove: ["sprint"], add: [{ id: "security", label: "Security", after: "review" }] },
  });

  it("refuses a stage the card's project does not use, even with override", () => {
    const card = { stage: BOARD_SEED_STAGE_IDS.backlog, projectId: projectA };
    expect(
      boardCardMoveRefusal(board, card, BOARD_SEED_STAGE_IDS.sprint, {
        override: true,
        projectName: "Alpha",
      }),
    ).toBe("Sprint is off for Alpha.");
    const other = { stage: BOARD_SEED_STAGE_IDS.review, projectId: projectB };
    expect(boardCardMoveRefusal(board, other, security, { override: true })).toBe(
      "Security is off for this card's project.",
    );
  });

  it("refuses a retired stage, and a skip without override", () => {
    const occupied = withFile({ stages: { remove: ["sprint"] } }, [
      { stage: BOARD_SEED_STAGE_IDS.sprint, projectId: projectA },
    ]);
    const card = { stage: BOARD_SEED_STAGE_IDS.backlog, projectId: projectA };
    expect(
      boardCardMoveRefusal(occupied, card, BOARD_SEED_STAGE_IDS.sprint, { override: true }),
    ).toBe(
      "Sprint is switched off for this card's project. Move the card on; the column goes once it's empty.",
    );
    expect(
      boardCardMoveRefusal(board, card, BOARD_SEED_STAGE_IDS.ready, { override: false }),
    ).toContain("is not adjacent");
    expect(boardCardMoveRefusal(board, card, BOARD_SEED_STAGE_IDS.ready, { override: true })).toBe(
      null,
    );
    expect(
      boardCardMoveRefusal(board, card, BOARD_SEED_STAGE_IDS.planning, { override: false }),
    ).toBe(null);
    expect(boardCardMoveRefusal(board, card, BoardStageId.make("gone"), { override: true })).toBe(
      "Stage 'gone' does not exist.",
    );
  });
});

describe("resolveBoardStageExecution with a project config", () => {
  it("merges the project's partial field by field over the global member", () => {
    const { delta: config } = resolve({
      stages: {
        settings: {
          review: { rounds: 7, phases: { triage: { prompt: "Targeted" } } },
          building: { prompt: "Project build", submit: { prompt: "Project submit" } },
        },
      },
    });
    const review = resolveBoardStageExecution(
      DEFAULT_BOARD_SETTINGS,
      BOARD_SEED_STAGE_IDS.review,
      config,
    );
    expect(isBoardReviewStageExecution(review) && review.rounds).toBe(7);
    if (!isBoardReviewStageExecution(review)) throw new Error("review member expected");
    expect(review.phases.triage.prompt).toBe("Targeted");
    expect(review.phases.triage.timeoutMs).toBe(DEFAULT_BOARD_REVIEW_PHASES.triage.timeoutMs);
    expect(review.phases.review).toEqual(DEFAULT_BOARD_REVIEW_PHASES.review);

    const building = resolveBoardStageExecution(
      DEFAULT_BOARD_SETTINGS,
      BOARD_SEED_STAGE_IDS.building,
      config,
    );
    expect(building.prompt).toBe("Project build");
    expect(building.kind === "build" && building.submit.prompt).toBe("Project submit");
    expect(
      resolveBoardStageExecution(DEFAULT_BOARD_SETTINGS, BOARD_SEED_STAGE_IDS.building),
    ).not.toHaveProperty("prompt", "Project build");
  });

  it("re-applies the forced invariants over the project's values", () => {
    const { delta: config } = resolve({
      stages: {
        settings: {
          review: { mode: "plan", humanInLoop: true },
          merge: { autoExecute: true, mode: "plan", strategy: "rebase" },
          planning: { mode: "build", humanInLoop: false },
        },
      },
    });
    const review = resolveBoardStageExecution(DEFAULT_BOARD_SETTINGS, "review" as never, config);
    expect([review.mode, review.humanInLoop]).toEqual(["build", false]);
    const merge = resolveBoardStageExecution(DEFAULT_BOARD_SETTINGS, "merge" as never, config);
    expect([merge.autoExecute, merge.mode]).toEqual([false, "build"]);
    expect(merge.kind === "merge" && merge.strategy).toBe("rebase");
    const planning = resolveBoardStageExecution(
      DEFAULT_BOARD_SETTINGS,
      "planning" as never,
      config,
    );
    expect([planning.mode, planning.humanInLoop]).toEqual(["plan", true]);
  });

  it("resolves a stage made for the project from the simple defaults plus its file fields", () => {
    const { delta, createStages } = resolve({
      stages: {
        add: [{ id: "qa", label: "QA", after: "building", autoExecute: true, prompt: "QA it" }],
      },
    });
    const exec = resolveBoardStageExecution(
      DEFAULT_BOARD_SETTINGS,
      createStages[0]!.stageId,
      delta,
    );
    expect(exec).toMatchObject({ kind: "simple", autoExecute: true, prompt: "QA it" });
  });
});
