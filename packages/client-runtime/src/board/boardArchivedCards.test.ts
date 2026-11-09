import { BoardCardId, ProjectId, type BoardCardShell } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { boardArchivedCardsInScope } from "./boardArchivedCards.ts";

const projectA = ProjectId.make("project-a");
const projectB = ProjectId.make("project-b");

function card(id: string, projectId: ProjectId): BoardCardShell {
  return {
    cardId: BoardCardId.make(id),
    projectId,
  } as BoardCardShell;
}

describe("boardArchivedCardsInScope", () => {
  const cards = [card("a", projectA), card("b", projectB), card("c", projectA)];

  it("returns the snapshot unchanged when the scope is all projects", () => {
    expect(boardArchivedCardsInScope(cards, null)).toBe(cards);
  });

  it("keeps only cards in the scoped project, in snapshot order", () => {
    expect(boardArchivedCardsInScope(cards, projectA).map((entry) => entry.cardId)).toEqual([
      "a",
      "c",
    ]);
  });
});
