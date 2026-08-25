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
  BOARD_WS_METHODS,
  compareBoardStages,
  deriveBoardCardThreadState,
  isBoardShellStreamEvent,
  type BoardCardDetail,
  type BoardCardId,
  type BoardCardPlansShellEvent,
  type BoardCardQueuedShellEvent,
  type BoardCardRemovedShellEvent,
  type BoardCardShell,
  type BoardCardStalledShellEvent,
  type BoardCardThreadShell,
  type BoardCardThreadsShellEvent,
  type BoardCardUpsertedShellEvent,
  type BoardLabel,
  type BoardLabelUpsertedShellEvent,
  type BoardStageDefinition,
  type BoardStageId,
  type BoardStageRemovedShellEvent,
  type BoardStageUpsertedShellEvent,
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
  createBoardStage,
  deleteBoardLabel,
  deleteBoardStage,
  linkBoardCardThread,
  moveBoardCard,
  renameBoardStage,
  reorderBoardCard,
  reorderBoardStage,
  startBoardStageThread,
  unarchiveBoardCard,
  undeleteBoardLabel,
  unlinkBoardCardThread,
  updateBoardCard,
  updateBoardLabel,
  type ArchiveBoardCardInput,
  type CreateBoardCardInput,
  type CreateBoardLabelInput,
  type CreateBoardStageInput,
  type DeleteBoardLabelInput,
  type DeleteBoardStageInput,
  type LinkBoardCardThreadInput,
  type MoveBoardCardInput,
  type RenameBoardStageInput,
  type ReorderBoardCardInput,
  type ReorderBoardStageInput,
  type StartBoardStageThreadInput,
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
  CreateBoardStageInput,
  DeleteBoardLabelInput,
  DeleteBoardStageInput,
  LinkBoardCardThreadInput,
  MoveBoardCardInput,
  RenameBoardStageInput,
  ReorderBoardCardInput,
  ReorderBoardStageInput,
  StartBoardStageThreadInput,
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
  | BoardCardStalledShellEvent
  | BoardCardPlansShellEvent
  | BoardCardThreadsShellEvent
  | BoardLabelUpsertedShellEvent
  | BoardStageUpsertedShellEvent
  | BoardStageRemovedShellEvent;

// Re-exported so the upstream reducer imports predicate + delegate on one line.
export { isBoardShellStreamEvent };

type ThreadShellLookup = (threadId: ThreadId) => OrchestrationThreadShell | undefined;

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
  const threads = liveCardThreadIds(card, cardThreads).map(threadById);
  const { threadState, awaitingInput } = deriveBoardCardThreadState(threads);
  return card.threadState === threadState && card.awaitingInput === awaitingInput
    ? card
    : { ...card, threadState, awaitingInput };
}

/**
 * Carry forward the key-optional shell fields a card-carrying delta cannot
 * know: `briefHasImage` (the brief BODY lives in `board_card_bodies`, D8) and
 * `planCount` (the plan set is its own slice). Their resting value is the
 * ABSENT key, not `false`/`0`, so "the producer could not see it" and "the
 * producer saw nothing there" stay distinguishable — a brief whose image was
 * deleted sends `briefHasImage: false` and clears the icon, while a drag
 * (`card-reordered` → `card-upserted`) omits the key and changes nothing.
 *
 * Returns the same reference when there is nothing to carry, so memoized
 * consumers keep their identity.
 */
function preserveAbsentShellFields(
  next: BoardCardShell,
  existing: BoardCardShell | undefined,
): BoardCardShell {
  if (existing === undefined) return next;
  const briefHasImage = next.briefHasImage ?? existing.briefHasImage;
  const planCount = next.planCount ?? existing.planCount;
  if (briefHasImage === next.briefHasImage && planCount === next.planCount) return next;
  return {
    ...next,
    ...(briefHasImage === undefined ? {} : { briefHasImage }),
    ...(planCount === undefined ? {} : { planCount }),
  };
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
      // `stalled` (t3o-17, D3) is derived from step state the same way, so a
      // card-carrying delta rests it at false too — preserve the last known
      // value so a drag never blanks a stalled badge.
      const withStalled =
        existing === undefined || existing.stalled === withQueued.stalled
          ? withQueued
          : { ...withQueued, stalled: existing.stalled };
      // `briefHasImage` and `planCount` are derived from slices the card
      // aggregate does not carry (the brief BODY, the plan set), so a
      // card-carrying delta that cannot see them OMITS the key rather than
      // asserting a false/zero — absent means "unchanged, keep what you have".
      // A present key is authoritative, including `false`/`0`: clearing an
      // image out of a brief has to clear the icon.
      const withBodyDerived = preserveAbsentShellFields(withStalled, existing);
      const card = withDerivedThreadFields(
        withBodyDerived,
        (threadId) => snapshot.threads.find((thread) => thread.id === threadId),
        snapshot.boardCardThreads,
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
    case "card-stalled": {
      // The authoritative live flip of `stalled` (t3o-17, D3): recovery gave up
      // on the card's step (→ true) or a retry / fresh run put it back to work
      // (→ false). A no-op for a card we do not hold.
      //
      // Raising `stalled` also clears `queued`: both badges are views of ONE
      // step status, so they are mutually exclusive at the source — a stalled
      // step is not waiting for a slot. Without this, a step that escalates
      // straight out of `queued` (its slot was granted but the spawn was
      // refused) keeps a queue badge no later delta clears, and it goes on
      // occupying a displayed queue position for every card behind it until a
      // reconnect re-derives the shell.
      const nextCards = Arr.map(cards, (card) => {
        if (card.cardId !== event.cardId) return card;
        const queued = event.stalled ? false : card.queued;
        return card.stalled === event.stalled && card.queued === queued
          ? card
          : { ...card, stalled: event.stalled, queued };
      });
      return { ...snapshot, cards: nextCards, snapshotSequence: event.sequence };
    }
    case "card-plans": {
      // The card's plan set was replaced (t3o-08) — the authoritative live
      // change of the footer's plan count. A no-op for a card we do not hold.
      const nextCards = Arr.map(cards, (card) =>
        card.cardId === event.cardId && card.planCount !== event.planCount
          ? { ...card, planCount: event.planCount }
          : card,
      );
      return { ...snapshot, cards: nextCards, snapshotSequence: event.sequence };
    }
    case "card-threads": {
      // The card's whole live link set, replaced wholesale (t3o-18, D3): the set
      // changes for three different reasons — a todo revision, a link, an unlink
      // — and a replace is idempotent under all three.
      const others = (snapshot.boardCardThreads ?? []).filter(
        (entry) => entry.cardId !== event.cardId,
      );
      return {
        ...snapshot,
        boardCardThreads: [...others, ...event.threads],
        snapshotSequence: event.sequence,
      };
    }
    case "card-removed":
      return {
        ...snapshot,
        cards: Arr.filter(cards, (card) => card.cardId !== event.cardId),
        // A card that left the board takes its thread entries with it; leaving
        // them would leak an unbounded list across a long-lived session.
        boardCardThreads: (snapshot.boardCardThreads ?? []).filter(
          (entry) => entry.cardId !== event.cardId,
        ),
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
    case "stage-upserted": {
      // Stage aggregate delta (t3o-15): the whole stage list rides so the board
      // reads column order and labels from it (D13). Create / rename / reorder
      // all arrive here; kept in canonical `compareBoardStages` order.
      const stages = snapshot.boardStages ?? [];
      const nextStages = (
        stages.some((existing) => existing.stageId === event.stage.stageId)
          ? Arr.map(stages, (existing) =>
              existing.stageId === event.stage.stageId ? event.stage : existing,
            )
          : Arr.append(stages, event.stage)
      ).toSorted(compareBoardStages);
      return { ...snapshot, boardStages: nextStages, snapshotSequence: event.sequence };
    }
    case "stage-removed": {
      const stages = snapshot.boardStages ?? [];
      return {
        ...snapshot,
        boardStages: Arr.filter(stages, (stage) => stage.stageId !== event.stageId),
        snapshotSequence: event.sequence,
      };
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

function groupBoardCards(
  snapshot: OrchestrationShellSnapshot,
): ReadonlyMap<ProjectId, BoardStageColumns> {
  const cards = snapshot.cards ?? [];
  if (cards.length === 0) return EMPTY_BOARD_PROJECTS;
  const threadsById = new Map(snapshot.threads.map((thread) => [thread.id, thread]));
  const byProject = new Map<ProjectId, Record<string, BoardCardShell[]>>();
  for (const card of cards) {
    let columns = byProject.get(card.projectId);
    if (columns === undefined) {
      columns = {};
      byProject.set(card.projectId, columns);
    }
    pushColumn(
      columns,
      card.stage,
      withDerivedThreadFields(
        card,
        (threadId) => threadsById.get(threadId),
        snapshot.boardCardThreads,
      ),
    );
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

  /**
   * Live card→thread links and their cached todo summaries (t3o-18, D3), keyed
   * by card id. Rides the shell snapshot once and is kept current by the
   * `card-threads` delta, so this is a cheap projection over cached state, not a
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
      const state = get(options.shellStateValueAtom(environmentId));
      return Option.match(state.snapshot, {
        onNone: () => EMPTY_CARD_THREADS,
        onSome: (snapshot) => {
          const entries = snapshot.boardCardThreads ?? [];
          if (entries.length === 0) return EMPTY_CARD_THREADS;
          const byCard = new Map<BoardCardId, BoardCardThreadShell[]>();
          for (const entry of entries) {
            const list = byCard.get(entry.cardId) ?? [];
            list.push(entry);
            byCard.set(entry.cardId, list);
          }
          return byCard;
        },
      });
    }).pipe(Atom.withLabel(`environment-board-card-threads:${environmentId}`)),
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

  /** The board's user-defined stage list (t3o-15) in canonical order — the
      source of column order and labels the board UI reads (D13). Rides the
      shell snapshot once. Empty until the first snapshot (the caller falls back
      to the compiled seeds via `boardStages`). */
  const EMPTY_STAGES: ReadonlyArray<BoardStageDefinition> = [];
  const stageListAtom = Atom.family((environmentId: EnvironmentId) =>
    Atom.make((get) => {
      const state = get(options.shellStateValueAtom(environmentId));
      return Option.match(state.snapshot, {
        onNone: () => EMPTY_STAGES,
        onSome: (snapshot) => [...(snapshot.boardStages ?? EMPTY_STAGES)].sort(compareBoardStages),
      });
    }).pipe(Atom.withLabel(`environment-board-stages:${environmentId}`)),
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
    cardThreadsByCardAtom,
    labelCatalogueAtom,
    stageListAtom,
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
