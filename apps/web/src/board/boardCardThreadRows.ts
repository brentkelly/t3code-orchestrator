/**
 * T3o: a card's threads that the shell left out. Shells keep only the newest settled threads, so a
 * finished card's threads are mostly absent and would read as deleted. Each is read on demand
 * through its family query, privately: mounting it would merge it into the sidebar's rows too.
 */
import { useAtomValue } from "@effect/atom-react";
import { selectEnvironmentQueryData } from "@t3tools/client-runtime/state/runtime";
import { threadFamilyRead } from "@t3tools/client-runtime/state/threads";
import type {
  BoardCardThreadLink,
  EnvironmentId,
  OrchestrationV2ThreadShell,
  ThreadId,
} from "@t3tools/contracts";
import { Atom } from "effect/reactivity";

import { threadFamilies } from "../state/threads";

/**
 * Linked threads this server should hold but its shell does not: not tombstoned, and not on
 * another worker, whose threads are never in this server's shell.
 */
export function cardThreadIdsMissingFromShell(
  links: ReadonlyArray<Pick<BoardCardThreadLink, "threadId" | "tombstonedAt" | "workerId">>,
  shellThreads: ReadonlyArray<{ readonly id: ThreadId }>,
): ReadonlyArray<ThreadId> {
  const present = new Set(shellThreads.map((thread) => thread.id));
  return links.flatMap((link) =>
    link.tombstonedAt === null && link.workerId === undefined && !present.has(link.threadId)
      ? [link.threadId]
      : [],
  );
}

export interface BoardCardThreadRows {
  readonly threads: ReadonlyMap<ThreadId, OrchestrationV2ThreadShell>;
  readonly loading: ReadonlySet<ThreadId>;
}

const NO_ROWS: BoardCardThreadRows = { threads: new Map(), loading: new Set() };

const rowsAtom = Atom.family((key: string) => {
  const [environmentId, threadIds] = JSON.parse(key) as [EnvironmentId, ReadonlyArray<ThreadId>];
  return Atom.make((get): BoardCardThreadRows => {
    if (threadIds.length === 0) return NO_ROWS;
    const threads = new Map<ThreadId, OrchestrationV2ThreadShell>();
    const loading = new Set<ThreadId>();
    for (const threadId of threadIds) {
      const read = get(threadFamilies.familyAtom(environmentId, threadId));
      if (threadFamilyRead(read) === "pending") loading.add(threadId);
      const row = selectEnvironmentQueryData(read)?.threads.find(
        (thread) => thread.id === threadId,
      );
      if (row !== undefined) threads.set(threadId, row);
    }
    return { threads, loading };
  }).pipe(Atom.withLabel(`t3o:board:card-thread-rows:${key}`));
});

/** The rows of `threadIds`, read while the caller is mounted, and those still loading. */
export function useBoardCardThreadRows(
  environmentId: EnvironmentId,
  threadIds: ReadonlyArray<ThreadId>,
): BoardCardThreadRows {
  return useAtomValue(rowsAtom(JSON.stringify([environmentId, threadIds])));
}
