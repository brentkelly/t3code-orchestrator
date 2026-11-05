/**
 * T3o per-project pipelines on the board (T3O-43): which columns a view draws,
 * what each header says about who uses it, and the Pipelines grid.
 */
import {
  BOARD_SEED_STAGES,
  BOARD_SEED_STAGE_IDS,
  ProjectId,
  resolveT3oProjectFile,
  type BoardStageView,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  boardCardPipelineStages,
  boardCardStageGoneNotes,
  boardPipelineColumns,
  boardPipelinesGrid,
} from "./boardProjectPipelines";

const NOW = "2026-01-01T00:00:00.000Z";
const advisor = { id: ProjectId.make("advisor"), title: "core.agent.advisor" };
const web = { id: ProjectId.make("web"), title: "mesh.web" };
const relay = { id: ProjectId.make("relay"), title: "mesh.relay" };

/** A view where `web` removes Sprint and adds QA after Building, and `relay`
    keeps the global pipeline. (Sprint is the one seed stage a project may
    remove: the rest hold a role or are where cards wait to build.) */
function makeView(cards: BoardStageView["cards"] = []): BoardStageView {
  const base = { cards: [], stages: BOARD_SEED_STAGES, nextCardNumberByProject: {} };
  const webFile = resolveT3oProjectFile({
    raw: {
      stages: { remove: ["sprint"], add: [{ id: "qa", label: "QA", after: "building" }] },
    },
    board: base,
    projectId: web.id,
    source: null,
    now: NOW,
  });
  const relayFile = resolveT3oProjectFile({
    raw: {},
    board: base,
    projectId: relay.id,
    source: null,
    now: NOW,
  });
  return {
    stages: [...BOARD_SEED_STAGES, ...webFile.stages],
    projectStageConfigs: { [web.id]: webFile.config, [relay.id]: relayFile.config },
    cards,
  };
}

const summary = (columns: ReturnType<typeof boardPipelineColumns>) =>
  columns.map((column) => `${column.stage.label}:${column.kind}:${column.hint ?? ""}`);

describe("boardPipelineColumns", () => {
  it("draws the union of the projects' pipelines in global order, annotating partial stages", () => {
    const columns = boardPipelineColumns({
      view: makeView(),
      projects: [advisor, web, relay],
      occupiedStageIds: new Set(),
    });
    expect(summary(columns)).toEqual([
      "Backlog:shared:",
      "Sprint:partial:Not in mesh.web",
      "Planning:shared:",
      "Ready:shared:",
      "Building:shared:",
      "QA:project-added:Only mesh.web",
      "Code review:shared:",
      "Ready for merge:shared:",
      "Done:shared:",
    ]);
    expect(columns[1]!.usedBy).toEqual([advisor, relay]);
  });

  it("drops a stage no project in view uses, unless a card still holds it", () => {
    const projects = [web];
    const empty = boardPipelineColumns({
      view: makeView(),
      projects,
      occupiedStageIds: new Set(),
    });
    expect(empty.map((column) => column.stage.stageId)).not.toContain("sprint");

    const occupied = boardPipelineColumns({
      view: makeView([{ stage: BOARD_SEED_STAGE_IDS.sprint, projectId: web.id }]),
      projects,
      occupiedStageIds: new Set(["sprint"]),
    });
    const sprint = occupied.find((column) => column.stage.stageId === "sprint");
    expect(sprint?.kind).toBe("removed");
    expect(sprint?.hint).toContain("Removed from this project's pipeline");
  });

  it("says a single project's own stage came from its t3o.json", () => {
    const columns = boardPipelineColumns({
      view: makeView(),
      projects: [web],
      occupiedStageIds: new Set(),
    });
    expect(summary(columns)).toContain("QA:project-added:Added in this project's t3o.json");
    expect(columns.map((column) => column.stage.stageId)).not.toContain("sprint");
  });

  it("is the global pipeline with no project in view", () => {
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

  it("draws CI only for a project with CI on, listing its steps on a single-project board", () => {
    const base = { cards: [], stages: BOARD_SEED_STAGES, nextCardNumberByProject: {} };
    const ciFile = (enabled: boolean) =>
      resolveT3oProjectFile({
        raw: {
          stages: {
            settings: {
              ci: {
                enabled,
                steps: [
                  { name: "Typecheck", command: "bun run typecheck" },
                  { name: "Test", command: "bun run test" },
                ],
              },
            },
          },
        },
        board: base,
        projectId: advisor.id,
        source: null,
        now: NOW,
      }).config;
    const view = (enabled: boolean): BoardStageView => ({
      stages: BOARD_SEED_STAGES,
      projectStageConfigs: { [advisor.id]: ciFile(enabled) },
      cards: [],
    });
    const single = summary(
      boardPipelineColumns({ view: view(true), projects: [advisor], occupiedStageIds: new Set() }),
    );
    expect(single).toContain("Continuous integration:shared:Typecheck · Test");
    expect(single.indexOf("Continuous integration:shared:Typecheck · Test")).toBe(
      single.indexOf("Code review:shared:") + 1,
    );
    expect(
      summary(
        boardPipelineColumns({
          view: view(true),
          projects: [advisor, web],
          occupiedStageIds: new Set(),
        }),
      ),
    ).toContain("Continuous integration:partial:Only core.agent.advisor");
    expect(
      boardPipelineColumns({
        view: view(false),
        projects: [advisor],
        occupiedStageIds: new Set(),
      }).map((column) => column.stage.stageId),
    ).not.toContain(BOARD_SEED_STAGE_IDS.ci);
  });
});

describe("boardCardStageGoneNotes", () => {
  it("notes a card whose project no longer uses its stage, and nothing otherwise", () => {
    const view = makeView([{ stage: BOARD_SEED_STAGE_IDS.sprint, projectId: web.id }]);
    const noteFor = boardCardStageGoneNotes(view, (projectId) =>
      projectId === web.id ? "mesh.web" : "x",
    );
    expect(noteFor({ stage: BOARD_SEED_STAGE_IDS.sprint, projectId: web.id })).toBe(
      "Sprint is no longer in mesh.web's pipeline",
    );
    expect(noteFor({ stage: BOARD_SEED_STAGE_IDS.sprint, projectId: relay.id })).toBeNull();
  });
});

describe("boardPipelinesGrid", () => {
  it("marks global, project-added and unused stages per project", () => {
    const grid = boardPipelinesGrid(makeView(), [advisor, web]);
    expect(grid.stages.map((stage) => stage.label)).toEqual([
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
    expect(grid.rows[0]!.cells[5]).toBe("unused");
    expect(grid.rows[1]!.cells.slice(1, 6)).toEqual([
      "unused",
      "global",
      "global",
      "global",
      "added",
    ]);
  });
});

describe("boardCardPipelineStages", () => {
  it("lists the card's own project's stages, keeping its retired stage", () => {
    const view = makeView();
    const stages = boardCardPipelineStages(view, {
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
    expect(stages.every((stage) => stage.projectId === null)).toBe(true);
  });
});
