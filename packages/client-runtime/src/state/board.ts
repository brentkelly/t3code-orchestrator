/**
 * T3o board client state (D17: lives in client-runtime so a future mobile
 * board is a UI project, not a rewrite).
 *
 * Three concerns share this module:
 *
 * - The board reducer (`boardReducer.ts`) and subscription
 *   (`boardSubscription.ts`) over `board.subscribeBoard` (T3O-57),
 *   re-exported here. Cards arrive with
 *   thread-derived fields at their "none" resting state; the views overlay
 *   them from the thread shells (`withBoardThreadFields`).
 * - Atom factories: card lists grouped by project and stage (sorted by
 *   `orderKey`, with thread-derived fields overlaid live so a thread
 *   starting or stopping updates its card without any card event), a
 *   card-detail subscription keyed by card, and dispatch helpers for every
 *   board command.
 * - Fractional-order planning for drag/reorder, reusing the `threadSort.ts`
 *   pin-order helpers — `BoardCard.orderKey` commits to that split (client
 *   computes, server stores); this module does not reimplement them.
 *
 * Exported to apps through `state/shell.ts`.
 */
import {
  BOARD_WS_METHODS,
  EMPTY_BOARD_WORKERS_STATE,
  type BoardCardWorkerMoveRequest,
  type BoardWorkerIdInput,
  type BoardWorkersAddInput,
  type BoardWorkersDismissSetupInput,
  type BoardWorkersRepairInput,
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
  type BoardStageDefinition,
  type BoardStageId,
  isBoardCardScheduleDue,
  type EnvironmentId,
  type BoardShellSnapshot,
  type OrchestrationV2ThreadShell,
  type ProjectId,
  type ThreadId,
} from "@t3tools/contracts";
import { boardThreadStateSource } from "@t3tools/shared/boardThreadState";
import type * as Crypto from "effect/Crypto";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/reactivity";

import type { EnvironmentRegistry } from "../connection/registry.ts";
import {
  addBoardWorker,
  dismissBoardWorkerSetup,
  previewBoardWorkerRemoval,
  removeBoardWorker,
  repairBoardWorker,
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
  linkBoardCardThread,
  attachBoardCardFile,
  detachBoardCardFile,
  mergeBoardCardPullRequest,
  moveBoardCard,
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
  removeBoardCardWorktree,
  checkBoardCardWorktree,
  submitBoardCardForMerge,
  unarchiveBoardCard,
  undeleteBoardLabel,
  unlinkBoardCardThread,
  updateBoardCard,
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
  type LinkBoardCardThreadInput,
  type MoveBoardCardInput,
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
import {
  createEnvironmentCommand,
  createEnvironmentRpcQueryAtomFamily,
  createEnvironmentRpcSubscriptionAtomFamily,
  environmentRpcKey,
} from "./runtime.ts";
import { pinOrderKeyBetween, planPinnedReorder } from "./threadSort.ts";

export * from "./boardReducer.ts";
export * from "./boardSubscription.ts";

export type {
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

/** Every live-linked thread id of a card (t3o-18, D7). `boardCardThreads` rides
    the shell snapshot with one entry per live link; a client that has not
    received it yet (or a card with no links) falls back to `activeThreadId`, so
    the aggregate degrades to exactly the pre-t3o-18 behaviour rather than to
    nothing. */
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

/** Thread-derived fields recomputed from the current thread shells; returns
    the same card reference when nothing changed so memoized consumers keep
    their identity.

    Aggregated across EVERY live-linked thread (t3o-18, D7), matching the
    server's snapshot enrichment exactly — the two must agree, or the badge would
    flicker between a snapshot and the next delta. */
function withDerivedThreadFields(
  card: BoardCardShell,
  threadById: ThreadShellLookup,
  cardThreads?: ReadonlyArray<BoardCardThreadShell> | undefined,
): BoardCardShell {
  const threads = liveCardThreadIds(card, cardThreads).map((threadId) => {
    const thread = threadById(threadId);
    return thread === undefined ? undefined : boardThreadStateSource(thread);
  });
  const { threadState, awaitingInput, waitingOnBackground } = deriveBoardCardThreadState(threads);
  if (
    card.threadState === threadState &&
    card.awaitingInput === awaitingInput &&
    (card.waitingOnBackground ?? false) === waitingOnBackground
  ) {
    return card;
  }
  // T3O-20: the key is omitted when false, matching the server's shell.
  const { waitingOnBackground: _previous, ...rest } = card;
  return {
    ...rest,
    threadState,
    awaitingInput,
    ...(waitingOnBackground ? { waitingOnBackground: true } : {}),
  };
}

// ── Column ordering ────────────────────────────────────────────────────

/** Column order inside a stage: (orderKey, cardId) by code units — the
    cardId tiebreak keeps two clients that computed equal keys agreeing. */
export function compareBoardCardShells(left: BoardCardShell, right: BoardCardShell): number {
  const compare = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
  return compare(left.orderKey, right.orderKey) || compare(left.cardId, right.cardId);
}

/** Order key for a card appended at the bottom of a column. Scans for the
    maximum existing key rather than trusting input order, so callers may
    pass the column in any order (snapshot order is createdAt, not
    orderKey). Falls back to the open-bounds midpoint when the column is
    empty or its bottom key is corrupt. */
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
 * Assignments realizing a drop within (or into) a stage column — a thin
 * card-shaped veneer over `planPinnedReorder` (single write to the moved
 * card in the common case; whole-column key rewrite only when existing keys
 * are corrupt). Callers dispatch `board.card.reorder` per assignment, or
 * `board.card.move` with the moved card's key when the drop crossed
 * stages.
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

// ── Board views and drag support (t3o-05) ──────────────────────────────
// Pure helpers shared by every board UI (D17): the web board consumes them
// today, a mobile board reuses them without a rewrite.

// Columns are keyed by stage id (t3o-15): stages are user-defined, so the
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
 * The board snapshot with each card's thread-derived fields overlaid from the
 * thread shells the client already holds (t3o-18, D7): the server leaves them
 * at rest, so a thread starting or stopping updates its card with no board
 * delta. Returns the same snapshot when no card changed, so memoized consumers
 * keep their identity.
 */
export function withBoardThreadFields(
  board: BoardShellSnapshot,
  threads: ReadonlyArray<OrchestrationV2ThreadShell>,
): BoardShellSnapshot {
  if (board.cards.length === 0) return board;
  const threadsById = new Map(threads.map((thread) => [thread.id, thread]));
  let changed = false;
  const cards = board.cards.map((card) => {
    const next = withDerivedThreadFields(
      card,
      (threadId) => threadsById.get(threadId),
      board.cardThreads,
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
 * Columns with optimistic placements laid over the live shells. Pure and
 * idempotent — re-applying a placement the server has since confirmed
 * changes nothing, and a placement for a card that left the board is
 * ignored — so callers only prune placements to bound the list (see
 * `isBoardCardPlacementSettled`). Returns the input columns object when no
 * placement changes anything, so memoized consumers keep their identity.
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

/** One queued card's place in the board-wide build queue (t3o-33). Positions
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
 * Queue view of every card holding for a concurrency slot (D11), across the
 * WHOLE environment — every project, and every stage that runs build-mode
 * steps, not just Building.
 *
 * Mirrors the governor's own ordering (`orderBoardQueue`, apps/server): later
 * stage first, then the cards' drag order. That is what makes the number
 * honest — an earlier per-project reading of one Building column numbered a
 * card `#1` while another project's review step was ahead of it in the only
 * queue that exists.
 *
 * ONE DIVERGENCE, deliberately: the server breaks a stage tie by admitting an
 * already-started step before an unstarted one. That needs step completions,
 * which are card detail, and it only separates two queued steps on the same
 * stage where one is a re-run. Buying it would cost a field on every shell, so
 * the client orders by drag order alone there.
 *
 * Derived strictly from the `queued` flag on the shells, so a board with
 * nothing queued yields an empty map and costs a single pass.
 *
 * A card holding a FUTURE scheduled start is excluded (T3O-19, D9), and that is
 * load-bearing rather than cosmetic. A card already `queued` when its schedule
 * is set keeps that step status — nothing transitions it back to `pending` —
 * while the server's gate has stopped offering it a slot. Left in, it would go
 * on counting against cards genuinely waiting for an agent, and every other
 * card's position number would be wrong.
 */
export function boardBuildQueue(
  cards: ReadonlyArray<BoardCardShell>,
  stages: ReadonlyArray<BoardStageDefinition>,
  /** Compared against each card's schedule. Required rather than defaulted:
      this package has no ambient clock, and a caller that forgot it would
      silently number a scheduled card into the queue. */
  nowMs: number,
): ReadonlyMap<string, BoardQueueSlot> {
  // A card held for its offline worker (T3O-66) waits on no slot, so it takes
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

/** Steps the executor is actually running, board-wide (t3o-33) — the numerator
    of "3 of 3 agents busy". Counted from the same shells the queue is, so the
    two halves of that sentence can never disagree. */
export function boardRunningStepCount(cards: ReadonlyArray<BoardCardShell>): number {
  let running = 0;
  for (const card of cards) if (card.stepRunning) running += 1;
  return running;
}

/**
 * The reorder that moves a queued card to the front of the build queue
 * (t3o-33), or null when there is no such move.
 *
 * Null in two cases, and the second is the point: the card is already first,
 * or reordering CANNOT improve its position. Drag order is the governor's last
 * tiebreak, so a card queued behind one on a later stage does not overtake it
 * however low its key goes — and a button that visibly does nothing is worse
 * than an absent one. The check is the derivation itself, run once against the
 * projected key, so it can never drift from what the queue will actually show.
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
  runtime: Atom.AtomRuntime<EnvironmentRegistry | Crypto.Crypto | R, ER>,
  options: {
    readonly shellStateValueAtom: (
      environmentId: EnvironmentId,
    ) => Atom.Atom<EnvironmentShellState>;
    /** The environment's board subscription (`createEnvironmentBoardStateAtoms`). */
    readonly boardSnapshotValueAtom: (
      environmentId: EnvironmentId,
    ) => Atom.Atom<BoardShellSnapshot | null>;
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
   * Live card→thread links and their cached todo summaries (t3o-18, D3), keyed
   * by card id. Rides the board snapshot once and is kept current by the
   * `card-threads` delta, so this is a cheap projection over held state, not a
   * subscription — and `BoardCardShell` still carries no todo field.
   *
   * Empty until the first snapshot. A card with no entry has no live-linked
   * thread; a thread with no todo fields is linked but has never emitted a
   * `turn.plan.updated` (D14: the cache fills forward only).
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

  /** The board's label catalogue (t3o-06a) — the vocabulary every card chip
      and the label picker read. Includes tombstoned labels (a card carrying
      one renders it muted); the picker filters `deletedAt !== null`. Empty
      until the first snapshot. */
  const EMPTY_LABELS: ReadonlyArray<BoardLabel> = [];
  const labelCatalogueAtom = Atom.family((environmentId: EnvironmentId) =>
    Atom.make(
      (get) => get(options.boardSnapshotValueAtom(environmentId))?.labels ?? EMPTY_LABELS,
    ).pipe(Atom.withLabel(`environment-board-labels:${environmentId}`)),
  );

  /** The board's user-defined stage list (t3o-15) in canonical order — the
      source of column order and labels the board UI reads (D13). Empty until
      the first snapshot (the caller falls back to the compiled seeds via
      `boardStages`). */
  const EMPTY_STAGES: ReadonlyArray<BoardStageDefinition> = [];
  const stageListAtom = Atom.family((environmentId: EnvironmentId) =>
    Atom.make((get) => {
      const stages = get(options.boardSnapshotValueAtom(environmentId))?.stages ?? EMPTY_STAGES;
      return stages.length === 0 ? EMPTY_STAGES : [...stages].sort(compareBoardStages);
    }).pipe(Atom.withLabel(`environment-board-stages:${environmentId}`)),
  );

  /** The board's workers (T3O-62, D19), or the local-only summary when the
      board has none — which is every board until a worker is added. */
  const workersAtom = Atom.family((environmentId: EnvironmentId) =>
    Atom.make(
      (get) =>
        get(options.boardSnapshotValueAtom(environmentId))?.workers ?? EMPTY_BOARD_WORKERS_STATE,
    ).pipe(Atom.withLabel(`environment-board-workers:${environmentId}`)),
  );

  /** The archive page's cards (t3o-13), read when the page opens. */
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

  return {
    boardAtom,
    cardsByProjectAtom,
    cardThreadsByCardAtom,
    archivedCardsAtom,
    labelCatalogueAtom,
    stageListAtom,
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
    /** Link a pull request to the card by hand (T3O-18). Resolves to the
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
        review (t3o-07). Resolves to the outcome the card reports — started, or
        the reason it was refused. */
    submitCardForMerge: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:board:submit-card-for-merge",
      execute: (input: { readonly cardId: BoardCardId }) => submitBoardCardForMerge(input),
    }),
    /** Run one more review round on a settled loop (T3O-39). Resolves to the
        round it bought, or the reason it was refused. */
    requestReviewRound: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:board:request-review-round",
      execute: (input: { readonly cardId: BoardCardId }) => requestBoardReviewRound(input),
    }),
    /** Remove a finished card's kept worktree past the safety rule (T3O-52). */
    removeCardWorktree: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:board:remove-card-worktree",
      execute: (input: { readonly cardId: BoardCardId }) => removeBoardCardWorktree(input),
    }),
    /** Re-run a kept worktree's cleanup and say what it did (T3O-52). */
    checkCardWorktree: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:board:check-card-worktree",
      execute: (input: { readonly cardId: BoardCardId }) => checkBoardCardWorktree(input),
    }),
    /** Attach a pending upload to a card's brief (t3o-32). Resolves with the
        stored record — the name may have been de-duplicated server-side. */
    attachCardFile: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:board:attach-card-file",
      execute: (input: BoardAttachCardFileInput) => attachBoardCardFile(input),
    }),
    detachCardFile: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:board:detach-card-file",
      execute: (input: BoardDetachCardFileInput) => detachBoardCardFile(input),
    }),
    // T3O-62: managing the board's workers. Each answers with what the
    // Workers settings show: the add summary, or a refusal to read inline.
    addWorker: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:board:add-worker",
      execute: (input: BoardWorkersAddInput) => addBoardWorker(input),
    }),
    repairWorker: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:board:repair-worker",
      execute: (input: BoardWorkersRepairInput) => repairBoardWorker(input),
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
    reorderCard: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:board:reorder-card",
      execute: (input: ReorderBoardCardInput) => reorderBoardCard(input),
    }),
    /** Start a queued step now, over the agent cap (t3o-33). */
    forceStartStep: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:board:force-start-step",
      execute: (input: ForceStartBoardCardStepInput) => forceStartBoardCardStep(input),
    }),
    /** Resume a card's paused step (T3O-23): it re-enters the build queue and
        the governor admits it into its EXISTING thread when a slot frees. */
    requeueStep: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:board:requeue-step",
      execute: (input: RequeueBoardCardStepInput) => requeueBoardCardStep(input),
    }),
    /** Send a settled step back because its recorded payload cannot be read
        (T3O-14) — the way out of a review round that halted `unreadable`. */
    reopenStep: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:board:reopen-step",
      execute: (input: ReopenBoardCardStepInput) => reopenBoardCardStep(input),
    }),
    updateCard: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:board:update-card",
      execute: (input: UpdateBoardCardInput) => updateBoardCard(input),
    }),
    /** Move a card to another project (T3O-33) — human-only, and refused by the
        decider once the card has ever been built. */
    setCardProject: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:board:set-card-project",
      execute: (input: SetBoardCardProjectInput) => setBoardCardProject(input),
    }),
    /** Pin a card to a worker, or follow the default (T3O-65). */
    pinCardWorker: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:board:pin-card-worker",
      execute: (input: PinBoardCardWorkerInput) => pinBoardCardWorker(input),
    }),
    /** The Move dialog's check / move / ask-push (T3O-65). */
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
export * from "./boardWorkerPairing.ts";
