/**
 * Board scope: `BoardPage` renders the root board (top-level cards) or one
 * group's sub-board (its children, Deferred included); the difference is data.
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
    board, one parent's children on its sub-board. */
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

/** The Deferred column: a system stage, never in the board's stage
    list, drawn only on a sub-board. */
export const BOARD_DEFERRED_STAGE: BoardStageDefinition = {
  stageId: BOARD_DEFERRED_STAGE_ID,
  label: "Deferred",
  role: null,
  orderKey: "0",
  createdAt: "1970-01-01T00:00:00.000Z",
  updatedAt: "1970-01-01T00:00:00.000Z",
  projectId: null,
};

/** The stages a scope renders: every stage on the root board; Deferred and
    then every stage inside a group, since an inherit group's
    children run the whole pipeline. */
export function boardScopeStages(
  stages: ReadonlyArray<BoardStageDefinition>,
  scope: BoardScope,
): ReadonlyArray<BoardStageDefinition> {
  if (scope.kind === "root") return stages;
  return [BOARD_DEFERRED_STAGE, ...stages];
}

/**
 * A column's collapse default. Root: the intake starts as a rail. In a group:
 * an empty Deferred and every empty column before Ready. A stored manual
 * collapse or expand always wins.
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

/** Whether the auto-collapse setting folds this column: on, and empty. */
export function boardColumnAutoFolded(input: {
  readonly autoCollapseEmpty: boolean;
  readonly cardCount: number;
}): boolean {
  return input.autoCollapseEmpty && input.cardCount === 0;
}

/**
 * Collapse with auto-collapse applied: while on, an empty column folds unless
 * peeked or hovered by a drag. A column with cards uses the stored-or-default
 * value, so a hand-collapsed stage stays collapsed when cards arrive.
 */
export function boardColumnCollapsed(input: {
  readonly autoCollapseEmpty: boolean;
  readonly cardCount: number;
  readonly dragOverThisColumn: boolean;
  readonly peeked: boolean;
  readonly storedOrDefaultCollapsed: boolean;
}): boolean {
  return boardColumnAutoFolded(input)
    ? !(input.peeked || input.dragOverThisColumn)
    : input.storedOrDefaultCollapsed;
}

/**
 * The auto-folded rail a live drag holds open: the latest one hovered.
 * Hovering an ordinary column keeps it; another folded rail replaces it, so a
 * drag never opens more than one.
 */
export function boardDragOpenedRail<S extends string>(input: {
  readonly current: S | null;
  readonly hovered: S;
  readonly hoveredAutoFolded: boolean;
}): S | null {
  return input.hoveredAutoFolded ? input.hovered : input.current;
}

/**
 * Where a column's collapse toggle goes. On an auto-folded column it
 * only opens or ends a transient peek, so `collapsedByStage` is never written
 * for it; on any other column it is the stored manual choice.
 */
export function boardCollapseToggle(input: {
  readonly autoCollapseEmpty: boolean;
  readonly cardCount: number;
  readonly key: string;
  readonly collapsed: boolean;
  readonly peeked: ReadonlySet<string>;
}): { readonly kind: "peek"; readonly peeked: ReadonlySet<string> } | { readonly kind: "store" } {
  if (!boardColumnAutoFolded(input)) return { kind: "store" };
  const peeked = new Set(input.peeked);
  if (input.collapsed) peeked.delete(input.key);
  else peeked.add(input.key);
  return { kind: "peek", peeked };
}

/**
 * The peeks that survive this render: still-empty columns of this scope, none
 * while the setting is off. Returns `peeked` itself when nothing was dropped, so
 * callers can compare by reference before setting state.
 */
export function livePeekedColumns(input: {
  readonly autoCollapseEmpty: boolean;
  readonly peeked: ReadonlySet<string>;
  readonly emptyColumnKeys: ReadonlyArray<string>;
}): ReadonlySet<string> {
  if (input.peeked.size === 0) return input.peeked;
  const empty = new Set(input.autoCollapseEmpty ? input.emptyColumnKeys : []);
  const live = [...input.peeked].filter((key) => empty.has(key));
  return live.length === input.peeked.size ? input.peeked : new Set(live);
}

/**
 * The collapse-store key for one column in one scope: the bare stage id
 * on the root board — every persisted legacy entry keeps meaning exactly
 * what it meant — and a `sub/<parent>/<stage>` composite inside a sub-board,
 * so a collapsed root Backlog collapses nothing anywhere else.
 */
export function boardScopeCollapseKey(scope: BoardScope, stageId: string): string {
  return scope.kind === "root" ? stageId : `sub/${scope.parentCardId}/${stageId}`;
}

/** Which board's filter text a scope reads. */
export function boardScopeQueryKey(scope: BoardScope): string {
  return scope.kind === "root" ? "root" : `sub/${scope.parentCardId}`;
}

/**
 * Where a sub-board URL lands: the sub-board for a group; the root board with
 * the parent's sheet open for a childless parent; the bare root board for a
 * missing card. Never a 404.
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
  // An empty heading is still a group: its board is where cards go.
  const isGroup =
    parent.group !== undefined || cards.some((card) => card.parentCardId === parentCardId);
  return isGroup ? { kind: "sub-board" } : { kind: "redirect-parent-sheet" };
}
