/**
 * T3o board client state (t3o-04): shell-delta reduction over the bounded
 * `BoardCardShell`, client-side re-derivation of the thread-derived fields,
 * and the fractional-order planning veneer.
 */
import {
  BoardCardId,
  boardCardShellFromCard,
  BOARD_SEED_STAGE_IDS,
  BoardLabelId,
  BoardStageId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type BoardCard,
  type BoardCardShell,
  type BoardLabel,
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
  labels: [],
  stage: BOARD_SEED_STAGE_IDS.backlog,
  orderKey: "m",
  title: `Card ${id}`,
  briefRef: null,
  dependsOn: [],
  parentCardId: null,
  threadLinks: [],
  externalRef: null,
  humanInLoop: null,
  worktree: null,
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

  it("card-queued raises then clears the queued badge on a held card (t3o-11)", () => {
    const held = snapshot({
      cards: [cardShell("card-1", { stage: BOARD_SEED_STAGE_IDS.building })],
    });
    const queued = applyShellStreamEvent(held, {
      kind: "card-queued",
      sequence: 2,
      cardId: BoardCardId.make("card-1"),
      queued: true,
      stepRunning: false,
    });
    expect(queued.cards?.[0]?.queued).toBe(true);
    expect(queued.snapshotSequence).toBe(2);
    const cleared = applyShellStreamEvent(queued, {
      kind: "card-queued",
      sequence: 3,
      cardId: BoardCardId.make("card-1"),
      queued: false,
      stepRunning: true,
    });
    expect(cleared.cards?.[0]?.queued).toBe(false);
  });

  it("card-queued admitted-to-running lights stepRunning; holding for a slot clears it", () => {
    // The durable "being worked" dot: an admitted-and-running step keeps a card
    // lit across a loop stage's per-phase thread gaps, while a step held for a
    // slot (queued) is not running.
    const held = snapshot({
      cards: [cardShell("card-1", { stage: BOARD_SEED_STAGE_IDS.building })],
    });
    const running = applyShellStreamEvent(held, {
      kind: "card-queued",
      sequence: 2,
      cardId: BoardCardId.make("card-1"),
      queued: false,
      stepRunning: true,
    });
    expect(running.cards?.[0]?.stepRunning).toBe(true);
    const heldAgain = applyShellStreamEvent(running, {
      kind: "card-queued",
      sequence: 3,
      cardId: BoardCardId.make("card-1"),
      queued: true,
      stepRunning: false,
    });
    expect(heldAgain.cards?.[0]?.stepRunning).toBe(false);
  });

  it("a card-carrying upsert preserves stepRunning — a drag never blanks a working card's dot", () => {
    const running = applyShellStreamEvent(
      snapshot({ cards: [cardShell("card-1", { stage: BOARD_SEED_STAGE_IDS.building })] }),
      {
        kind: "card-queued",
        sequence: 2,
        cardId: BoardCardId.make("card-1"),
        queued: false,
        stepRunning: true,
      },
    );
    expect(running.cards?.[0]?.stepRunning).toBe(true);
    const reordered = applyShellStreamEvent(running, {
      kind: "card-upserted",
      sequence: 3,
      card: cardShell("card-1", { stage: BOARD_SEED_STAGE_IDS.building, orderKey: "z" }),
    });
    expect(reordered.cards?.[0]?.stepRunning).toBe(true); // preserved across the drag
  });

  it("card-stalled raises then clears the stalled badge on a card (t3o-17, D3)", () => {
    const held = snapshot({
      cards: [cardShell("card-1", { stage: BOARD_SEED_STAGE_IDS.building })],
    });
    const stalled = applyShellStreamEvent(held, {
      kind: "card-stalled",
      sequence: 2,
      cardId: BoardCardId.make("card-1"),
      stalled: true,
      stepRunning: false,
    });
    expect(stalled.cards?.[0]?.stalled).toBe(true);
    expect(stalled.snapshotSequence).toBe(2);
    const cleared = applyShellStreamEvent(stalled, {
      kind: "card-stalled",
      sequence: 3,
      cardId: BoardCardId.make("card-1"),
      stalled: false,
      stepRunning: false,
    });
    expect(cleared.cards?.[0]?.stalled).toBe(false);
  });

  it("a card that stalls out of the queue drops its queue badge with it", () => {
    // Both badges are views of one step status, so they cannot both be true.
    // A step whose slot was granted but whose spawn was refused escalates
    // straight from `queued` to `stalled`, and no later delta clears the queue
    // badge — it would otherwise hold a displayed queue position until reconnect.
    const queued = applyShellStreamEvent(
      snapshot({ cards: [cardShell("card-1", { stage: BOARD_SEED_STAGE_IDS.building })] }),
      {
        kind: "card-queued",
        sequence: 2,
        cardId: BoardCardId.make("card-1"),
        queued: true,
        stepRunning: false,
      },
    );
    expect(queued.cards?.[0]?.queued).toBe(true);
    const stalled = applyShellStreamEvent(queued, {
      kind: "card-stalled",
      sequence: 3,
      cardId: BoardCardId.make("card-1"),
      stalled: true,
      stepRunning: false,
    });
    expect(stalled.cards?.[0]?.stalled).toBe(true);
    expect(stalled.cards?.[0]?.queued).toBe(false);
  });

  it("clearing the stalled badge leaves the queue badge alone", () => {
    // The clear rides a fresh select-step / settle, neither of which says
    // anything about the queue — only `card-queued` and an admit do.
    const queued = applyShellStreamEvent(
      snapshot({ cards: [cardShell("card-1", { stage: BOARD_SEED_STAGE_IDS.building })] }),
      {
        kind: "card-queued",
        sequence: 2,
        cardId: BoardCardId.make("card-1"),
        queued: true,
        stepRunning: false,
      },
    );
    const cleared = applyShellStreamEvent(queued, {
      kind: "card-stalled",
      sequence: 3,
      cardId: BoardCardId.make("card-1"),
      stalled: false,
      stepRunning: false,
    });
    expect(cleared.cards?.[0]?.queued).toBe(true);
  });

  it("a card-carrying upsert preserves the stalled badge — a drag never blanks it (t3o-17)", () => {
    const stalled = applyShellStreamEvent(
      snapshot({ cards: [cardShell("card-1", { stage: BOARD_SEED_STAGE_IDS.building })] }),
      {
        kind: "card-stalled",
        sequence: 2,
        cardId: BoardCardId.make("card-1"),
        stalled: true,
        stepRunning: false,
      },
    );
    expect(stalled.cards?.[0]?.stalled).toBe(true);
    const reordered = applyShellStreamEvent(stalled, {
      kind: "card-upserted",
      sequence: 3,
      card: cardShell("card-1", { stage: BOARD_SEED_STAGE_IDS.building, orderKey: "z" }),
    });
    expect(reordered.cards?.[0]?.stalled).toBe(true); // preserved
  });

  it("card-plans updates the footer's plan count and no-ops on an unheld card", () => {
    const held = snapshot({ cards: [cardShell("card-1")] });
    const proposed = applyShellStreamEvent(held, {
      kind: "card-plans",
      sequence: 2,
      cardId: BoardCardId.make("card-1"),
      planCount: 3,
    });
    expect(proposed.cards?.[0]?.planCount).toBe(3);

    // A re-proposal that shrinks the set has to bring the count down.
    const shrunk = applyShellStreamEvent(proposed, {
      kind: "card-plans",
      sequence: 3,
      cardId: BoardCardId.make("card-1"),
      planCount: 1,
    });
    expect(shrunk.cards?.[0]?.planCount).toBe(1);

    const stranger = applyShellStreamEvent(held, {
      kind: "card-plans",
      sequence: 4,
      cardId: BoardCardId.make("card-elsewhere"),
      planCount: 9,
    });
    expect(stranger.cards).toEqual(held.cards);
  });

  it("a card upsert preserves body-derived fields it could not know, and applies the ones it could", () => {
    // These two fields come from slices the card aggregate does not carry, so
    // an absent key means "unchanged" — otherwise a drag (`card-reordered` →
    // `card-upserted`) would blank a card's image icon and plan count.
    const known = snapshot({
      cards: [{ ...cardShell("card-1"), briefHasImage: true, planCount: 2 }],
    });
    const dragged = applyShellStreamEvent(known, {
      kind: "card-upserted",
      sequence: 2,
      card: cardShell("card-1", { orderKey: "z" }),
    });
    expect(dragged.cards?.[0]?.briefHasImage).toBe(true);
    expect(dragged.cards?.[0]?.planCount).toBe(2);

    // But a delta that DID see the brief is authoritative, `false` included.
    const edited = applyShellStreamEvent(known, {
      kind: "card-upserted",
      sequence: 3,
      card: { ...cardShell("card-1"), briefHasImage: false },
    });
    expect(edited.cards?.[0]?.briefHasImage).toBe(false);
    expect(edited.cards?.[0]?.planCount).toBe(2);
  });

  it("card-queued is a no-op for a card the client does not hold (t3o-11)", () => {
    const held = snapshot({ cards: [cardShell("card-1")] });
    const next = applyShellStreamEvent(held, {
      kind: "card-queued",
      sequence: 2,
      cardId: BoardCardId.make("card-missing"),
      queued: true,
      stepRunning: false,
    });
    expect(next.cards).toEqual(held.cards);
  });

  it("a card-carrying upsert preserves the queued badge — a drag never blanks it (t3o-11)", () => {
    // `queued` is derived from step state the card aggregate does not carry, so
    // a card-carrying delta (here a reorder = drag) rests it at false. The
    // client must keep the last known queued value, like it re-derives
    // threadState, or reprioritising the queue would flicker the badge off.
    const queued = applyShellStreamEvent(
      snapshot({ cards: [cardShell("card-1", { stage: BOARD_SEED_STAGE_IDS.building })] }),
      {
        kind: "card-queued",
        sequence: 2,
        cardId: BoardCardId.make("card-1"),
        queued: true,
        stepRunning: false,
      },
    );
    expect(queued.cards?.[0]?.queued).toBe(true);
    const reordered = applyShellStreamEvent(queued, {
      kind: "card-upserted",
      sequence: 3,
      card: cardShell("card-1", { stage: BOARD_SEED_STAGE_IDS.building, orderKey: "z" }),
    });
    expect(reordered.cards?.[0]?.queued).toBe(true); // preserved
    expect(reordered.cards?.[0]?.orderKey).toBe("z"); // new position honored
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

const label = (id: string, overrides?: Partial<BoardLabel>): BoardLabel => ({
  labelId: BoardLabelId.make(id),
  name: id,
  colour: "#3b82f6",
  deletedAt: null,
  createdAt: NOW,
  updatedAt: NOW,
  ...overrides,
});

describe("board label catalogue reducer (t3o-06a)", () => {
  it("appends a label to a snapshot with no catalogue yet", () => {
    const next = applyShellStreamEvent(snapshot(), {
      kind: "label-upserted",
      sequence: 2,
      label: label("label-1"),
    });
    expect(next.boardLabels).toEqual([label("label-1")]);
    expect(next.snapshotSequence).toBe(2);
  });

  it("recolours an existing label in place — repainting cards without a card delta", () => {
    const cards = [cardShell("card-1", { labels: [BoardLabelId.make("label-1")] })];
    const next = applyShellStreamEvent(
      snapshot({ cards, boardLabels: [label("label-1"), label("label-2")] }),
      { kind: "label-upserted", sequence: 3, label: label("label-1", { colour: "#ef4444" }) },
    );
    // The catalogue changed; the card list is untouched (chips read colour by
    // id from the catalogue, so no per-card write is needed).
    expect(next.boardLabels).toEqual([label("label-1", { colour: "#ef4444" }), label("label-2")]);
    expect(next.cards).toBe(cards);
  });

  it("keeps a tombstoned label in the catalogue on delete", () => {
    const next = applyShellStreamEvent(snapshot({ boardLabels: [label("label-1")] }), {
      kind: "label-upserted",
      sequence: 4,
      label: label("label-1", { deletedAt: NOW }),
    });
    expect(next.boardLabels).toEqual([label("label-1", { deletedAt: NOW })]);
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

// Columns are now keyed dynamically by stage id (t3o-15): only stages that
// hold cards get a key, and callers read `columns[id] ?? []` for the rest.
const columnsOf = (cards: ReadonlyArray<BoardCardShell>): BoardStageColumns => {
  const columns: Record<string, BoardCardShell[]> = {};
  for (const card of cards) (columns[card.stage] ??= []).push(card);
  for (const stage of Object.keys(columns)) {
    columns[stage]!.sort(compareBoardCardShells);
  }
  return columns;
};

const stageColumn = (
  columns: BoardStageColumns,
  stageId: BoardStageId,
): ReadonlyArray<BoardCardShell> => columns[stageId] ?? [];

describe("mergeBoardStageColumns", () => {
  it("merges per-project columns into canonical cross-project order", () => {
    const otherProject = ProjectId.make("project-2");
    const a = cardShell("card-a", { orderKey: "c" });
    const b = cardShell("card-b", { projectId: otherProject, orderKey: "m" });
    const c = cardShell("card-c", { orderKey: "t" });
    const merged = mergeBoardStageColumns([columnsOf([a, c]), columnsOf([b])]);
    expect(stageColumn(merged, BOARD_SEED_STAGE_IDS.backlog).map((card) => card.cardId)).toEqual([
      "card-a",
      "card-b",
      "card-c",
    ]);
    expect(stageColumn(merged, BOARD_SEED_STAGE_IDS.done)).toHaveLength(0);
  });
});

describe("applyBoardCardPlacements", () => {
  it("moves a card between stages and re-sorts the target column", () => {
    const columns = columnsOf([
      cardShell("card-a", { orderKey: "c" }),
      cardShell("card-b", { stage: BOARD_SEED_STAGE_IDS.ready, orderKey: "m" }),
    ]);
    const next = applyBoardCardPlacements(columns, [
      { cardId: "card-a", stage: BOARD_SEED_STAGE_IDS.ready, orderKey: "t" },
    ]);
    expect(stageColumn(next, BOARD_SEED_STAGE_IDS.backlog)).toHaveLength(0);
    expect(stageColumn(next, BOARD_SEED_STAGE_IDS.ready).map((card) => card.cardId)).toEqual([
      "card-b",
      "card-a",
    ]);
  });

  it("reorders within a stage", () => {
    const columns = columnsOf([
      cardShell("card-a", { orderKey: "c" }),
      cardShell("card-b", { orderKey: "m" }),
    ]);
    const next = applyBoardCardPlacements(columns, [
      { cardId: "card-b", stage: BOARD_SEED_STAGE_IDS.backlog, orderKey: "a" },
    ]);
    expect(stageColumn(next, BOARD_SEED_STAGE_IDS.backlog).map((card) => card.cardId)).toEqual([
      "card-b",
      "card-a",
    ]);
  });

  it("returns the same columns object when every placement is already live", () => {
    const columns = columnsOf([cardShell("card-a", { orderKey: "c" })]);
    const next = applyBoardCardPlacements(columns, [
      { cardId: "card-a", stage: BOARD_SEED_STAGE_IDS.backlog, orderKey: "c" },
      { cardId: "card-gone", stage: BOARD_SEED_STAGE_IDS.ready, orderKey: "m" },
    ]);
    expect(next).toBe(columns);
  });
});

describe("isBoardCardPlacementSettled", () => {
  it("reports settled when the live card matches, unsettled when it does not", () => {
    const columns = columnsOf([
      cardShell("card-a", { stage: BOARD_SEED_STAGE_IDS.ready, orderKey: "m" }),
    ]);
    expect(
      isBoardCardPlacementSettled(columns, {
        cardId: "card-a",
        stage: BOARD_SEED_STAGE_IDS.ready,
        orderKey: "m",
      }),
    ).toBe(true);
    expect(
      isBoardCardPlacementSettled(columns, {
        cardId: "card-a",
        stage: BOARD_SEED_STAGE_IDS.building,
        orderKey: "m",
      }),
    ).toBe(false);
  });

  it("treats a card that left the board as settled", () => {
    expect(
      isBoardCardPlacementSettled(columnsOf([]), {
        cardId: "card-gone",
        stage: BOARD_SEED_STAGE_IDS.ready,
        orderKey: "m",
      }),
    ).toBe(true);
  });
});

describe("boardBuildingQueueInfo", () => {
  it("is empty while nothing carries the queued flag (t3o-11 populates it)", () => {
    const column = [cardShell("card-a", { stage: BOARD_SEED_STAGE_IDS.building })];
    expect(boardBuildingQueueInfo(column).size).toBe(0);
  });

  it("numbers queued cards in column order and marks the head as starting next", () => {
    const column = [
      {
        ...cardShell("card-a", { stage: BOARD_SEED_STAGE_IDS.building, orderKey: "c" }),
        queued: false,
      },
      {
        ...cardShell("card-b", { stage: BOARD_SEED_STAGE_IDS.building, orderKey: "m" }),
        queued: true,
      },
      {
        ...cardShell("card-c", { stage: BOARD_SEED_STAGE_IDS.building, orderKey: "t" }),
        queued: true,
      },
    ];
    const queue = boardBuildingQueueInfo(column);
    expect(queue.get("card-b")).toEqual({ position: 1, startsNext: true });
    expect(queue.get("card-c")).toEqual({ position: 2, startsNext: false });
    expect(queue.has("card-a")).toBe(false);
  });
});
