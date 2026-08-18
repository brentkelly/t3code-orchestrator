/**
 * The archive sheet's selection rule (t3o-13, D7). The sheet itself portals,
 * so the part worth asserting is the pure one: which archived cards the
 * board's project scope admits, and in what order.
 */
import { BoardCardId, ProjectId, makeBoardCardShell } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { boardArchivedCardsInScope } from "./BoardArchivedCardsSheet";

const projectOne = ProjectId.make("project-one");
const projectTwo = ProjectId.make("project-two");

const archivedCard = (id: string, projectId: ProjectId, archivedAt: string) =>
  makeBoardCardShell({
    cardId: BoardCardId.make(id),
    key: id.toUpperCase(),
    projectId,
    labelIds: [],
    stage: "building",
    orderKey: "m",
    title: `Card ${id}`,
    blocked: false,
    dependencyCount: 0,
    hasBrief: false,
    archivedAt,
    activeThreadId: null,
  });

// Newest first, as the server returns them.
const cards = [
  archivedCard("newest", projectOne, "2026-03-03T00:00:00.000Z"),
  archivedCard("middle", projectTwo, "2026-02-02T00:00:00.000Z"),
  archivedCard("oldest", projectOne, "2026-01-01T00:00:00.000Z"),
];

describe("boardArchivedCardsInScope", () => {
  it("shows every project's archive when the board is unscoped", () => {
    expect(boardArchivedCardsInScope(cards, null).map((card) => card.cardId)).toEqual([
      "newest",
      "middle",
      "oldest",
    ]);
  });

  it("shows only the scoped project's cards, so the archive matches the board it opened from", () => {
    expect(boardArchivedCardsInScope(cards, projectOne).map((card) => card.cardId)).toEqual([
      "newest",
      "oldest",
    ]);
    expect(boardArchivedCardsInScope(cards, projectTwo).map((card) => card.cardId)).toEqual([
      "middle",
    ]);
  });

  it("preserves the server's newest-archived-first order rather than re-sorting", () => {
    // The card you just archived by mistake is the one you came to restore.
    expect(boardArchivedCardsInScope(cards, null).map((card) => card.archivedAt)).toEqual([
      "2026-03-03T00:00:00.000Z",
      "2026-02-02T00:00:00.000Z",
      "2026-01-01T00:00:00.000Z",
    ]);
  });

  it("is empty when the scoped project has archived nothing", () => {
    expect(boardArchivedCardsInScope([], projectOne)).toEqual([]);
    expect(boardArchivedCardsInScope(cards, ProjectId.make("project-with-no-archive"))).toEqual([]);
  });
});
