import { describe, expect, it } from "vite-plus/test";

import {
  BOARD_SEED_STAGES,
  BOARD_SEED_STAGE_IDS,
  BoardCardId,
  BoardStageId,
  DEFAULT_BOARD_SETTINGS,
  DEFAULT_BOARD_REVIEW_PHASES,
  EMPTY_BOARD_STATE,
  ProjectId,
  areBoardStagesAdjacent,
  boardCardMoveRefusal,
  boardGroupRevertStage,
  boardNextStageId,
  boardProjectStageId,
  boardProjectStagesInOrder,
  isBoardReviewStageExecution,
  planBoardProjectStageConfig,
  resolveBoardStageExecution,
  type BoardCard,
  type BoardState,
} from "./index.ts";
import { parseT3oProjectFile, resolveT3oProjectFile } from "./t3oProjectFile.ts";

const NOW = "2026-01-01T00:00:00.000Z";
const projectA = ProjectId.make("project-a");
const projectB = ProjectId.make("project-b");
const source = { path: "/repo/t3o.json", commitSha: "abc" };

const resolve = (raw: unknown, board: BoardState = EMPTY_BOARD_STATE) =>
  resolveT3oProjectFile({ raw, board, projectId: projectA, source, now: NOW });

/** The board after a project's file is applied, as the projector would. */
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
    stages: [...BOARD_SEED_STAGES, ...resolved.stages],
    projectStageConfigs: { [projectA]: resolved.config },
  } satisfies BoardState;
};

const ids = (board: BoardState, projectId: ProjectId | null) =>
  boardProjectStagesInOrder(board, projectId).map((stage) =>
    stage.retired ? `${stage.stageId}(retired)` : String(stage.stageId),
  );

describe("resolveT3oProjectFile", () => {
  it("decodes removals, additions and settings", () => {
    const { config, stages } = resolve({
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
    const security = boardProjectStageId(projectA, "security");
    expect(config.removedStageIds).toEqual(["sprint"]);
    expect(config.addedStageIds).toEqual([security]);
    expect(stages).toHaveLength(1);
    expect(stages[0]).toMatchObject({
      stageId: security,
      label: "Security review",
      projectId: projectA,
    });
    expect(stages[0]!.orderKey > "l" && stages[0]!.orderKey < "n").toBe(true);
    expect(config.overrides).toEqual({
      review: { phases: { triage: { prompt: "Only touched areas" } } },
      building: { prompt: "Build it" },
      [security]: { autoExecute: true, autoAdvance: true, prompt: "Check it", timeoutMs: 1000 },
    });
    expect(config.warnings).toEqual([]);
    expect(config.source).toEqual(source);
  });

  it("keeps the valid keys of a partial entry and warns about the rest", () => {
    const { config } = resolve({
      stages: {
        settings: {
          building: { prompt: "ok", timeoutMs: -5, rounds: 3, label: "Make", kind: "review" },
          review: { rounds: 2, phases: { triage: { prompt: 7, model: null }, bogus: {} } },
          planning: { planReview: { enabledByDefault: true, nope: 1 } },
          nowhere: { prompt: "x" },
        },
      },
    });
    expect(config.overrides).toEqual({
      building: { prompt: "ok" },
      review: { rounds: 2, phases: { triage: { model: null } } },
      planning: { planReview: { enabledByDefault: true } },
    });
    expect(config.warnings).toEqual(
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

  it("ignores removing a role stage or an unknown stage", () => {
    const { config } = resolve({ stages: { remove: ["review", "done", "nope", "backlog", 4] } });
    expect(config.removedStageIds).toEqual(["backlog"]);
    expect(config.warnings).toHaveLength(4);
    expect(config.warnings.join("\n")).toContain("holds the review role");
  });

  it("keeps the stage before build: it can't be removed or have a stage put after it", () => {
    const { config, stages } = resolve({
      stages: {
        remove: ["ready"],
        add: [
          { id: "gate", label: "Gate", after: "ready" },
          { id: "chained", label: "Chained", after: "gate" },
          { id: "early", label: "Early", after: "planning" },
        ],
      },
    });
    expect(config.removedStageIds).toEqual([]);
    expect(stages.map((stage) => stage.label)).toEqual(["Early"]);
    expect(config.warnings.join("\n")).toContain("where cards wait to build and can't be removed");
    expect(config.warnings.join("\n")).toContain("can't come after Ready, where cards wait");
    expect(config.warnings).toHaveLength(3);
  });

  it("drops bad additions with a warning and keeps the good ones", () => {
    const { config, stages } = resolve({
      stages: {
        add: [
          { id: "review", label: "Clash", after: "building" },
          { id: "bad id!", label: "X", after: "building" },
          { id: "nolabel", after: "building" },
          { id: "orphan", label: "Orphan", after: "missing" },
          { id: "last", label: "Last", after: "done" },
          { id: "ok", label: "OK", after: "building" },
          { id: "ok", label: "Twice", after: "building" },
        ],
      },
    });
    expect(stages.map((stage) => stage.label)).toEqual(["OK"]);
    expect(config.addedStageIds).toEqual([boardProjectStageId(projectA, "ok")]);
    expect(config.warnings).toHaveLength(6);
  });

  it("places chained and sibling additions in file order", () => {
    const { stages } = resolve({
      stages: {
        add: [
          { id: "a", label: "A", after: "review" },
          { id: "b", label: "B", after: "review" },
          { id: "c", label: "C", after: "a" },
        ],
      },
    });
    const board = { ...EMPTY_BOARD_STATE, stages: [...BOARD_SEED_STAGES, ...stages] };
    const order = [...board.stages]
      .sort((left, right) => (left.orderKey < right.orderKey ? -1 : 1))
      .map((stage) => String(stage.stageId).replace(`${projectA}:`, ""));
    expect(order.slice(order.indexOf("review"), order.indexOf("merge") + 1)).toEqual([
      "review",
      "a",
      "c",
      "b",
      // The CI seed (T3O-44) sits between review and merge on every board.
      "ci",
      "merge",
    ]);
  });

  it("ignores CI steps whose timeout is past a day, with a warning", () => {
    const resolved = resolve({
      stages: {
        settings: { ci: { steps: [{ name: "Check", command: "x", timeoutMinutes: 40_000 }] } },
      },
    });
    expect(resolved.config.ci).toBeNull();
    expect(resolved.config.warnings.join("\n")).toContain("stages.settings.ci");
    expect(
      resolve({
        stages: {
          settings: { ci: { steps: [{ name: "Check", command: "x", timeoutMinutes: 1_440 }] } },
        },
      }).config.ci?.steps[0]?.timeoutMinutes,
    ).toBe(1_440);
  });

  it("treats a non-object file or block as empty with a warning", () => {
    expect(resolve([1]).config.warnings[0]).toContain("must be a JSON object");
    expect(resolve({ stages: 3 }).config.warnings[0]).toContain("stages: expected an object");
    expect(resolve(null).config).toEqual({
      removedStageIds: [],
      addedStageIds: [],
      overrides: {},
      warnings: [],
      source,
      ci: null,
    });
    expect(parseT3oProjectFile("{ nope").warning).toContain("not valid JSON");
  });
});

describe("boardProjectStagesInOrder", () => {
  const security = boardProjectStageId(projectA, "security");
  const file = {
    stages: { remove: ["sprint"], add: [{ id: "security", label: "Security", after: "review" }] },
  };

  it("drops removed stages and adds the project's own, for that project only", () => {
    const board = withFile(file);
    expect(ids(board, projectA)).toEqual([
      "backlog",
      "planning",
      "ready",
      "building",
      "review",
      String(security),
      "merge",
      "done",
    ]);
    // CI (T3O-44) is in no pipeline whose project has no CI steps.
    expect(ids(board, projectB)).toEqual(
      BOARD_SEED_STAGES.filter((stage) => stage.stageId !== "ci").map((stage) =>
        String(stage.stageId),
      ),
    );
    expect(ids(board, null)).toEqual(ids(board, projectB));
  });

  it("keeps a removed stage, retired, while a live card of the project sits in it", () => {
    const board = withFile(file, [{ stage: BOARD_SEED_STAGE_IDS.sprint, projectId: projectA }]);
    expect(ids(board, projectA)).toContain("sprint(retired)");
    // Another project's card in Sprint does not resurrect it for A.
    const other = withFile(file, [{ stage: BOARD_SEED_STAGE_IDS.sprint, projectId: projectB }]);
    expect(ids(other, projectA)).not.toContain("sprint(retired)");
  });

  it("keeps an added stage that left the file, retired, while occupied", () => {
    const board = withFile(file, [{ stage: security, projectId: projectA }]);
    const shrunk: BoardState = {
      ...board,
      projectStageConfigs: {
        [projectA]: { ...board.projectStageConfigs[projectA]!, addedStageIds: [] },
      },
    };
    expect(ids(shrunk, projectA)).toContain(`${security}(retired)`);
    const empty = { ...shrunk, cards: [] };
    expect(ids(empty, projectA)).not.toContain(String(security));
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
  const triage = boardProjectStageId(projectA, "triage");
  const file = {
    stages: { remove: ["sprint"], add: [{ id: "triage", label: "Triage", after: "backlog" }] },
  };
  const revert = (board: BoardState, prevStage: BoardStageId, projectId: ProjectId) =>
    boardGroupRevertStage(board, {
      stage: BOARD_SEED_STAGE_IDS.building,
      group: { prevStage } as never,
      projectId,
    });

  it("reverts into a project-owned stage before planning without crashing", () => {
    expect(revert(withFile(file), triage, projectA)).toBe(triage);
  });

  it("caps at the stage before planning in the card's own pipeline", () => {
    // Sprint is removed for A, so A's cap is its own Triage stage.
    expect(revert(withFile(file), BOARD_SEED_STAGE_IDS.ready, projectA)).toBe(triage);
    expect(revert(withFile(file), BOARD_SEED_STAGE_IDS.ready, projectB)).toBe("sprint");
  });

  it("never reverts into a stage the card's project removed", () => {
    expect(revert(withFile(file), BOARD_SEED_STAGE_IDS.sprint, projectA)).toBe(triage);
  });
});

describe("boardCardMoveRefusal", () => {
  const board = withFile({
    stages: { remove: ["sprint"], add: [{ id: "security", label: "Security", after: "review" }] },
  });
  const security = boardProjectStageId(projectA, "security");

  it("refuses a stage the card's project does not use, even with override", () => {
    const card = { stage: BOARD_SEED_STAGE_IDS.backlog, projectId: projectA };
    expect(boardCardMoveRefusal(board, card, BOARD_SEED_STAGE_IDS.sprint, { override: true })).toBe(
      "This card's project doesn't use the Sprint stage.",
    );
    const other = { stage: BOARD_SEED_STAGE_IDS.review, projectId: projectB };
    expect(boardCardMoveRefusal(board, other, security, { override: true })).toBe(
      "Security belongs to another project's pipeline.",
    );
  });

  it("refuses a retired stage, and a skip without override", () => {
    const occupied = withFile({ stages: { remove: ["sprint"] } }, [
      { stage: BOARD_SEED_STAGE_IDS.sprint, projectId: projectA },
    ]);
    const card = { stage: BOARD_SEED_STAGE_IDS.backlog, projectId: projectA };
    expect(
      boardCardMoveRefusal(occupied, card, BOARD_SEED_STAGE_IDS.sprint, { override: true }),
    ).toBe("This card's project no longer uses the Sprint stage.");
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
    const { config } = resolve({
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
    // The untouched parts of the phase and the other phases keep the global values.
    expect(review.phases.triage.timeoutMs).toBe(DEFAULT_BOARD_REVIEW_PHASES.triage.timeoutMs);
    expect(review.phases.review).toEqual(DEFAULT_BOARD_REVIEW_PHASES.review);

    const building = resolveBoardStageExecution(
      DEFAULT_BOARD_SETTINGS,
      BOARD_SEED_STAGE_IDS.building,
      config,
    );
    expect(building.prompt).toBe("Project build");
    expect(building.kind === "build" && building.submit.prompt).toBe("Project submit");
    // Without the project config, nothing changes.
    expect(
      resolveBoardStageExecution(DEFAULT_BOARD_SETTINGS, BOARD_SEED_STAGE_IDS.building),
    ).not.toHaveProperty("prompt", "Project build");
  });

  it("re-applies the forced invariants over the project's values", () => {
    const { config } = resolve({
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

  it("resolves a project-added stage from the simple defaults plus its file fields", () => {
    const { config, stages } = resolve({
      stages: {
        add: [{ id: "qa", label: "QA", after: "building", autoExecute: true, prompt: "QA it" }],
      },
    });
    const exec = resolveBoardStageExecution(DEFAULT_BOARD_SETTINGS, stages[0]!.stageId, config);
    expect(exec).toMatchObject({ kind: "simple", autoExecute: true, prompt: "QA it" });
  });
});

describe("planBoardProjectStageConfig", () => {
  it("is empty for an unchanged config and drops only unoccupied undeclared rows", () => {
    const resolved = resolve({ stages: { add: [{ id: "qa", label: "QA", after: "building" }] } });
    const board = withFile({ stages: { add: [{ id: "qa", label: "QA", after: "building" }] } });
    const same = planBoardProjectStageConfig({
      board,
      projectId: projectA,
      config: resolved.config,
      stages: resolved.stages,
    });
    expect(same).toEqual({ configChanged: false, upserts: [], deletedStageIds: [] });

    const cleared = resolve({});
    const dropped = planBoardProjectStageConfig({
      board,
      projectId: projectA,
      config: cleared.config,
      stages: cleared.stages,
    });
    expect(dropped.deletedStageIds).toEqual([boardProjectStageId(projectA, "qa")]);

    const held = withFile({ stages: { add: [{ id: "qa", label: "QA", after: "building" }] } }, [
      { stage: boardProjectStageId(projectA, "qa"), projectId: projectA },
    ]);
    expect(
      planBoardProjectStageConfig({
        board: held,
        projectId: projectA,
        config: cleared.config,
        stages: cleared.stages,
      }).deletedStageIds,
    ).toEqual([]);
  });
});
