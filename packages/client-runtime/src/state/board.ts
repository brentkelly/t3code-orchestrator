/**
 * T3o board client state (D17: lives in client-runtime so a future mobile
 * board is a UI project, not a rewrite).
 *
 * Three concerns share this module:
 *
 * - The card shell reducer, called from the upstream shell reducer's
 *   predicate seam, so every surface that keeps a cached shell snapshot
 *   (web, mobile, persistence) applies card deltas without further seams.
 *   Deltas arrive with thread-derived fields at their "none" resting state
 *   (the server-side mapping is a pure function of the board event); the
 *   reducer re-derives them against the thread shells the snapshot already
 *   holds, so cached state stays truthful.
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
  BOARD_STAGES,
  BOARD_WS_METHODS,
  deriveBoardCardThreadState,
  isBoardShellStreamEvent,
  type BoardCardDetail,
  type BoardCardId,
  type BoardCardQueuedShellEvent,
  type BoardCardRemovedShellEvent,
  type BoardCardShell,
  type BoardCardUpsertedShellEvent,
  type BoardLabel,
  type BoardLabelUpsertedShellEvent,
  type BoardStage,
  type EnvironmentId,
  type OrchestrationShellSnapshot,
  type OrchestrationThreadShell,
  type ProjectId,
  type ThreadId,
} from "@t3tools/contracts";
import * as Arr from "effect/Array";
import type * as Crypto from "effect/Crypto";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/unstable/reactivity";

import type { EnvironmentRegistry } from "../connection/registry.ts";
import {
  archiveBoardCard,
  createBoardCard,
  createBoardLabel,
  deleteBoardLabel,
  linkBoardCardThread,
  moveBoardCard,
  reorderBoardCard,
  unarchiveBoardCard,
  undeleteBoardLabel,
  unlinkBoardCardThread,
  updateBoardCard,
  updateBoardLabel,
  type ArchiveBoardCardInput,
  type CreateBoardCardInput,
  type CreateBoardLabelInput,
  type DeleteBoardLabelInput,
  type LinkBoardCardThreadInput,
  type MoveBoardCardInput,
  type ReorderBoardCardInput,
  type UnarchiveBoardCardInput,
  type UndeleteBoardLabelInput,
  type UnlinkBoardCardThreadInput,
  type UpdateBoardCardInput,
  type UpdateBoardLabelInput,
} from "../operations/boardCommands.ts";
import type { EnvironmentShellState } from "./shell.ts";
import {
  createEnvironmentCommand,
  createEnvironmentRpcSubscriptionAtomFamily,
  environmentRpcKey,
} from "./runtime.ts";
import { pinOrderKeyBetween, planPinnedReorder } from "./threadSort.ts";

export type {
  ArchiveBoardCardInput,
  CreateBoardCardInput,
  CreateBoardLabelInput,
  DeleteBoardLabelInput,
  LinkBoardCardThreadInput,
  MoveBoardCardInput,
  ReorderBoardCardInput,
  UnarchiveBoardCardInput,
  UndeleteBoardLabelInput,
  UnlinkBoardCardThreadInput,
  UpdateBoardCardInput,
  UpdateBoardLabelInput,
};

export type BoardShellStreamEvent =
  | BoardCardUpsertedShellEvent
  | BoardCardRemovedShellEvent
  | BoardCardQueuedShellEvent
  | BoardLabelUpsertedShellEvent;

// Re-exported so the upstream reducer imports predicate + delegate on one line.
export { isBoardShellStreamEvent };

type ThreadShellLookup = (threadId: ThreadId) => OrchestrationThreadShell | undefined;

/** Thread-derived fields recomputed from the current thread shells; returns
    the same card reference when nothing changed so memoized consumers keep
    their identity. */
function withDerivedThreadFields(
  card: BoardCardShell,
  threadById: ThreadShellLookup,
): BoardCardShell {
  const thread = card.activeThreadId === null ? undefined : threadById(card.activeThreadId);
  const { threadState, awaitingInput } = deriveBoardCardThreadState(thread);
  return card.threadState === threadState && card.awaitingInput === awaitingInput
    ? card
    : { ...card, threadState, awaitingInput };
}

export function applyBoardShellStreamEvent(
  snapshot: OrchestrationShellSnapshot,
  event: BoardShellStreamEvent,
): OrchestrationShellSnapshot {
  const cards = snapshot.cards ?? [];
  switch (event.kind) {
    case "card-upserted": {
      // `queued` is derived from step state the card aggregate does not carry
      // (t3o-11, D11), so a card-carrying delta rests it at false. Preserve the
      // last known value from the card we already hold — exactly as
      // `withDerivedThreadFields` re-derives `threadState` — so reprioritising
      // the queue (a drag = `card-reordered` → `card-upserted`) never blanks a
      // card's queued badge. The authoritative changes arrive via `card-queued`
      // and the snapshot.
      const existing = cards.find((entry) => entry.cardId === event.card.cardId);
      const withQueued =
        existing === undefined || existing.queued === event.card.queued
          ? event.card
          : { ...event.card, queued: existing.queued };
      const card = withDerivedThreadFields(withQueued, (threadId) =>
        snapshot.threads.find((thread) => thread.id === threadId),
      );
      const nextCards = cards.some((entry) => entry.cardId === card.cardId)
        ? Arr.map(cards, (entry) => (entry.cardId === card.cardId ? card : entry))
        : Arr.append(cards, card);
      return { ...snapshot, cards: nextCards, snapshotSequence: event.sequence };
    }
    case "card-queued": {
      // The one authoritative live flip of `queued` (t3o-11): the governor
      // admitted the card's step (→ false) or held it for a slot (→ true). A
      // no-op for a card we do not hold (archived / not yet arrived).
      const nextCards = Arr.map(cards, (card) =>
        card.cardId === event.cardId && card.queued !== event.queued
          ? { ...card, queued: event.queued }
          : card,
      );
      return { ...snapshot, cards: nextCards, snapshotSequence: event.sequence };
    }
    case "card-removed":
      return {
        ...snapshot,
        cards: Arr.filter(cards, (card) => card.cardId !== event.cardId),
        snapshotSequence: event.sequence,
      };
    case "label-upserted": {
      // Catalogue delta (t3o-06a): the whole board's label vocabulary rides
      // once. A recolour arrives here and repaints every chip that references
      // the id, with no card deltas. Delete/undelete are upserts carrying
      // `deletedAt` set/cleared — the label stays in the catalogue.
      const labels = snapshot.boardLabels ?? [];
      const nextLabels = labels.some((existing) => existing.labelId === event.label.labelId)
        ? Arr.map(labels, (existing) =>
            existing.labelId === event.label.labelId ? event.label : existing,
          )
        : Arr.append(labels, event.label);
      return { ...snapshot, boardLabels: nextLabels, snapshotSequence: event.sequence };
    }
  }
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

export type BoardStageColumns = Readonly<Record<BoardStage, ReadonlyArray<BoardCardShell>>>;

const EMPTY_BOARD_PROJECTS: ReadonlyMap<ProjectId, BoardStageColumns> = new Map();

function emptyBoardColumns(): Record<BoardStage, BoardCardShell[]> {
  return {
    backlog: [],
    sprint: [],
    planning: [],
    ready: [],
    building: [],
    review: [],
    merge: [],
    done: [],
  };
}

function groupBoardCards(
  snapshot: OrchestrationShellSnapshot,
): ReadonlyMap<ProjectId, BoardStageColumns> {
  const cards = snapshot.cards ?? [];
  if (cards.length === 0) return EMPTY_BOARD_PROJECTS;
  const threadsById = new Map(snapshot.threads.map((thread) => [thread.id, thread]));
  const byProject = new Map<ProjectId, Record<BoardStage, BoardCardShell[]>>();
  for (const card of cards) {
    let columns = byProject.get(card.projectId);
    if (columns === undefined) {
      columns = emptyBoardColumns();
      byProject.set(card.projectId, columns);
    }
    columns[card.stage].push(
      withDerivedThreadFields(card, (threadId) => threadsById.get(threadId)),
    );
  }
  for (const columns of byProject.values()) {
    for (const stage of BOARD_STAGES) {
      columns[stage].sort(compareBoardCardShells);
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
  const merged = emptyBoardColumns();
  for (const columns of columnsList) {
    for (const stage of BOARD_STAGES) {
      if (columns[stage].length > 0) merged[stage].push(...columns[stage]);
    }
  }
  for (const stage of BOARD_STAGES) {
    merged[stage].sort(compareBoardCardShells);
  }
  return merged;
}

/** The stage and order key a drop expects the server to store — held
    client-side until the shell confirms it (optimistic reordering with
    server reconciliation; the drag never blocks on a round trip). */
export interface BoardCardPlacement {
  readonly cardId: string;
  readonly stage: BoardStage;
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
  const next = emptyBoardColumns();
  let changed = false;
  for (const stage of BOARD_STAGES) {
    for (const card of columns[stage]) {
      const placement = placementByCardId.get(card.cardId);
      if (
        placement === undefined ||
        (placement.stage === card.stage && placement.orderKey === card.orderKey)
      ) {
        next[card.stage].push(card);
        continue;
      }
      changed = true;
      next[placement.stage].push({ ...card, stage: placement.stage, orderKey: placement.orderKey });
    }
  }
  if (!changed) return columns;
  for (const stage of BOARD_STAGES) {
    next[stage].sort(compareBoardCardShells);
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
  for (const stage of BOARD_STAGES) {
    const card = columns[stage].find((existing) => existing.cardId === placement.cardId);
    if (card !== undefined) {
      return card.stage === placement.stage && card.orderKey === placement.orderKey;
    }
  }
  return true;
}

/**
 * Queue view of the Building column (D11: the column is the queue,
 * position is priority). Derived strictly from the `queued` flag on the
 * shells — until t3o-11 populates it nothing is queued and the map is
 * empty. UIs render this, never invented queue state.
 */
export function boardBuildingQueueInfo(
  buildingColumn: ReadonlyArray<BoardCardShell>,
): ReadonlyMap<string, { readonly position: number; readonly startsNext: boolean }> {
  const queue = new Map<string, { readonly position: number; readonly startsNext: boolean }>();
  for (const card of buildingColumn) {
    if (!card.queued) continue;
    const position = queue.size + 1;
    queue.set(card.cardId, { position, startsNext: position === 1 });
  }
  return queue;
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
  },
) {
  /** Cards grouped by project, then by stage in board column order, each
      column sorted by orderKey — with thread-derived fields overlaid from
      the live thread shells, so a `thread-upserted` delta moves the card's
      status indicator without any card event. */
  const cardsByProjectAtom = Atom.family((environmentId: EnvironmentId) =>
    Atom.make((get) => {
      const state = get(options.shellStateValueAtom(environmentId));
      return Option.match(state.snapshot, {
        onNone: () => EMPTY_BOARD_PROJECTS,
        onSome: groupBoardCards,
      });
    }).pipe(Atom.withLabel(`environment-board-cards:${environmentId}`)),
  );

  /** The board's label catalogue (t3o-06a) — the vocabulary every card chip
      and the label picker read, keyed by id. Rides the shell snapshot once,
      so this is a cheap projection over cached state, not a subscription.
      Includes tombstoned labels (a card carrying one renders it muted); the
      picker filters `deletedAt !== null`. Empty until the first snapshot. */
  const EMPTY_LABELS: ReadonlyArray<BoardLabel> = [];
  const labelCatalogueAtom = Atom.family((environmentId: EnvironmentId) =>
    Atom.make((get) => {
      const state = get(options.shellStateValueAtom(environmentId));
      return Option.match(state.snapshot, {
        onNone: () => EMPTY_LABELS,
        onSome: (snapshot) => snapshot.boardLabels ?? EMPTY_LABELS,
      });
    }).pipe(Atom.withLabel(`environment-board-labels:${environmentId}`)),
  );

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
    cardsByProjectAtom,
    labelCatalogueAtom,
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
    reorderCard: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:board:reorder-card",
      execute: (input: ReorderBoardCardInput) => reorderBoardCard(input),
    }),
    updateCard: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:board:update-card",
      execute: (input: UpdateBoardCardInput) => updateBoardCard(input),
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
