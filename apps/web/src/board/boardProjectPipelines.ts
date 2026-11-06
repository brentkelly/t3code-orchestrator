/**
 * T3o per-project pipelines on the board (T3O-43/49): which columns a view
 * draws when its projects switch stages on or off, which projects each
 * column covers, and the Pipelines grid. Pure functions over the read model
 * the page already holds; coverage is computed once per render.
 */
import {
  BOARD_SEED_STAGE_IDS,
  boardAllStages,
  boardCiStepGroups,
  boardProjectStagesInOrder,
  boardProjectUsesStage,
  boardStageDefaultForProjects,
  compareBoardStages,
  type BoardCiStepShape,
  type BoardStageDefinition,
  type BoardStageView,
  type ProjectId,
} from "@t3tools/contracts";

export interface BoardPipelineProject {
  readonly id: ProjectId;
  readonly title: string;
}

/** Why a project does or doesn't run a stage: its default, or its own switch. */
export interface BoardStageCoverageEntry {
  readonly project: BoardPipelineProject;
  readonly how: "default" | "switched";
}

export interface BoardStageCoverage {
  readonly included: ReadonlyArray<BoardStageCoverageEntry>;
  readonly excluded: ReadonlyArray<BoardStageCoverageEntry>;
}

export type BoardPipelineColumnKind =
  /** Every project in view uses it. */
  | "shared"
  /** Some projects in view use it. */
  | "partial"
  /** No project in view uses it any more, but a card still sits in it. */
  | "retired";

export interface BoardPipelineColumn {
  readonly stage: BoardStageDefinition;
  readonly kind: BoardPipelineColumnKind;
  readonly coverage: BoardStageCoverage;
  /** The partial-stage icon's title, e.g. "2 of 3 projects · only mesh.web". */
  readonly partialTitle: string | null;
  /** The line under the header, or null when there is nothing to say. */
  readonly hint: string | null;
}

const nameList = (projects: ReadonlyArray<BoardPipelineProject>) =>
  projects.map((project) => project.title).join(", ");

function coverageOf(
  view: BoardStageView,
  stage: BoardStageDefinition,
  projects: ReadonlyArray<BoardPipelineProject>,
): BoardStageCoverage {
  const included: BoardStageCoverageEntry[] = [];
  const excluded: BoardStageCoverageEntry[] = [];
  for (const project of projects) {
    const switched = view.projectStageConfigs?.[project.id]?.stageSwitches[stage.stageId];
    const how = switched === undefined ? "default" : "switched";
    (boardProjectUsesStage(view, project.id, stage) ? included : excluded).push({ project, how });
  }
  return { included, excluded };
}

/** "N of M projects · only X" (or "not X" when fewer are missing). */
function boardPartialStageTitle(coverage: BoardStageCoverage): string {
  const total = coverage.included.length + coverage.excluded.length;
  const included = coverage.included.map((entry) => entry.project);
  const excluded = coverage.excluded.map((entry) => entry.project);
  const tail =
    included.length <= excluded.length ? `only ${nameList(included)}` : `not ${nameList(excluded)}`;
  return `${included.length} of ${total} projects · ${tail}`;
}

/** A CI step list as its run shape: "Typecheck ∥ Lint → Test". */
export function boardCiStepShapeLine(steps: ReadonlyArray<BoardCiStepShape>): string {
  return boardCiStepGroups(steps)
    .map((group) => group.map((step) => step.name).join(" ∥ "))
    .join(" → ");
}

/**
 * The columns a view draws: every stage a project in view uses, plus any stage
 * holding one of the view's cards, always in board order. With no project in
 * view, the stages on by default.
 */
export function boardPipelineColumns(input: {
  readonly view: BoardStageView;
  readonly projects: ReadonlyArray<BoardPipelineProject>;
  /** Stage ids holding a card the view shows. */
  readonly occupiedStageIds: ReadonlySet<string>;
}): ReadonlyArray<BoardPipelineColumn> {
  const { view, projects, occupiedStageIds } = input;
  const all = [...boardAllStages(view)].sort(compareBoardStages);
  const empty: BoardStageCoverage = { included: [], excluded: [] };
  if (projects.length === 0) {
    return all
      .filter(
        (stage) => boardProjectUsesStage(view, null, stage) || occupiedStageIds.has(stage.stageId),
      )
      .map((stage) => ({ stage, kind: "shared", coverage: empty, partialTitle: null, hint: null }));
  }
  const single = projects.length === 1 ? projects[0]! : null;
  const columns: Array<BoardPipelineColumn> = [];
  for (const stage of all) {
    const coverage = coverageOf(view, stage, projects);
    if (coverage.included.length === 0) {
      if (!occupiedStageIds.has(stage.stageId)) continue;
      columns.push({
        stage,
        kind: "retired",
        coverage,
        partialTitle: null,
        hint:
          single === null
            ? `Off for ${nameList(coverage.excluded.map((entry) => entry.project))}. Stays until its cards move on.`
            : `Switched off for ${single.title}. Shown until its last card moves on.`,
      });
      continue;
    }
    if (coverage.excluded.length > 0) {
      columns.push({
        stage,
        kind: "partial",
        coverage,
        partialTitle: boardPartialStageTitle(coverage),
        hint: null,
      });
      continue;
    }
    columns.push({
      stage,
      kind: "shared",
      coverage,
      partialTitle: null,
      hint: single === null ? null : singleProjectHint(view, stage, single),
    });
  }
  return columns;
}

/** The header line on a single-project board: CI's step shape, or a note on
    a stage the project switched on against its default. */
function singleProjectHint(
  view: BoardStageView,
  stage: BoardStageDefinition,
  project: BoardPipelineProject,
): string | null {
  const config = view.projectStageConfigs?.[project.id];
  if (stage.stageId === BOARD_SEED_STAGE_IDS.ci) {
    const steps =
      config === undefined ? [] : "ciSteps" in config ? config.ciSteps : config.ci.steps;
    return steps.length === 0 ? null : `Sync with base → ${boardCiStepShapeLine(steps)}`;
  }
  return config?.stageSwitches[stage.stageId] === true && !boardStageDefaultForProjects(stage)
    ? "Switched on for this project"
    : null;
}

/** A lookup for the note a card carries when its project switched off the
    stage it sits in, or null. */
export function boardCardStageGoneNotes(
  view: BoardStageView,
  projectTitle: (projectId: ProjectId) => string,
): (card: { readonly stage: string; readonly projectId: ProjectId }) => string | null {
  // One pipeline walk per project, not per card: the board calls this for every card.
  const retiredByProject = new Map<ProjectId, ReadonlyMap<string, string>>();
  return (card) => {
    let retired = retiredByProject.get(card.projectId);
    if (retired === undefined) {
      retired = new Map(
        boardProjectStagesInOrder(view, card.projectId)
          .filter((stage) => stage.retired)
          .map((stage) => [String(stage.stageId), stage.label]),
      );
      retiredByProject.set(card.projectId, retired);
    }
    const label = retired.get(card.stage);
    return label === undefined
      ? null
      : `${label} is switched off for ${projectTitle(card.projectId)}`;
  };
}

/** A Pipelines grid cell: on by default, switched on for the project, or not used. */
export type BoardPipelineCell = "default" | "switched" | "unused";

export interface BoardPipelinesGrid {
  readonly stages: ReadonlyArray<BoardStageDefinition>;
  readonly rows: ReadonlyArray<{
    readonly project: BoardPipelineProject;
    readonly cells: ReadonlyArray<BoardPipelineCell>;
  }>;
}

/** The Pipelines grid: projects against every stage any of them uses. */
export function boardPipelinesGrid(
  view: BoardStageView,
  projects: ReadonlyArray<BoardPipelineProject>,
): BoardPipelinesGrid {
  const stages = [...boardAllStages(view)]
    .sort(compareBoardStages)
    .filter((stage) => projects.some((project) => boardProjectUsesStage(view, project.id, stage)));
  return {
    stages,
    rows: projects.map((project) => ({
      project,
      cells: stages.map((stage): BoardPipelineCell => {
        if (!boardProjectUsesStage(view, project.id, stage)) return "unused";
        const switched = view.projectStageConfigs?.[project.id]?.stageSwitches[stage.stageId];
        return switched === true ? "switched" : "default";
      }),
    })),
  };
}

/**
 * One card's project pipeline as a bare stage list, for the detail pane's
 * stage section and every bare-list helper it feeds: the project's stages in
 * order, plus the card's own stage if it is retired.
 */
export function boardCardPipelineStages(
  view: Pick<BoardStageView, "stages" | "projectStageConfigs">,
  card: { readonly stage: string; readonly projectId: ProjectId },
): ReadonlyArray<BoardStageDefinition> {
  return boardProjectStagesInOrder({ ...view, cards: [card as never] }, card.projectId)
    .filter((stage) => !stage.retired || stage.stageId === card.stage)
    .map(({ retired: _retired, ...stage }) => stage);
}
