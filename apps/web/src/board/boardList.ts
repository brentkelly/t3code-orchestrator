/**
 * The List view's outline (T3O-30): the card tree as rows, which rows a
 * filter keeps, what indent and outdent would do, where a drop lands, and the
 * one move path every gesture goes through. Pure functions over the shells
 * the client already holds; the decider re-checks every move, these only say
 * why a move is refused before it is sent.
 */
import {
  boardGroupRevertStage,
  boardStageBeforeBuild,
  boardStageIndex,
  isBoardDeferredStage,
  type BoardCardId,
  type BoardCardShell,
  type BoardStageId,
  type BoardState,
} from "@t3tools/contracts";

import {
  BOARD_TRUNK_LABEL,
  boardCardLandsOnLabel,
  boardGroupTargetLabel,
  boardShellAncestors,
  boardShellChildren,
  boardShellDescendants,
  boardShellGroup,
  isBoardGroupShell,
  isBoardShellStarted,
} from "./boardGroups";

type Shells = ReadonlyArray<BoardCardShell>;

const TOP = "";

export interface BoardListTree {
  /** Every live shell, the substrate the group rules read. */
  readonly shells: Shells;
  readonly byId: ReadonlyMap<string, BoardCardShell>;
  /** Children per parent id (`""` for the top level), in outline order. */
  readonly children: ReadonlyMap<string, Shells>;
  /** Each card's position in the fully expanded outline. */
  readonly order: ReadonlyMap<string, number>;
  /** Cards in the project scope; the rest are shown for context only. */
  readonly inScope: ReadonlySet<string>;
}

/** Outline order among siblings: by stage, Deferred last, then the column's
    own order, so a group's children read in the order its board shows them. */
function siblingRank(stages: BoardState, stageId: BoardStageId): number {
  if (isBoardDeferredStage(stageId)) return Number.MAX_SAFE_INTEGER;
  const index = boardStageIndex(stages, stageId);
  return index < 0 ? Number.MAX_SAFE_INTEGER - 1 : index;
}

function compareSiblings(stages: BoardState) {
  return (left: BoardCardShell, right: BoardCardShell): number => {
    const byStage = siblingRank(stages, left.stage) - siblingRank(stages, right.stage);
    if (byStage !== 0) return byStage;
    if (left.orderKey !== right.orderKey) return left.orderKey < right.orderKey ? -1 : 1;
    return left.cardId < right.cardId ? -1 : left.cardId > right.cardId ? 1 : 0;
  };
}

/**
 * The tree for one project scope. A top-level card is shown when it, or
 * anything under it, is in scope, and its whole subtree comes with it: a
 * child in another project shows under its group.
 */
export function buildBoardListTree(input: {
  readonly shells: Shells;
  readonly stages: BoardState;
  readonly inScope: (card: BoardCardShell) => boolean;
}): BoardListTree {
  const { shells, stages } = input;
  const byId = new Map(shells.map((card) => [String(card.cardId), card] as const));
  const compare = compareSiblings(stages);
  const children = new Map<string, Shells>();
  const order = new Map<string, number>();
  const inScope = new Set<string>();
  const roots = shells.filter(
    (card) => card.parentCardId === undefined || !byId.has(String(card.parentCardId)),
  );
  const subtreeInScope = (card: BoardCardShell) =>
    input.inScope(card) ||
    boardShellDescendants(shells, String(card.cardId)).some((descendant) =>
      input.inScope(descendant),
    );
  const shownRoots = roots.filter(subtreeInScope).toSorted(compare);
  children.set(TOP, shownRoots);
  const seen = new Set<string>();
  const walk = (cards: Shells) => {
    for (const card of cards) {
      const id = String(card.cardId);
      if (seen.has(id)) continue;
      seen.add(id);
      order.set(id, order.size);
      if (input.inScope(card)) inScope.add(id);
      const kids = boardShellChildren(shells, id).toSorted(compare);
      if (kids.length > 0) children.set(id, kids);
      walk(kids);
    }
  };
  walk(shownRoots);
  return { shells, byId, children, order, inScope };
}

function boardListChildren(tree: BoardListTree, parentId: string | null): Shells {
  return tree.children.get(parentId ?? TOP) ?? [];
}

export interface BoardListFilter {
  readonly query: string;
  /** Stage ids; empty means every stage. */
  readonly stages: ReadonlySet<string>;
}

function isBoardListFiltering(filter: BoardListFilter): boolean {
  return filter.query.trim().length > 0 || filter.stages.size > 0;
}

function matchesFilter(card: BoardCardShell, filter: BoardListFilter): boolean {
  const query = filter.query.trim().toLowerCase();
  if (query.length > 0 && !`${card.title} ${card.key}`.toLowerCase().includes(query)) return false;
  return filter.stages.size === 0 || filter.stages.has(card.stage);
}

export interface BoardListRow {
  readonly card: BoardCardShell;
  readonly depth: number;
  readonly isGroup: boolean;
  readonly expanded: boolean;
  readonly childCount: number;
  /** Shown only for what is under it (a filter's ancestor, or another
      project's group): dimmed. */
  readonly context: boolean;
}

/**
 * The visible rows. With a filter on, a row stays when it matches or when
 * something under it does; the ones kept only for context are marked, and
 * every group on the way expands.
 */
export function boardListRows(input: {
  readonly tree: BoardListTree;
  readonly collapsed: ReadonlySet<string>;
  readonly filter: BoardListFilter;
}): ReadonlyArray<BoardListRow> {
  const { tree, collapsed, filter } = input;
  const filtering = isBoardListFiltering(filter);
  const keepMemo = new Map<string, boolean>();
  const keep = (card: BoardCardShell): boolean => {
    if (!filtering) return true;
    const id = String(card.cardId);
    const known = keepMemo.get(id);
    if (known !== undefined) return known;
    keepMemo.set(id, false);
    const kept =
      (tree.inScope.has(id) && matchesFilter(card, filter)) ||
      (tree.children.get(id) ?? []).some(keep);
    keepMemo.set(id, kept);
    return kept;
  };
  const rows: Array<BoardListRow> = [];
  const walk = (parentId: string, depth: number) => {
    for (const card of tree.children.get(parentId) ?? []) {
      if (!keep(card)) continue;
      const id = String(card.cardId);
      const kids = tree.children.get(id) ?? [];
      const isGroup = isBoardGroupShell(tree.shells, card);
      const expanded = isGroup && (filtering || !collapsed.has(id));
      rows.push({
        card,
        depth,
        isGroup,
        expanded,
        childCount: kids.length,
        context: !tree.inScope.has(id) || (filtering && !matchesFilter(card, filter)),
      });
      if (expanded) walk(id, depth + 1);
    }
  };
  walk(TOP, 0);
  return rows;
}

/** The selection, in outline order, dropping ids no longer on the list. */
export function boardListSelection(tree: BoardListTree, selected: ReadonlySet<string>): Shells {
  return [...selected]
    .filter((id) => tree.order.has(id))
    .toSorted((left, right) => tree.order.get(left)! - tree.order.get(right)!)
    .map((id) => tree.byId.get(id)!);
}

/** A move a gesture asks for: these cards, under this parent, next to this
    sibling. */
export interface BoardListMoveRequest {
  readonly ids: ReadonlyArray<string>;
  readonly parentId: string | null;
  readonly afterId?: string | undefined;
  readonly beforeId?: string | undefined;
}

export type BoardListStep =
  | { readonly kind: "ok"; readonly request: BoardListMoveRequest; readonly label: string }
  | { readonly kind: "refused"; readonly reason: string };

function sharedParent(cards: Shells): string | null | undefined {
  const parentOf = (card: BoardCardShell) =>
    card.parentCardId === undefined ? null : String(card.parentCardId);
  const first = parentOf(cards[0]!);
  return cards.every((card) => parentOf(card) === first) ? first : undefined;
}

/** Indent: the selection goes under the sibling above the first selected card.
    With a filter on, pass the visible ids: a hidden sibling is never a target. */
export function boardListIndent(
  tree: BoardListTree,
  selected: ReadonlySet<string>,
  visible?: ReadonlySet<string>,
): BoardListStep {
  const cards = boardListSelection(tree, selected);
  if (cards.length === 0) return { kind: "refused", reason: "Select cards first" };
  const parentId = sharedParent(cards);
  if (parentId === undefined)
    return { kind: "refused", reason: "Select cards that share a parent" };
  const siblings = boardListChildren(tree, parentId);
  const ids = new Set(cards.map((card) => String(card.cardId)));
  const first = siblings.findIndex((card) => ids.has(String(card.cardId)));
  for (let index = first - 1; index >= 0; index--) {
    const target = siblings[index]!;
    if (ids.has(String(target.cardId))) continue;
    if (visible !== undefined && !visible.has(String(target.cardId))) continue;
    return {
      kind: "ok",
      request: { ids: [...ids], parentId: String(target.cardId) },
      label: `Indent under ${target.key} · ${target.title}`,
    };
  }
  return { kind: "refused", reason: "Nothing above to indent under" };
}

/** Outdent: the selection goes directly after its parent, one level up. */
/** `allShells` includes hidden projects: a card whose group is in one is
    still inside it, though the tree draws it at the top level. */
export function boardListOutdent(
  tree: BoardListTree,
  selected: ReadonlySet<string>,
  allShells: Shells,
): BoardListStep {
  const cards = boardListSelection(tree, selected);
  if (cards.length === 0) return { kind: "refused", reason: "Select cards first" };
  const parentId = sharedParent(cards);
  if (parentId === null) return { kind: "refused", reason: "Already at the top level" };
  if (parentId === undefined)
    return { kind: "refused", reason: "Select cards that share a parent" };
  const parent =
    tree.byId.get(parentId) ?? allShells.find((card) => String(card.cardId) === parentId);
  if (parent === undefined) return { kind: "refused", reason: "Already at the top level" };
  return {
    kind: "ok",
    request: {
      ids: cards.map((card) => String(card.cardId)),
      parentId: parent.parentCardId === undefined ? null : String(parent.parentCardId),
      afterId: parentId,
    },
    label: `Move out of ${parent.key}`,
  };
}

/** Shift-click: every visible row between the anchor and the clicked one. */
export function boardListRange(
  visibleIds: ReadonlyArray<string>,
  anchorId: string | null,
  id: string,
): ReadonlyArray<string> {
  const from = anchorId === null ? -1 : visibleIds.indexOf(anchorId);
  const to = visibleIds.indexOf(id);
  if (from < 0 || to < 0) return [id];
  return visibleIds.slice(Math.min(from, to), Math.max(from, to) + 1);
}

export type BoardListDropZone = "before" | "into" | "after";

/** The top and bottom 28% of a row drop beside it; the middle nests inside. */
const BOARD_LIST_EDGE_FRACTION = 0.28;

export function boardListDropZone(offsetY: number, height: number): BoardListDropZone {
  const at = height <= 0 ? 0.5 : offsetY / height;
  if (at < BOARD_LIST_EDGE_FRACTION) return "before";
  if (at > 1 - BOARD_LIST_EDGE_FRACTION) return "after";
  return "into";
}

export function boardListDropRequest(
  ids: ReadonlyArray<string>,
  target: BoardCardShell,
  zone: BoardListDropZone,
): BoardListMoveRequest {
  const targetId = String(target.cardId);
  const parentId = target.parentCardId === undefined ? null : String(target.parentCardId);
  if (zone === "into") return { ids, parentId: targetId };
  return zone === "before"
    ? { ids, parentId, beforeId: targetId }
    : { ids, parentId, afterId: targetId };
}

/** The dragged cards and everything under them: no drop lands there. */
export function boardListDragBlocked(
  shells: Shells,
  ids: ReadonlyArray<string>,
): ReadonlySet<string> {
  const blocked = new Set<string>();
  for (const id of ids) {
    blocked.add(id);
    for (const descendant of boardShellDescendants(shells, id)) {
      blocked.add(String(descendant.cardId));
    }
  }
  return blocked;
}

/** "Move to…": Top level, then every card outside the selection's subtrees. */
export function boardListMoveTargets(
  tree: BoardListTree,
  selected: ReadonlySet<string>,
): ReadonlyArray<{ readonly card: BoardCardShell | null; readonly depth: number }> {
  const excluded = boardListDragBlocked(tree.shells, [...selected]);
  const out: Array<{ readonly card: BoardCardShell | null; readonly depth: number }> = [
    { card: null, depth: 0 },
  ];
  const walk = (parentId: string, depth: number) => {
    for (const card of tree.children.get(parentId) ?? []) {
      const id = String(card.cardId);
      if (excluded.has(id)) continue;
      out.push({ card, depth });
      walk(id, depth + 1);
    }
  };
  walk(TOP, 0);
  return out;
}

export interface BoardListMoveInput {
  readonly cardId: BoardCardId;
  readonly cardIds: ReadonlyArray<BoardCardId>;
  readonly parentCardId: BoardCardId | null;
  readonly afterCardId?: BoardCardId;
  readonly beforeCardId?: BoardCardId;
}

export type BoardListMovePlan =
  | { readonly kind: "noop" }
  | { readonly kind: "refused"; readonly reason: string }
  /** The destination is a started leaf: the started-card dialog decides. */
  | { readonly kind: "started"; readonly started: BoardCardShell; readonly moving: Shells }
  | {
      readonly kind: "move";
      readonly input: BoardListMoveInput;
      /** Groups this move empties, each with the stage it reverts to. */
      readonly reverting: ReadonlyArray<{
        readonly card: BoardCardShell;
        readonly stageId: BoardStageId;
      }>;
    };

/**
 * The one move path (the prototype's `tryMove`): the guard rails a human
 * hits, in the order the decider checks them, then the command to send.
 */
export function planBoardListMove(input: {
  readonly shells: Shells;
  readonly stages: BoardState;
  readonly request: BoardListMoveRequest;
}): BoardListMovePlan {
  const { shells, stages, request } = input;
  const byId = new Map(shells.map((card) => [String(card.cardId), card] as const));
  const movers = request.ids.flatMap((id) => {
    const card = byId.get(id);
    return card === undefined ? [] : [card];
  });
  if (movers.length === 0) return { kind: "noop" };
  const parent = request.parentId === null ? null : (byId.get(request.parentId) ?? null);
  if (request.parentId !== null && parent === null) {
    return { kind: "refused", reason: "That card is no longer on the board." };
  }
  const moverIds = new Set(movers.map((card) => String(card.cardId)));
  const roots = movers.filter(
    (mover) =>
      !boardShellAncestors(shells, mover).some((ancestor) => moverIds.has(String(ancestor.cardId))),
  );
  if (parent !== null) {
    const parentId = String(parent.cardId);
    const inside = roots.some(
      (mover) =>
        String(mover.cardId) === parentId ||
        boardShellDescendants(shells, String(mover.cardId)).some(
          (descendant) => String(descendant.cardId) === parentId,
        ),
    );
    if (inside) return { kind: "refused", reason: "A card can't move inside itself." };
  }
  const arriving = roots.flatMap((root) => [
    root,
    ...boardShellDescendants(shells, String(root.cardId)),
  ]);
  if (parent !== null) {
    const owner =
      boardShellGroup(shells, parent)?.target === "own"
        ? parent
        : (boardShellAncestors(shells, parent).find(
            (ancestor) => boardShellGroup(shells, ancestor)?.target === "own",
          ) ?? null);
    const foreign =
      owner === null ? undefined : arriving.find((card) => card.projectId !== owner.projectId);
    if (owner !== null && foreign !== undefined) {
      return {
        kind: "refused",
        reason: `Can't put ${foreign.key} under ${parent.key}: it's in another project, and the integration branch of ${owner.key} lives in that card's repository.`,
      };
    }
  }
  const destination = parent === null ? BOARD_TRUNK_LABEL : boardGroupTargetLabel(shells, parent);
  // A descendant keeps its target when an own-branch group sits between it and the mover.
  const keepsTarget = (card: BoardCardShell) => {
    if (moverIds.has(String(card.cardId))) return false;
    for (const ancestor of boardShellAncestors(shells, card)) {
      if (boardShellGroup(shells, ancestor)?.target === "own") return true;
      if (moverIds.has(String(ancestor.cardId))) return false;
    }
    return false;
  };
  const retargeted = arriving.find(
    (card) =>
      isBoardShellStarted(shells, stages, card) &&
      !keepsTarget(card) &&
      boardCardLandsOnLabel(shells, card) !== destination,
  );
  if (retargeted !== undefined) {
    const into = parent === null ? "to the top level" : `into ${parent.key}`;
    const merges =
      parent === null ? "top-level cards merge into" : `${parent.key}'s children merge into`;
    return {
      kind: "refused",
      reason: `Can't move ${retargeted.key} ${into}. It's built on ${boardCardLandsOnLabel(shells, retargeted)}, and ${merges} ${destination}. Rebase onto ${destination} first.`,
    };
  }
  if (
    parent !== null &&
    !isBoardGroupShell(shells, parent) &&
    isBoardShellStarted(shells, stages, parent)
  ) {
    return { kind: "started", started: parent, moving: movers };
  }
  // An own-branch group's children are materialised work, from the floor onward.
  const floor = boardStageBeforeBuild(stages);
  if (parent !== null && floor !== null && boardShellGroup(shells, parent)?.target === "own") {
    const early = roots.find(
      (root) =>
        !isBoardDeferredStage(root.stage) &&
        boardStageIndex(stages, root.stage) < boardStageIndex(stages, floor.stageId),
    );
    if (early !== undefined) {
      return {
        kind: "refused",
        reason: `${parent.key} has its own integration branch, so its cards live from ${floor.label} onward. Move ${early.key} to ${floor.label} first.`,
      };
    }
  }
  const anchorId = request.beforeId ?? request.afterId;
  const anchor = anchorId === undefined || moverIds.has(anchorId) ? undefined : byId.get(anchorId);
  const parentKey = parent === null ? undefined : String(parent.cardId);
  const anchorUsable =
    anchor !== undefined &&
    (anchor.parentCardId === undefined ? undefined : String(anchor.parentCardId)) === parentKey;
  const cardIds = movers.map((card) => card.cardId);
  const reverting = [
    ...new Set(
      movers.flatMap((card) =>
        card.parentCardId === undefined || String(card.parentCardId) === parentKey
          ? []
          : [String(card.parentCardId)],
      ),
    ),
  ].flatMap((oldParentId) => {
    const old = byId.get(oldParentId);
    if (old === undefined || old.group === undefined || old.group.heading) return [];
    const left = boardShellChildren(shells, oldParentId).filter(
      (child) => !moverIds.has(String(child.cardId)),
    );
    if (left.length > 0) return [];
    return [
      { card: old, stageId: boardGroupRevertStage(stages, { stage: old.stage, group: old.group }) },
    ];
  });
  return {
    kind: "move",
    input: {
      cardId: cardIds[0]!,
      cardIds,
      parentCardId: parent === null ? null : parent.cardId,
      ...(anchorUsable && request.beforeId !== undefined ? { beforeCardId: anchor.cardId } : {}),
      ...(anchorUsable && request.beforeId === undefined ? { afterCardId: anchor.cardId } : {}),
    },
    reverting,
  };
}

/** The selected ids still shown; the same set back when none are hidden. */
export function boardListVisibleSelection(
  selected: ReadonlySet<string>,
  visibleIds: ReadonlyArray<string>,
): ReadonlySet<string> {
  if (selected.size === 0) return selected;
  const visible = new Set(visibleIds);
  const shown = [...selected].filter((id) => visible.has(id));
  return shown.length === selected.size ? selected : new Set(shown);
}

/** Stage filter rows: every stage then Deferred, each with its count. */
export function boardListStageCounts(tree: BoardListTree): ReadonlyMap<string, number> {
  const counts = new Map<string, number>();
  for (const id of tree.inScope) {
    const card = tree.byId.get(id);
    if (card === undefined) continue;
    counts.set(card.stage, (counts.get(card.stage) ?? 0) + 1);
  }
  return counts;
}

/**
 * The slice of rows a virtualised list renders for a scroll position. The
 * scroll offset is clamped to the rows that exist, so a list that shrinks
 * under a stale scroll position still shows its last rows, never a blank band.
 */
export function boardListRowWindow(input: {
  readonly scrollTop: number;
  readonly viewportHeight: number;
  readonly rowCount: number;
  readonly rowHeight: number;
  readonly overscan: number;
}): { readonly start: number; readonly end: number } {
  const { viewportHeight, rowCount, rowHeight, overscan } = input;
  const maxScroll = Math.max(0, rowCount * rowHeight - viewportHeight);
  const scrollTop = Math.min(Math.max(0, input.scrollTop), maxScroll);
  const start = Math.max(0, Math.floor(scrollTop / rowHeight) - overscan);
  const end = Math.min(rowCount, Math.ceil((scrollTop + viewportHeight) / rowHeight) + overscan);
  return { start, end };
}
