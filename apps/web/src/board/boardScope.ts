/**
 * T3o board scope (t3o-25, D1): one board component, scoped twice.
 *
 * `BoardPage` renders either the root board or one parent's sub-board; the
 * difference is DATA, held here as pure functions over the shells the page
 * already has. Root scope shows top-level cards across every stage; sub-board
 * scope shows one parent's children across the floor-onward stages a
 * materialised child may occupy (`isBoardStageAtOrAfterSubBoardFloor` — the
 * decider's own rule, so the columns rendered are exactly the columns a child
 * can be in).
 */
import {
  isBoardStageAtOrAfterSubBoardFloor,
  type BoardCardId,
  type BoardCardShell,
  type BoardStageDefinition,
  type BoardState,
} from "@t3tools/contracts";
import type { BoardStageColumns } from "@t3tools/client-runtime/state/shell";

export type BoardScope =
  | { readonly kind: "root" }
  | { readonly kind: "sub-board"; readonly parentCardId: BoardCardId };

export const ROOT_BOARD_SCOPE: BoardScope = { kind: "root" };

/** Whether one card belongs on a scope's board: top-level cards on the root
    board, one parent's children on its sub-board (D1). */
export function isBoardCardInScope(
  card: Pick<BoardCardShell, "parentCardId">,
  scope: BoardScope,
): boolean {
  return scope.kind === "root"
    ? card.parentCardId === undefined
    : card.parentCardId === scope.parentCardId;
}

/** Thin every column to the scope's cards. The FULL columns stay the ordering
    substrate (drops anchor into them, exactly as the stalled filter's do);
    this only decides what renders. */
export function filterBoardColumnsByScope(
  columns: BoardStageColumns,
  scope: BoardScope,
): BoardStageColumns {
  return Object.fromEntries(
    Object.entries(columns).map(([stageId, cards]) => [
      stageId,
      cards.filter((card) => isBoardCardInScope(card, scope)),
    ]),
  ) as BoardStageColumns;
}

/** The stages a scope renders: every stage on the root board, the
    materialisation floor onward inside a sub-board (D1 — ideation columns
    cannot hold a child, so they do not render there). `stageState` is the
    read-model view over the same ordered list, for the role helpers. */
export function boardScopeStages(
  stages: ReadonlyArray<BoardStageDefinition>,
  stageState: BoardState,
  scope: BoardScope,
): ReadonlyArray<BoardStageDefinition> {
  if (scope.kind === "root") return stages;
  return stages.filter((stage) => isBoardStageAtOrAfterSubBoardFloor(stageState, stage.stageId));
}

/**
 * The collapse-store key for one column in one scope (D1): the bare stage id
 * on the root board — every persisted pre-t3o-25 entry keeps meaning exactly
 * what it meant — and a `sub/<parent>/<stage>` composite inside a sub-board,
 * so a collapsed root Backlog collapses nothing anywhere else.
 */
export function boardScopeCollapseKey(scope: BoardScope, stageId: string): string {
  return scope.kind === "root" ? stageId : `sub/${scope.parentCardId}/${stageId}`;
}

/**
 * Where a sub-board URL should land (D3): on the sub-board when the parent
 * exists and has children; on the root board with the parent's sheet open
 * when the parent exists childless (children all deleted, or a stale link);
 * on the bare root board when the named card does not exist at all. Never a
 * 404 inside the shell — reverse states include navigation.
 */
export type SubBoardEntry =
  | { readonly kind: "sub-board" }
  | { readonly kind: "redirect-parent-sheet" }
  | { readonly kind: "redirect-root" };

export function resolveSubBoardEntry(
  cards: ReadonlyArray<Pick<BoardCardShell, "cardId" | "parentCardId">>,
  parentCardId: BoardCardId,
): SubBoardEntry {
  const parent = cards.find((card) => card.cardId === parentCardId);
  if (parent === undefined) return { kind: "redirect-root" };
  const hasChildren = cards.some((card) => card.parentCardId === parentCardId);
  return hasChildren ? { kind: "sub-board" } : { kind: "redirect-parent-sheet" };
}
