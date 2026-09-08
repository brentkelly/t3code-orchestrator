/**
 * T3o board card filter (T3O-16): the top bar's filter box, as pure rules over
 * the columns the board already holds.
 *
 * Matching follows the rule the board's pickers already use
 * (`BoardPickerSearchBody`): a case-insensitive substring of the card's title
 * or its key, so "conflict" and "t3o-16" both land. One rule, so a card found
 * by the dependency picker is a card found by the board.
 *
 * Like the scope filter next door, this thins what RENDERS while the full
 * columns stay the ordering substrate — a drop between two matching cards
 * still anchors into the real column, so filtered-out cards keep their order.
 */
import type { BoardCardShell } from "@t3tools/contracts";
import type { BoardStageColumns } from "@t3tools/client-runtime/state/shell";

/** The comparable form of what the user typed. Empty means "no filter". */
export function normaliseBoardCardQuery(query: string): string {
  return query.trim().toLowerCase();
}

/** Whether one card survives a NORMALISED query (`normaliseBoardCardQuery`). */
export function boardCardMatchesQuery(
  card: Pick<BoardCardShell, "key" | "title">,
  normalisedQuery: string,
): boolean {
  if (normalisedQuery.length === 0) return true;
  return (
    card.title.toLowerCase().includes(normalisedQuery) ||
    card.key.toLowerCase().includes(normalisedQuery)
  );
}

/** Thin every column to the cards matching `query`. An empty query returns the
    columns untouched — the same reference, so the common case memoises to a
    no-op rather than rebuilding eight arrays on every keystroke. */
export function filterBoardColumnsByQuery(
  columns: BoardStageColumns,
  query: string,
): BoardStageColumns {
  const normalised = normaliseBoardCardQuery(query);
  if (normalised.length === 0) return columns;
  return Object.fromEntries(
    Object.entries(columns).map(([stageId, cards]) => [
      stageId,
      cards.filter((card) => boardCardMatchesQuery(card, normalised)),
    ]),
  ) as BoardStageColumns;
}

/** How many cards a query leaves across every column — the board says so when
    the answer is none, rather than showing eight empty columns and no reason. */
export function countBoardColumnCards(columns: BoardStageColumns): number {
  return Object.values(columns).reduce((total, cards) => total + cards.length, 0);
}
