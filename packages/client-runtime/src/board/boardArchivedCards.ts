/**
 * The archive sheet's selection rule (t3o-13, D7), shared by web and mobile.
 */
import type { BoardCardShell, ProjectId } from "@t3tools/contracts";

/**
 * The archived cards the sheet should show: the board's own project scope
 * applied to the archive snapshot, nothing else. The server already returns
 * them newest-archived first.
 */
export function boardArchivedCardsInScope(
  cards: ReadonlyArray<BoardCardShell>,
  scopeProjectId: ProjectId | null,
): ReadonlyArray<BoardCardShell> {
  if (scopeProjectId === null) return cards;
  return cards.filter((card) => card.projectId === scopeProjectId);
}
