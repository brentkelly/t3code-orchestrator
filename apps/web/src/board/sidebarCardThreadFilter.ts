/** T3o: which Settled rows the card-thread filter hides, and how many it hides (T3O-78). */
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import {
  unloadedOlderSettledCount,
  type OlderSettledScope,
  type OlderSettledShelfEnvironment,
} from "@t3tools/client-runtime/state/threads";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";

export type CardThreadMatch = (environmentId: EnvironmentId, threadId: ThreadId) => boolean;

/**
 * The Settled rows with card threads taken out when hiding. The open thread stays, so the row
 * the user is on never vanishes. `held` is every visible row less the hidden ones, the set the
 * server's filtered counts are reconciled against.
 */
export function filterSettledCardThreads(input: {
  readonly hide: boolean;
  readonly isCardThread: CardThreadMatch;
  readonly settledThreads: readonly EnvironmentThreadShell[];
  readonly visibleThreads: readonly EnvironmentThreadShell[];
  readonly isRouteThread: (thread: EnvironmentThreadShell) => boolean;
}) {
  const { hide, isCardThread, settledThreads, visibleThreads, isRouteThread } = input;
  if (!hide) {
    return {
      settledThreads,
      held: visibleThreads,
      heldCardThreads: [] as readonly EnvironmentThreadShell[],
      hiddenCount: 0,
    };
  }
  const isCard = (thread: EnvironmentThreadShell) => isCardThread(thread.environmentId, thread.id);
  const kept = settledThreads.filter((thread) => !isCard(thread) || isRouteThread(thread));
  return {
    settledThreads: kept.length === settledThreads.length ? settledThreads : kept,
    held: visibleThreads.filter((thread) => !isCard(thread)),
    heldCardThreads: visibleThreads.filter(isCard),
    hiddenCount: settledThreads.length - kept.length,
  };
}

/**
 * Card threads hidden from the scope: those taken out of the local rows, plus the older ones the
 * server left out of its counts and the client does not hold.
 */
export function hiddenCardThreadCount(input: {
  readonly hiddenLocally: number;
  readonly scopes: ReadonlyArray<OlderSettledScope>;
  readonly environments: ReadonlyMap<EnvironmentId, OlderSettledShelfEnvironment>;
  readonly heldCardThreads: readonly EnvironmentThreadShell[];
}): number {
  return (
    input.hiddenLocally +
    unloadedOlderSettledCount({
      olderSettled: (environmentId) => input.environments.get(environmentId)?.older ?? null,
      scopes: input.scopes,
      threads: input.heldCardThreads,
      countsOf: (older) => older.boardCardThreadCounts,
    })
  );
}
