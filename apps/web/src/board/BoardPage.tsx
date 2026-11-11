/**
 * Board surface: top bar, stage columns and drag ordering. Every ordering number
 * comes from `@t3tools/client-runtime`; this file decides when to dispatch, never
 * what number to store.
 */
import {
  BoardCardId,
  BOARD_SEED_STAGES,
  areBoardStagesAdjacent,
  isBoardDeferredStage,
  boardCreateDefaultStage,
  boardStageBeforeBuild,
  boardStageWithRole,
  boardCardWorktreeIsCancelledWork,
  boardCardWorktreeKept,
  boardCardWorktreeKeptReason,
  deriveBoardCardPlanProgress,
  boardCardAttention,
  boardShellAutoMergeArmedByCard,
  deriveBoardCardChildAttention,
  deriveBoardCardChildRunning,
  deriveBoardCardThreadState,
  isBoardMergeStageExecution,
  isBoardProjectHidden,
  resolveBoardStageExecution,
  type BoardCardShell,
  type BoardCardThreadShell,
  type BoardSettings,
  type BoardStageDefinition,
  type BoardStageId,
  type BoardState,
  type BoardProjectStageConfigShell,
  type EnvironmentId,
  type ProjectId,
  type ThreadId,
  assignBoardKeyPrefix,
} from "@t3tools/contracts";
import {
  applyBoardCardPlacements,
  boardBuildQueue,
  boardRunningStepCount,
  boardThreadStateSourceWithSubagents,
  isBoardCardPlacementSettled,
  mergeBoardStageColumns,
  planBoardCardReorder,
  type BoardCardPlacement,
  type BoardStageColumns,
} from "@t3tools/client-runtime/state/shell";
import { isAtomCommandInterrupted } from "@t3tools/client-runtime/state/runtime";
import { useAtomValue } from "@effect/atom-react";
import { useNavigate, useSearch } from "@tanstack/react-router";
import {
  ArchiveIcon,
  ChevronLeftIcon,
  LayersIcon,
  PlusIcon,
  TriangleAlertIcon,
} from "lucide-react";
import * as Option from "effect/Option";
import { useEffect, useRef, useState, type DragEvent } from "react";

import { Button } from "../components/ui/button";
import { SidebarInset } from "../components/ui/sidebar";
import { toastManager } from "../components/ui/toast";
import { isEditableFocused } from "../lib/editableFocus";
import { cn } from "../lib/utils";
import { environmentShell } from "../state/shell";
import { environmentThreadShells } from "../state/threads";
import { boardEnvironment, environmentBoard } from "../state/board";
import { useAtomCommand } from "../state/use-atom-command";
import { BoardArchivedCardsSheet, refreshBoardArchivedCards } from "./BoardArchivedCardsSheet";
import { BoardCardCreateDialog } from "./BoardCardCreateDialog";
import { BoardPlanningExitConfirmDialog } from "./BoardPlanningExitConfirmDialog";
import { boardMoveLeavesPlanningUnwritten } from "./boardStageActions";
import { boardStageLabel } from "./boardStages";
import { countBoardColumnCards, filterBoardColumnsByQuery } from "./boardCardFilter";
import { describeBoardCommandFailure } from "./boardCommandFeedback";
import { BoardCardDetail } from "./BoardCardDetail";
import {
  boardCardMaximisedAfterStep,
  boardCardNavTarget,
  resolveBoardCardNeighbours,
  type BoardCardStep,
} from "./boardCardNav";
import type { BoardCardNav } from "./BoardCardNavRails";
import { useBoardAttentionSettle } from "./boardAttentionSettle";
import { boardCardNoPullRequest } from "./boardCardNotice";
import { boardQueueInfo, type BoardQueueInfo } from "./boardQueueInfo";
import type { BoardCardTodoContext } from "./BoardCardItem";
import { boardShellAutomationNode, resolveBoardShellAutomation } from "./boardCardAutomation";
import { BoardColumn, BOARD_CARD_GAP } from "./BoardColumn";
import { indexBoardLabels } from "./labelColour";
import {
  boardCollapseToggle,
  boardColumnAutoFolded,
  boardColumnCollapsed,
  boardDragOpenedRail,
  boardScopeCollapseKey,
  boardScopeColumnCollapsedByDefault,
  boardScopeQueryKey,
  boardScopeStages,
  filterBoardColumnsByScope,
  livePeekedColumns,
  isBoardCardInScope,
  resolveSubBoardEntry,
  ROOT_BOARD_SCOPE,
  type BoardScope,
} from "./boardScope";
import { BoardSubBoardHeader } from "./BoardSubBoardHeader";
import { BoardProjectScopeSelect } from "./BoardProjectScopeSelect";
import { BoardHint } from "./BoardHint";
import { BoardGroupStartDialog, BoardNewPhaseDialog } from "./BoardGroupDialogs";
import {
  boardDropRefusal,
  boardGroupCardVm,
  boardShellAncestors,
  boardShellGroup,
  isBoardGroupShell,
} from "./boardGroups";
import { boardCardStageGoneNotes, boardPipelineColumns } from "./boardProjectPipelines";
import { BOARD_UTILITY_MENU_RESERVED_SPACE, BoardUtilityMenu } from "./BoardUtilityMenu";
import { BoardSubBoardPlanStrip } from "./BoardSubBoardPlanStrip";
import { BoardCardFilterField, BoardTopBar } from "./BoardTopBar";
import { isBoardColumnCollapsed, useBoardUiStore } from "./boardUiStore";
import { projectAccent, projectIconColorOf } from "./projectAccent";
import { BoardWorkersContext, useBoardWorkersCardView } from "./workers/BoardWorkersContext";
import { boardQueueReason } from "./workers/cardWorker";
import { BoardWorkersAttentionPill } from "./workers/BoardWorkersAttentionPill";
import { validateBoardSearch, type BoardSearch } from "../routes/board";
import { BoardServerUnavailableNotice } from "./BoardServerSettings";
import { useBoardEnvironment, useBoardSettings } from "./useBoardEnvironmentId";

const EMPTY_COLUMNS: BoardStageColumns = mergeBoardStageColumns([]);
const EMPTY_CARDS: ReadonlyArray<BoardCardShell> = [];
const EMPTY_QUEUE_INFO: ReadonlyMap<string, BoardQueueInfo> = new Map();
const EMPTY_CARD_THREADS: ReadonlyArray<BoardCardThreadShell> = [];

/** A `BoardState` view over a bare ordered stage list, so the read-model stage
    helpers (`areBoardStagesAdjacent`, `boardStageWithRole`, …) apply. */
function stageStateOf(
  stages: ReadonlyArray<BoardStageDefinition>,
  projectStageConfigs?: Readonly<Record<string, BoardProjectStageConfigShell>>,
): BoardState {
  return {
    cards: [],
    stages,
    nextCardNumberByProject: {},
    // The stage helpers read a project's switches and overrides, which the
    // shell carries; prompts and step bodies they never read.
    ...(projectStageConfigs === undefined
      ? {}
      : {
          projectStageConfigs: projectStageConfigs as unknown as BoardState["projectStageConfigs"],
        }),
  };
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
 * The insertion index a pointer at `y` maps to, in the cards' unshifted
 * coordinates: cards below the placeholder are offset by its height first, or
 * the next dragover computes a different index and flickers.
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

function BoardPage({
  scope = ROOT_BOARD_SCOPE,
}: {
  /** Which board this mount is: the root board, or one parent's
      sub-board. The scope is data — the surface below is the same code. */
  readonly scope?: BoardScope;
} = {}) {
  // The board server this device nominated, or the primary environment.
  const board = useBoardEnvironment();
  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none bg-background text-foreground">
      {/* The corner menu is chrome, not board content: it belongs to every
          branch of this surface, connected or not, root board or sub-board. */}
      <BoardUtilityMenu />
      <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-x-hidden bg-background">
        {/* With no environment the bar carries the brand and the mode tabs
            alone: nothing to filter, nothing to create — but the way back to
            threads still has to be on screen. The connected board renders its
            own bar, with those controls in it. */}
        {board.kind === "ready" ? (
          <EnvironmentBoard environmentId={board.environmentId} scope={scope} />
        ) : (
          <>
            <BoardTopBar />
            <div className="flex flex-1 items-center justify-center p-6">
              {board.kind === "unavailable" ? (
                <div className="w-full max-w-md">
                  <BoardServerUnavailableNotice label={board.label} />
                </div>
              ) : (
                <p className="text-sm text-muted-foreground">No connected environment.</p>
              )}
            </div>
          </>
        )}
      </div>
    </SidebarInset>
  );
}

/**
 * The board's live columns, through the attention settle. A hook of its own so
 * its results reach the page frozen: the compiler drops the cache of any value
 * the page later passes to a call after one of its hooks.
 */
function useBoardLiveColumns({
  environmentId,
  boardSettings,
  scopeProjectId,
  orderedStages,
}: {
  readonly environmentId: EnvironmentId;
  readonly boardSettings: BoardSettings;
  readonly scopeProjectId: ProjectId | null;
  readonly orderedStages: ReadonlyArray<BoardStageDefinition>;
}) {
  const shellState = useAtomValue(environmentShell.stateValueAtom(environmentId));
  const cardsByProject = useAtomValue(boardEnvironment.cardsByProjectAtom(environmentId));
  // Optimistic drop placements: applied over the live shells immediately,
  // pruned as the server's deltas confirm them, removed on rejection.
  const [placements, setPlacements] = useState<ReadonlyArray<BoardCardPlacement>>([]);

  // The thread shells, joined from the snapshot the client already holds. Read
  // by the card todo strips and by the attention settle grace.
  // A subagent awaiting approval turns its parent's to-do row violet.
  const subagentRequests = useAtomValue(
    environmentThreadShells.pendingSubagentRequestsAtom(environmentId),
  );
  const threadShellsById = (() => {
    const shells = Option.getOrNull(shellState.snapshot)?.threads ?? [];
    return new Map(shells.map((thread) => [thread.id, thread]));
  })();
  const threadShellOf = (threadId: ThreadId) => threadShellsById.get(threadId);
  const liveColumns = (() => {
    if (scopeProjectId !== null) {
      if (isBoardProjectHidden(boardSettings, scopeProjectId)) return EMPTY_COLUMNS;
      return cardsByProject.get(scopeProjectId) ?? EMPTY_COLUMNS;
    }
    return mergeBoardStageColumns(
      [...cardsByProject.entries()]
        .filter(([projectId]) => !isBoardProjectHidden(boardSettings, projectId))
        .map(([, columns]) => columns),
    );
  })();

  const unsettledPlacements =
    placements.length === 0
      ? placements
      : placements.filter((placement) => !isBoardCardPlacementSettled(liveColumns, placement));
  if (unsettledPlacements.length !== placements.length) setPlacements(unsettledPlacements);
  const placedColumns = applyBoardCardPlacements(liveColumns, unsettledPlacements);

  // Plan pips are derived client-side from the children the shell already
  // carries; the server never produces them.
  const { columns, parentKeyById, cardKeyById } = (() => {
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
            : {
                ...card,
                planTotal: counts.total,
                planDone: counts.done,
                planStatuses: counts.statuses,
              };
        }),
      ]),
    ) as typeof placedColumns;
    return { columns: decorated, parentKeyById: parents, cardKeyById: keyById };
  })();
  // Every live shell, flat: the attention derivations fold over it, and
  // the sub-board's plan strip resolves this parent's children out of it.
  // The FULL columns, not the scoped ones: a child is filtered
  // out of what renders, never out of what the client knows.
  const allCards = Object.values(columns).flat();
  // Group rules read across every project, as the server's do: `?project=` and
  // hidden projects filter what renders, never a group's children.
  const groupShells = (() => {
    const seen = new Set(allCards.map((card) => String(card.cardId)));
    const elsewhere = [...cardsByProject.values()]
      .flatMap((projectColumns) => Object.values(projectColumns).flat())
      .filter((card) => !seen.has(String(card.cardId)));
    return elsewhere.length === 0 ? allCards : [...allCards, ...elsewhere];
  })();
  // When each card's thread last went quiet, plus the clock that ticks once
  // when a grace expires. Both feed `boardCardAttention`, which
  // withholds the "Needs a human" chips until the card has been still for
  // `BOARD_ATTENTION_SETTLE_MS`.
  const { threadIdleSinceByCard, now: attentionNow } = useBoardAttentionSettle({
    cards: allCards,
    threadOf: threadShellOf,
  });
  return {
    liveColumns,
    setPlacements,
    columns,
    parentKeyById,
    cardKeyById,
    threadShellsById,
    allCards,
    groupShells,
    threadIdleSinceByCard,
    attentionNow,
  };
}

/**
 * Everything the page derives before its handlers. A hook of its own so the results
 * reach the page frozen: the compiler drops the cache of a value the page might
 * still mutate when a hook or an effect runs.
 */
function useBoardPageModel({
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
  const patchSearch = (
    updater: (previous: BoardSearch) => BoardSearch,
    options?: { readonly replace?: boolean },
  ) => {
    void navigate({
      to: ".",
      search: (previous) => updater(validateBoardSearch(previous)),
      replace: options?.replace === true,
    });
  };
  // Both drill-in and breadcrumb-back CARRY `?project` (a sub-board ignores
  // it — its project is the parent's — but keeping it in the URL means the
  // round trip lands back on the root board the user left, not "All
  // projects"). `?card` and `?stalled` are per-board state and drop.
  const openSubBoard = (
    parentCardId: string,
    cardId?: string,
    options?: { readonly replace?: boolean },
  ) => {
    void navigate({
      to: "/board/$parentCardId",
      params: { parentCardId },
      search: (previous) => ({
        ...(previous.project === undefined ? {} : { project: previous.project }),
        ...(cardId === undefined ? {} : { card: cardId }),
      }),
      replace: options?.replace === true,
    });
  };
  const openRootBoard = (cardId?: string, options?: { readonly replace?: boolean }) => {
    void navigate({
      to: "/board",
      search: (previous) => ({
        ...(previous.project === undefined ? {} : { project: previous.project }),
        ...(cardId === undefined ? {} : { card: cardId }),
      }),
      replace: options?.replace === true,
    });
  };
  const shellState = useAtomValue(environmentShell.stateValueAtom(environmentId));
  const cardsByProject = useAtomValue(boardEnvironment.cardsByProjectAtom(environmentId));
  const labelCatalogue = useAtomValue(boardEnvironment.labelCatalogueAtom(environmentId));
  const moveCard = useAtomCommand(boardEnvironment.moveCard);
  const reorderCard = useAtomCommand(boardEnvironment.reorderCard);

  const collapsedByStage = useBoardUiStore((state) => state.collapsedByStage);
  const setColumnCollapsed = useBoardUiStore((state) => state.setColumnCollapsed);
  const setDetailMaximisedCardId = useBoardUiStore((state) => state.setDetailMaximisedCardId);

  // The user-defined stage list drives column order and labels; falls
  // back to the compiled seeds until the first shell snapshot arrives.
  const stageList = useAtomValue(boardEnvironment.stageListAtom(environmentId));

  const orderedStages = stageList.length > 0 ? stageList : BOARD_SEED_STAGES;
  // Each project's delta: which stages its cards use.
  const projectStageConfigs = useAtomValue(boardEnvironment.projectStageConfigsAtom(environmentId));
  // Board settings: the per-project key prefix used when creating a
  // card. Read once here and threaded down, rather than subscribed per card.
  const boardSettings = useBoardSettings((settings) => settings.board);
  // The confirmations a group drag or the Deferred column opens.
  const [startingGroupId, setStartingGroupId] = useState<string | null>(null);
  const [phaseGroupId, setPhaseGroupId] = useState<string | null>(null);
  // The sub-board's dependency chart. Ephemeral: the page
  // remounts per navigation, and persisted board UI state has already caused
  // a navigation bug in this codebase.
  const [subBoardChartOpen, setSubBoardChartOpen] = useState(false);
  // Stays the same object across a clone's progress ticks, so those don't
  // rebuild the queue or re-render the columns.
  const cardWorkersState = useBoardWorkersCardView(environmentId);
  // The strip's thread title and state are joined from the thread shells the
  // client already holds; nothing is duplicated onto the wire.
  const cardThreadsByCard = useAtomValue(boardEnvironment.cardThreadsByCardAtom(environmentId));
  // Which cards have their extra threads revealed. In-memory and session-scoped:
  // a collapse preference has near-zero value across reloads, and persisted
  // board UI state has already caused a navigation bug in this codebase.
  const [expandedThreadCards, setExpandedThreadCards] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const [peekedColumns, setPeekedColumns] = useState<ReadonlySet<string>>(() => new Set());
  // The top bar's filter box. Local state, not a search param: this is
  // per-keystroke typing state, and routing every character would re-run route
  // matching for a filter nobody wants to deep-link or land back on.
  const queryKey = boardScopeQueryKey(scope);
  const query = useBoardUiStore((state) => state.queryByBoard[queryKey] ?? "");
  const setBoardQuery = useBoardUiStore((state) => state.setBoardQuery);
  // Native HTML5 drag: dnd-kit's sortable transforms broke the virtualised list.
  const [drag, setDrag] = useState<BoardDrag | null>(null);
  const [dragOver, setDragOver] = useState<BoardDragOver | null>(null);
  const [dragOpenedRail, setDragOpenedRail] = useState<BoardStageId | null>(null);
  const [dragTip, setDragTip] = useState<string | null>(null);
  // T3o: a drag out of Planning with no plan written waits for the
  // human to confirm it, exactly as the detail pane's move does. The drop is
  // held as the card it landed before, not as a column order: the column can
  // change while the dialog is open, so the order is rebuilt on confirm.
  const [unplannedDrop, setUnplannedDrop] = useState<{
    readonly targetStage: BoardStageId;
    /** The card the drop landed before; null appends to the column. */
    readonly beforeId: string | null;
    readonly source: FoundCard;
  } | null>(null);
  const snapshotArrived = useAtomValue(environmentBoard.snapshotValueAtom(environmentId)) !== null;
  const setPaletteActions = useBoardUiStore((state) => state.setPaletteActions);
  // The stage the create dialog prefills; null means closed.
  const [createStage, setCreateStage] = useState<BoardStageId | null>(null);
  const [archiveOpen, setArchiveOpen] = useState(false);
  const unarchiveCard = useAtomCommand(boardEnvironment.unarchiveCard);
  const deleteCard = useAtomCommand(boardEnvironment.deleteCard);

  // `?project` scopes the ROOT board only — a sub-board's project is implied
  // by its parent, so the param is ignored there rather than double-filtering.
  const scopeProjectId =
    scope.kind === "root" ? ((search.project ?? null) as ProjectId | null) : null;
  const {
    liveColumns,
    setPlacements,
    columns,
    parentKeyById,
    cardKeyById,
    threadShellsById,
    allCards,
    groupShells,
    threadIdleSinceByCard,
    attentionNow,
  } = useBoardLiveColumns({ environmentId, boardSettings, scopeProjectId, orderedStages });
  const parentKeyFor = (cardId: string) =>
    scope.kind === "root" ? parentKeyById.get(cardId) : undefined;

  const labelsById = indexBoardLabels(labelCatalogue);
  const stageState = stageStateOf(orderedStages, projectStageConfigs);
  const buildStageId = boardStageWithRole(stageState, "build")?.stageId ?? null;
  // The merge-role stage, for the armed-and-quiet `Auto` glyph:
  // an armed card in Building looks normal because it is, so the glyph is
  // offered only where the merge is actually imminent.
  const mergeStageId = boardStageWithRole(stageState, "merge")?.stageId ?? null;
  const doneStageId = boardStageWithRole(stageState, "done")?.stageId ?? null;
  /** Collapse state keys on `(scope, stageId)`; the defaults are
      `boardScopeColumnCollapsedByDefault`'s. */
  const collapseKeyOf = (stageId: string) => boardScopeCollapseKey(scope, stageId);

  // The board-wide arm — the third arming condition, and the one
  // the card shell cannot carry, since the SQL snapshot producer cannot see
  // settings. ORed into the glyph in the column exactly as `BoardCardDetail`
  // ORs it into the modal chip.
  const mergeExecution =
    mergeStageId === null ? null : resolveBoardStageExecution(boardSettings, mergeStageId);
  const boardWideAutoMerge =
    mergeExecution !== null && isBoardMergeStageExecution(mergeExecution)
      ? mergeExecution.autoMerge
      : false;

  const allProjects = Option.getOrNull(shellState.snapshot)?.projects ?? [];
  // A project's Board colour is its icon colour, read from the live
  // shell snapshot so an icon change in project settings recolours its cards
  // without a reload. Keyed once here and threaded down, not looked up per card.
  const accentByProject = new Map(
    allProjects.map((project) => [project.id, projectIconColorOf(project)] as const),
  );
  const accentNameFor = (projectId: ProjectId) => accentByProject.get(projectId) ?? null;
  // A hidden project (the settings eye toggle) leaves the board view entirely
  // — scope picker, legend, add-card list and the merged columns below — while
  // its cards and automation run on untouched.
  const projects = allProjects.filter(
    (project) => !isBoardProjectHidden(boardSettings, project.id),
  );
  // A stale deep link (project deleted, hidden, or another environment's id)
  // still needs a visible scope so the user can switch back to All projects.
  const scopeIsStale =
    scopeProjectId !== null &&
    allProjects.length > 0 &&
    !projects.some((project) => project.id === scopeProjectId);
  const scopeIsHidden =
    scopeProjectId !== null && isBoardProjectHidden(boardSettings, scopeProjectId);

  // "Needs a human", derived client-side from the shell + stage list with no
  // extra payload (a split approval is one of its reasons). The card
  // face turns this into a border, a fill tint and one chip.
  const attentionFor = (card: BoardCardShell) => {
    // Spread only where there is a timestamp to carry — a card whose thread
    // has never finished a turn is passed through as the shell it already is.
    const threadIdleSince = threadIdleSinceByCard.get(String(card.cardId));
    return boardCardAttention({
      card: threadIdleSince === undefined ? card : { ...card, threadIdleSince },
      stages: orderedStages,
      now: attentionNow,
    });
  };
  // Resolved here, not in the column, because the settle grace joins the thread
  // shells only the page holds.
  const noPullRequestFor = (card: BoardCardShell) =>
    boardCardNoPullRequest({
      atMergeStage: mergeStageId !== null && card.stage === mergeStageId,
      hasPr: card.hasPr,
      threadIdleSince: threadIdleSinceByCard.get(String(card.cardId)),
      now: attentionNow,
    });
  // A finished card still holding its worktree — the amber `Worktree
  // kept` notice. Here because the "finished" half needs the done-role stage
  // and `reclaimWorktreeOnDone`, which the shell cannot carry (its SQL producer
  // cannot see settings).
  const reclaimWorktreeOnDone = boardSettings.lifecycle.reclaimWorktreeOnDone;
  const worktreeKeptFor = (card: BoardCardShell) =>
    boardCardWorktreeKept({
      worktreeReady: card.worktreeReady === true,
      archived: card.archivedAt !== null,
      inDoneStage: doneStageId !== null && card.stage === doneStageId,
      reclaimWorktreeOnDone,
      cancelledWork: boardCardWorktreeIsCancelledWork(card),
    })
      ? boardCardWorktreeKeptReason(card.worktreeKeptReason)
      : null;
  // A child that needs a human blocks its split parent too, so the parent wears
  // the child's tone. Folded once for the whole board.
  const childAttentionByParent = deriveBoardCardChildAttention({
    // Only a sub-board CHILD can roll up, so only a child pays for the
    // settle-grace join — on the ordinary board that is every card skipped.
    cards: allCards.map((card) => {
      if (card.parentCardId === undefined) return card;
      const threadIdleSince = threadIdleSinceByCard.get(String(card.cardId));
      return threadIdleSince === undefined ? card : { ...card, threadIdleSince };
    }),
    stages: orderedStages,
    now: attentionNow,
  });
  // Nearest wins: a card's own override, else its parent group's
  // settings, else — top-level only — the board-wide default.
  const autoMergeArmedByCard = boardShellAutoMergeArmedByCard({
    shells: allCards,
    boardWide: boardWideAutoMerge,
  });
  const autoMergeArmedFor = (card: BoardCardShell) =>
    autoMergeArmedByCard.get(String(card.cardId)) === true;
  // The card face's Auto-build chip: a card waiting in the stage
  // before build that will start itself.
  const beforeBuildStageId = boardStageBeforeBuild(stageState)?.stageId ?? null;
  const autoBuildArmedFor = (card: BoardCardShell) =>
    card.stage === beforeBuildStageId &&
    card.group === undefined &&
    resolveBoardShellAutomation({
      shells: allCards,
      stages: stageState,
      card: boardShellAutomationNode(card),
      boardWideAutoMerge: false,
    }).autoBuild.value;
  const childAttentionFor = (card: BoardCardShell) => childAttentionByParent.get(card.cardId);
  // A split parent runs no step of its own while its children go, so its working
  // dot comes from them.
  const childRunningByParent = deriveBoardCardChildRunning({ cards: allCards });
  const childRunningFor = (card: BoardCardShell) => childRunningByParent.get(card.cardId);

  // The parent this sub-board drills into, as a live (decorated) shell — null
  // on the root board, and null again the moment the parent leaves the live
  // board (the redirect below takes over).
  const parentShell =
    scope.kind === "sub-board" ? (findBoardCard(columns, scope.parentCardId)?.card ?? null) : null;

  // ── Groups ────────────────────────────────────────────────
  // A group card's face, folded once per board render over the shells the
  // client already holds: no group adds a field to the wire.
  const groupVmByCard = (() => {
    const input = { shells: groupShells, stages: stageState, attentionFor };
    const parents = new Set(
      groupShells.flatMap((card) =>
        card.parentCardId === undefined ? [] : [String(card.parentCardId)],
      ),
    );
    const out = new Map<string, NonNullable<ReturnType<typeof boardGroupCardVm>>>();
    for (const card of groupShells) {
      if (card.group === undefined && !parents.has(String(card.cardId))) continue;
      const vm = boardGroupCardVm(input, card);
      if (vm !== null) out.set(String(card.cardId), vm);
    }
    return out;
  })();
  const groupFor = (card: BoardCardShell) => groupVmByCard.get(String(card.cardId)) ?? null;
  const parentGroup = parentShell === null ? null : boardShellGroup(groupShells, parentShell);
  // Where a new card lands by default: Planning inside a started group.
  const defaultCreateStageId = boardCreateDefaultStage(
    stageState,
    parentGroup?.started === true,
    parentShell?.projectId ?? scopeProjectId,
  );
  // Ancestors of this sub-board's group, root first: the breadcrumb, and
  // where Back goes (one level up).
  const ancestors =
    parentShell === null ? [] : [...boardShellAncestors(groupShells, parentShell)].reverse();
  /** One level up; `withSheet` opens this group's sheet there, which is
      where a group's own popup lives. */
  const goUpOneLevel = (withSheet = false) => {
    if (scope.kind !== "sub-board") return;
    const up = ancestors.at(-1);
    const sheet = withSheet ? scope.parentCardId : undefined;
    if (up === undefined) openRootBoard(sheet);
    else openSubBoard(up.cardId, sheet);
  };

  // Every card in the environment, scoped or not: the build queue is board-wide,
  // and a queue that skipped a hidden project's card would number the rest wrong.
  const everyCard = [...cardsByProject.values()].flatMap((byStage) =>
    Object.values(byStage).flat(),
  );

  const queueSlots = (() => {
    const queue = boardBuildQueue(
      everyCard,
      orderedStages,
      // oxlint-disable-next-line react/purity -- Schedule-due samples the clock when the cards change; the compiler recomputes it only then.
      Date.now(),
    );
    if (queue.size === 0) return EMPTY_QUEUE_INFO;
    const running = boardRunningStepCount(everyCard);
    const cap = boardSettings.concurrency.globalMaxConcurrent;
    const cardsById = new Map(everyCard.map((card) => [card.cardId, card] as const));
    const projectNames = new Map(
      allProjects.map((project) => [project.id, project.title] as const),
    );
    const info = new Map<string, BoardQueueInfo>();
    for (const [cardId, slot] of queue) {
      const card = cardsById.get(cardId as BoardCardShell["cardId"]);
      const reason =
        card === undefined
          ? null
          : boardQueueReason({
              card,
              state: cardWorkersState,
              cards: everyCard,
              concurrency: boardSettings.concurrency,
              projectName: projectNames.get(card.projectId) ?? "this project",
            });
      const resolved = boardQueueInfo({ slot, running, cap, reason });
      if (resolved !== null) info.set(cardId, resolved);
    }
    return info;
  })();

  const toggleCardThreads = (cardId: string) => {
    setExpandedThreadCards((current) => {
      const next = new Set(current);
      if (!next.delete(cardId)) next.add(cardId);
      return next;
    });
  };
  const todoThreadStateOf = (threadId: ThreadId) => {
    const shell = threadShellsById.get(threadId);
    if (shell === undefined) return undefined;
    const { threadState, awaitingInput } = deriveBoardCardThreadState(
      boardThreadStateSourceWithSubagents(shell, subagentRequests),
    );
    return {
      awaitingInput,
      running: threadState === "working",
      // A failed thread is stopped for the winner rule.
      stopped: threadState === "stopped" || threadState === "failed" || threadState === "none",
    };
  };
  const todoThreadTitleOf = (threadId: ThreadId) =>
    threadShellsById.get(threadId)?.title ?? "Thread";
  const todosFor = (cardId: string): BoardCardTodoContext => ({
    threads: cardThreadsByCard.get(BoardCardId.make(cardId)) ?? EMPTY_CARD_THREADS,
    stateOf: todoThreadStateOf,
    titleOf: todoThreadTitleOf,
    expanded: expandedThreadCards.has(cardId),
    onToggleExpanded: () => toggleCardThreads(cardId),
  });

  // Scope and the stalled filter thin what renders; `columns` stays the full
  // ordering substrate so a drop anchors into the real column.
  const scopedColumns = filterBoardColumnsByScope(columns, scope);

  // Every live card, as the per-project stage helpers read them.
  const pipelineView = { stages: orderedStages, projectStageConfigs, cards: everyCard };
  // The projects whose pipelines this view draws: the scoped project, a
  // sub-board's parent's and its children's (a child may sit in another
  // project), or every visible project.
  const parentProjectId = parentShell?.projectId ?? null;
  const pipelineProjects = (() => {
    const subBoardProjectIds = new Set<string>();
    if (scope.kind === "sub-board") {
      if (parentProjectId !== null) subBoardProjectIds.add(parentProjectId);
      for (const cards of Object.values(scopedColumns)) {
        for (const card of cards) subBoardProjectIds.add(card.projectId);
      }
    }
    const inView =
      scope.kind === "sub-board"
        ? allProjects.filter((project) => subBoardProjectIds.has(project.id))
        : scopeProjectId === null
          ? projects
          : allProjects.filter((project) => project.id === scopeProjectId);
    return inView.map((project) => ({ id: project.id, title: project.title }));
  })();
  const pipelineColumns = boardPipelineColumns({
    view: pipelineView,
    projects: pipelineProjects,
    occupiedStageIds: new Set(
      Object.entries(scopedColumns)
        .filter(([, cards]) => cards.length > 0)
        .map(([stageId]) => stageId),
    ),
  });
  const pipelineColumnById = new Map(
    pipelineColumns.map((column) => [String(column.stage.stageId), column]),
  );
  // The columns this SCOPE renders: every stage the
  // projects in view use on the root board; Deferred and then those
  // stages inside a group.
  const renderedStages = boardScopeStages(
    pipelineColumns.map((column) => column.stage),
    scope,
  );
  const projectTitleById = new Map(
    allProjects.map((project) => [String(project.id), project.title]),
  );
  const stageGoneFor = boardCardStageGoneNotes(
    pipelineView,
    (projectId) => projectTitleById.get(projectId) ?? "its project",
  );

  // Auto-collapse empty stages. A peek opens an auto-folded column
  // for this mounted board only; it never touches `collapsedByStage`.
  const autoCollapseEmpty = boardSettings.display.autoCollapseEmptyStages;
  // A peek ends once its column holds cards (or the setting or scope changes),
  // so the column folds again the next time it empties. Adjusted during
  // render, not in an effect, so the stale peek never paints.
  const livePeeks = livePeekedColumns({
    autoCollapseEmpty,
    peeked: peekedColumns,
    emptyColumnKeys: renderedStages
      .filter((stage) => (scopedColumns[stage.stageId] ?? EMPTY_CARDS).length === 0)
      .map((stage) => collapseKeyOf(stage.stageId)),
  });
  if (livePeeks !== peekedColumns) setPeekedColumns(livePeeks);
  const handleSetCollapsed = (stageId: BoardStageId, collapsed: boolean) => {
    const key = boardScopeCollapseKey(scope, stageId);
    const toggle = boardCollapseToggle({
      autoCollapseEmpty,
      cardCount: (scopedColumns[stageId] ?? EMPTY_CARDS).length,
      key,
      collapsed,
      peeked: peekedColumns,
    });
    if (toggle.kind === "peek") setPeekedColumns(toggle.peeked);
    else setColumnCollapsed(key, collapsed);
  };
  const showStalledOnly = search.stalled === true;
  const stalledCount = Object.values(scopedColumns).reduce(
    (total, cards) => total + cards.filter((card) => card.stalled).length,
    0,
  );
  const stalledColumns = (() => {
    if (!showStalledOnly) return scopedColumns;
    return Object.fromEntries(
      Object.entries(scopedColumns).map(([stageId, cards]) => [
        stageId,
        cards.filter((card) => card.stalled),
      ]),
    ) as typeof scopedColumns;
  })();
  const setQuery = (next: string) => setBoardQuery(queryKey, next);
  const visibleColumns = filterBoardColumnsByQuery(stalledColumns, query);
  // Zero matches is a state the board has to SAY, or eight empty columns read
  // as a board that lost its cards.
  const noQueryMatches =
    query.trim().length > 0 &&
    countBoardColumnCards(visibleColumns) === 0 &&
    countBoardColumnCards(stalledColumns) > 0;

  return {
    search,
    patchSearch,
    openSubBoard,
    openRootBoard,
    moveCard,
    reorderCard,
    collapsedByStage,
    setColumnCollapsed,
    setDetailMaximisedCardId,
    orderedStages,
    boardSettings,
    startingGroupId,
    setStartingGroupId,
    phaseGroupId,
    setPhaseGroupId,
    subBoardChartOpen,
    setSubBoardChartOpen,
    cardWorkersState,
    peekedColumns,
    query,
    drag,
    setDrag,
    dragOver,
    setDragOver,
    dragOpenedRail,
    setDragOpenedRail,
    dragTip,
    setDragTip,
    unplannedDrop,
    setUnplannedDrop,
    snapshotArrived,
    setPaletteActions,
    createStage,
    setCreateStage,
    archiveOpen,
    setArchiveOpen,
    unarchiveCard,
    deleteCard,
    scopeProjectId,
    parentKeyFor,
    labelsById,
    stageState,
    buildStageId,
    mergeStageId,
    collapseKeyOf,
    boardWideAutoMerge,
    allProjects,
    accentNameFor,
    projects,
    scopeIsStale,
    scopeIsHidden,
    attentionFor,
    noPullRequestFor,
    worktreeKeptFor,
    autoMergeArmedFor,
    autoBuildArmedFor,
    childAttentionFor,
    childRunningFor,
    parentShell,
    groupFor,
    parentGroup,
    defaultCreateStageId,
    ancestors,
    goUpOneLevel,
    everyCard,
    queueSlots,
    todosFor,
    scopedColumns,
    pipelineView,
    pipelineProjects,
    pipelineColumnById,
    renderedStages,
    stageGoneFor,
    autoCollapseEmpty,
    handleSetCollapsed,
    showStalledOnly,
    stalledCount,
    setQuery,
    visibleColumns,
    noQueryMatches,
    liveColumns,
    setPlacements,
    columns,
    cardKeyById,
    groupShells,
  };
}

function EnvironmentBoard({
  environmentId,
  scope,
}: {
  readonly environmentId: EnvironmentId;
  readonly scope: BoardScope;
}) {
  const dragTipRef = useRef<HTMLDivElement | null>(null);
  const ghostRef = useRef<HTMLElement | null>(null);
  const dragRef = useRef<BoardDrag | null>(null);
  const handledDeepLinkRef = useRef<string | null>(null);
  const {
    search,
    patchSearch,
    openSubBoard,
    openRootBoard,
    moveCard,
    reorderCard,
    collapsedByStage,
    setColumnCollapsed,
    setDetailMaximisedCardId,
    orderedStages,
    boardSettings,
    startingGroupId,
    setStartingGroupId,
    phaseGroupId,
    setPhaseGroupId,
    subBoardChartOpen,
    setSubBoardChartOpen,
    cardWorkersState,
    peekedColumns,
    query,
    drag,
    setDrag,
    dragOver,
    setDragOver,
    dragOpenedRail,
    setDragOpenedRail,
    dragTip,
    setDragTip,
    unplannedDrop,
    setUnplannedDrop,
    snapshotArrived,
    setPaletteActions,
    createStage,
    setCreateStage,
    archiveOpen,
    setArchiveOpen,
    unarchiveCard,
    deleteCard,
    scopeProjectId,
    parentKeyFor,
    labelsById,
    stageState,
    buildStageId,
    mergeStageId,
    collapseKeyOf,
    boardWideAutoMerge,
    allProjects,
    accentNameFor,
    projects,
    scopeIsStale,
    scopeIsHidden,
    attentionFor,
    noPullRequestFor,
    worktreeKeptFor,
    autoMergeArmedFor,
    autoBuildArmedFor,
    childAttentionFor,
    childRunningFor,
    parentShell,
    groupFor,
    parentGroup,
    defaultCreateStageId,
    ancestors,
    goUpOneLevel,
    everyCard,
    queueSlots,
    todosFor,
    scopedColumns,
    pipelineView,
    pipelineProjects,
    pipelineColumnById,
    renderedStages,
    stageGoneFor,
    autoCollapseEmpty,
    handleSetCollapsed,
    showStalledOnly,
    stalledCount,
    setQuery,
    visibleColumns,
    noQueryMatches,
    liveColumns,
    setPlacements,
    columns,
    cardKeyById,
    groupShells,
  } = useBoardPageModel({ environmentId, scope });

  const clearGhost = () => {
    if (ghostRef.current !== null) {
      ghostRef.current.remove();
      ghostRef.current = null;
    }
  };

  // Prices and dispatches a settled order for one column: the optimistic
  // placement lands first, then the move/reorder commands, with rejection
  // rollback and the Building queue toast. Shared by drop and (future) keyboard.
  // Reached through `dispatchDrop`, which may hold the drop for a confirm.
  const performDrop = (
    targetStage: BoardStageId,
    orderedIds: ReadonlyArray<string>,
    source: FoundCard,
  ) => {
    const cardId = source.card.cardId as string;
    const isMove = targetStage !== source.stage;
    if (!isMove) {
      const currentIds = (columns[targetStage] ?? EMPTY_CARDS).map((card) => card.cardId as string);
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
                ...(areBoardStagesAdjacent(
                  pipelineView,
                  source.stage,
                  targetStage,
                  source.card.projectId,
                )
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
      if (targetStage === buildStageId) {
        // Within Building, position is queue priority. Announce the slot the drop
        // landed in, keyed on the stage's role so a renamed build stage still does.
        const movedAssignment = assignments.find((next) => next.cardId === cardId);
        if (movedAssignment === undefined) return;
        const slot = boardBuildQueue(
          everyCard.map((existing) =>
            existing.cardId === cardId
              ? { ...existing, stage: targetStage, orderKey: movedAssignment.orderKey }
              : existing,
          ),
          orderedStages,
          Date.now(),
        ).get(cardId);
        if (slot !== undefined) {
          toastManager.add({
            type: "success",
            title: slot.startsNext ? "Queued: starts next" : `Queued at position ${slot.position}`,
            description: `${source.card.key} ${
              slot.startsNext ? "is first in the build queue." : "joins the build queue."
            }`,
          });
        }
      }
    });
  };

  const dispatchDrop = (
    targetStage: BoardStageId,
    orderedIds: ReadonlyArray<string>,
    source: FoundCard,
  ) => {
    const isGroup = isBoardGroupShell(groupShells, source.card);
    // Dropping a group on Building is the start gesture: it opens
    // a confirmation rather than moving anything yet.
    if (isGroup && targetStage === buildStageId && source.stage !== buildStageId) {
      setStartingGroupId(String(source.card.cardId));
      return;
    }
    if (
      !isGroup &&
      boardMoveLeavesPlanningUnwritten({
        stages: orderedStages,
        card: { stage: source.stage },
        toStage: targetStage,
        planCount: source.card.planCount ?? 0,
      })
    ) {
      const ownIndex = orderedIds.indexOf(source.card.cardId as string);
      setUnplannedDrop({ targetStage, beforeId: orderedIds[ownIndex + 1] ?? null, source });
      return;
    }
    performDrop(targetStage, orderedIds, source);
  };

  // The index is measured against the rendered (possibly filtered) cards, so it
  // resolves to an anchor card there first, then maps into the full column.
  // Splicing filtered coordinates into the full list would persist a wrong order.
  const commitDrop = (targetStage: BoardStageId, insertIndex: number, cardId: string) => {
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
  };

  // Keyboard reorder (Ctrl/Cmd+ArrowUp/Down on a focused card): the pointer
  // drag's keyboard analogue. Moves relative to the RENDERED (possibly
  // stalled-filtered) neighbour, anchored into the full column exactly like
  // commitDrop, and commits through the same drop path.
  const handleCardReorder = (card: BoardCardShell, direction: -1 | 1) => {
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
  };

  const handleCardDragStart = (card: BoardCardShell, event: DragEvent<HTMLDivElement>) => {
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
    setDragOpenedRail(null);
  };

  const handleCardDragEnd = () => {
    clearGhost();
    dragRef.current = null;
    setDrag(null);
    setDragOver(null);
    setDragOpenedRail(null);
    setDragTip(null);
  };

  // Client-side pre-validation of a drop: a refused column is
  // outlined and never `preventDefault`s, so the browser shows a no-drop
  // cursor, and a tooltip at the pointer says why.
  const dropRefusalFor = (active: BoardDrag, stage: BoardStageId): string | null => {
    const source = findBoardCard(columns, active.cardId);
    if (source === null) return null;
    return boardDropRefusal({
      shells: groupShells,
      stages: stageState,
      card: source.card,
      toStage: stage,
    });
  };
  // The tip follows the pointer through the DOM, not state: a dragover fires
  // per pointer move, and the board must not re-render that often.
  const handleRefusedDragOver = (
    stage: BoardStageId,
    refusal: string,
    event: DragEvent<HTMLElement>,
  ) => {
    const tip = dragTipRef.current;
    if (tip !== null) {
      tip.style.transform = `translate(${event.clientX + 14}px, ${event.clientY + 16}px)`;
    }
    setDragTip(refusal);
    setDragOver((current) => (current?.stage === stage ? current : { stage, index: 0 }));
  };
  const handleRefusedDragLeave = () => setDragTip(null);
  const handleColumnDragOver = (stage: BoardStageId, event: DragEvent<HTMLElement>) => {
    if (dragRef.current === null) return;
    setDragTip(null);
    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
    const index = boardDropIndexIn(event.currentTarget, event.clientY);
    const hoveredAutoFolded = boardColumnAutoFolded({
      autoCollapseEmpty,
      cardCount: (scopedColumns[stage] ?? EMPTY_CARDS).length,
    });
    setDragOpenedRail((current) =>
      boardDragOpenedRail({ current, hovered: stage, hoveredAutoFolded }),
    );
    setDragOver((current) =>
      current !== null && current.stage === stage && current.index === index
        ? current
        : { stage, index },
    );
  };

  const handleColumnDrop = (stage: BoardStageId, event: DragEvent<HTMLElement>) => {
    event.preventDefault();
    const active = dragRef.current;
    if (active === null || dropRefusalFor(active, stage) !== null) {
      handleCardDragEnd();
      return;
    }
    const index = boardDropIndexIn(event.currentTarget, event.clientY);
    commitDrop(stage, index, active.cardId);
    handleCardDragEnd();
  };

  // ── Selection and deep link (?card=…) ───────────────────────────────
  const selectedCardId = search.card ?? null;
  const handleSelectCard = (card: BoardCardShell) => {
    // Native drag doesn't fire a click on the source after a drop, so no
    // click-suppression is needed here.
    patchSearch((previous) => {
      const { card: selected, ...rest } = previous;
      return selected === card.cardId ? rest : { ...rest, card: card.cardId };
    });
  };
  const handleCloseDetail = () => {
    patchSearch((previous) => {
      const { card: _card, ...rest } = previous;
      return rest;
    });
  };
  // Steps through `visibleColumns` in `renderedStages` order, exactly what the
  // board shows, running off one column into the next. A card not in it resolves
  // to index -1 and stepping goes quiet.
  const stageOrder = renderedStages.map((stage) => stage.stageId);
  const stageLabels = new Map(renderedStages.map((stage) => [stage.stageId, stage.label] as const));
  const neighbours = resolveBoardCardNeighbours(visibleColumns, stageOrder, selectedCardId);
  const stepCard = (direction: BoardCardStep) => {
    const target = direction === -1 ? neighbours.prev : neighbours.next;
    if (target === null) return;
    // A step is the one card change that carries fullscreen with it.
    // Read non-reactively: the board does not re-render when the sheet above
    // it is maximised.
    const store = useBoardUiStore.getState();
    store.setDetailMaximisedCardId(
      boardCardMaximisedAfterStep(store.detailMaximisedCardId, selectedCardId, target.cardId),
    );
    // `replace`, not push: reading ten cards in a row must not bury the
    // board under ten history entries. Back closes the sheet to where the
    // reading started. Clicking a card on the board still pushes.
    patchSearch((previous) => ({ ...previous, card: target.cardId }), { replace: true });
  };
  const cardNav: BoardCardNav | null =
    neighbours.prev === null && neighbours.next === null
      ? null
      : {
          prev: boardCardNavTarget(neighbours.prev, neighbours.stage, stageLabels),
          next: boardCardNavTarget(neighbours.next, neighbours.stage, stageLabels),
          onStep: stepCard,
        };

  /** The stack affordance on a split parent's face: clicking it
      drills into that parent's sub-board. */
  const handleOpenSubBoard = (card: BoardCardShell) => openSubBoard(card.cardId);

  const selectedShell =
    selectedCardId === null ? null : (findBoardCard(columns, selectedCardId)?.card ?? null);
  const selectedGroup =
    selectedShell !== null && isBoardGroupShell(groupShells, selectedShell) ? selectedShell : null;
  const selectedGroupId = selectedGroup === null ? null : String(selectedGroup.cardId);
  const selectedGroupKey = selectedGroup?.key ?? null;
  const selectedGroupTitle = selectedGroup?.title ?? null;
  const upKey = ancestors.at(-1)?.key ?? null;

  const openCreate = (stage: BoardStageId) => setCreateStage(stage);

  // ── Archive ────────────────────────────────────────────
  // Archived cards are off the live shell by design, so they need a place to
  // be seen and restored from — otherwise archiving is a one-way door.
  const handleRestoreCard = (cardId: BoardCardId) => {
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
  };

  // Deleting from the archive: the natural place to decide something is never
  // coming back is the list of things that already went away. The sheet owns
  // the confirmation; this only dispatches and re-reads the list.
  const handleDeleteCard = (cardId: BoardCardId) => {
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
  };

  const addProjects = (() => {
    // A sub-board creates into its parent's project, nothing else;
    // the root board follows its own `?project` scope.
    const parentProjectId = parentShell?.projectId ?? null;
    const inScope =
      scope.kind === "sub-board"
        ? projects.filter((project) => project.id === parentProjectId)
        : scopeProjectId === null
          ? projects
          : projects.filter((project) => project.id === scopeProjectId);
    return inScope.map((project) => ({
      id: project.id,
      title: project.title,
      projectIcon: project.projectIcon,
    }));
  })();

  const canCreate = addProjects.length > 0;

  const view = (
    <BoardWorkersContext.Provider value={cardWorkersState}>
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <BoardTopBar>
          {/* T3o: workers that are offline, revoked or incompatible,
            and the cards they hold. Renders nothing otherwise. */}
          <BoardWorkersAttentionPill
            cards={everyCard}
            onOpenCard={(cardId) => patchSearch((previous) => ({ ...previous, card: cardId }))}
            workers={cardWorkersState}
          />
          <BoardCardFilterField onQueryChange={setQuery} query={query} />
          {canCreate ? (
            <Button onClick={() => openCreate(defaultCreateStageId)} size="xs">
              <PlusIcon />
              {/* Same treatment as the mode tabs: on a phone the icon carries it. */}
              <span className="max-sm:sr-only">New card</span>
            </Button>
          ) : null}
        </BoardTopBar>
        <div className="flex shrink-0 items-center gap-3 px-3 py-2 sm:px-5">
          {scope.kind === "sub-board" ? (
            <>
              {/* Back goes up one level: to the group above, or the
                  root board from a top-level group. The breadcrumb names every
                  level on the way. */}
              <Button
                onClick={() => goUpOneLevel()}
                size="xs"
                variant="ghost"
                title={`Back to ${ancestors.at(-1)?.key ?? "the board"} (Alt+↑)`}
              >
                <ChevronLeftIcon />
                Back
              </Button>
              <nav
                aria-label="Group breadcrumb"
                className="flex min-w-0 shrink items-center gap-1 text-[12px] text-muted-foreground"
              >
                <button
                  className="shrink-0 hover:text-foreground hover:underline"
                  onClick={() => openRootBoard()}
                  type="button"
                >
                  Board
                </button>
                {ancestors.map((ancestor) => (
                  <span className="flex min-w-0 items-center gap-1" key={ancestor.cardId}>
                    <span aria-hidden>›</span>
                    <BoardHint label={ancestor.title}>
                      <button
                        className="truncate hover:text-foreground hover:underline"
                        onClick={() => openSubBoard(ancestor.cardId)}
                        type="button"
                      >
                        {ancestor.key}
                      </button>
                    </BoardHint>
                  </span>
                ))}
                <span aria-hidden>›</span>
              </nav>
              <BoardSubBoardHeader
                accentName={parentShell === null ? null : accentNameFor(parentShell.projectId)}
                chartOpen={subBoardChartOpen}
                environmentId={environmentId}
                onOpenParentCard={() => goUpOneLevel(true)}
                onToggleChart={() => setSubBoardChartOpen((open) => !open)}
                parentCardId={scope.parentCardId}
                parentShell={parentShell}
                shells={groupShells}
                stages={stageState}
                attentionFor={attentionFor}
                boardWideAutoMerge={boardWideAutoMerge}
              />
            </>
          ) : (
            <>
              <BoardProjectScopeSelect
                accentNameFor={accentNameFor}
                onChange={(projectId) =>
                  patchSearch((previous) => {
                    const { project: _project, ...rest } = previous;
                    return projectId === null ? rest : { ...rest, project: projectId };
                  })
                }
                projects={projects}
                scopeIsHidden={scopeIsHidden}
                scopeIsStale={scopeIsStale}
                scopeProjectId={scopeProjectId}
              />
              {/* The project legend. Shown for a single project too: its colour is on
                  every card. */}
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
              title="Show only stalled cards: recovery gave up and a human is needed"
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
        </div>
        {noQueryMatches ? (
          <p className="shrink-0 px-3 pb-1 text-[12.5px] text-muted-foreground sm:px-5">
            No cards match “{query.trim()}”.
          </p>
        ) : null}
        {/* The chart and the final-review footer sit between the header row and
          the columns, the order the prototype's drill-in uses. */}
        {scope.kind === "sub-board" ? (
          <BoardSubBoardPlanStrip
            cards={groupShells}
            chartOpen={subBoardChartOpen}
            environmentId={environmentId}
            onOpenChild={(childCardId) =>
              patchSearch((previous) => ({ ...previous, card: childCardId }))
            }
            parentCardId={scope.parentCardId}
            stages={orderedStages}
            ownBranch={parentGroup?.target === "own"}
          />
        ) : null}
        <div className="flex min-h-0 flex-1">
          {/* `items-start` lets each column size to its cards; a collapsed rail
            opts back into full height with `self-stretch`. The row scrolls in
            both axes, so a column taller than the viewport is reachable. */}
          <div
            className={cn(
              "flex min-h-0 flex-1 items-start gap-2.5 overflow-auto px-3 sm:px-5",
              // Reserved unconditionally: no card comes to rest
              // under the corner menu, and collapsing it does not reflow the
              // columns under the user's cursor.
              BOARD_UTILITY_MENU_RESERVED_SPACE,
            )}
          >
            {renderedStages.map((stage, index) => {
              const deferredColumn = isBoardDeferredStage(stage.stageId);
              const deferredCards = deferredColumn
                ? (scopedColumns[stage.stageId] ?? EMPTY_CARDS)
                : EMPTY_CARDS;
              const cardCount = (scopedColumns[stage.stageId] ?? EMPTY_CARDS).length;
              const dropRefusal = drag === null ? null : dropRefusalFor(drag, stage.stageId);
              const collapsed = boardColumnCollapsed({
                autoCollapseEmpty,
                cardCount,
                dragOverThisColumn:
                  drag !== null &&
                  dropRefusal === null &&
                  (dragOver?.stage === stage.stageId || dragOpenedRail === stage.stageId),
                peeked: peekedColumns.has(collapseKeyOf(stage.stageId)),
                storedOrDefaultCollapsed: isBoardColumnCollapsed(
                  collapsedByStage,
                  collapseKeyOf(stage.stageId),
                  boardScopeColumnCollapsedByDefault({
                    scope,
                    stageState,
                    stageId: stage.stageId,
                    renderedIndex: index,
                    cardCount,
                  }),
                ),
              });
              return (
                <BoardColumn
                  accentNameFor={accentNameFor}
                  parentKeyFor={parentKeyFor}
                  attentionFor={attentionFor}
                  childAttentionFor={childAttentionFor}
                  childRunningFor={childRunningFor}
                  addProjects={isBoardDeferredStage(stage.stageId) ? [] : addProjects}
                  cards={visibleColumns[stage.stageId] ?? EMPTY_CARDS}
                  labelsById={labelsById}
                  collapsed={collapsed}
                  dropRefusal={dropRefusal}
                  groupFor={groupFor}
                  hint={
                    deferredColumn
                      ? "Not this round. Doesn't count toward done."
                      : (pipelineColumnById.get(stage.stageId)?.hint ?? undefined)
                  }
                  coverage={pipelineColumnById.get(stage.stageId)?.coverage}
                  partialTitle={pipelineColumnById.get(stage.stageId)?.partialTitle ?? null}
                  removed={pipelineColumnById.get(stage.stageId)?.kind === "retired"}
                  settingsProjectId={pipelineProjects.length === 1 ? pipelineProjects[0]!.id : null}
                  stageGoneFor={stageGoneFor}
                  headerAction={
                    deferredColumn && deferredCards.length > 0 ? (
                      <Button
                        onClick={() =>
                          setPhaseGroupId(
                            String(scope.kind === "sub-board" ? scope.parentCardId : ""),
                          )
                        }
                        size="xs"
                        variant="outline"
                      >
                        <LayersIcon />
                        New phase
                      </Button>
                    ) : undefined
                  }
                  draggedCardId={drag?.cardId ?? null}
                  dragHeight={drag?.height ?? 0}
                  dragOverIndex={
                    drag !== null && dragOver !== null && dragOver.stage === stage.stageId
                      ? dragOver.index
                      : null
                  }
                  key={stage.stageId}
                  label={stage.label}
                  atMergeStage={stage.stageId === mergeStageId}
                  noPullRequestFor={noPullRequestFor}
                  worktreeKeptFor={worktreeKeptFor}
                  autoMergeArmedFor={autoMergeArmedFor}
                  autoBuildArmedFor={autoBuildArmedFor}
                  onCardDragEnd={handleCardDragEnd}
                  onCardReorder={handleCardReorder}
                  onCardDragStart={handleCardDragStart}
                  onColumnDragOver={handleColumnDragOver}
                  onRefusedDragOver={handleRefusedDragOver}
                  onRefusedDragLeave={handleRefusedDragLeave}
                  onColumnDrop={handleColumnDrop}
                  onOpenSubBoard={handleOpenSubBoard}
                  onRequestCreate={openCreate}
                  onSelectCard={handleSelectCard}
                  onSetCollapsed={handleSetCollapsed}
                  queueSlots={queueSlots}
                  selectedCardId={selectedCardId}
                  todosFor={todosFor}
                  stage={stage.stageId}
                />
              );
            })}
          </div>
        </div>
        {/* `key` resets per-card view state on a step. Base UI only animates a
            popup that goes closed to open, and this sheet always mounts open, so a
            step swaps contents without replaying the open transition. Hoisting the
            Dialog above the key would lose the reset. */}
        {selectedCardId !== null ? (
          <BoardCardDetail
            cardId={BoardCardId.make(selectedCardId)}
            environmentId={environmentId}
            key={selectedCardId}
            nav={cardNav}
            onClose={handleCloseDetail}
            onOpenSubBoard={openSubBoard}
          />
        ) : null}
        {(() => {
          const group =
            startingGroupId === null
              ? null
              : (findBoardCard(columns, startingGroupId)?.card ?? null);
          return group === null || buildStageId === null ? null : (
            <BoardGroupStartDialog
              buildStageId={buildStageId}
              environmentId={environmentId}
              group={group}
              key={group.cardId}
              onClose={() => setStartingGroupId(null)}
              shells={groupShells}
              stages={stageState}
            />
          );
        })()}
        {(() => {
          const group =
            phaseGroupId === null ? null : (findBoardCard(columns, phaseGroupId)?.card ?? null);
          return group === null ? null : (
            <BoardNewPhaseDialog
              environmentId={environmentId}
              group={group}
              // The prefix `board_new_phase` would use: the project's setting, not the group's key.
              keyPrefix={
                assignBoardKeyPrefix({
                  board: boardSettings,
                  projectId: group.projectId,
                  projectTitle:
                    allProjects.find((project) => project.id === group.projectId)?.title ?? "",
                }).prefix
              }
              key={group.cardId}
              onClose={() => setPhaseGroupId(null)}
              onOpenBoard={(groupCardId) => openSubBoard(groupCardId)}
              shells={groupShells}
              stages={stageState}
            />
          );
        })()}
        {/* The refused drop's reason, at the pointer. */}
        <div
          aria-live="polite"
          className={cn(
            "pointer-events-none fixed top-0 left-0 z-50 max-w-72 rounded-md border border-border bg-popover px-2.5 py-1.5 text-[12px] text-popover-foreground shadow-md",
            dragTip === null && "hidden",
          )}
          ref={dragTipRef}
          role="status"
        >
          {dragTip}
        </div>
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
        <BoardPlanningExitConfirmDialog
          open={unplannedDrop !== null}
          onOpenChange={(open) => {
            if (!open) setUnplannedDrop(null);
          }}
          cardKey={unplannedDrop?.source.card.key ?? ""}
          fromStageLabel={
            unplannedDrop === null ? "" : boardStageLabel(orderedStages, unplannedDrop.source.stage)
          }
          toStageLabel={
            unplannedDrop === null ? "" : boardStageLabel(orderedStages, unplannedDrop.targetStage)
          }
          onConfirm={() => {
            if (unplannedDrop === null) return;
            const cardId = unplannedDrop.source.card.cardId as string;
            const source = findBoardCard(columns, cardId);
            if (source === null) return;
            const list = (columns[unplannedDrop.targetStage] ?? EMPTY_CARDS)
              .map((card) => card.cardId as string)
              .filter((id) => id !== cardId);
            const anchor =
              unplannedDrop.beforeId === null ? -1 : list.indexOf(unplannedDrop.beforeId);
            list.splice(anchor < 0 ? list.length : anchor, 0, cardId);
            performDrop(unplannedDrop.targetStage, list, source);
          }}
        />
        <BoardCardCreateDialog
          defaultProjectId={
            scope.kind === "sub-board" ? (parentShell?.projectId ?? null) : scopeProjectId
          }
          defaultStage={createStage ?? defaultCreateStageId}
          environmentId={environmentId}
          onOpenChange={(open) => {
            if (!open) setCreateStage(null);
          }}
          open={createStage !== null}
          projects={addProjects}
          subBoardParentId={scope.kind === "sub-board" ? scope.parentCardId : null}
        />
      </div>
    </BoardWorkersContext.Provider>
  );

  // Alt+Up leaves a sub-board for the level above, wherever focus is on the
  // board — but not out of an open dialog, the card sheet or a text field.
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- window keydown listener for Alt+Up, held while this sub-board is mounted.
  useEffect(() => {
    if (scope.kind !== "sub-board") return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (!event.altKey || event.key !== "ArrowUp" || event.defaultPrevented) return;
      if (isEditableFocused(event.target)) return;
      if (document.querySelector("[role=dialog],[role=alertdialog]") !== null) return;
      event.preventDefault();
      goUpOneLevel();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [goUpOneLevel, scope.kind]);
  // Fullscreen rides the store so it survives a STEP between cards, and the store names the
  // card it belongs to, so a card that opens any other way opens windowed whether or not it
  // passed through "no card open" on the way in. This effect only has to forget the card once
  // the sheet is gone, so that re-opening that same card later starts windowed too.
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- the board UI store forgets fullscreen once the URL (which back/forward also edits) drops the card.
  useEffect(() => {
    if (selectedCardId === null) setDetailMaximisedCardId(null);
  }, [selectedCardId, setDetailMaximisedCardId]);
  // Opening a card URL selects the card and brings it into view: expand its
  // column if collapsed, scroll the row into place.
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- expands the column and scrolls the DOM row into view for a card URL.
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
        boardScopeColumnCollapsedByDefault({
          scope,
          stageState,
          stageId: found.stage,
          renderedIndex: renderedStages.findIndex((stage) => stage.stageId === found.stage),
          // The card is in it, so it is not empty.
          cardCount: 1,
        }),
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
  }, [
    collapseKeyOf,
    collapsedByStage,
    columns,
    handledDeepLinkRef,
    renderedStages,
    scope,
    search.card,
    setColumnCollapsed,
    stageState,
  ]);
  // Cross-scope deep links resolve to the right board: a child
  // card's URL opened over the root board — or over the wrong sub-board —
  // navigates into its parent's sub-board with the sheet selection intact,
  // and a top-level card's URL opened inside a sub-board goes back up.
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- router: redirects a cross-scope card URL to the board that holds the card.
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
  // Dead sub-board links resolve UP: a URL naming a card with no
  // children lands on the root board with that card's sheet open; a card that
  // does not exist at all lands on the bare root board. Gated on the first
  // snapshot so an empty pre-connection board is never mistaken for either.
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- router: redirects a dead sub-board URL up once the first snapshot arrives.
  useEffect(() => {
    if (scope.kind !== "sub-board" || !snapshotArrived) return;
    const entry = resolveSubBoardEntry(Object.values(liveColumns).flat(), scope.parentCardId);
    if (entry.kind === "redirect-parent-sheet") {
      openRootBoard(scope.parentCardId, { replace: true });
    } else if (entry.kind === "redirect-root") {
      openRootBoard(undefined, { replace: true });
    }
  }, [liveColumns, openRootBoard, scope, snapshotArrived]);
  // The command palette's board actions: published while this board
  // is mounted, cleared when it goes.
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- command palette registry entries, held while this board is mounted.
  useEffect(() => {
    const actions = [
      ...(scope.kind === "sub-board"
        ? [
            {
              id: "up",
              title: "Board: back up one level",
              description: `To ${upKey ?? "the board"} (Alt+↑)`,
              run: () => goUpOneLevel(),
            },
          ]
        : []),
      ...(selectedGroupId === null
        ? []
        : [
            {
              id: `open:${selectedGroupId}`,
              title: `Open ${selectedGroupKey}'s board`,
              description: selectedGroupTitle ?? "",
              run: () => openSubBoard(selectedGroupId),
            },
          ]),
    ];
    setPaletteActions(actions);
    return () => setPaletteActions([]);
  }, [
    goUpOneLevel,
    openSubBoard,
    scope.kind,
    selectedGroupId,
    selectedGroupKey,
    selectedGroupTitle,
    setPaletteActions,
    upKey,
  ]);

  return view;
}

export default BoardPage;
