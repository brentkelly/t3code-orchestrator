import {
  BoardCardId,
  ProjectId,
  type BoardCard,
  type OrchestrationShellSnapshot,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { applyShellStreamEvent } from "./shellReducer.ts";

const card = (id: string, title: string): BoardCard => ({
  id: BoardCardId.make(id),
  projectId: ProjectId.make("project-1"),
  title,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
});

const snapshot = (input?: Partial<OrchestrationShellSnapshot>): OrchestrationShellSnapshot => ({
  snapshotSequence: 1,
  projects: [],
  threads: [],
  updatedAt: "2026-01-01T00:00:00.000Z",
  ...input,
});

describe("board shell reducer", () => {
  it("appends a card to a snapshot that has no cards field yet", () => {
    const next = applyShellStreamEvent(snapshot(), {
      kind: "card-upserted",
      sequence: 2,
      card: card("card-1", "First"),
    });
    expect(next.cards).toEqual([card("card-1", "First")]);
    expect(next.snapshotSequence).toBe(2);
  });

  it("replaces an existing card on upsert", () => {
    const next = applyShellStreamEvent(snapshot({ cards: [card("card-1", "First")] }), {
      kind: "card-upserted",
      sequence: 2,
      card: card("card-1", "Renamed"),
    });
    expect(next.cards).toEqual([card("card-1", "Renamed")]);
  });

  it("removes a card", () => {
    const next = applyShellStreamEvent(
      snapshot({ cards: [card("card-1", "First"), card("card-2", "Second")] }),
      {
        kind: "card-removed",
        sequence: 2,
        cardId: BoardCardId.make("card-1"),
      },
    );
    expect(next.cards).toEqual([card("card-2", "Second")]);
  });

  it("drops stale card events by sequence", () => {
    const current = snapshot({ snapshotSequence: 5, cards: [card("card-1", "First")] });
    const next = applyShellStreamEvent(current, {
      kind: "card-upserted",
      sequence: 4,
      card: card("card-1", "Stale rename"),
    });
    expect(next).toBe(current);
  });
});
