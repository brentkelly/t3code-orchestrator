/**
 * The slice of the thread shell the board reads, kept to card-linked threads. The raw shell
 * changes on every orchestration event for any thread; this projection keeps its identity
 * unless a card-linked thread changed a field below, so board views skip unrelated streaming.
 */
import type {
  BoardCardShell,
  BoardCardThreadShell,
  OrchestrationV2ThreadShell,
  ThreadId,
} from "@t3tools/contracts";
import * as Equal from "effect/Equal";

export type BoardCardThreadFields = Pick<
  OrchestrationV2ThreadShell,
  | "id"
  | "title"
  | "branch"
  | "latestRunCompletedAt"
  | "activityRunStatus"
  | "status"
  | "latestRunId"
  | "activeProviderThreadId"
  | "pendingRuntimeRequest"
  | "pendingBackgroundTasks"
>;

export type BoardCardThreadShells = ReadonlyMap<ThreadId, BoardCardThreadFields>;

export const EMPTY_BOARD_CARD_THREAD_SHELLS: BoardCardThreadShells = new Map();

/** Every thread a card can read: its live links, and its active thread when it has none. */
export function boardCardLinkedThreadIds(
  cards: ReadonlyArray<Pick<BoardCardShell, "activeThreadId">>,
  cardThreads: ReadonlyArray<Pick<BoardCardThreadShell, "threadId">> | undefined,
): ReadonlySet<ThreadId> {
  const ids = new Set<ThreadId>();
  for (const entry of cardThreads ?? []) ids.add(entry.threadId);
  for (const card of cards) if (card.activeThreadId !== null) ids.add(card.activeThreadId);
  return ids;
}

function sameFields(left: BoardCardThreadFields, right: BoardCardThreadFields): boolean {
  return (
    left.id === right.id &&
    left.title === right.title &&
    left.branch === right.branch &&
    left.activityRunStatus === right.activityRunStatus &&
    left.status === right.status &&
    left.latestRunId === right.latestRunId &&
    left.activeProviderThreadId === right.activeProviderThreadId &&
    // Nested values may be re-decoded per push; compare them by value.
    Equal.equals(left.latestRunCompletedAt ?? null, right.latestRunCompletedAt ?? null) &&
    Equal.equals(left.pendingRuntimeRequest, right.pendingRuntimeRequest) &&
    Equal.equals(left.pendingBackgroundTasks ?? [], right.pendingBackgroundTasks ?? [])
  );
}

function pickFields(thread: OrchestrationV2ThreadShell): BoardCardThreadFields {
  return {
    id: thread.id,
    title: thread.title,
    branch: thread.branch,
    latestRunCompletedAt: thread.latestRunCompletedAt,
    activityRunStatus: thread.activityRunStatus,
    status: thread.status,
    latestRunId: thread.latestRunId,
    activeProviderThreadId: thread.activeProviderThreadId,
    pendingRuntimeRequest: thread.pendingRuntimeRequest,
    pendingBackgroundTasks: thread.pendingBackgroundTasks,
  };
}

/**
 * The linked threads' board fields. Returns `previous` itself when no linked thread changed
 * a field the board reads, and reuses each unchanged entry, so a consumer can compare by
 * reference.
 */
export function projectBoardCardThreadShells(input: {
  readonly linkedThreadIds: ReadonlySet<ThreadId>;
  readonly threads: ReadonlyArray<OrchestrationV2ThreadShell>;
  readonly previous: BoardCardThreadShells;
}): BoardCardThreadShells {
  const { linkedThreadIds, threads, previous } = input;
  if (linkedThreadIds.size === 0) {
    return previous.size === 0 ? previous : EMPTY_BOARD_CARD_THREAD_SHELLS;
  }
  const next = new Map<ThreadId, BoardCardThreadFields>();
  let changed = false;
  for (const thread of threads) {
    if (!linkedThreadIds.has(thread.id)) continue;
    const held = previous.get(thread.id);
    if (held !== undefined && sameFields(held, thread)) {
      next.set(thread.id, held);
    } else {
      next.set(thread.id, pickFields(thread));
      changed = true;
    }
  }
  if (!changed && next.size === previous.size) return previous;
  return next.size === 0 ? EMPTY_BOARD_CARD_THREAD_SHELLS : next;
}
