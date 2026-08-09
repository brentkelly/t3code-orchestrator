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
  type BoardCardRemovedShellEvent,
  type BoardCardShell,
  type BoardCardUpsertedShellEvent,
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
  linkBoardCardThread,
  moveBoardCard,
  reorderBoardCard,
  unarchiveBoardCard,
  unlinkBoardCardThread,
  updateBoardCard,
  type ArchiveBoardCardInput,
  type CreateBoardCardInput,
  type LinkBoardCardThreadInput,
  type MoveBoardCardInput,
  type ReorderBoardCardInput,
  type UnarchiveBoardCardInput,
  type UnlinkBoardCardThreadInput,
  type UpdateBoardCardInput,
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
  LinkBoardCardThreadInput,
  MoveBoardCardInput,
  ReorderBoardCardInput,
  UnarchiveBoardCardInput,
  UnlinkBoardCardThreadInput,
  UpdateBoardCardInput,
};

export type BoardShellStreamEvent = BoardCardUpsertedShellEvent | BoardCardRemovedShellEvent;

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
      const card = withDerivedThreadFields(event.card, (threadId) =>
        snapshot.threads.find((thread) => thread.id === threadId),
      );
      const nextCards = cards.some((existing) => existing.cardId === card.cardId)
        ? Arr.map(cards, (existing) => (existing.cardId === card.cardId ? card : existing))
        : Arr.append(cards, card);
      return { ...snapshot, cards: nextCards, snapshotSequence: event.sequence };
    }
    case "card-removed":
      return {
        ...snapshot,
        cards: Arr.filter(cards, (card) => card.cardId !== event.cardId),
        snapshotSequence: event.sequence,
      };
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

// ── Atoms ──────────────────────────────────────────────────────────────

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
