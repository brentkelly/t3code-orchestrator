/**
 * T3o per-project pipelines on the board: which columns a view
 * draws, which projects each covers.
 */
import {
  BOARD_SEED_STAGES,
  BOARD_SEED_STAGE_IDS,
  EMPTY_BOARD_PROJECT_STAGE_CONFIG,
  ProjectId,
  boardProjectStageConfigShell,
  resolveT3oProjectFile,
  withBoardProjectConfigVersion,
  type BoardStageView,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  boardCardPipelineStages,
  boardCardStageGoneNotes,
  boardCiStepShapeLine,
  boardPipelineColumns,
} from "./boardProjectPipelines";

const NOW = "2026-01-01T00:00:00.000Z";
const advisor = { id: ProjectId.make("advisor"), title: "core.agent.advisor" };
const web = { id: ProjectId.make("web"), title: "mesh.web" };
const relay = { id: ProjectId.make("relay"), title: "mesh.relay" };

const shellFrom = (raw: unknown, projectId: ProjectId) => {
  const base = { cards: [], stages: BOARD_SEED_STAGES, nextCardNumberByProject: {} };
  const resolved = resolveT3oProjectFile({ raw, board: base, projectId, now: NOW });
  return {
    stages: resolved.createStages,
    shell: boardProjectStageConfigShell(
      withBoardProjectConfigVersion({
        ...resolved.delta,
        dismissedImportSha: null,
        lastChangedBy: null,
      }),
    ),
  };
};

/** `web` switches Sprint off and has QA made for it after Building; `relay`
    follows the defaults. The client holds shell configs. */
function makeView(cards: BoardStageView["cards"] = []): BoardStageView {
  const webFile = shellFrom(
    { stages: { remove: ["sprint"], add: [{ id: "qa", label: "QA", after: "building" }] } },
    web.id,
  );
  return {
    stages: [...BOARD_SEED_STAGES, ...webFile.stages],
    projectStageConfigs: {
      [web.id]: webFile.shell,
      [relay.id]: boardProjectStageConfigShell(EMPTY_BOARD_PROJECT_STAGE_CONFIG),
    },
    cards,
  };
}

const summary = (columns: ReturnType<typeof boardPipelineColumns>) =>
  columns.map(
    (column) => `${column.stage.label}:${column.kind}:${column.partialTitle ?? column.hint ?? ""}`,
  );

describe("boardPipelineColumns", () => {
  it("draws the union of the projects' pipelines in board order, flagging partial stages", () => {
    const columns = boardPipelineColumns({
      view: makeView(),
      projects: [advisor, web, relay],
      occupiedStageIds: new Set(),
    });
    expect(summary(columns)).toEqual([
      "Backlog:shared:",
      "Sprint:partial:2 of 3 projects · not mesh.web",
      "Planning:shared:",
      "Ready:shared:",
      "Building:shared:",
      "QA:partial:1 of 3 projects · only mesh.web",
      "Code review:shared:",
      "Ready for merge:shared:",
      "Done:shared:",
    ]);
    expect(columns[5]!.coverage.included).toEqual([{ project: web, how: "switched" }]);
    expect(columns[5]!.coverage.excluded.map((entry) => entry.how)).toEqual(["default", "default"]);
  });

  it("drops a stage no project in view uses, unless a card still holds it", () => {
    const empty = boardPipelineColumns({
      view: makeView(),
      projects: [web],
      occupiedStageIds: new Set(),
    });
    expect(empty.map((column) => column.stage.stageId)).not.toContain("sprint");

    const occupied = boardPipelineColumns({
      view: makeView([{ stage: BOARD_SEED_STAGE_IDS.sprint, projectId: web.id }]),
      projects: [web],
      occupiedStageIds: new Set(["sprint"]),
    });
    const sprint = occupied.find((column) => column.stage.stageId === "sprint");
    expect(sprint?.kind).toBe("retired");
    expect(sprint?.hint).toBe("Switched off for mesh.web. Shown until its last card moves on.");
  });

  it("notes a stage a single project switched on against its default", () => {
    const columns = boardPipelineColumns({
      view: makeView(),
      projects: [web],
      occupiedStageIds: new Set(),
    });
    expect(summary(columns)).toContain("QA:shared:Switched on for this project");
  });

  it("is the default pipeline with no project in view", () => {
    const columns = boardPipelineColumns({
      view: makeView(),
      projects: [],
      occupiedStageIds: new Set(),
    });
    expect(columns.map((column) => column.stage.stageId)).toEqual(
      BOARD_SEED_STAGES.filter((stage) => stage.stageId !== BOARD_SEED_STAGE_IDS.ci).map(
        (stage) => stage.stageId,
      ),
    );
  });

  it("draws CI only for a project with CI on, with its step shape on a single-project board", () => {
    const view = (enabled: boolean): BoardStageView => ({
      stages: BOARD_SEED_STAGES,
      projectStageConfigs: {
        [advisor.id]: shellFrom(
          {
            ci: {
              enabled,
              steps: [
                { id: "types", name: "Typecheck", command: "bun run typecheck" },
                { id: "lint", name: "Lint", command: "bun run lint", parallel: true },
                { id: "test", name: "Test", command: "bun run test" },
              ],
            },
          },
          advisor.id,
        ).shell,
      },
      cards: [],
    });
    const single = summary(
      boardPipelineColumns({ view: view(true), projects: [advisor], occupiedStageIds: new Set() }),
    );
    expect(single).toContain(
      "Continuous integration:shared:Sync with base → Typecheck ∥ Lint → Test",
    );
    expect(
      summary(
        boardPipelineColumns({
          view: view(true),
          projects: [advisor, web],
          occupiedStageIds: new Set(),
        }),
      ),
    ).toContain("Continuous integration:partial:1 of 2 projects · only core.agent.advisor");
    expect(
      boardPipelineColumns({
        view: view(false),
        projects: [advisor],
        occupiedStageIds: new Set(),
      }).map((column) => column.stage.stageId),
    ).not.toContain(BOARD_SEED_STAGE_IDS.ci);
  });
});

describe("boardCiStepShapeLine", () => {
  it("joins parallel scripts with ∥ and groups with →", () => {
    expect(
      boardCiStepShapeLine([
        { id: "a", name: "A", kind: "script", parallel: false },
        { id: "b", name: "B", kind: "script", parallel: true },
        { id: "c", name: "C", kind: "agent", parallel: false },
      ]),
    ).toBe("A ∥ B → C");
  });
});

describe("boardCardStageGoneNotes", () => {
  it("notes a card whose project switched its stage off, and nothing otherwise", () => {
    const view = makeView([{ stage: BOARD_SEED_STAGE_IDS.sprint, projectId: web.id }]);
    const noteFor = boardCardStageGoneNotes(view, (projectId) =>
      projectId === web.id ? "mesh.web" : "x",
    );
    expect(noteFor({ stage: BOARD_SEED_STAGE_IDS.sprint, projectId: web.id })).toBe(
      "Sprint is switched off for mesh.web",
    );
    expect(noteFor({ stage: BOARD_SEED_STAGE_IDS.sprint, projectId: relay.id })).toBeNull();
  });
});

describe("boardCardPipelineStages", () => {
  it("lists the card's own project's stages, keeping its retired stage", () => {
    const stages = boardCardPipelineStages(makeView(), {
      stage: BOARD_SEED_STAGE_IDS.sprint,
      projectId: web.id,
    });
    expect(stages.map((stage) => stage.label)).toEqual([
      "Backlog",
      "Sprint",
      "Planning",
      "Ready",
      "Building",
      "QA",
      "Code review",
      "Ready for merge",
      "Done",
    ]);
  });
});
