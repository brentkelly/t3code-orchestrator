/**
 * T3o: a card's threads that the shell left out. Shells keep only the newest settled threads, so a
 * finished card's threads are mostly absent and would read as deleted. Each is read on demand
 * through its family query, privately: mounting it would merge it into the sidebar's rows too.
 */
import { useAtomValue } from "@effect/atom-react";
import { selectEnvironmentQueryData } from "@t3tools/client-runtime/state/runtime";
import {
  type BoardCardThreadShells,
  EMPTY_BOARD_CARD_THREAD_SHELLS,
  projectBoardCardThreadShells,
} from "@t3tools/client-runtime/state/shell";
import { threadFamilyRead } from "@t3tools/client-runtime/state/threads";
import type {
  BoardCardThreadLink,
  BoardThreadStateSource,
  EnvironmentId,
  OrchestrationV2ThreadShell,
  ThreadId,
} from "@t3tools/contracts";
import * as Option from "effect/Option";
import { Atom } from "effect/reactivity";

import { orchestrationEnvironment } from "../state/orchestration";
import { useEnvironmentQuery } from "../state/query";
import { environmentShell } from "../state/shell";
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
  readonly failed: ReadonlySet<ThreadId>;
}

const NO_ROWS: BoardCardThreadRows = { threads: new Map(), loading: new Set(), failed: new Set() };

/**
 * What the card's thread pane can show for one thread. Only a read that succeeded without the row
 * proves the thread is gone; a failed read is not proof.
 */
export function boardCardChatPresence(input: {
  readonly threadId: ThreadId;
  readonly inShell: boolean;
  readonly rows: BoardCardThreadRows;
}): "open" | "loading" | "failed" | "gone" {
  if (input.inShell || input.rows.threads.has(input.threadId)) return "open";
  if (input.rows.loading.has(input.threadId)) return "loading";
  if (input.rows.failed.has(input.threadId)) return "failed";
  return "gone";
}

/**
 * Why a linked thread the family read did not return cannot open: the family read covers active
 * threads only, so an archived one is absent from it but still on the server.
 */
export function boardCardMissingThreadReason(input: {
  readonly threadId: ThreadId;
  readonly archivedThreadIds: ReadonlyArray<ThreadId> | null;
  readonly archivedLoading: boolean;
}): "checking" | "archived" | "unknown" | "gone" {
  if (input.archivedThreadIds?.includes(input.threadId) === true) return "archived";
  if (input.archivedLoading) return "checking";
  return input.archivedThreadIds === null ? "unknown" : "gone";
}

const rowsAtom = Atom.family((key: string) => {
  const [environmentId, threadIds] = JSON.parse(key) as [EnvironmentId, ReadonlyArray<ThreadId>];
  return Atom.make((get): BoardCardThreadRows => {
    if (threadIds.length === 0) return NO_ROWS;
    const threads = new Map<ThreadId, OrchestrationV2ThreadShell>();
    const loading = new Set<ThreadId>();
    const failed = new Set<ThreadId>();
    for (const threadId of threadIds) {
      const read = get(threadFamilies.familyAtom(environmentId, threadId));
      const status = threadFamilyRead(read);
      if (status === "pending") loading.add(threadId);
      if (status === "failed") failed.add(threadId);
      const row = selectEnvironmentQueryData(read)?.threads.find(
        (thread) => thread.id === threadId,
      );
      if (row !== undefined) threads.set(threadId, row);
    }
    return { threads, loading, failed };
  }).pipe(Atom.withLabel(`t3o:board:card-thread-rows:${key}`));
});

/** The rows of `threadIds`, read while the caller is mounted, and those still loading. */
export function useBoardCardThreadRows(
  environmentId: EnvironmentId,
  threadIds: ReadonlyArray<ThreadId>,
): BoardCardThreadRows {
  return useAtomValue(rowsAtom(JSON.stringify([environmentId, threadIds])));
}

const cardShellThreadsAtom = Atom.family((key: string) => {
  const [environmentId, threadIds] = JSON.parse(key) as [EnvironmentId, ReadonlyArray<ThreadId>];
  const linked = new Set(threadIds);
  let previous: BoardCardThreadShells = EMPTY_BOARD_CARD_THREAD_SHELLS;
  return Atom.make((get): BoardCardThreadShells => {
    const shell = get(environmentShell.stateValueAtom(environmentId));
    previous = projectBoardCardThreadShells({
      linkedThreadIds: linked,
      threads: Option.match(shell.snapshot, { onNone: () => [], onSome: (value) => value.threads }),
      previous,
    });
    return previous;
  }).pipe(Atom.withLabel(`t3o:board:card-shell-threads:${key}`));
});

/** The board fields of one card's threads that the shell holds. Keeps its identity across
    pushes for other threads, so an open card does not re-render while unrelated agents stream. */
export function useBoardCardShellThreads(
  environmentId: EnvironmentId,
  threadIds: ReadonlyArray<ThreadId>,
): BoardCardThreadShells {
  return useAtomValue(cardShellThreadsAtom(JSON.stringify([environmentId, threadIds])));
}

export interface BoardCardOffShellThreads {
  /** Titles of the threads that exist, archived ones included. */
  readonly titles: ReadonlyMap<ThreadId, string>;
  readonly loading: boolean;
}

const NO_OFF_SHELL_TITLES: ReadonlyMap<ThreadId, string> = new Map();

/** A thread the shell left out has settled: the shell keeps every thread with a live run. */
export const OFF_SHELL_THREAD_STATE: BoardThreadStateSource = {
  hasPendingUserInput: false,
  hasPendingApprovals: false,
  session: { status: "ready" },
  backgroundLiveness: null,
};

/** The titles of `threadIds` the shell left out, in one read however many there are. */
export function useBoardCardOffShellThreads(
  environmentId: EnvironmentId,
  threadIds: ReadonlyArray<ThreadId>,
): BoardCardOffShellThreads {
  const read = useEnvironmentQuery(
    threadIds.length === 0
      ? null
      : orchestrationEnvironment.threadTitles({ environmentId, input: { threadIds } }),
  );
  const titles =
    read.data === null
      ? NO_OFF_SHELL_TITLES
      : new Map(Object.entries(read.data) as Array<[ThreadId, string]>);
  return { titles, loading: read.isPending };
}
