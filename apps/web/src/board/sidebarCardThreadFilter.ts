/** T3o: which Settled rows the card-thread filter hides, and how many card threads it covers (T3O-78). */
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
