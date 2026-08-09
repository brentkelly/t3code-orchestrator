/**
 * T3o board client state (t3o-04): shell-delta reduction over the bounded
 * `BoardCardShell`, client-side re-derivation of the thread-derived fields,
 * and the fractional-order planning veneer.
 */
import {
  BoardCardId,
  boardCardShellFromCard,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type BoardCard,
  type BoardCardShell,
  type BoardStage,
  type OrchestrationShellSnapshot,
  type OrchestrationThreadShell,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  applyBoardCardPlacements,
  boardBuildingQueueInfo,
  boardColumnAppendOrderKey,
  compareBoardCardShells,
  isBoardCardPlacementSettled,
  mergeBoardStageColumns,
  planBoardCardReorder,
  type BoardStageColumns,
} from "./board.ts";
import { applyShellStreamEvent } from "./shellReducer.ts";

const NOW = "2026-01-01T00:00:00.000Z";
const projectId = ProjectId.make("project-1");
const threadId = ThreadId.make("thread-1");

const fullCard = (id: string, overrides?: Partial<BoardCard>): BoardCard => ({
  id: BoardCardId.make(id),
  key: "CARD-1",
  cardNumber: 1,
  projectId,
  type: "feature",
  stage: "backlog",
  orderKey: "m",
  title: `Card ${id}`,
  briefRef: null,
  dependsOn: [],
  parentCardId: null,
  threadLinks: [],
  externalRef: null,
  recipeSnapshot: null,
  blocked: false,
  archivedAt: null,
  createdAt: NOW,
  updatedAt: NOW,
  ...overrides,
});

const cardShell = (id: string, overrides?: Partial<BoardCard>): BoardCardShell =>
  boardCardShellFromCard(fullCard(id, overrides));

const threadShell = (overrides?: Partial<OrchestrationThreadShell>): OrchestrationThreadShell => ({
  id: threadId,
  projectId,
  title: "Thread",
  modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5-codex" },
  runtimeMode: "full-access",
  interactionMode: "default",
  branch: null,
  worktreePath: null,
  latestTurn: null,
  createdAt: NOW,
  updatedAt: NOW,
  archivedAt: null,
  settledOverride: null,
  settledAt: null,
  latestUserMessageAt: null,
  hasPendingApprovals: false,
  hasPendingUserInput: false,
  hasActionableProposedPlan: false,
  session: null,
  ...overrides,
});

const snapshot = (input?: Partial<OrchestrationShellSnapshot>): OrchestrationShellSnapshot => ({
  snapshotSequence: 1,
  projects: [],
  threads: [],
  updatedAt: NOW,
  ...input,
});

describe("board shell reducer", () => {
  it("appends a card to a snapshot that has no cards field yet", () => {
    const next = applyShellStreamEvent(snapshot(), {
      kind: "card-upserted",
      sequence: 2,
      card: cardShell("card-1"),
    });
    expect(next.cards).toEqual([cardShell("card-1")]);
    expect(next.snapshotSequence).toBe(2);
  });

  it("replaces an existing card on upsert", () => {
    const next = applyShellStreamEvent(snapshot({ cards: [cardShell("card-1")] }), {
      kind: "card-upserted",
      sequence: 2,
      card: cardShell("card-1", { title: "Renamed" }),
    });
    expect(next.cards).toEqual([cardShell("card-1", { title: "Renamed" })]);
  });

  it("removes a card", () => {
    const next = applyShellStreamEvent(
      snapshot({ cards: [cardShell("card-1"), cardShell("card-2")] }),
      {
        kind: "card-removed",
        sequence: 2,
        cardId: BoardCardId.make("card-1"),
      },
    );
    expect(next.cards).toEqual([cardShell("card-2")]);
  });

  it("drops stale card events by sequence", () => {
    const current = snapshot({ snapshotSequence: 5, cards: [cardShell("card-1")] });
    const next = applyShellStreamEvent(current, {
      kind: "card-upserted",
      sequence: 4,
      card: cardShell("card-1", { title: "Stale rename" }),
    });
    expect(next).toBe(current);
  });

  it("re-derives thread-derived fields from the snapshot's thread shells on upsert", () => {
    // Delta-carried shells leave threadState at "none" (the server-side
    // mapping is a pure function of the board event); the reducer must
    // re-derive from the linked thread the snapshot already holds.
    const linked = cardShell("card-1", {
      threadLinks: [{ threadId, role: "build", linkedAt: NOW, tombstonedAt: null }],
    });
    expect(linked.activeThreadId).toBe(threadId);
    expect(linked.threadState).toBe("none");

    const next = applyShellStreamEvent(
      snapshot({ threads: [threadShell({ hasPendingUserInput: true })] }),
      { kind: "card-upserted", sequence: 2, card: linked },
    );
    expect(next.cards?.[0]?.threadState).toBe("waiting");
    expect(next.cards?.[0]?.awaitingInput).toBe(true);
  });

  it("leaves thread-derived fields at rest for a card with no live link", () => {
    const next = applyShellStreamEvent(
      snapshot({ threads: [threadShell({ hasPendingUserInput: true })] }),
      { kind: "card-upserted", sequence: 2, card: cardShell("card-1") },
    );
    expect(next.cards?.[0]?.threadState).toBe("none");
    expect(next.cards?.[0]?.awaitingInput).toBe(false);
  });
});

describe("board column ordering", () => {
  it("orders by orderKey with cardId tiebreak", () => {
    const cards = [
      cardShell("card-b", { orderKey: "m" }),
      cardShell("card-a", { orderKey: "m" }),
      cardShell("card-c", { orderKey: "c" }),
    ];
    const sorted = [...cards].sort(compareBoardCardShells);
    expect(sorted.map((card) => card.cardId)).toEqual(["card-c", "card-a", "card-b"]);
  });

  it("appends after the column tail", () => {
    const key = boardColumnAppendOrderKey([cardShell("card-1", { orderKey: "m" })]);
    expect(key > "m").toBe(true);
  });

  it("appends after the bottom key even when the column is not sorted by orderKey", () => {
    // Snapshot order is (createdAt, cardId), not orderKey — the append key
    // must clear the maximum key, not the last element's.
    const key = boardColumnAppendOrderKey([
      cardShell("card-1", { orderKey: "t" }),
      cardShell("card-2", { orderKey: "c" }),
    ]);
    expect(key > "t").toBe(true);
  });

  it("yields a key for an empty column", () => {
    expect(boardColumnAppendOrderKey([]).length).toBeGreaterThan(0);
  });

  it("plans a single write for a reorder between keyed neighbors", () => {
    const assignments = planBoardCardReorder({
      orderedCardIds: ["card-a", "card-c", "card-b"],
      keysByCardId: new Map([
        ["card-a", "c"],
        ["card-b", "m"],
        ["card-c", "t"],
      ]),
      movedCardId: "card-c",
    });
    expect(assignments).toHaveLength(1);
    expect(assignments[0]?.cardId).toBe("card-c");
    const key = assignments[0]?.orderKey ?? "";
    expect(key > "c" && key < "m").toBe(true);
  });
});

const columnsOf = (cards: ReadonlyArray<BoardCardShell>): BoardStageColumns => {
  const columns: Record<BoardStage, BoardCardShell[]> = {
    backlog: [],
    sprint: [],
    planning: [],
    ready: [],
    building: [],
    review: [],
    merge: [],
    done: [],
  };
  for (const card of cards) columns[card.stage].push(card);
  for (const stage of Object.keys(columns) as BoardStage[]) {
    columns[stage].sort(compareBoardCardShells);
  }
  return columns;
};

describe("mergeBoardStageColumns", () => {
  it("merges per-project columns into canonical cross-project order", () => {
    const otherProject = ProjectId.make("project-2");
    const a = cardShell("card-a", { orderKey: "c" });
    const b = cardShell("card-b", { projectId: otherProject, orderKey: "m" });
    const c = cardShell("card-c", { orderKey: "t" });
    const merged = mergeBoardStageColumns([columnsOf([a, c]), columnsOf([b])]);
    expect(merged.backlog.map((card) => card.cardId)).toEqual(["card-a", "card-b", "card-c"]);
    expect(merged.done).toHaveLength(0);
  });
});

describe("applyBoardCardPlacements", () => {
  it("moves a card between stages and re-sorts the target column", () => {
    const columns = columnsOf([
      cardShell("card-a", { orderKey: "c" }),
      cardShell("card-b", { stage: "ready", orderKey: "m" }),
    ]);
    const next = applyBoardCardPlacements(columns, [
      { cardId: "card-a", stage: "ready", orderKey: "t" },
    ]);
    expect(next.backlog).toHaveLength(0);
    expect(next.ready.map((card) => card.cardId)).toEqual(["card-b", "card-a"]);
  });

  it("reorders within a stage", () => {
    const columns = columnsOf([
      cardShell("card-a", { orderKey: "c" }),
      cardShell("card-b", { orderKey: "m" }),
    ]);
    const next = applyBoardCardPlacements(columns, [
      { cardId: "card-b", stage: "backlog", orderKey: "a" },
    ]);
    expect(next.backlog.map((card) => card.cardId)).toEqual(["card-b", "card-a"]);
  });

  it("returns the same columns object when every placement is already live", () => {
    const columns = columnsOf([cardShell("card-a", { orderKey: "c" })]);
    const next = applyBoardCardPlacements(columns, [
      { cardId: "card-a", stage: "backlog", orderKey: "c" },
      { cardId: "card-gone", stage: "ready", orderKey: "m" },
    ]);
    expect(next).toBe(columns);
  });
});

describe("isBoardCardPlacementSettled", () => {
  it("reports settled when the live card matches, unsettled when it does not", () => {
    const columns = columnsOf([cardShell("card-a", { stage: "ready", orderKey: "m" })]);
    expect(
      isBoardCardPlacementSettled(columns, { cardId: "card-a", stage: "ready", orderKey: "m" }),
    ).toBe(true);
    expect(
      isBoardCardPlacementSettled(columns, { cardId: "card-a", stage: "building", orderKey: "m" }),
    ).toBe(false);
  });

  it("treats a card that left the board as settled", () => {
    expect(
      isBoardCardPlacementSettled(columnsOf([]), {
        cardId: "card-gone",
        stage: "ready",
        orderKey: "m",
      }),
    ).toBe(true);
  });
});

describe("boardBuildingQueueInfo", () => {
  it("is empty while nothing carries the queued flag (t3o-11 populates it)", () => {
    const column = [cardShell("card-a", { stage: "building" })];
    expect(boardBuildingQueueInfo(column).size).toBe(0);
  });

  it("numbers queued cards in column order and marks the head as starting next", () => {
    const column = [
      { ...cardShell("card-a", { stage: "building", orderKey: "c" }), queued: false },
      { ...cardShell("card-b", { stage: "building", orderKey: "m" }), queued: true },
      { ...cardShell("card-c", { stage: "building", orderKey: "t" }), queued: true },
    ];
    const queue = boardBuildingQueueInfo(column);
    expect(queue.get("card-b")).toEqual({ position: 1, startsNext: true });
    expect(queue.get("card-c")).toEqual({ position: 2, startsNext: false });
    expect(queue.has("card-a")).toBe(false);
  });
});
