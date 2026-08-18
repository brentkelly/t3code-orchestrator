/**
 * The archive sheet's selection rule (t3o-13, D7), kept apart from the sheet
 * component so it can be read and tested without pulling the web runtime
 * graph in behind it.
 */
import type { BoardCardShell, ProjectId } from "@t3tools/contracts";

/**
 * The archived cards the sheet should show: the board's own project scope
 * applied to the archive snapshot, nothing else. The server already returns
 * them newest-archived first — the card you just archived by mistake is the
 * one you came to restore — so this must not reorder them.
 */
export function boardArchivedCardsInScope(
  cards: ReadonlyArray<BoardCardShell>,
  scopeProjectId: ProjectId | null,
): ReadonlyArray<BoardCardShell> {
  if (scopeProjectId === null) return cards;
  return cards.filter((card) => card.projectId === scopeProjectId);
}
