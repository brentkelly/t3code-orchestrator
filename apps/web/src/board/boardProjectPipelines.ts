/**
 * T3o per-project pipelines on the board (T3O-43): which columns a view draws
 * when its projects' `t3o.json` files add or remove stages, what each column's
 * header says about who uses it, and the Pipelines grid. Pure functions over
 * the read model the page already holds.
 */
import {
  boardAllStages,
  boardProjectStagesInOrder,
  compareBoardStages,
  type BoardStageDefinition,
  type BoardStageView,
  type ProjectId,
} from "@t3tools/contracts";

export interface BoardPipelineProject {
  readonly id: ProjectId;
  readonly title: string;
}

export type BoardPipelineColumnKind =
  /** Every project in view uses it. */
  | "shared"
  /** Some projects in view use it; `usedBy` names them. */
  | "partial"
  /** A project's own stage, from its `t3o.json`. */
  | "project-added"
  /** No project in view uses it any more, but a card still sits in it. */
  | "removed";

export interface BoardPipelineColumn {
  readonly stage: BoardStageDefinition;
  readonly kind: BoardPipelineColumnKind;
  /** The projects in view that use the stage, when not all of them do. */
  readonly usedBy: ReadonlyArray<BoardPipelineProject>;
  /** The line under the header, or null when there is nothing to say. */
  readonly hint: string | null;
}

const nameList = (projects: ReadonlyArray<BoardPipelineProject>) =>
  projects.map((project) => project.title).join(", ");

/** Which projects in view use each stage — retired stages do not count. */
function stageUsers(
  view: BoardStageView,
  projects: ReadonlyArray<BoardPipelineProject>,
): Map<string, Array<BoardPipelineProject>> {
  const users = new Map<string, Array<BoardPipelineProject>>();
  for (const project of projects) {
    for (const stage of boardProjectStagesInOrder(view, project.id)) {
      if (stage.retired) continue;
      const list = users.get(stage.stageId) ?? [];
      list.push(project);
      users.set(stage.stageId, list);
    }
  }
  return users;
}

/**
 * The columns a view draws: every stage a project in view uses, plus any stage
 * holding one of the view's cards, always in global pipeline order. With no
 * project in view, the global pipeline.
 */
export function boardPipelineColumns(input: {
  readonly view: BoardStageView;
  readonly projects: ReadonlyArray<BoardPipelineProject>;
  /** Stage ids holding a card the view shows. */
  readonly occupiedStageIds: ReadonlySet<string>;
}): ReadonlyArray<BoardPipelineColumn> {
  const { view, projects, occupiedStageIds } = input;
  const all = [...boardAllStages(view)].sort(compareBoardStages);
  if (projects.length === 0) {
    return all
      .filter((stage) => stage.projectId === null)
      .map((stage) => ({ stage, kind: "shared", usedBy: [], hint: null }));
  }
  const users = stageUsers(view, projects);
  const single = projects.length === 1;
  const columns: Array<BoardPipelineColumn> = [];
  for (const stage of all) {
    const usedBy = users.get(stage.stageId) ?? [];
    if (usedBy.length === 0) {
      if (!occupiedStageIds.has(stage.stageId)) continue;
      const goneFor = projects.filter(
        (project) => stage.projectId === null || stage.projectId === project.id,
      );
      columns.push({
        stage,
        kind: "removed",
        usedBy: [],
        hint: `Removed from ${single ? "this project" : nameList(goneFor)}'s pipeline. Stays until its cards move on.`,
      });
      continue;
    }
    if (stage.projectId !== null) {
      columns.push({
        stage,
        kind: "project-added",
        usedBy: single ? [] : usedBy,
        hint: single ? "Added in this project's t3o.json" : `Only ${nameList(usedBy)}`,
      });
      continue;
    }
    if (usedBy.length === projects.length) {
      columns.push({ stage, kind: "shared", usedBy: [], hint: null });
      continue;
    }
    const others = projects.filter((project) => !usedBy.includes(project));
    columns.push({
      stage,
      kind: "partial",
      usedBy,
      hint:
        usedBy.length <= others.length ? `Only ${nameList(usedBy)}` : `Not in ${nameList(others)}`,
    });
  }
  return columns;
}

/** A lookup for the note a card carries when its project no longer uses the
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
      : `${label} is no longer in ${projectTitle(card.projectId)}'s pipeline`;
  };
}

export type BoardPipelineCell = "global" | "added" | "unused";

export interface BoardPipelinesGrid {
  readonly stages: ReadonlyArray<BoardStageDefinition>;
  readonly rows: ReadonlyArray<{
    readonly project: BoardPipelineProject;
    readonly cells: ReadonlyArray<BoardPipelineCell>;
  }>;
}

/** The Pipelines grid: projects against every stage any of them uses, marking
    which are global, which the project added, and which it does not use. */
export function boardPipelinesGrid(
  view: BoardStageView,
  projects: ReadonlyArray<BoardPipelineProject>,
): BoardPipelinesGrid {
  const users = stageUsers(view, projects);
  const stages = [...boardAllStages(view)]
    .sort(compareBoardStages)
    .filter((stage) => stage.projectId === null || users.has(stage.stageId));
  return {
    stages,
    rows: projects.map((project) => ({
      project,
      cells: stages.map((stage): BoardPipelineCell => {
        if (!(users.get(stage.stageId) ?? []).includes(project)) return "unused";
        return stage.projectId === null ? "global" : "added";
      }),
    })),
  };
}

/**
 * One card's project pipeline as a bare stage list (T3O-43), for the detail
 * pane's stage section and every bare-list helper it feeds: the project's
 * stages in order, plus the card's own stage if it is retired. Project rows
 * are presented as ordinary stages (`projectId: null`), because within one
 * project's list they are.
 */
export function boardCardPipelineStages(
  view: Pick<BoardStageView, "stages" | "projectStageConfigs">,
  card: { readonly stage: string; readonly projectId: ProjectId },
): ReadonlyArray<BoardStageDefinition> {
  return boardProjectStagesInOrder({ ...view, cards: [card as never] }, card.projectId)
    .filter((stage) => !stage.retired || stage.stageId === card.stage)
    .map(({ retired: _retired, ...stage }) => ({ ...stage, projectId: null }));
}
