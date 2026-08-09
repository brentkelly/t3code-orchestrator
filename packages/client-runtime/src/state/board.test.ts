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
  type OrchestrationShellSnapshot,
  type OrchestrationThreadShell,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  boardColumnAppendOrderKey,
  compareBoardCardShells,
  planBoardCardReorder,
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
