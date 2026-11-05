/**
 * New phase (T3O-29): which deferred cards may move out of a group into a
 * fresh sibling heading, where that heading sits, and its default title.
 */
import { describe, expect, it } from "vite-plus/test";

import {
  BOARD_DEFERRED_STAGE_ID,
  BOARD_SEED_STAGES,
  BOARD_SEED_STAGE_IDS,
  BoardCardId,
  type BoardCard,
  type BoardState,
} from "./board.ts";
import { ProjectId } from "./baseSchemas.ts";
import { boardNewPhasePlan, boardNextPhaseTitle, defaultBoardCardGroup } from "./boardGroups.ts";

const PROJECT = ProjectId.make("project-1");
const AT = "2026-01-01T00:00:00.000Z";

function card(id: string, overrides: Partial<BoardCard> = {}): BoardCard {
  return {
    id: BoardCardId.make(id),
    key: `T3O-${id.replace(/\D/g, "") || "1"}`,
    cardNumber: 1,
    projectId: PROJECT,
    labels: [],
    stage: BOARD_SEED_STAGE_IDS.backlog,
    pullRequest: null,
    pullRequestHistory: [],
    pullRequestFloor: null,
    reviewOverrides: null,
    modelOverrides: null,
    splitRationale: null,
    baseBranch: null,
    scheduledStartAt: null,
    autoPlanSetting: null,
    autoBuildSetting: null,
    autoMergeSetting: null,
    autoMergeHold: null,
    mergeStrategy: null,
    pinnedWorkerId: null,
    placedWorkerId: null,
    workerMove: null,
    placementOrphaned: null,
    orderKey: "m",
    title: `Card ${id}`,
    briefRef: null,
    dependsOn: [],
    parentCardId: null,
    sourcePlanId: null,
    group: null,
    attachments: [],
    threadLinks: [],
    externalRef: null,
    worktree: null,
    blocked: false,
    humanInLoop: null,
    archivedAt: null,
    createdAt: AT,
    updatedAt: AT,
    ...overrides,
  };
}

const board = (cards: ReadonlyArray<BoardCard>): BoardState => ({
  cards,
  stages: BOARD_SEED_STAGES,
  nextCardNumberByProject: {},
});

const groupOf = (stage = BOARD_SEED_STAGE_IDS.planning, target: "own" | "inherit" = "inherit") =>
  defaultBoardCardGroup(board([]), { stage }, { target });

describe("boardNextPhaseTitle", () => {
  it("adds Phase 2 to a plain title", () => {
    expect(boardNextPhaseTitle("Event log overhaul")).toBe("Event log overhaul: Phase 2");
  });

  it("increments a title that already names its phase", () => {
    expect(boardNextPhaseTitle("Event log overhaul: Phase 2")).toBe("Event log overhaul: Phase 3");
    expect(boardNextPhaseTitle("Event log: Phase 9")).toBe("Event log: Phase 10");
  });

  it("only treats a trailing `: Phase n` as a phase", () => {
    expect(boardNextPhaseTitle("Phase 2 cleanup")).toBe("Phase 2 cleanup: Phase 2");
  });
});

describe("boardNewPhasePlan", () => {
  const group = card("g1", { key: "T3O-10", group: groupOf() });
  const deferredA = card("c2", {
    key: "T3O-12",
    parentCardId: group.id,
    stage: BOARD_DEFERRED_STAGE_ID,
    orderKey: "b",
  });
  const deferredB = card("c3", {
    key: "T3O-13",
    parentCardId: group.id,
    stage: BOARD_DEFERRED_STAGE_ID,
    orderKey: "a",
  });
  const active = card("c4", { key: "T3O-14", parentCardId: group.id });

  it("plans a top-level sibling heading in Backlog", () => {
    const plan = boardNewPhasePlan(board([group, deferredA, deferredB, active]), group.id, [
      deferredB.id,
      deferredA.id,
    ]);
    expect(plan).toMatchObject({
      kind: "ok",
      parentCardId: null,
      headingStage: "backlog",
      cardStage: "backlog",
    });
    // Board order, not the order the caller ticked them in.
    expect(plan.kind === "ok" ? plan.cardIds : []).toEqual([deferredA.id, deferredB.id]);
  });

  it("refuses a card that is not one of the group's deferred cards", () => {
    const plan = boardNewPhasePlan(board([group, deferredA, active]), group.id, [active.id]);
    expect(plan).toEqual({
      kind: "refused",
      reason:
        "'T3O-14' is not a deferred card of 'T3O-10'; only deferred cards move to a new phase.",
    });
  });

  it("refuses an empty pick and a card that is not a group", () => {
    expect(boardNewPhasePlan(board([group, deferredA]), group.id, []).kind).toBe("refused");
    const leaf = card("c9", { key: "T3O-19" });
    expect(boardNewPhasePlan(board([leaf]), leaf.id, [leaf.id]).kind).toBe("refused");
  });

  it("puts the heading on the floor under an own-branch parent", () => {
    const outer = card("g5", { key: "T3O-50", group: groupOf(undefined, "own") });
    const inner = card("g6", { key: "T3O-60", parentCardId: outer.id, group: groupOf() });
    const parked = card("c7", {
      key: "T3O-70",
      parentCardId: inner.id,
      stage: BOARD_DEFERRED_STAGE_ID,
    });
    const plan = boardNewPhasePlan(board([outer, inner, parked]), inner.id, [parked.id]);
    expect(plan).toMatchObject({
      kind: "ok",
      parentCardId: outer.id,
      headingStage: "ready",
      cardStage: "backlog",
    });
  });
});
