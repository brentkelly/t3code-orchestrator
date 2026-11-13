/**
 * Board client state, in client-runtime so a mobile board can reuse it. Cards arrive with
 * thread-derived fields at rest; views overlay them from thread shells
 * (`withBoardThreadFields`). Order keys reuse the `threadSort.ts` pin-order helpers.
 */
import {
  BOARD_WS_METHODS,
  EMPTY_BOARD_WORKERS_STATE,
  type BoardCardWorkerMoveRequest,
  type BoardWorkerIdInput,
  type BoardWorkersCancelJoinCodeInput,
  type BoardWorkersDismissSetupInput,
  type BoardWorkersRenameInput,
  type BoardWorkersSetDefaultInput,
  type BoardWorkersSetupProjectInput,
  type BoardAttachCardFileInput,
  type BoardDetachCardFileInput,
  compareBoardStages,
  deriveBoardCardThreadState,
  type BoardCardDetail,
  type BoardCardId,
  type BoardCardShell,
  type BoardCardThreadShell,
  type BoardLabel,
  type BoardThreadStateSource,
  type BoardProjectImportCandidatesInput,
  type BoardProjectImportInput,
  type BoardProjectStageConfigShell,
  type BoardStageDefinition,
  type BoardStageId,
  isBoardCardScheduleDue,
  type EnvironmentId,
  type BoardShellSnapshot,
  type OrchestrationV2ThreadShell,
  type ProjectId,
  type ThreadId,
  type BoardWorkersCapacityActionInput,
} from "@t3tools/contracts";
import {
  type BoardThreadShellFields,
  boardThreadStateSource,
} from "@t3tools/shared/boardThreadState";
import type * as SecureRandom from "effect/crypto/SecureRandom";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/reactivity";

import type { EnvironmentRegistry } from "../connection/registry.ts";
import type { PendingSubagentRequest } from "./models.ts";
import {
  boardWorkerThreadAccess,
  cancelBoardWorkerJoinCode,
  createBoardWorkerJoinCode,
  dismissBoardWorkerSetup,
  previewBoardWorkerRemoval,
  removeBoardWorker,
  renameBoardWorker,
  setDefaultBoardWorker,
  setupBoardWorkerProject,
} from "../operations/boardWorkers.ts";
import {
  approveBoardPlans,
  archiveBoardCard,
  createBoardCard,
  createBoardLabel,
  createBoardStage,
  deleteBoardCard,
  deleteBoardLabel,
  deleteBoardStage,
  dismissBoardProjectImport,
  exportBoardProjectFile,
  getBoardProjectConfig,
  getBoardProjectImportCandidates,
  getBoardProjectTokenStatus,
  importBoardProjectFile,
  resetBoardProject,
  setBoardProjectCiEnabled,
  setBoardProjectCiStopOnFailure,
  setBoardProjectCiSteps,
  setBoardProjectStageOverride,
  setBoardProjectStageSwitch,
  setBoardStageDefault,
  linkBoardCardThread,
  attachBoardCardFile,
  detachBoardCardFile,
  mergeBoardCardPullRequest,
  moveBoardCard,
  moveBoardCards,
  setBoardCardGroupSettings,
  setBoardCardAutomation,
  cancelBoardCardWork,
  refreshBoardCardPullRequest,
  linkBoardCardPullRequest,
  renameBoardStage,
  reorderBoardCard,
  requeueBoardCardStep,
  forceStartBoardCardStep,
  reopenBoardCardStep,
  reorderBoardStage,
  startBoardStageThread,
  requestBoardReviewRound,
  skipBoardCardCi,
  retryBoardCardCi,
  sendBackBoardCardCi,
  removeBoardCardWorktree,
  checkBoardCardWorktree,
  submitBoardCardForMerge,
  unarchiveBoardCard,
  undeleteBoardLabel,
  unlinkBoardCardThread,
  updateBoardCard,
  boardCardSetupAction,
  type BoardCardSetupActionInput,
  setBoardCardProject,
  pinBoardCardWorker,
  boardCardWorkerMove,
  type PinBoardCardWorkerInput,
  updateBoardLabel,
  type ApproveBoardPlansInput,
  type ArchiveBoardCardInput,
  type CreateBoardCardInput,
  type CreateBoardLabelInput,
  type CreateBoardStageInput,
  type DeleteBoardCardInput,
  type DeleteBoardLabelInput,
  type DeleteBoardStageInput,
  type DismissBoardProjectImportInput,
  type ResetBoardProjectInput,
  type SetBoardProjectCiEnabledInput,
  type SetBoardProjectCiStopOnFailureInput,
  type SetBoardProjectCiStepsInput,
  type SetBoardProjectStageOverrideInput,
  type SetBoardProjectStageSwitchInput,
  type SetBoardStageDefaultInput,
  type LinkBoardCardThreadInput,
  type MoveBoardCardInput,
  type MoveBoardCardsInput,
  type SetBoardCardGroupSettingsInput,
  type SetBoardCardAutomationInput,
  type CancelBoardCardWorkInput,
  type RenameBoardStageInput,
  type ReorderBoardCardInput,
  type RequeueBoardCardStepInput,
  type ForceStartBoardCardStepInput,
  type ReopenBoardCardStepInput,
  type ReorderBoardStageInput,
  type StartBoardStageThreadInput,
  type UnarchiveBoardCardInput,
  type UndeleteBoardLabelInput,
  type UnlinkBoardCardThreadInput,
  type UpdateBoardCardInput,
  type SetBoardCardProjectInput,
  type UpdateBoardLabelInput,
} from "../operations/boardCommands.ts";
import type { EnvironmentShellState } from "./shell.ts";
import { boardCapacityAction, boardCapacityViewStream } from "./boardCapacity.ts";
import {
  createEnvironmentCommand,
  createEnvironmentRpcQueryAtomFamily,
  createEnvironmentRpcSubscriptionAtomFamily,
  createEnvironmentSubscriptionAtomFamily,
  environmentRpcKey,
} from "./runtime.ts";
import {
  boardCiLogDownloadStream,
  boardCiLogViewStream,
  type BoardCiLogRequest,
} from "./boardCiLog.ts";
import { pinOrderKeyBetween, planPinnedReorder } from "./threadSort.ts";

export * from "./boardReducer.ts";
export * from "./boardSubscription.ts";

export type {
  DismissBoardProjectImportInput,
  ResetBoardProjectInput,
  SetBoardProjectCiEnabledInput,
  SetBoardProjectCiStopOnFailureInput,
  SetBoardProjectCiStepsInput,
  SetBoardProjectStageOverrideInput,
  SetBoardProjectStageSwitchInput,
  SetBoardStageDefaultInput,
  MoveBoardCardsInput,
  SetBoardCardGroupSettingsInput,
  SetBoardCardAutomationInput,
  CancelBoardCardWorkInput,
  ApproveBoardPlansInput,
  ArchiveBoardCardInput,
  CreateBoardCardInput,
  CreateBoardLabelInput,
  CreateBoardStageInput,
  DeleteBoardCardInput,
  DeleteBoardLabelInput,
  DeleteBoardStageInput,
  LinkBoardCardThreadInput,
  MoveBoardCardInput,
  RenameBoardStageInput,
  ReorderBoardCardInput,
  RequeueBoardCardStepInput,
  ForceStartBoardCardStepInput,
  ReopenBoardCardStepInput,
  ReorderBoardStageInput,
  StartBoardStageThreadInput,
  UnarchiveBoardCardInput,
  UndeleteBoardLabelInput,
  UnlinkBoardCardThreadInput,
  UpdateBoardCardInput,
  SetBoardCardProjectInput,
  PinBoardCardWorkerInput,
  UpdateBoardLabelInput,
};

type ThreadShellLookup = (threadId: ThreadId) => OrchestrationV2ThreadShell | undefined;

/** Every live-linked thread id of a card. Falls back to `activeThreadId` when
    `boardCardThreads` has not arrived, so the aggregate degrades rather than empties. */
function liveCardThreadIds(
  card: BoardCardShell,
  cardThreads: ReadonlyArray<BoardCardThreadShell> | undefined,
): ReadonlyArray<ThreadId> {
  const linked = (cardThreads ?? [])
    .filter((entry) => entry.cardId === card.cardId)
    .map((entry) => entry.threadId);
  if (linked.length > 0) return linked;
  return card.activeThreadId === null ? [] : [card.activeThreadId];
}

/** `liveCardThreadIds` for many cards: indexes the links once instead of per card. */
export function indexLiveCardThreadIds(
  cardThreads: ReadonlyArray<BoardCardThreadShell> | undefined,
): (card: BoardCardShell) => ReadonlyArray<ThreadId> {
  const linkedByCard = new Map<string, Array<ThreadId>>();
  for (const entry of cardThreads ?? []) {
    const linked = linkedByCard.get(entry.cardId);
    if (linked === undefined) linkedByCard.set(entry.cardId, [entry.threadId]);
    else linked.push(entry.threadId);
  }
  return (card) =>
    linkedByCard.get(card.cardId) ?? (card.activeThreadId === null ? [] : [card.activeThreadId]);
}

/** Aggregated across every live-linked thread, matching the server's snapshot enrichment
    exactly, or the badge flickers between a snapshot and the next delta. Returns the same
    card reference when nothing changed. */
function withDerivedThreadFields(
  card: BoardCardShell,
  threadById: ThreadShellLookup,
  cardThreads: ReadonlyArray<BoardCardThreadShell> | undefined,
  subagentRequests: ReadonlyMap<ThreadId, PendingSubagentRequest>,
): BoardCardShell {
  const threads = liveCardThreadIds(card, cardThreads).map((threadId) => {
    const thread = threadById(threadId);
    return thread === undefined
      ? undefined
      : boardThreadStateSourceWithSubagents(thread, subagentRequests);
  });
  const { threadState, awaitingInput, waitingOnBackground, awaitingSubagent } =
    deriveBoardCardThreadState(threads);
  if (
    card.threadState === threadState &&
    card.awaitingInput === awaitingInput &&
    (card.waitingOnBackground ?? false) === waitingOnBackground &&
    (card.awaitingSubagent ?? false) === awaitingSubagent
  ) {
    return card;
  }
  // The key is omitted when false, matching the server's shell.
  const { waitingOnBackground: _previous, awaitingSubagent: _previousSubagent, ...rest } = card;
  return {
    ...rest,
    threadState,
    awaitingInput,
    ...(waitingOnBackground ? { waitingOnBackground: true } : {}),
    ...(awaitingSubagent ? { awaitingSubagent: true } : {}),
  };
}

const NO_SUBAGENT_REQUESTS: ReadonlyMap<ThreadId, PendingSubagentRequest> = new Map();

/** A thread's board state source, flagged when upstream's subagent-request map
    (`pendingSubagentRequestsAtom`) says something under it awaits approval.
    Only approvals count: the coordinator answers child questions. */
export function boardThreadStateSourceWithSubagents(
  thread: BoardThreadShellFields & { readonly id: ThreadId },
  subagentRequests: ReadonlyMap<ThreadId, PendingSubagentRequest>,
): BoardThreadStateSource {
  const source = boardThreadStateSource(thread);
  return subagentRequests.get(thread.id) === "approval"
    ? { ...source, subagentAwaitingApproval: true }
    : source;
}

// ── Column ordering ────────────────────────────────────────────────────

/** Column order inside a stage: (orderKey, cardId) by code units — the
    cardId tiebreak keeps two clients that computed equal keys agreeing. */
export function compareBoardCardShells(left: BoardCardShell, right: BoardCardShell): number {
  const compare = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
  return compare(left.orderKey, right.orderKey) || compare(left.cardId, right.cardId);
}

/** Scans for the maximum key rather than trusting input order (snapshot order is
    createdAt). Falls back to the open-bounds midpoint when the column is empty or its
    bottom key is corrupt. */
export function boardColumnAppendOrderKey(
  column: ReadonlyArray<Pick<BoardCardShell, "orderKey">>,
): string {
  let bottomKey: string | null = null;
  for (const card of column) {
    if (bottomKey === null || card.orderKey > bottomKey) bottomKey = card.orderKey;
  }
  return pinOrderKeyBetween(bottomKey, null) ?? (pinOrderKeyBetween(null, null) as string);
}

/**
 * Assignments realizing a drop within or into a stage column, over `planPinnedReorder`.
 * Callers dispatch `board.card.reorder` per assignment, or `board.card.move` with the moved
 * card's key when the drop crossed stages.
 */
export function planBoardCardReorder(input: {
  /** Card ids in the desired visual order (after the move). */
  readonly orderedCardIds: readonly string[];
  readonly keysByCardId: ReadonlyMap<string, string | null | undefined>;
  readonly movedCardId: string;
}): ReadonlyArray<{ readonly cardId: string; readonly orderKey: string }> {
  return planPinnedReorder({
    orderedIds: input.orderedCardIds,
    keysById: input.keysByCardId,
    movedId: input.movedCardId,
  }).map((assignment) => ({ cardId: assignment.id, orderKey: assignment.orderKey }));
}

// ── Board views and drag support ──────────────────────────────
// Pure helpers shared by every board UI: the web board consumes them
// today, a mobile board reuses them without a rewrite.

// Columns are keyed by stage id: stages are user-defined, so the
// column map is dynamic — only stages that hold cards appear. The board UI
// iterates the read-model stage list and reads `columns[stageId] ?? []`, so an
// empty stage still renders as an empty column without needing a key here.
export type BoardStageColumns = Readonly<Record<string, ReadonlyArray<BoardCardShell>>>;

const EMPTY_BOARD_PROJECTS: ReadonlyMap<ProjectId, BoardStageColumns> = new Map();

function pushColumn(
  columns: Record<string, BoardCardShell[]>,
  stage: string,
  card: BoardCardShell,
): void {
  (columns[stage] ??= []).push(card);
}

/**
 * The server leaves thread-derived fields at rest, so overlaying them here lets a thread
 * starting or stopping update its card with no board delta. Returns the same snapshot when
 * no card changed.
 */
export function withBoardThreadFields(
  board: BoardShellSnapshot,
  threads: ReadonlyArray<OrchestrationV2ThreadShell>,
  subagentRequests: ReadonlyMap<ThreadId, PendingSubagentRequest> = NO_SUBAGENT_REQUESTS,
): BoardShellSnapshot {
  if (board.cards.length === 0) return board;
  const threadsById = new Map(threads.map((thread) => [thread.id, thread]));
  let changed = false;
  const cards = board.cards.map((card) => {
    const next = withDerivedThreadFields(
      card,
      (threadId) => threadsById.get(threadId),
      board.cardThreads,
      subagentRequests,
    );
    if (next !== card) changed = true;
    return next;
  });
  return changed ? { ...board, cards } : board;
}

function groupBoardCards(
  cards: ReadonlyArray<BoardCardShell>,
): ReadonlyMap<ProjectId, BoardStageColumns> {
  if (cards.length === 0) return EMPTY_BOARD_PROJECTS;
  const byProject = new Map<ProjectId, Record<string, BoardCardShell[]>>();
  for (const card of cards) {
    let columns = byProject.get(card.projectId);
    if (columns === undefined) {
      columns = {};
      byProject.set(card.projectId, columns);
    }
    pushColumn(columns, card.stage, card);
  }
  for (const columns of byProject.values()) {
    for (const stage of Object.keys(columns)) {
      columns[stage]!.sort(compareBoardCardShells);
    }
  }
  return byProject;
}

/**
 * Stage columns for the "All projects" scope — a view over the per-project
 * grouping, never a stored entity: cards stay keyed to their own
 * `ProjectId` and each merged column re-sorts with the canonical
 * comparator so every client agrees on the cross-project order.
 */
export function mergeBoardStageColumns(
  columnsList: Iterable<BoardStageColumns>,
): BoardStageColumns {
  const merged: Record<string, BoardCardShell[]> = {};
  for (const columns of columnsList) {
    for (const [stage, cards] of Object.entries(columns)) {
      if (cards.length > 0) (merged[stage] ??= []).push(...cards);
    }
  }
  for (const stage of Object.keys(merged)) {
    merged[stage]!.sort(compareBoardCardShells);
  }
  return merged;
}

/** The stage and order key a drop expects the server to store — held
    client-side until the shell confirms it (optimistic reordering with
    server reconciliation; the drag never blocks on a round trip). */
export interface BoardCardPlacement {
  readonly cardId: string;
  readonly stage: BoardStageId;
  readonly orderKey: string;
}

/**
 * Pure and idempotent: a confirmed placement changes nothing and one for a departed card is
 * ignored, so callers prune only to bound the list (`isBoardCardPlacementSettled`). Returns
 * the input columns object when no placement changes anything.
 */
export function applyBoardCardPlacements(
  columns: BoardStageColumns,
  placements: ReadonlyArray<BoardCardPlacement>,
): BoardStageColumns {
  if (placements.length === 0) return columns;
  const placementByCardId = new Map(placements.map((placement) => [placement.cardId, placement]));
  const next: Record<string, BoardCardShell[]> = {};
  let changed = false;
  for (const cards of Object.values(columns)) {
    for (const card of cards) {
      const placement = placementByCardId.get(card.cardId);
      if (
        placement === undefined ||
        (placement.stage === card.stage && placement.orderKey === card.orderKey)
      ) {
        pushColumn(next, card.stage, card);
        continue;
      }
      changed = true;
      pushColumn(next, placement.stage, {
        ...card,
        stage: placement.stage,
        orderKey: placement.orderKey,
      });
    }
  }
  if (!changed) return columns;
  for (const stage of Object.keys(next)) {
    next[stage]!.sort(compareBoardCardShells);
  }
  return next;
}

/** True once the live columns already reflect the placement — the server
    confirmed the drop (or the card left the board) and the optimistic
    overlay entry can be dropped. */
export function isBoardCardPlacementSettled(
  columns: BoardStageColumns,
  placement: BoardCardPlacement,
): boolean {
  for (const cards of Object.values(columns)) {
    const card = cards.find((existing) => existing.cardId === placement.cardId);
    if (card !== undefined) {
      return card.stage === placement.stage && card.orderKey === placement.orderKey;
    }
  }
  return true;
}

/** One queued card's place in the board-wide build queue. Positions
    are a VIEW over the queue and are never stored on a card: every one of
    these is recomputed whenever the queue changes. */
export interface BoardQueueSlot {
  /** 1-based place in the queue. */
  readonly position: number;
  /** How many cards are queued in total, this one included. */
  readonly total: number;
  /** Cards that will be admitted before this one. */
  readonly ahead: number;
  readonly startsNext: boolean;
}

/**
 * Mirrors the server's `orderBoardQueue` across the whole environment: later stage first,
 * then drag order. It skips the server's started-before-unstarted tiebreak, which needs card
 * detail. A future scheduled start is excluded: such a card stays `queued` while the server
 * no longer offers it a slot, and counting it would misnumber every card behind it.
 */
export function boardBuildQueue(
  cards: ReadonlyArray<BoardCardShell>,
  stages: ReadonlyArray<BoardStageDefinition>,
  /** Compared against each card's schedule. Required rather than defaulted:
      this package has no ambient clock, and a caller that forgot it would
      silently number a scheduled card into the queue. */
  nowMs: number,
): ReadonlyMap<string, BoardQueueSlot> {
  // A card held for its offline worker waits on no slot, so it takes
  // no place in the queue; its notice says Worker offline instead.
  const queued = cards.filter(
    (card) =>
      card.queued &&
      card.queuedBy !== "worker-offline" &&
      isBoardCardScheduleDue(card.scheduledStartAt, nowMs),
  );
  if (queued.length === 0) return EMPTY_QUEUE;
  const stageOrder = new Map(stages.map((stage, index) => [stage.stageId, index]));
  // An unknown stage sorts last rather than ahead of everything: a card on a
  // stage this client has not seen yet must not claim the front of the queue.
  const rankOf = (card: BoardCardShell) => stageOrder.get(card.stage) ?? -1;
  const ordered = [...queued].sort(
    (left, right) =>
      rankOf(right) - rankOf(left) ||
      (left.orderKey < right.orderKey ? -1 : left.orderKey > right.orderKey ? 1 : 0) ||
      (left.cardId < right.cardId ? -1 : left.cardId > right.cardId ? 1 : 0),
  );
  const queue = new Map<string, BoardQueueSlot>();
  ordered.forEach((card, index) => {
    queue.set(card.cardId, {
      position: index + 1,
      total: ordered.length,
      ahead: index,
      startsNext: index === 0,
    });
  });
  return queue;
}

const EMPTY_QUEUE: ReadonlyMap<string, BoardQueueSlot> = new Map();

/** Steps the executor is actually running, board-wide — the numerator
    of "3 of 3 agents busy". Counted from the same shells the queue is, so the
    two halves of that sentence can never disagree. */
export function boardRunningStepCount(cards: ReadonlyArray<BoardCardShell>): number {
  let running = 0;
  for (const card of cards) if (card.stepRunning) running += 1;
  return running;
}

/**
 * Null when the card is already first or reordering cannot improve its position (drag order
 * is only the last tiebreak). Checked by running the derivation against the projected key,
 * so it cannot drift from what the queue will show.
 */
export function planBoardQueueMoveToFront(input: {
  readonly cards: ReadonlyArray<BoardCardShell>;
  readonly stages: ReadonlyArray<BoardStageDefinition>;
  readonly cardId: string;
  /** Passed straight through to `boardBuildQueue`, so the projected position is
      measured against exactly the queue the user is looking at. */
  readonly nowMs: number;
}): { readonly orderKey: string } | null {
  const current = boardBuildQueue(input.cards, input.stages, input.nowMs).get(input.cardId);
  if (current === undefined || current.position === 1) return null;
  let frontKey: string | null = null;
  for (const card of input.cards) {
    if (!card.queued) continue;
    if (frontKey === null || card.orderKey < frontKey) frontKey = card.orderKey;
  }
  const orderKey = pinOrderKeyBetween(null, frontKey);
  if (orderKey === null) return null;
  const projected = boardBuildQueue(
    input.cards.map((card) => (card.cardId === input.cardId ? { ...card, orderKey } : card)),
    input.stages,
    input.nowMs,
  ).get(input.cardId);
  return projected !== undefined && projected.position < current.position ? { orderKey } : null;
}

/** Card-detail subscriptions get a short grace so closing and immediately
    reopening a card does not tear the stream down and refetch; past it the
    subscription is disposed with the atom. */
const BOARD_CARD_DETAIL_IDLE_TTL_MS = 5_000;

export function createBoardEnvironmentAtoms<R, ER>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | SecureRandom.SecureRandom | R, ER>,
  options: {
    readonly shellStateValueAtom: (
      environmentId: EnvironmentId,
    ) => Atom.Atom<EnvironmentShellState>;
    /** The environment's board subscription (`createEnvironmentBoardStateAtoms`). */
    readonly boardSnapshotValueAtom: (
      environmentId: EnvironmentId,
    ) => Atom.Atom<BoardShellSnapshot | null>;
    /** Upstream's parent→subagent-request map. Cached upstream, so
        it keeps its identity across streaming ticks. */
    readonly pendingSubagentRequestsAtom: (
      environmentId: EnvironmentId,
    ) => Atom.Atom<ReadonlyMap<ThreadId, PendingSubagentRequest>>;
  },
) {
  /** The board, with thread-derived card fields overlaid from the live thread
      shells — null until the board's first snapshot arrives. Every view of the
      cards reads this, so they all agree on a card's thread state. */
  const boardAtom = Atom.family((environmentId: EnvironmentId) =>
    Atom.make((get): BoardShellSnapshot | null => {
      const board = get(options.boardSnapshotValueAtom(environmentId));
      if (board === null) return null;
      const shell = get(options.shellStateValueAtom(environmentId));
      return withBoardThreadFields(
        board,
        Option.match(shell.snapshot, { onNone: () => [], onSome: (value) => value.threads }),
        get(options.pendingSubagentRequestsAtom(environmentId)),
      );
    }).pipe(Atom.withLabel(`environment-board:${environmentId}`)),
  );

  /** Cards grouped by project, then by stage in board column order, each
      column sorted by orderKey. */
  const cardsByProjectAtom = Atom.family((environmentId: EnvironmentId) =>
    Atom.make((get) => {
      const board = get(boardAtom(environmentId));
      return board === null ? EMPTY_BOARD_PROJECTS : groupBoardCards(board.cards);
    }).pipe(Atom.withLabel(`environment-board-cards:${environmentId}`)),
  );

  /**
   * Live card-thread links and cached todo summaries, keyed by card id; a projection over the
   * snapshot kept current by `card-threads`, not a subscription. A thread with no todo fields
   * is linked but has never emitted `turn.plan.updated` (the cache fills forward only).
   */
  const EMPTY_CARD_THREADS: ReadonlyMap<
    BoardCardId,
    ReadonlyArray<BoardCardThreadShell>
  > = new Map();
  const cardThreadsByCardAtom = Atom.family((environmentId: EnvironmentId) =>
    Atom.make((get) => {
      const entries = get(options.boardSnapshotValueAtom(environmentId))?.cardThreads ?? [];
      if (entries.length === 0) return EMPTY_CARD_THREADS;
      const byCard = new Map<BoardCardId, BoardCardThreadShell[]>();
      for (const entry of entries) {
        const list = byCard.get(entry.cardId) ?? [];
        list.push(entry);
        byCard.set(entry.cardId, list);
      }
      return byCard;
    }).pipe(Atom.withLabel(`environment-board-card-threads:${environmentId}`)),
  );

  /** The board's label catalogue — the vocabulary every card chip
      and the label picker read. Includes tombstoned labels (a card carrying
      one renders it muted); the picker filters `deletedAt !== null`. Empty
      until the first snapshot. */
  const EMPTY_LABELS: ReadonlyArray<BoardLabel> = [];
  const labelCatalogueAtom = Atom.family((environmentId: EnvironmentId) =>
    Atom.make(
      (get) => get(options.boardSnapshotValueAtom(environmentId))?.labels ?? EMPTY_LABELS,
    ).pipe(Atom.withLabel(`environment-board-labels:${environmentId}`)),
  );

  /** The board's user-defined stage list in canonical order — the
      source of column order and labels the board UI reads. Empty until
      the first snapshot (the caller falls back to the compiled seeds via
      `boardStages`). */
  const EMPTY_STAGES: ReadonlyArray<BoardStageDefinition> = [];
  const stageListAtom = Atom.family((environmentId: EnvironmentId) =>
    Atom.make((get) => {
      const stages = get(options.boardSnapshotValueAtom(environmentId))?.stages ?? EMPTY_STAGES;
      return stages.length === 0 ? EMPTY_STAGES : [...stages].sort(compareBoardStages);
    }).pipe(Atom.withLabel(`environment-board-stages:${environmentId}`)),
  );

  /** Each project's delta from the global pipeline, shell-sized.
      Empty when no project has one. */
  const EMPTY_PROJECT_STAGE_CONFIGS: Readonly<Record<string, BoardProjectStageConfigShell>> = {};
  const projectStageConfigsAtom = Atom.family((environmentId: EnvironmentId) =>
    Atom.make(
      (get) =>
        get(options.boardSnapshotValueAtom(environmentId))?.projectStageConfigs ??
        EMPTY_PROJECT_STAGE_CONFIGS,
    ).pipe(Atom.withLabel(`environment-board-project-stage-configs:${environmentId}`)),
  );

  /** The board's workers, or the local-only summary when the
      board has none — which is every board until a worker is added. */
  const workersAtom = Atom.family((environmentId: EnvironmentId) =>
    Atom.make(
      (get) =>
        get(options.boardSnapshotValueAtom(environmentId))?.workers ?? EMPTY_BOARD_WORKERS_STATE,
    ).pipe(Atom.withLabel(`environment-board-workers:${environmentId}`)),
  );

  /** The archive page's cards, read when the page opens. */
  const archivedCardsAtom = createEnvironmentRpcQueryAtomFamily(runtime, {
    label: "environment-data:board:archived-cards",
    tag: BOARD_WS_METHODS.getArchivedCards,
  });

  const cardDetailStateAtom = createEnvironmentRpcSubscriptionAtomFamily(runtime, {
    label: "environment-board-card-detail",
    tag: BOARD_WS_METHODS.subscribeCard,
    idleTtlMs: BOARD_CARD_DETAIL_IDLE_TTL_MS,
  });

  /** Latest detail for one open card, or null while loading. One
      subscription per open card, keyed by (environment, card), disposed
      shortly after the last subscriber (the card view) unmounts. */
  const cardDetailValueAtomFamily = Atom.family((key: string) =>
    Atom.make((get) => {
      const target = parseBoardCardDetailKey(key);
      const result = get(
        cardDetailStateAtom({
          environmentId: target.environmentId,
          input: { cardId: target.cardId },
        }),
      );
      return Option.match(AsyncResult.value(result), {
        onNone: () => null,
        onSome: (item) => item.detail,
      });
    }).pipe(
      Atom.setIdleTTL(BOARD_CARD_DETAIL_IDLE_TTL_MS),
      Atom.withLabel(`environment-board-card-detail-value:${key}`),
    ),
  );

  const cardDetailValueAtom = (target: {
    readonly environmentId: EnvironmentId;
    readonly cardId: BoardCardId;
  }): Atom.Atom<BoardCardDetail | null> =>
    cardDetailValueAtomFamily(
      environmentRpcKey({
        environmentId: target.environmentId,
        input: { cardId: target.cardId },
      }),
    );

  /** One CI step's log in the viewer. Closing the viewer stops the
      read almost at once: a followed log polls on the server. */
  const ciLogAtom = createEnvironmentSubscriptionAtomFamily(runtime, {
    label: "environment-board-ci-log",
    idleTtlMs: 1_000,
    subscribe: (request: BoardCiLogRequest) => boardCiLogViewStream(request),
  });

  /** The whole of one CI step's log, for Download. */
  const ciLogDownloadAtom = createEnvironmentSubscriptionAtomFamily(runtime, {
    label: "environment-board-ci-log-download",
    idleTtlMs: 0,
    subscribe: (request: Pick<BoardCiLogRequest, "cardId" | "runId" | "index">) =>
      boardCiLogDownloadStream(request),
  });

  /** T3o: each worker's capacity, for the views that show it (T3O-86). */
  const capacityAtom = createEnvironmentSubscriptionAtomFamily(runtime, {
    label: "environment-board-capacity",
    idleTtlMs: 5_000,
    subscribe: (_request: Record<string, never>) => boardCapacityViewStream(),
  });

  return {
    boardAtom,
    capacityAtom,
    capacityAction: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:board:capacity-action",
      execute: (input: BoardWorkersCapacityActionInput) => boardCapacityAction(input),
    }),
    ciLogAtom,
    ciLogDownloadAtom,
    cardsByProjectAtom,
    cardThreadsByCardAtom,
    archivedCardsAtom,
    labelCatalogueAtom,
    stageListAtom,
    projectStageConfigsAtom,
    workersAtom,
    /** Raw subscription state (loading/failure visible), keyed like
        `cardDetailValueAtom`. */
    cardDetailStateAtom,
    cardDetailValueAtom,
    createCard: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:board:create-card",
      execute: (input: CreateBoardCardInput) => createBoardCard(input),
    }),
    moveCard: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:board:move-card",
      execute: (input: MoveBoardCardInput) => moveBoardCard(input),
    }),
    /** Re-resolve the card's pull request from the forge. Cheap and safe to
        fire on any of the client-side refresh triggers — the server-side
        lookup is cached for two minutes, so a burst costs one forge call. */
    refreshCardPullRequest: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:board:refresh-card-pull-request",
      execute: (input: { readonly cardId: BoardCardId; readonly force?: boolean }) =>
        refreshBoardCardPullRequest(input),
    }),
    /** Link a pull request to the card by hand. Resolves to the
        outcome the card shows — linked, or the server's refusal. */
    linkCardPullRequest: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:board:link-card-pull-request",
      execute: (input: { readonly cardId: BoardCardId; readonly target: string }) =>
        linkBoardCardPullRequest(input),
    }),
    /** Merge the card's pull request and advance it. Resolves to the outcome
        the button reports — merged, refused, conflict-being-resolved. */
    mergeCardPullRequest: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:board:merge-card-pull-request",
      execute: (input: { readonly cardId: BoardCardId }) => mergeBoardCardPullRequest(input),
    }),
    /** Open the card's pull request from Building and route it past Code
        review. Resolves to the outcome the card reports — started, or
        the reason it was refused. */
    submitCardForMerge: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:board:submit-card-for-merge",
      execute: (input: { readonly cardId: BoardCardId }) => submitBoardCardForMerge(input),
    }),
    /** Run one more review round on a settled loop. Resolves to the
        round it bought, or the reason it was refused. */
    requestReviewRound: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:board:request-review-round",
      execute: (input: { readonly cardId: BoardCardId }) => requestBoardReviewRound(input),
    }),
    /** Skip CI for a card in the CI stage. Resolves to where the
        card went, or why it could not. */
    retryCi: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:board:retry-ci",
      execute: (input: { readonly cardId: BoardCardId }) => retryBoardCardCi(input),
    }),
    /** Stop CI: hold the card's pass; Retry CI runs it again. */
    stopCi: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:board:stop-ci",
      execute: (input: { readonly cardId: BoardCardId }) =>
        retryBoardCardCi({ cardId: input.cardId, action: "stop" }),
    }),
    sendBackCi: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:board:send-back-ci",
      execute: (input: { readonly cardId: BoardCardId }) => sendBackBoardCardCi(input),
    }),
    skipCi: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:board:skip-ci",
      execute: (input: { readonly cardId: BoardCardId }) => skipBoardCardCi(input),
    }),
    /** Remove a finished card's kept worktree past the safety rule. */
    removeCardWorktree: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:board:remove-card-worktree",
      execute: (input: { readonly cardId: BoardCardId }) => removeBoardCardWorktree(input),
    }),
    /** Re-run a kept worktree's cleanup and say what it did. */
    checkCardWorktree: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:board:check-card-worktree",
      execute: (input: { readonly cardId: BoardCardId }) => checkBoardCardWorktree(input),
    }),
    /** Attach a pending upload to a card's brief. Resolves with the
        stored record — the name may have been de-duplicated server-side. */
    attachCardFile: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:board:attach-card-file",
      execute: (input: BoardAttachCardFileInput) => attachBoardCardFile(input),
    }),
    detachCardFile: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:board:detach-card-file",
      execute: (input: BoardDetachCardFileInput) => detachBoardCardFile(input),
    }),
    // Managing the board's workers. A refusal is a sentence to show inline.
    createWorkerJoinCode: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:board:create-worker-join-code",
      execute: (_input: Record<string, never>) => createBoardWorkerJoinCode(),
    }),
    cancelWorkerJoinCode: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:board:cancel-worker-join-code",
      execute: (input: BoardWorkersCancelJoinCodeInput) => cancelBoardWorkerJoinCode(input),
    }),
    renameWorker: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:board:rename-worker",
      execute: (input: BoardWorkersRenameInput) => renameBoardWorker(input),
    }),
    workerThreadAccess: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:board:worker-thread-access",
      execute: (input: BoardWorkerIdInput) => boardWorkerThreadAccess(input),
    }),
    removeWorker: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:board:remove-worker",
      execute: (input: BoardWorkerIdInput) => removeBoardWorker(input),
    }),
    previewWorkerRemoval: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:board:preview-worker-removal",
      execute: (input: BoardWorkerIdInput) => previewBoardWorkerRemoval(input),
    }),
    setDefaultWorker: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:board:set-default-worker",
      execute: (input: BoardWorkersSetDefaultInput) => setDefaultBoardWorker(input),
    }),
    setupWorkerProject: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:board:setup-worker-project",
      execute: (input: BoardWorkersSetupProjectInput) => setupBoardWorkerProject(input),
    }),
    dismissWorkerSetup: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:board:dismiss-worker-setup",
      execute: (input: BoardWorkersDismissSetupInput) => dismissBoardWorkerSetup(input),
    }),
    /** Regroup cards; the board's New phase and shared parent. */
    moveCards: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:board:move-cards",
      execute: (input: MoveBoardCardsInput) => moveBoardCards(input),
    }),
    setGroupSettings: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:board:set-group-settings",
      execute: (input: SetBoardCardGroupSettingsInput) => setBoardCardGroupSettings(input),
    }),
    /** A card's own Automation toggles. */
    setCardAutomation: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:board:set-card-automation",
      execute: (input: SetBoardCardAutomationInput) => setBoardCardAutomation(input),
    }),
    /** Destructive: the caller confirmed it by the card's typed key. */
    cancelCardWork: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:board:cancel-card-work",
      execute: (input: CancelBoardCardWorkInput) => cancelBoardCardWork(input),
    }),
    reorderCard: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:board:reorder-card",
      execute: (input: ReorderBoardCardInput) => reorderBoardCard(input),
    }),
    /** Start a queued step now, over the agent cap. */
    forceStartStep: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:board:force-start-step",
      execute: (input: ForceStartBoardCardStepInput) => forceStartBoardCardStep(input),
    }),
    /** Resume a card's paused step: it re-enters the build queue and
        the governor admits it into its EXISTING thread when a slot frees. */
    requeueStep: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:board:requeue-step",
      execute: (input: RequeueBoardCardStepInput) => requeueBoardCardStep(input),
    }),
    /** Send a settled step back because its recorded payload cannot be read —
         the way out of a review round that halted `unreadable`. */
    reopenStep: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:board:reopen-step",
      execute: (input: ReopenBoardCardStepInput) => reopenBoardCardStep(input),
    }),
    updateCard: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:board:update-card",
      execute: (input: UpdateBoardCardInput) => updateBoardCard(input),
    }),
    cardSetupAction: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:board:card-setup-action",
      execute: (input: BoardCardSetupActionInput) => boardCardSetupAction(input),
    }),
    /** Move a card to another project — human-only, and refused by the
        decider once the card has ever been built. */
    setCardProject: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:board:set-card-project",
      execute: (input: SetBoardCardProjectInput) => setBoardCardProject(input),
    }),
    /** Pin a card to a worker, or follow the default. */
    pinCardWorker: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:board:pin-card-worker",
      execute: (input: PinBoardCardWorkerInput) => pinBoardCardWorker(input),
    }),
    /** The Move dialog's check / move / ask-push. */
    cardWorkerMove: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:board:card-worker-move",
      execute: (input: BoardCardWorkerMoveRequest) => boardCardWorkerMove(input),
    }),
    linkThread: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:board:link-thread",
      execute: (input: LinkBoardCardThreadInput) => linkBoardCardThread(input),
    }),
    unlinkThread: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:board:unlink-thread",
      execute: (input: UnlinkBoardCardThreadInput) => unlinkBoardCardThread(input),
    }),
    archiveCard: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:board:archive-card",
      execute: (input: ArchiveBoardCardInput) => archiveBoardCard(input),
    }),
    unarchiveCard: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:board:unarchive-card",
      execute: (input: UnarchiveBoardCardInput) => unarchiveBoardCard(input),
    }),
    /** Irreversible: the card, its threads, its worktree and its branches all
        go. Only ever wire this to a confirmed user action. */
    deleteCard: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:board:delete-card",
      execute: (input: DeleteBoardCardInput) => deleteBoardCard(input),
    }),
    approvePlans: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:board:approve-plans",
      execute: (input: ApproveBoardPlansInput) => approveBoardPlans(input),
    }),
    createLabel: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:board:create-label",
      execute: (input: CreateBoardLabelInput) => createBoardLabel(input),
    }),
    updateLabel: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:board:update-label",
      execute: (input: UpdateBoardLabelInput) => updateBoardLabel(input),
    }),
    deleteLabel: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:board:delete-label",
      execute: (input: DeleteBoardLabelInput) => deleteBoardLabel(input),
    }),
    undeleteLabel: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:board:undelete-label",
      execute: (input: UndeleteBoardLabelInput) => undeleteBoardLabel(input),
    }),
    createStage: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:board:create-stage",
      execute: (input: CreateBoardStageInput) => createBoardStage(input),
    }),
    renameStage: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:board:rename-stage",
      execute: (input: RenameBoardStageInput) => renameBoardStage(input),
    }),
    reorderStage: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:board:reorder-stage",
      execute: (input: ReorderBoardStageInput) => reorderBoardStage(input),
    }),
    deleteStage: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:board:delete-stage",
      execute: (input: DeleteBoardStageInput) => deleteBoardStage(input),
    }),
    // Stage defaults and per-project config, at the settings tier.
    setStageDefault: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:board:set-stage-default",
      execute: (input: SetBoardStageDefaultInput) => setBoardStageDefault(input),
    }),
    setProjectStageSwitch: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:board:set-project-stage-switch",
      execute: (input: SetBoardProjectStageSwitchInput) => setBoardProjectStageSwitch(input),
    }),
    setProjectStageOverride: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:board:set-project-stage-override",
      execute: (input: SetBoardProjectStageOverrideInput) => setBoardProjectStageOverride(input),
    }),
    setProjectCiSteps: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:board:set-project-ci-steps",
      execute: (input: SetBoardProjectCiStepsInput) => setBoardProjectCiSteps(input),
    }),
    setProjectCiEnabled: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:board:set-project-ci-enabled",
      execute: (input: SetBoardProjectCiEnabledInput) => setBoardProjectCiEnabled(input),
    }),
    setProjectCiStopOnFailure: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:board:set-project-ci-stop-on-failure",
      execute: (input: SetBoardProjectCiStopOnFailureInput) =>
        setBoardProjectCiStopOnFailure(input),
    }),
    resetProject: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:board:reset-project",
      execute: (input: ResetBoardProjectInput) => resetBoardProject(input),
    }),
    dismissProjectImport: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:board:dismiss-project-import",
      execute: (input: DismissBoardProjectImportInput) => dismissBoardProjectImport(input),
    }),
    getProjectConfig: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:board:get-project-config",
      execute: (input: { readonly projectId: ProjectId }) => getBoardProjectConfig(input),
    }),
    projectTokenStatus: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:board:project-token-status",
      execute: (_input: Record<string, never>) => getBoardProjectTokenStatus(),
    }),
    projectImportCandidates: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:board:project-import-candidates",
      execute: (input: BoardProjectImportCandidatesInput) => getBoardProjectImportCandidates(input),
    }),
    importProjectFile: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:board:import-project-file",
      execute: (input: BoardProjectImportInput) => importBoardProjectFile(input),
    }),
    exportProjectFile: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:board:export-project-file",
      execute: (input: { readonly projectId: ProjectId }) => exportBoardProjectFile(input),
    }),
    startStageThread: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:board:start-stage-thread",
      execute: (input: StartBoardStageThreadInput) => startBoardStageThread(input),
    }),
  };
}

/** Mirrors `runtime.ts`'s private `parseEnvironmentRpcKey` for the
    `environmentRpcKey` encoding. Duplicated deliberately: exporting the
    upstream parser would add a seam to an upstream-owned file for eight
    lines of JSON plumbing. */
function parseBoardCardDetailKey(key: string): {
  readonly environmentId: EnvironmentId;
  readonly cardId: BoardCardId;
} {
  const [environmentId, input] = JSON.parse(key) as [
    EnvironmentId,
    { readonly cardId: BoardCardId },
  ];
  return { environmentId, cardId: input.cardId };
}
