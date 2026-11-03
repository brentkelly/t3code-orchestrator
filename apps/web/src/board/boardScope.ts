/**
 * T3o board scope (t3o-25, D1): one board component, scoped twice.
 *
 * `BoardPage` renders either the root board or one parent's sub-board; the
 * difference is DATA, held here as pure functions over the shells the page
 * already has. Root scope shows top-level cards across every stage; sub-board
 * scope shows one group's children across Deferred and every stage (T3O-29).
 */
import {
  BOARD_DEFERRED_STAGE_ID,
  boardStageBeforeBuild,
  boardStageIndex,
  isBoardDeferredStage,
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

/** The Deferred column (T3O-29): a system stage, never in the board's stage
    list, drawn only on a sub-board. */
export const BOARD_DEFERRED_STAGE: BoardStageDefinition = {
  stageId: BOARD_DEFERRED_STAGE_ID,
  label: "Deferred",
  role: null,
  orderKey: "0",
  createdAt: "1970-01-01T00:00:00.000Z",
  updatedAt: "1970-01-01T00:00:00.000Z",
};

/** The stages a scope renders: every stage on the root board; Deferred and
    then every stage inside a group (T3O-29), since an inherit group's
    children run the whole pipeline. */
export function boardScopeStages(
  stages: ReadonlyArray<BoardStageDefinition>,
  scope: BoardScope,
): ReadonlyArray<BoardStageDefinition> {
  if (scope.kind === "root") return stages;
  return [BOARD_DEFERRED_STAGE, ...stages];
}

/**
 * A column's collapse default when the human has not set one. The root
 * board's first column (the intake) starts as a rail. Inside a group an empty
 * Deferred column, and every empty column before Ready, start as rails, so a
 * fully planned split reads like the sub-board it always was. A stored manual
 * collapse or expand always wins (`isBoardColumnCollapsed`).
 */
export function boardScopeColumnCollapsedByDefault(input: {
  readonly scope: BoardScope;
  readonly stageState: BoardState;
  readonly stageId: BoardStageDefinition["stageId"];
  readonly renderedIndex: number;
  readonly cardCount: number;
}): boolean {
  if (input.scope.kind === "root") return input.renderedIndex === 0;
  if (input.cardCount > 0) return false;
  if (isBoardDeferredStage(input.stageId)) return true;
  const ready = boardStageBeforeBuild(input.stageState);
  if (ready === null) return false;
  return (
    boardStageIndex(input.stageState, input.stageId) <
    boardStageIndex(input.stageState, ready.stageId)
  );
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
 * exists and is a group; on the root board with the parent's sheet open
 * when the parent exists childless (children all deleted, or a stale link);
 * on the bare root board when the named card does not exist at all. Never a
 * 404 inside the shell — reverse states include navigation.
 */
export type SubBoardEntry =
  | { readonly kind: "sub-board" }
  | { readonly kind: "redirect-parent-sheet" }
  | { readonly kind: "redirect-root" };

export function resolveSubBoardEntry(
  cards: ReadonlyArray<Pick<BoardCardShell, "cardId" | "parentCardId" | "group">>,
  parentCardId: BoardCardId,
): SubBoardEntry {
  const parent = cards.find((card) => card.cardId === parentCardId);
  if (parent === undefined) return { kind: "redirect-root" };
  // An empty heading is still a group (T3O-29): its board is where cards go.
  const isGroup =
    parent.group !== undefined || cards.some((card) => card.parentCardId === parentCardId);
  return isGroup ? { kind: "sub-board" } : { kind: "redirect-parent-sheet" };
}
