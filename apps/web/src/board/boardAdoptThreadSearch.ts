/**
 * T3o: server-side title search for the card's "Adopt an existing thread" picker (T3O-41). The shell
 * keeps only the newest settled threads, so the picker cannot find older ones in the snapshot.
 * Rows are read here and never mounted, so search results do not leak into the sidebar.
 */
import { useAtomValue } from "@effect/atom-react";
import {
  createThreadSearchResultsAtomFamily,
  makeThreadSearchKey,
  type ThreadSearchResultsState,
} from "@t3tools/client-runtime/state/thread-search";
import {
  THREAD_SEARCH_QUERY_MAX_LENGTH,
  type EnvironmentId,
  type OrchestrationV2ThreadShell,
  type ProjectId,
  type ThreadId,
} from "@t3tools/contracts";
import { Atom } from "effect/reactivity";

import { orchestrationEnvironment } from "../state/orchestration";
import { useDebouncedValue } from "../state/queries";
import { olderSettledThreads } from "../state/threads";
import type { BoardPickerOption } from "./BoardSearchAddPicker";

const DEBOUNCE_MS = 120;
/** Older settled titles match from two characters, as in the sidebar search. */
const MIN_QUERY_LENGTH = 2;
const NO_ROWS: ReadonlyArray<OrchestrationV2ThreadShell> = [];

const olderSettledBefore = Atom.family((environmentId: EnvironmentId) =>
  Atom.make((get) => get(olderSettledThreads.olderSettledAtom(environmentId))?.before ?? null).pipe(
    Atom.withLabel(`t3o:board:adopt-search-before:${environmentId}`),
  ),
);

const search = createThreadSearchResultsAtomFamily({
  getSearchAtom: (environmentId, input) =>
    input.olderSettledBefore === undefined
      ? orchestrationEnvironment.threadSearch({ environmentId, input })
      : olderSettledThreads.searchAtom(environmentId, input),
  olderSettledBefore,
  labelPrefix: "t3o:board:adopt-search",
});

const EMPTY = Atom.make<ThreadSearchResultsState>({ matches: [], isLoading: false, rows: [] }).pipe(
  Atom.withLabel("t3o:board:adopt-search:empty"),
);

/** The older settled threads in `projectId` whose titles match `query`, and whether a read is due. */
export function useBoardAdoptThreadSearch(
  environmentId: EnvironmentId,
  projectId: ProjectId | null,
  query: string,
): { readonly rows: ReadonlyArray<OrchestrationV2ThreadShell>; readonly pending: boolean } {
  const normalized = query.trim().slice(0, THREAD_SEARCH_QUERY_MAX_LENGTH).trim();
  const debounced = useDebouncedValue(normalized, DEBOUNCE_MS);
  const canSearch = projectId !== null && normalized.length >= MIN_QUERY_LENGTH;
  const key =
    canSearch && debounced === normalized
      ? makeThreadSearchKey([environmentId], debounced, {
          projectIds: [projectId],
          titlesOnly: true,
        })
      : null;
  const result = useAtomValue(key === null ? EMPTY : search.results(key));
  return {
    rows: key === null ? NO_ROWS : result.rows.flatMap((entry) => entry.read.threads),
    pending: canSearch && (debounced !== normalized || result.isLoading),
  };
}

/**
 * The threads the picker offers: the card's project, not archived, from the shell and the search,
 * and not linked to any card — a thread belongs to one card (D9), so offering one that is would
 * only produce a refused command. `linkedElsewhere` is every card-thread id the client knows of.
 */
export function boardAdoptableThreads(input: {
  readonly projectId: ProjectId;
  readonly cardThreadIds: ReadonlyArray<ThreadId>;
  readonly linkedElsewhere: (threadId: ThreadId) => boolean;
  readonly threads: ReadonlyArray<
    Pick<OrchestrationV2ThreadShell, "id" | "projectId" | "archivedAt" | "title">
  >;
}): ReadonlyArray<BoardPickerOption> {
  const excluded = new Set(input.cardThreadIds);
  const options: BoardPickerOption[] = [];
  for (const thread of input.threads) {
    if (thread.projectId !== input.projectId || thread.archivedAt !== null) continue;
    if (excluded.has(thread.id) || input.linkedElsewhere(thread.id)) continue;
    excluded.add(thread.id);
    options.push({ id: thread.id, key: "", title: thread.title });
  }
  return options;
}
