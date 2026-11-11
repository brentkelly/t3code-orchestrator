/** T3o: which Settled rows the card-thread filter hides, and how many card threads it covers. */
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import {
  unloadedOlderSettledCount,
  type OlderSettled,
  type OlderSettledScope,
} from "@t3tools/client-runtime/state/threads";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";

export type CardThreadMatch = (environmentId: EnvironmentId, threadId: ThreadId) => boolean;

/**
 * Card threads as each environment's server names them on its filtered count read, so the rows
 * the shell carries are judged by the same rule as the pages and counts the server filters.
 */
export function cardThreadMatcher(
  olderSettled: (environmentId: EnvironmentId) => OlderSettled | null,
): CardThreadMatch {
  return (environmentId, threadId) =>
    olderSettled(environmentId)?.boardCardThreadIds?.has(threadId) ?? false;
}

/** Where the last card-thread ids each environment's server named are kept between sessions. */
export interface CardThreadIdStore {
  readonly load: (environmentId: EnvironmentId) => ReadonlyArray<string> | null;
  readonly save: (environmentId: EnvironmentId, ids: ReadonlyArray<string>) => void;
}

const sameIds = (left: ReadonlySet<ThreadId> | null, right: ReadonlySet<ThreadId>) =>
  left !== null && left.size === right.size && [...right].every((id) => left.has(id));

/**
 * Until this session's filtered read lands (a cached shell, or the first snapshot's read in
 * flight), an environment's card threads are the ones its server last named, so they do not show
 * in Settled on every load and then drop out.
 */
export function rememberCardThreadIds(store: CardThreadIdStore) {
  const known = new Map<EnvironmentId, ReadonlySet<ThreadId> | null>();
  const recall = (environmentId: EnvironmentId) => {
    if (known.has(environmentId)) return known.get(environmentId) ?? null;
    const loaded = store.load(environmentId);
    const remembered = loaded === null ? null : new Set(loaded.map((id) => id as ThreadId));
    known.set(environmentId, remembered);
    return remembered;
  };
  return (environmentId: EnvironmentId, older: OlderSettled | null): OlderSettled | null => {
    if (older === null) return null;
    const ids = older.boardCardThreadIds;
    if (ids != null) {
      const previous = recall(environmentId);
      if (previous !== ids) {
        known.set(environmentId, ids);
        if (!sameIds(previous, ids)) store.save(environmentId, [...ids]);
      }
      return older;
    }
    const remembered = recall(environmentId);
    return remembered === null ? older : { ...older, boardCardThreadIds: remembered };
  };
}

/**
 * The Settled rows with card threads taken out when hiding. The open thread stays, so the row
 * the user is on never vanishes. `held` is every visible row less the hidden ones, the set the
 * server's filtered counts are reconciled against; `localCardCount` is the card threads the
 * notice covers among the Settled rows, hidden or shown.
 */
export function filterSettledCardThreads(input: {
  readonly hide: boolean;
  readonly isCardThread: CardThreadMatch;
  readonly settledThreads: readonly EnvironmentThreadShell[];
  readonly visibleThreads: readonly EnvironmentThreadShell[];
  readonly isRouteThread: (thread: EnvironmentThreadShell) => boolean;
}) {
  const { hide, isCardThread, settledThreads, visibleThreads, isRouteThread } = input;
  const isCard = (thread: EnvironmentThreadShell) => isCardThread(thread.environmentId, thread.id);
  const heldCardThreads = visibleThreads.filter(isCard);
  if (!hide) {
    return {
      settledThreads,
      held: visibleThreads,
      heldCardThreads,
      localCardCount: settledThreads.filter(isCard).length,
    };
  }
  const kept = settledThreads.filter((thread) => !isCard(thread) || isRouteThread(thread));
  return {
    settledThreads: kept.length === settledThreads.length ? settledThreads : kept,
    held: heldCardThreads.length === 0 ? visibleThreads : visibleThreads.filter((t) => !isCard(t)),
    heldCardThreads,
    localCardCount: settledThreads.length - kept.length,
  };
}

/**
 * Card threads in the scope: those among the local Settled rows, plus the older ones the server
 * counted apart and the client does not hold.
 */
export function settledCardThreadCount(input: {
  readonly localCardCount: number;
  readonly scopes: ReadonlyArray<OlderSettledScope>;
  readonly olderSettled: (environmentId: EnvironmentId) => OlderSettled | null;
  readonly heldCardThreads: readonly EnvironmentThreadShell[];
}): number {
  return (
    input.localCardCount +
    unloadedOlderSettledCount({
      olderSettled: input.olderSettled,
      scopes: input.scopes,
      threads: input.heldCardThreads,
      countsOf: (older) => older.boardCardThreadCounts,
    })
  );
}
