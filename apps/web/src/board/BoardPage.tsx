/**
 * T3o board surface (t3o-05): mode tabs and project scope in a board-owned
 * top bar, the eight stage columns, and drag ordering.
 *
 * Every ordering number comes from `@t3tools/client-runtime` (t3o-04):
 * `compareBoardCardShells` orders columns, `boardColumnAppendOrderKey`
 * appends, `planBoardCardReorder` prices a drop, and the optimistic
 * placement overlay reconciles against the shell stream. This file decides
 * *when* to dispatch, never *what number* to store.
 */
import {
  BoardCardId,
  BOARD_SEED_STAGES,
  areBoardStagesAdjacent,
  boardStageWithRole,
  deriveBoardCardPlanProgress,
  boardCardShellPendingSplit,
  deriveBoardCardThreadState,
  resolveBoardProjectAccent,
  type BoardCardShell,
  type BoardCardThreadShell,
  type BoardStageDefinition,
  type BoardStageId,
  type BoardState,
  type EnvironmentId,
  type ProjectId,
  type ThreadId,
} from "@t3tools/contracts";
import {
  applyBoardCardPlacements,
  boardBuildingQueueInfo,
  isBoardCardPlacementSettled,
  mergeBoardStageColumns,
  planBoardCardReorder,
  type BoardCardPlacement,
  type BoardStageColumns,
} from "@t3tools/client-runtime/state/shell";
import { isAtomCommandInterrupted } from "@t3tools/client-runtime/state/runtime";
import { useAtomValue } from "@effect/atom-react";
import { useNavigate, useSearch } from "@tanstack/react-router";
import { ArchiveIcon, ChevronLeftIcon, PlusIcon, TriangleAlertIcon } from "lucide-react";
import * as Option from "effect/Option";
import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent } from "react";

import { Button } from "../components/ui/button";
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "../components/ui/select";
import { SidebarInset } from "../components/ui/sidebar";
import { toastManager } from "../components/ui/toast";
import { isElectron } from "../env";
import { cn } from "../lib/utils";
import { environmentShell } from "../state/shell";
import { boardEnvironment } from "../state/board";
import { usePrimaryEnvironmentId } from "../state/environments";
import { usePrimarySettings } from "../hooks/useSettings";
import { useAtomCommand } from "../state/use-atom-command";
import { COLLAPSED_SIDEBAR_TITLEBAR_INSET_CLASS } from "../workspaceTitlebar";
import { BoardArchivedCardsSheet, refreshBoardArchivedCards } from "./BoardArchivedCardsSheet";
import { BoardCardCreateDialog } from "./BoardCardCreateDialog";
import { describeBoardCommandFailure } from "./boardCommandFeedback";
import { BoardCardDetail } from "./BoardCardDetail";
import type { BoardCardTodoContext } from "./BoardCardItem";
import { BoardColumn, BOARD_CARD_GAP } from "./BoardColumn";
import { indexBoardLabels } from "./labelColour";
import { BoardModeTabs } from "./BoardModeTabs";
import {
  boardScopeCollapseKey,
  boardScopeStages,
  filterBoardColumnsByScope,
  isBoardCardInScope,
  resolveSubBoardEntry,
  ROOT_BOARD_SCOPE,
  type BoardScope,
} from "./boardScope";
import { BoardSubBoardHeader } from "./BoardSubBoardHeader";
import { isBoardColumnCollapsed, useBoardUiStore } from "./boardUiStore";
import { projectAccent } from "./projectAccent";
import type { BoardSearch } from "../routes/board";

const EMPTY_COLUMNS: BoardStageColumns = mergeBoardStageColumns([]);
const EMPTY_CARDS: ReadonlyArray<BoardCardShell> = [];
const EMPTY_CARD_THREADS: ReadonlyArray<BoardCardThreadShell> = [];

const ALL_PROJECTS = "__all__";

/** A `BoardState` view over a bare ordered stage list, so the read-model stage
    helpers (`areBoardStagesAdjacent`, `boardStageWithRole`, …) apply. */
function stageStateOf(stages: ReadonlyArray<BoardStageDefinition>): BoardState {
  return { cards: [], stages, nextCardNumberByProject: {} };
}

interface FoundCard {
  readonly stage: BoardStageId;
  readonly card: BoardCardShell;
}

function findBoardCard(columns: BoardStageColumns, cardId: string | null): FoundCard | null {
  if (cardId === null) return null;
  for (const [stage, cards] of Object.entries(columns)) {
    const card = cards.find((existing) => existing.cardId === cardId);
    if (card !== undefined) return { stage: stage as BoardStageId, card };
  }
  return null;
}

interface BoardDrag {
  readonly cardId: string;
  readonly height: number;
}

interface BoardDragOver {
  readonly stage: BoardStageId;
  readonly index: number;
}

/**
 * The insertion index a pointer at `y` maps to within a column element,
 * measured in the cards' "unshifted" coordinates: any card sitting below the
 * inserted placeholder is offset by its height, so we subtract that before
 * comparing midpoints — otherwise inserting the placeholder shifts the cards
 * and the next dragover computes a different index, flickering. (Ported from
 * the prototype's `dropIndexIn`.)
 */
function boardDropIndexIn(columnEl: Element, y: number): number {
  const placeholder = columnEl.querySelector("[data-board-ph]");
  const cards = columnEl.querySelectorAll("[data-board-card]");
  if (cards.length === 0) return 0;
  let shift = 0;
  let placeholderTop: number | null = null;
  if (placeholder !== null) {
    const rect = placeholder.getBoundingClientRect();
    shift = rect.height + BOARD_CARD_GAP;
    placeholderTop = rect.top;
  }
  for (let index = 0; index < cards.length; index++) {
    const rect = cards[index]!.getBoundingClientRect();
    const offset = placeholderTop !== null && rect.top > placeholderTop ? shift : 0;
    if (y < rect.top + rect.height / 2 - offset) return index;
  }
  return cards.length;
}

export function BoardPage({
  scope = ROOT_BOARD_SCOPE,
}: {
  /** Which board this mount is (t3o-25, D1): the root board, or one parent's
      sub-board. The scope is data — the surface below is the same code. */
  readonly scope?: BoardScope;
} = {}) {
  const environmentId = usePrimaryEnvironmentId();
  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none bg-background text-foreground">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-x-hidden bg-background">
        <header
          className={cn(
            "workspace-topbar shrink-0 gap-2 px-3 sm:px-5",
            isElectron && "drag-region",
            COLLAPSED_SIDEBAR_TITLEBAR_INSET_CLASS,
          )}
        >
          <BoardModeTabs mode="board" />
        </header>
        {environmentId === null ? (
          <div className="flex flex-1 items-center justify-center">
            <p className="text-sm text-muted-foreground">No connected environment.</p>
          </div>
        ) : (
          <EnvironmentBoard environmentId={environmentId} scope={scope} />
        )}
      </div>
    </SidebarInset>
  );
}

function EnvironmentBoard({
  environmentId,
  scope,
}: {
  readonly environmentId: EnvironmentId;
  readonly scope: BoardScope;
}) {
  // Both board routes carry the same search grammar (`validateBoardSearch`),
  // so the non-strict read is safe on either mount.
  const search = useSearch({ strict: false }) as BoardSearch;
  const navigate = useNavigate();
  /** Update the current route's search params in place — the scope (the
      path) never changes here, only the selection/filter state riding it. */
  const patchSearch = useCallback(
    (updater: (previous: BoardSearch) => BoardSearch) => {
      void navigate({
        to: ".",
        search: (previous: BoardSearch) => updater(previous),
      });
    },
    [navigate],
  );
  // Both drill-in and breadcrumb-back CARRY `?project` (a sub-board ignores
  // it — its project is the parent's — but keeping it in the URL means the
  // round trip lands back on the root board the user left, not "All
  // projects"). `?card` and `?stalled` are per-board state and drop.
  const openSubBoard = useCallback(
    (parentCardId: string, cardId?: string, options?: { readonly replace?: boolean }) => {
      void navigate({
        to: "/board/$parentCardId",
        params: { parentCardId },
        search: (previous: BoardSearch) => ({
          ...(previous.project === undefined ? {} : { project: previous.project }),
          ...(cardId === undefined ? {} : { card: cardId }),
        }),
        replace: options?.replace === true,
      });
    },
    [navigate],
  );
  const openRootBoard = useCallback(
    (cardId?: string, options?: { readonly replace?: boolean }) => {
      void navigate({
        to: "/board",
        search: (previous: BoardSearch) => ({
          ...(previous.project === undefined ? {} : { project: previous.project }),
          ...(cardId === undefined ? {} : { card: cardId }),
        }),
        replace: options?.replace === true,
      });
    },
    [navigate],
  );
  const shellState = useAtomValue(environmentShell.stateValueAtom(environmentId));
  const cardsByProject = useAtomValue(boardEnvironment.cardsByProjectAtom(environmentId));
  const labelCatalogue = useAtomValue(boardEnvironment.labelCatalogueAtom(environmentId));
  const labelsById = useMemo(() => indexBoardLabels(labelCatalogue), [labelCatalogue]);
  const moveCard = useAtomCommand(boardEnvironment.moveCard);
  const reorderCard = useAtomCommand(boardEnvironment.reorderCard);

  const collapsedByStage = useBoardUiStore((state) => state.collapsedByStage);
  const setColumnCollapsed = useBoardUiStore((state) => state.setColumnCollapsed);

  // The user-defined stage list drives column order and labels (D13); falls
  // back to the compiled seeds until the first shell snapshot arrives.
  const stageList = useAtomValue(boardEnvironment.stageListAtom(environmentId));
  const orderedStages = stageList.length > 0 ? stageList : BOARD_SEED_STAGES;
  const stageState = useMemo(() => stageStateOf(orderedStages), [orderedStages]);
  const buildStageId = boardStageWithRole(stageState, "build")?.stageId ?? null;
  // The columns this SCOPE renders (t3o-25, D1): every stage on the root
  // board, the materialisation floor onward inside a sub-board. Stage
  // adjacency and ordering keep reading the FULL `stageState` — the stages a
  // sub-board hides still exist.
  const renderedStages = useMemo(
    () => boardScopeStages(orderedStages, stageState, scope),
    [orderedStages, stageState, scope],
  );
  const firstStageId = renderedStages[0]?.stageId ?? null;
  /** Collapse state keys on `(scope, stageId)` (D1), and only the ROOT
      board's first column defaults to the collapsed rail — a sub-board's
      first column is the floor its children queue in. */
  const collapseKeyOf = useCallback(
    (stageId: string) => boardScopeCollapseKey(scope, stageId),
    [scope],
  );
  const handleSetCollapsed = useCallback(
    (stageId: BoardStageId, collapsed: boolean) =>
      setColumnCollapsed(boardScopeCollapseKey(scope, stageId), collapsed),
    [scope, setColumnCollapsed],
  );

  // Board settings (t3o-07): the per-project key prefix used when creating a
  // card, and the configured accent used to colour a project's cards. Read
  // once here and threaded down, rather than subscribed per card.
  const boardSettings = usePrimarySettings((settings) => settings.board);
  const accentNameFor = useCallback(
    (projectId: ProjectId) => resolveBoardProjectAccent(boardSettings, projectId),
    [boardSettings],
  );

  const projects = useMemo(
    () => Option.getOrNull(shellState.snapshot)?.projects ?? [],
    [shellState.snapshot],
  );
  // `?project` scopes the ROOT board only — a sub-board's project is implied
  // by its parent, so the param is ignored there rather than double-filtering.
  const scopeProjectId =
    scope.kind === "root" ? ((search.project ?? null) as ProjectId | null) : null;
  // A stale deep link (project deleted, or another environment's id) still
  // needs a visible scope so the user can switch back to All projects.
  const scopeIsStale =
    scopeProjectId !== null &&
    projects.length > 0 &&
    !projects.some((project) => project.id === scopeProjectId);

  const liveColumns = useMemo(() => {
    if (scopeProjectId !== null) {
      return cardsByProject.get(scopeProjectId) ?? EMPTY_COLUMNS;
    }
    return mergeBoardStageColumns(cardsByProject.values());
  }, [cardsByProject, scopeProjectId]);

  // Optimistic drop placements: applied over the live shells immediately,
  // pruned as the server's deltas confirm them, removed on rejection.
  const [placements, setPlacements] = useState<ReadonlyArray<BoardCardPlacement>>([]);
  useEffect(() => {
    setPlacements((current) => {
      if (current.length === 0) return current;
      const remaining = current.filter(
        (placement) => !isBoardCardPlacementSettled(liveColumns, placement),
      );
      return remaining.length === current.length ? current : remaining;
    });
  }, [liveColumns]);
  const placedColumns = useMemo(
    () => applyBoardCardPlacements(liveColumns, placements),
    [liveColumns, placements],
  );

  // Sub-board pips (t3o-23, D6): `planTotal` / `planDone` are DERIVED here,
  // client-side, from the children the shell already carries — the server
  // never produces them. Injected onto the parents' shells so the summary /
  // progress-block chain (which predates the data) lights up unchanged.
  // `parentKeyById` feeds the children's "part of <key>" chip.
  const { columns, parentKeyById, cardKeyById } = useMemo(() => {
    const cards = Object.values(placedColumns).flat();
    const progress = deriveBoardCardPlanProgress({ cards, stages: orderedStages });
    const keyById = new Map(cards.map((card) => [String(card.cardId), card.key]));
    const parents = new Map<string, string>();
    for (const card of cards) {
      if (card.parentCardId === undefined) continue;
      const parentKey = keyById.get(String(card.parentCardId));
      if (parentKey !== undefined) parents.set(String(card.cardId), parentKey);
    }
    if (progress.size === 0) {
      return { columns: placedColumns, parentKeyById: parents, cardKeyById: keyById };
    }
    const decorated = Object.fromEntries(
      Object.entries(placedColumns).map(([stageId, stageCards]) => [
        stageId,
        stageCards.map((card) => {
          const counts = progress.get(card.cardId);
          return counts === undefined
            ? card
            : { ...card, planTotal: counts.total, planDone: counts.done };
        }),
      ]),
    ) as typeof placedColumns;
    return { columns: decorated, parentKeyById: parents, cardKeyById: keyById };
  }, [placedColumns, orderedStages]);
  const parentKeyFor = useCallback(
    // Inside a sub-board every card is the same parent's child, so the chip
    // would be forty copies of the header — resolve nothing there (D2).
    (cardId: string) => (scope.kind === "root" ? parentKeyById.get(cardId) : undefined),
    [parentKeyById, scope],
  );
  // Awaiting split approval (t3o-27) — derived client-side from the shell +
  // stage list, no extra payload (a child card carries `parentCardId` and so
  // is never pending). Amber "Needs approval" on the card face.
  const pendingSplitFor = useCallback(
    (card: BoardCardShell) => boardCardShellPendingSplit(card, orderedStages),
    [orderedStages],
  );

  // The parent this sub-board drills into, as a live (decorated) shell — null
  // on the root board, and null again the moment the parent leaves the live
  // board (the D3 redirect below takes over).
  const parentShell = useMemo(
    () =>
      scope.kind === "sub-board"
        ? (findBoardCard(columns, scope.parentCardId)?.card ?? null)
        : null,
    [columns, scope],
  );

  const buildColumn = buildStageId === null ? EMPTY_CARDS : (columns[buildStageId] ?? EMPTY_CARDS);
  const queueSlots = useMemo(() => boardBuildingQueueInfo(buildColumn), [buildColumn]);

  // ── Card todo strips (t3o-18) ────────────────────────────────────────
  // The card→thread links and their cached lists ride the shell snapshot as
  // their own array; everything else the strip needs — the thread's title and
  // whether it is running or waiting — is joined here from the thread shells the
  // client already holds. Nothing is duplicated onto the wire, and no card opens
  // a subscription.
  const cardThreadsByCard = useAtomValue(boardEnvironment.cardThreadsByCardAtom(environmentId));
  const threadShellsById = useMemo(() => {
    const shells = Option.getOrNull(shellState.snapshot)?.threads ?? [];
    return new Map(shells.map((thread) => [thread.id, thread]));
  }, [shellState.snapshot]);
  // Which cards have their extra threads revealed. In-memory and session-scoped
  // (D9): a collapse preference has near-zero value across reloads, and persisted
  // board UI state has already caused a navigation bug in this codebase.
  const [expandedThreadCards, setExpandedThreadCards] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const toggleCardThreads = useCallback((cardId: string) => {
    setExpandedThreadCards((current) => {
      const next = new Set(current);
      if (!next.delete(cardId)) next.add(cardId);
      return next;
    });
  }, []);
  const todoThreadStateOf = useCallback(
    (threadId: ThreadId) => {
      const shell = threadShellsById.get(threadId);
      if (shell === undefined) return undefined;
      const { threadState, awaitingInput } = deriveBoardCardThreadState(shell);
      return {
        awaitingInput,
        running: threadState === "working",
        stopped: threadState === "stopped" || threadState === "none",
      };
    },
    [threadShellsById],
  );
  const todoThreadTitleOf = useCallback(
    (threadId: ThreadId) => threadShellsById.get(threadId)?.title ?? "Thread",
    [threadShellsById],
  );
  const todosFor = useCallback(
    (cardId: string): BoardCardTodoContext => ({
      threads: cardThreadsByCard.get(BoardCardId.make(cardId)) ?? EMPTY_CARD_THREADS,
      stateOf: todoThreadStateOf,
      titleOf: todoThreadTitleOf,
      expanded: expandedThreadCards.has(cardId),
      onToggleExpanded: () => toggleCardThreads(cardId),
    }),
    [
      cardThreadsByCard,
      expandedThreadCards,
      todoThreadStateOf,
      todoThreadTitleOf,
      toggleCardThreads,
    ],
  );

  // Stalled cards (t3o-17, D3): the "find every stalled card" affordance. Count
  // them across every column, and when the `stalled` filter is on, show only
  // the cards recovery gave up on — so a human never has to open forty cards to
  // find the one that needs rescuing.
  // Scope filtering (t3o-25, D1): the root board renders top-level cards, a
  // sub-board renders one parent's children. Like the stalled filter below,
  // this thins what RENDERS while `columns` stays the full ordering substrate
  // — a drop between two visible cards anchors into the real column, so
  // hidden cards keep their order.
  const scopedColumns = useMemo(() => filterBoardColumnsByScope(columns, scope), [columns, scope]);
  const showStalledOnly = search.stalled === true;
  const stalledCount = useMemo(
    () =>
      Object.values(scopedColumns).reduce(
        (total, cards) => total + cards.filter((card) => card.stalled).length,
        0,
      ),
    [scopedColumns],
  );
  const visibleColumns = useMemo(() => {
    if (!showStalledOnly) return scopedColumns;
    return Object.fromEntries(
      Object.entries(scopedColumns).map(([stageId, cards]) => [
        stageId,
        cards.filter((card) => card.stalled),
      ]),
    ) as typeof scopedColumns;
  }, [scopedColumns, showStalledOnly]);

  // ── Drag (native HTML5, the prototype's model) ──────────────────────
  // dnd-kit's sortable transforms were incompatible with the virtualised
  // list — cards vanished mid-drag and no gap opened. Native drag carries a
  // tilted ghost clone; each column measures the drop index and opens a
  // placeholder gap; the drop reuses the command layer below.
  const [drag, setDrag] = useState<BoardDrag | null>(null);
  const [dragOver, setDragOver] = useState<BoardDragOver | null>(null);
  const ghostRef = useRef<HTMLElement | null>(null);
  const dragRef = useRef<BoardDrag | null>(null);

  const clearGhost = useCallback(() => {
    if (ghostRef.current !== null) {
      ghostRef.current.remove();
      ghostRef.current = null;
    }
  }, []);

  // Prices and dispatches a settled order for one column: the optimistic
  // placement lands first, then the move/reorder commands, with rejection
  // rollback and the Building queue toast. Shared by drop and (future) keyboard.
  const dispatchDrop = useCallback(
    (targetStage: BoardStageId, orderedIds: ReadonlyArray<string>, source: FoundCard) => {
      const cardId = source.card.cardId as string;
      const isMove = targetStage !== source.stage;
      if (!isMove) {
        const currentIds = (columns[targetStage] ?? EMPTY_CARDS).map(
          (card) => card.cardId as string,
        );
        if (
          orderedIds.length === currentIds.length &&
          orderedIds.every((id, index) => id === currentIds[index])
        ) {
          return;
        }
      }

      const keysByCardId = new Map<string, string>(
        (columns[targetStage] ?? EMPTY_CARDS).map((card) => [card.cardId as string, card.orderKey]),
      );
      keysByCardId.set(cardId, source.card.orderKey);
      const assignments = planBoardCardReorder({
        orderedCardIds: [...orderedIds],
        keysByCardId,
        movedCardId: cardId,
      });
      if (assignments.length === 0) return;

      // Apply locally first — the drag never blocks on the round trip.
      setPlacements((current) => [
        ...current.filter(
          (placement) => !assignments.some((next) => next.cardId === placement.cardId),
        ),
        ...assignments.map((assignment) => ({
          cardId: assignment.cardId,
          stage: targetStage,
          orderKey: assignment.orderKey,
        })),
      ]);

      const dispatches = assignments.map((assignment) => {
        const command =
          isMove && assignment.cardId === cardId
            ? moveCard({
                environmentId,
                input: {
                  cardId: source.card.cardId,
                  toStage: targetStage,
                  orderKey: assignment.orderKey,
                  // A drag may cross several stages; override forces the
                  // non-adjacent transition (never the dependency gate).
                  ...(areBoardStagesAdjacent(stageState, source.stage, targetStage)
                    ? {}
                    : { override: true }),
                },
              })
            : reorderCard({
                environmentId,
                input: {
                  cardId: BoardCardId.make(assignment.cardId),
                  orderKey: assignment.orderKey,
                },
              });
        return command.then((result) => ({ cardId: assignment.cardId, result }));
      });

      void Promise.all(dispatches).then((settled) => {
        const rejected = settled.filter(
          ({ result }) => result._tag === "Failure" && !isAtomCommandInterrupted(result),
        );
        if (rejected.length > 0) {
          // Never let optimistic state survive a rejected command — and say
          // why it bounced (the decider names the unmet dependency).
          const rejectedIds = new Set(rejected.map(({ cardId: id }) => id));
          setPlacements((current) =>
            current.filter((placement) => !rejectedIds.has(placement.cardId)),
          );
          toastManager.add({
            type: "error",
            title: isMove ? "Move rejected" : "Reorder rejected",
            description: describeBoardCommandFailure(rejected[0]!.result),
          });
          return;
        }
        if (targetStage === "building") {
          // D11: within Building, position is queue priority. Announce the
          // slot the drop landed in — derived from the `queued` field, so
          // this stays silent until t3o-11 populates the queue.
          const movedAssignment = assignments.find((next) => next.cardId === cardId);
          if (movedAssignment === undefined) return;
          const projected = applyBoardCardPlacements(liveColumns, [
            { cardId, stage: targetStage, orderKey: movedAssignment.orderKey },
          ]);
          const slot = boardBuildingQueueInfo(
            buildStageId === null ? EMPTY_CARDS : (projected[buildStageId] ?? EMPTY_CARDS),
          ).get(cardId);
          if (slot !== undefined) {
            toastManager.add({
              type: "success",
              title: slot.startsNext
                ? "Queued — starts next"
                : `Queued at position ${slot.position}`,
              description: `${source.card.key} ${
                slot.startsNext ? "is first in the build queue." : "joins the build queue."
              }`,
            });
          }
        }
      });
    },
    [columns, environmentId, liveColumns, moveCard, reorderCard],
  );

  // Turns a target stage + raw insertion index into the settled card order.
  // The index is measured against the RENDERED cards — `visibleColumns`, which
  // the stalled filter may have thinned — so it is resolved to an anchor card
  // in that same rendered list first, then mapped into the full column. A drop
  // computed in filtered coordinates but spliced into the full list would
  // persist a wrong order server-side, for every client.
  const commitDrop = useCallback(
    (targetStage: BoardStageId, insertIndex: number, cardId: string) => {
      const source = findBoardCard(columns, cardId);
      if (source === null) return;
      const rendered = (visibleColumns[targetStage] ?? EMPTY_CARDS).map(
        (card) => card.cardId as string,
      );
      // The rendered index still counts the dragged card; convert to a slot in
      // the rendered list without it, matching the prototype.
      const renderedOwn = rendered.indexOf(cardId);
      const renderedRest = rendered.filter((id) => id !== cardId);
      let renderedIndex = Math.max(0, Math.min(rendered.length, insertIndex));
      if (renderedOwn >= 0 && renderedIndex > renderedOwn) renderedIndex -= 1;
      // The visible card the drop lands BEFORE anchors the position; past the
      // last visible card appends to the end of the full column.
      const anchor = renderedRest[renderedIndex];
      const ids = (columns[targetStage] ?? EMPTY_CARDS).map((card) => card.cardId as string);
      const list = ids.filter((id) => id !== cardId);
      const index = anchor === undefined ? list.length : Math.max(0, list.indexOf(anchor));
      list.splice(index, 0, cardId);
      dispatchDrop(targetStage, list, source);
    },
    [columns, visibleColumns, dispatchDrop],
  );

  // Keyboard reorder (Ctrl/Cmd+ArrowUp/Down on a focused card): the pointer
  // drag's keyboard analogue. Moves relative to the RENDERED (possibly
  // stalled-filtered) neighbour, anchored into the full column exactly like
  // commitDrop, and commits through the same drop path.
  const handleCardReorder = useCallback(
    (card: BoardCardShell, direction: -1 | 1) => {
      const source = findBoardCard(columns, card.cardId);
      if (source === null) return;
      const rendered = (visibleColumns[source.stage] ?? EMPTY_CARDS).map(
        (candidate) => candidate.cardId as string,
      );
      const renderedIndex = rendered.indexOf(card.cardId);
      const renderedTarget = renderedIndex + direction;
      if (renderedIndex < 0 || renderedTarget < 0 || renderedTarget >= rendered.length) return;
      const anchor = rendered[renderedTarget]!;
      const ids = (columns[source.stage] ?? EMPTY_CARDS).map(
        (candidate) => candidate.cardId as string,
      );
      const list = ids.filter((id) => id !== card.cardId);
      const anchorIndex = list.indexOf(anchor);
      if (anchorIndex < 0) return;
      list.splice(direction > 0 ? anchorIndex + 1 : anchorIndex, 0, card.cardId);
      dispatchDrop(source.stage, list, source);
    },
    [columns, visibleColumns, dispatchDrop],
  );

  const handleCardDragStart = useCallback(
    (card: BoardCardShell, event: DragEvent<HTMLDivElement>) => {
      const element = event.currentTarget;
      const rect = element.getBoundingClientRect();
      event.dataTransfer.effectAllowed = "move";
      try {
        event.dataTransfer.setData("text/plain", card.cardId);
      } catch {
        // Some browsers disallow setData here; the drag still works without it.
      }
      // A tilted, shadowed clone is the drag image (the prototype's ghost). It
      // sits off-screen just long enough for the browser to snapshot it.
      const ghost = element.cloneNode(true) as HTMLElement;
      ghost.classList.remove("opacity-40");
      ghost.style.cssText +=
        `;position:fixed;top:-1000px;left:-1000px;pointer-events:none;opacity:1;width:${rect.width}px;` +
        "transform:rotate(4deg);box-shadow:0 18px 34px -14px rgb(0 0 0 / 55%)";
      document.body.appendChild(ghost);
      ghostRef.current = ghost;
      event.dataTransfer.setDragImage(ghost, event.clientX - rect.left, event.clientY - rect.top);
      setTimeout(clearGhost, 0);

      const source = findBoardCard(columns, card.cardId);
      const startIndex =
        source === null
          ? 0
          : (columns[source.stage] ?? EMPTY_CARDS).findIndex((c) => c.cardId === card.cardId);
      const next: BoardDrag = { cardId: card.cardId, height: Math.round(rect.height) };
      dragRef.current = next;
      setDrag(next);
      setDragOver(source === null ? null : { stage: source.stage, index: startIndex });
    },
    [clearGhost, columns],
  );

  const handleCardDragEnd = useCallback(() => {
    clearGhost();
    dragRef.current = null;
    setDrag(null);
    setDragOver(null);
  }, [clearGhost]);

  const handleColumnDragOver = useCallback((stage: BoardStageId, event: DragEvent<HTMLElement>) => {
    if (dragRef.current === null) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
    const index = boardDropIndexIn(event.currentTarget, event.clientY);
    setDragOver((current) =>
      current !== null && current.stage === stage && current.index === index
        ? current
        : { stage, index },
    );
  }, []);

  const handleColumnDrop = useCallback(
    (stage: BoardStageId, event: DragEvent<HTMLElement>) => {
      event.preventDefault();
      const active = dragRef.current;
      if (active === null) {
        handleCardDragEnd();
        return;
      }
      const index = boardDropIndexIn(event.currentTarget, event.clientY);
      commitDrop(stage, index, active.cardId);
      handleCardDragEnd();
    },
    [commitDrop, handleCardDragEnd],
  );

  // ── Selection and deep link (?card=…) ───────────────────────────────
  const selectedCardId = search.card ?? null;
  const handleSelectCard = useCallback(
    (card: BoardCardShell) => {
      // Native drag doesn't fire a click on the source after a drop, so no
      // click-suppression is needed here.
      patchSearch((previous) => {
        const { card: selected, ...rest } = previous;
        return selected === card.cardId ? rest : { ...rest, card: card.cardId };
      });
    },
    [patchSearch],
  );
  const handleCloseDetail = useCallback(() => {
    patchSearch((previous) => {
      const { card: _card, ...rest } = previous;
      return rest;
    });
  }, [patchSearch]);
  /** The stack affordance on a split parent's face (t3o-25, AC2): clicking it
      drills into that parent's sub-board. */
  const handleOpenSubBoard = useCallback(
    (card: BoardCardShell) => openSubBoard(card.cardId),
    [openSubBoard],
  );

  // Opening a card URL selects the card and brings it into view: expand its
  // column if collapsed, scroll the row into place. The detail pane that
  // opens from this selection is t3o-06's.
  const handledDeepLinkRef = useRef<string | null>(null);
  useEffect(() => {
    const cardId = search.card;
    if (cardId === undefined || handledDeepLinkRef.current === cardId) return;
    const found = findBoardCard(columns, cardId);
    // Out-of-scope cards are the redirect effect's job, not a scroll target.
    if (found === null || !isBoardCardInScope(found.card, scope)) return;
    handledDeepLinkRef.current = cardId;
    const collapseKey = collapseKeyOf(found.stage);
    if (
      isBoardColumnCollapsed(
        collapsedByStage,
        collapseKey,
        scope.kind === "root" && found.stage === firstStageId,
      )
    ) {
      setColumnCollapsed(collapseKey, false);
    }
    // Two frames: the first lets a just-expanded column mount its list.
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        document
          .querySelector(`[data-board-card="${window.CSS.escape(cardId)}"]`)
          ?.scrollIntoView({ block: "nearest", inline: "nearest" });
      });
    });
  }, [collapseKeyOf, collapsedByStage, columns, scope, search.card, setColumnCollapsed]);

  // Cross-scope deep links resolve to the right board (t3o-25, AC4): a child
  // card's URL opened over the root board — or over the wrong sub-board —
  // navigates into its parent's sub-board with the sheet selection intact,
  // and a top-level card's URL opened inside a sub-board goes back up.
  useEffect(() => {
    const cardId = search.card;
    if (cardId === undefined) return;
    const found = findBoardCard(columns, cardId);
    if (found === null || isBoardCardInScope(found.card, scope)) return;
    const parentId = found.card.parentCardId;
    if (parentId !== undefined) {
      openSubBoard(parentId, cardId, { replace: true });
    } else {
      openRootBoard(cardId, { replace: true });
    }
  }, [columns, openRootBoard, openSubBoard, scope, search.card]);

  // Dead sub-board links resolve UP (t3o-25, D3): a URL naming a card with no
  // children lands on the root board with that card's sheet open; a card that
  // does not exist at all lands on the bare root board. Gated on the first
  // snapshot so an empty pre-connection board is never mistaken for either.
  const snapshotArrived = Option.isSome(shellState.snapshot);
  useEffect(() => {
    if (scope.kind !== "sub-board" || !snapshotArrived) return;
    const entry = resolveSubBoardEntry(Object.values(liveColumns).flat(), scope.parentCardId);
    if (entry.kind === "redirect-parent-sheet") {
      openRootBoard(scope.parentCardId, { replace: true });
    } else if (entry.kind === "redirect-root") {
      openRootBoard(undefined, { replace: true });
    }
  }, [liveColumns, openRootBoard, scope, snapshotArrived]);

  // ── Create dialog ───────────────────────────────────────────────────
  // Both the column add buttons and the top-bar button open the same dialog
  // (t3o-06). The dialog owns creation (title, brief, labels, project, stage
  // and initial dependencies land in one atomic create); this only tracks
  // which stage to prefill. Absent means closed.
  const [createStage, setCreateStage] = useState<BoardStageId | null>(null);
  const openCreate = useCallback((stage: BoardStageId) => setCreateStage(stage), []);

  // ── Archive (t3o-13, D7) ────────────────────────────────────────────
  // Archived cards are off the live shell by design, so they need a place to
  // be seen and restored from — otherwise archiving is a one-way door.
  const [archiveOpen, setArchiveOpen] = useState(false);
  const unarchiveCard = useAtomCommand(boardEnvironment.unarchiveCard);
  const handleRestoreCard = useCallback(
    (cardId: BoardCardId) => {
      void unarchiveCard({ environmentId, input: { cardId } }).then((result) => {
        if (result._tag === "Failure") {
          if (isAtomCommandInterrupted(result)) return;
          toastManager.add({
            title: "Could not restore card",
            description: describeBoardCommandFailure(result),
          });
          return;
        }
        // The card is back on the live board; drop it from the archive list.
        refreshBoardArchivedCards(environmentId);
      });
    },
    [environmentId, unarchiveCard],
  );

  // Deleting from the archive: the natural place to decide something is never
  // coming back is the list of things that already went away. The sheet owns
  // the confirmation; this only dispatches and re-reads the list.
  const deleteCard = useAtomCommand(boardEnvironment.deleteCard);
  const handleDeleteCard = useCallback(
    (cardId: BoardCardId) => {
      void deleteCard({ environmentId, input: { cardId } }).then((result) => {
        if (result._tag === "Failure") {
          if (isAtomCommandInterrupted(result)) return;
          toastManager.add({
            title: "Could not delete card",
            description: describeBoardCommandFailure(result),
          });
          return;
        }
        refreshBoardArchivedCards(environmentId);
      });
    },
    [deleteCard, environmentId],
  );

  const addProjects = useMemo(() => {
    // A sub-board creates into its parent's project, nothing else (t3o-25);
    // the root board follows its own `?project` scope.
    const parentProjectId = parentShell?.projectId ?? null;
    const inScope =
      scope.kind === "sub-board"
        ? projects.filter((project) => project.id === parentProjectId)
        : scopeProjectId === null
          ? projects
          : projects.filter((project) => project.id === scopeProjectId);
    return inScope.map((project) => ({ id: project.id, title: project.title }));
  }, [projects, scope.kind, scopeProjectId, parentShell?.projectId]);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 items-center gap-3 px-3 py-2 sm:px-5">
        {scope.kind === "sub-board" ? (
          <>
            {/* Breadcrumb back (t3o-25): the sub-board is a place, so leaving
                it is navigation, not closing something. */}
            <Button
              onClick={() => openRootBoard()}
              size="xs"
              variant="ghost"
              title="Back to the board"
            >
              <ChevronLeftIcon />
              Board
            </Button>
            <BoardSubBoardHeader
              accentName={parentShell === null ? null : accentNameFor(parentShell.projectId)}
              environmentId={environmentId}
              onOpenParentCard={() => openRootBoard(scope.parentCardId)}
              parentCardId={scope.parentCardId}
              parentShell={parentShell}
            />
          </>
        ) : (
          <>
            <Select
              items={[
                { value: ALL_PROJECTS, label: "All projects" },
                ...projects.map((project) => ({
                  value: project.id as string,
                  label: project.title,
                })),
                ...(scopeIsStale ? [{ value: scopeProjectId, label: "Unknown project" }] : []),
              ]}
              modal={false}
              onValueChange={(value: string | null) => {
                patchSearch((previous) => {
                  const { project: _project, ...rest } = previous;
                  return value === null || value === ALL_PROJECTS
                    ? rest
                    : { ...rest, project: value };
                });
              }}
              value={scopeProjectId ?? ALL_PROJECTS}
            >
              <SelectTrigger aria-label="Project scope" size="xs" variant="ghost">
                <span
                  className={cn(
                    "size-2 rounded-full",
                    scopeProjectId === null
                      ? "bg-muted-foreground/40"
                      : projectAccent(scopeProjectId, accentNameFor(scopeProjectId)).dot,
                  )}
                />
                <SelectValue />
              </SelectTrigger>
              <SelectPopup>
                <SelectItem value={ALL_PROJECTS}>All projects</SelectItem>
                {projects.map((project) => (
                  <SelectItem key={project.id} value={project.id}>
                    <span className="inline-flex items-center gap-1.5">
                      <span
                        className={cn(
                          "size-2 rounded-full",
                          projectAccent(project.id, accentNameFor(project.id)).dot,
                        )}
                      />
                      {project.title}
                    </span>
                  </SelectItem>
                ))}
                {scopeIsStale ? (
                  <SelectItem value={scopeProjectId}>Unknown project</SelectItem>
                ) : null}
              </SelectPopup>
            </Select>
            {/* The legend: which colour is which project, for as long as the board
                is showing more than one project's cards. The prototype's swatch is
                a short bar, not the scope picker's dot — the two never read as the
                same control. Shown for a single project too: its colour is on every
                card, so the board still owes you the key to it. */}
            {scopeProjectId === null && projects.length > 0 ? (
              <div className="flex min-w-0 items-center gap-3 overflow-hidden">
                {projects.map((project) => (
                  <span
                    className="inline-flex shrink-0 items-center gap-1.5 text-[11.5px] font-medium text-muted-foreground"
                    key={project.id}
                  >
                    <span
                      className={cn(
                        "h-[3px] w-[9px] shrink-0 rounded-[2px]",
                        projectAccent(project.id, accentNameFor(project.id)).dot,
                      )}
                    />
                    {project.title}
                  </span>
                ))}
              </div>
            ) : null}
          </>
        )}
        <span className="flex-1" />
        {showStalledOnly || stalledCount > 0 ? (
          <Button
            onClick={() =>
              patchSearch((previous) => {
                const { stalled: _stalled, ...rest } = previous;
                return showStalledOnly ? rest : { ...rest, stalled: true };
              })
            }
            size="xs"
            variant={showStalledOnly ? "secondary" : "ghost"}
            title="Show only stalled cards — recovery gave up and a human is needed"
          >
            <TriangleAlertIcon />
            {showStalledOnly ? "Stalled only" : `Stalled ${stalledCount}`}
          </Button>
        ) : null}
        {scope.kind === "root" ? (
          <Button onClick={() => setArchiveOpen(true)} size="xs" variant="ghost">
            <ArchiveIcon />
            Archived
          </Button>
        ) : null}
        {addProjects.length > 0 && firstStageId !== null ? (
          <Button onClick={() => openCreate(firstStageId)} size="xs" variant="secondary">
            <PlusIcon />
            New card
          </Button>
        ) : null}
      </div>
      <div className="flex min-h-0 flex-1">
        {/* `items-start` lets each column size to its cards; a collapsed rail
            opts back into full height with `self-stretch`. The row scrolls in
            both axes, so a column taller than the viewport is reachable. */}
        <div className="flex min-h-0 flex-1 items-start gap-2.5 overflow-auto px-3 pb-3 sm:px-5">
          {renderedStages.map((stage, index) => (
            <BoardColumn
              accentNameFor={accentNameFor}
              parentKeyFor={parentKeyFor}
              pendingSplitFor={pendingSplitFor}
              addProjects={addProjects}
              cards={visibleColumns[stage.stageId] ?? EMPTY_CARDS}
              labelsById={labelsById}
              collapsed={isBoardColumnCollapsed(
                collapsedByStage,
                collapseKeyOf(stage.stageId),
                scope.kind === "root" && index === 0,
              )}
              draggedCardId={drag?.cardId ?? null}
              dragHeight={drag?.height ?? 0}
              dragOverIndex={
                drag !== null && dragOver !== null && dragOver.stage === stage.stageId
                  ? dragOver.index
                  : null
              }
              key={stage.stageId}
              label={stage.label}
              onCardDragEnd={handleCardDragEnd}
              onCardReorder={handleCardReorder}
              onCardDragStart={handleCardDragStart}
              onColumnDragOver={handleColumnDragOver}
              onColumnDrop={handleColumnDrop}
              onOpenSubBoard={scope.kind === "root" ? handleOpenSubBoard : undefined}
              onRequestCreate={openCreate}
              onSelectCard={handleSelectCard}
              onSetCollapsed={handleSetCollapsed}
              queueSlots={queueSlots}
              selectedCardId={selectedCardId}
              todosFor={todosFor}
              stage={stage.stageId}
            />
          ))}
        </div>
      </div>
      {/* The card opens as a centred modal over the board (t3o-06), not a
          rail beside it — so it never squeezes the columns. */}
      {selectedCardId !== null ? (
        <BoardCardDetail
          cardId={BoardCardId.make(selectedCardId)}
          environmentId={environmentId}
          key={selectedCardId}
          onClose={handleCloseDetail}
          onOpenSubBoard={openSubBoard}
        />
      ) : null}
      <BoardArchivedCardsSheet
        environmentId={environmentId}
        liveCardKeyById={cardKeyById}
        onDelete={handleDeleteCard}
        onOpenChange={setArchiveOpen}
        onRestore={handleRestoreCard}
        onSelectCard={(cardId) => {
          setArchiveOpen(false);
          patchSearch((previous) => ({ ...previous, card: cardId }));
        }}
        open={archiveOpen}
        scopeProjectId={scopeProjectId}
      />
      <BoardCardCreateDialog
        defaultProjectId={
          scope.kind === "sub-board" ? (parentShell?.projectId ?? null) : scopeProjectId
        }
        defaultStage={createStage ?? firstStageId ?? BOARD_SEED_STAGES[0]!.stageId}
        environmentId={environmentId}
        onOpenChange={(open) => {
          if (!open) setCreateStage(null);
        }}
        open={createStage !== null}
        projects={addProjects}
        subBoardParentId={scope.kind === "sub-board" ? scope.parentCardId : null}
      />
    </div>
  );
}

export default BoardPage;
