/**
 * The List view's surface (T3O-30): the board's top bar with the List tab
 * active, the same `?project` scope as the root board, the outline, and the
 * card popup over it (`?card`). Board-owned and full-bleed, like the board.
 */
import {
  BoardCardId,
  BOARD_SEED_STAGES,
  assignBoardKeyPrefix,
  boardCardAttention,
  isBoardProjectHidden,
  type BoardCardShell,
  type BoardStageDefinition,
  type BoardState,
  type EnvironmentId,
  type ProjectId,
  type ThreadId,
} from "@t3tools/contracts";
import { useAtomValue } from "@effect/atom-react";
import { useNavigate, useSearch } from "@tanstack/react-router";
import * as Option from "effect/Option";
import { useCallback, useMemo } from "react";

import { SidebarInset } from "../components/ui/sidebar";
import { environmentShell } from "../state/shell";
import { boardEnvironment } from "../state/board";
import { validateBoardSearch, type BoardSearch } from "../routes/board";
import { useBoardAttentionSettle } from "./boardAttentionSettle";
import { BoardCardDetail } from "./BoardCardDetail";
import { BoardListView } from "./BoardListView";
import { BoardProjectScopeSelect } from "./BoardProjectScopeSelect";
import { BoardServerUnavailableNotice } from "./BoardServerSettings";
import { BoardCardFilterField, BoardTopBar } from "./BoardTopBar";
import { useBoardUiStore } from "./boardUiStore";
import { BoardUtilityMenu } from "./BoardUtilityMenu";
import { projectIconColorOf } from "./projectAccent";
import { useBoardEnvironment, useBoardSettings } from "./useBoardEnvironmentId";

/** The List view's own filter text, apart from every board's. */
const LIST_QUERY_KEY = "list";

function stageStateOf(stages: ReadonlyArray<BoardStageDefinition>): BoardState {
  return { cards: [], stages, nextCardNumberByProject: {} };
}

function BoardListPage() {
  const board = useBoardEnvironment();
  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none bg-background text-foreground">
      <BoardUtilityMenu />
      <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-x-hidden bg-background">
        {board.kind === "ready" ? (
          <EnvironmentList environmentId={board.environmentId} />
        ) : (
          <>
            <BoardTopBar mode="list" />
            <div className="flex flex-1 items-center justify-center p-6">
              {board.kind === "unavailable" ? (
                <div className="w-full max-w-md">
                  <BoardServerUnavailableNotice label={board.label} />
                </div>
              ) : (
                <p className="text-sm text-muted-foreground">No connected environment.</p>
              )}
            </div>
          </>
        )}
      </div>
    </SidebarInset>
  );
}

function EnvironmentList({ environmentId }: { readonly environmentId: EnvironmentId }) {
  const search = useSearch({ strict: false }) as BoardSearch;
  const navigate = useNavigate();
  const shellState = useAtomValue(environmentShell.stateValueAtom(environmentId));
  const cardsByProject = useAtomValue(boardEnvironment.cardsByProjectAtom(environmentId));
  const stageList = useAtomValue(boardEnvironment.stageListAtom(environmentId));
  const orderedStages = stageList.length > 0 ? stageList : BOARD_SEED_STAGES;
  const stageState = useMemo(() => stageStateOf(orderedStages), [orderedStages]);
  const boardSettings = useBoardSettings((settings) => settings.board);

  const allProjects = useMemo(
    () => Option.getOrNull(shellState.snapshot)?.projects ?? [],
    [shellState.snapshot],
  );
  const accentNameFor = useMemo(() => {
    const byProject = new Map(
      allProjects.map((project) => [project.id, projectIconColorOf(project)] as const),
    );
    return (projectId: ProjectId) => byProject.get(projectId) ?? null;
  }, [allProjects]);
  const projects = useMemo(
    () => allProjects.filter((project) => !isBoardProjectHidden(boardSettings, project.id)),
    [allProjects, boardSettings],
  );
  const scopeProjectId = (search.project ?? null) as ProjectId | null;
  const scopeIsStale =
    scopeProjectId !== null &&
    allProjects.length > 0 &&
    !projects.some((project) => project.id === scopeProjectId);
  const scopeIsHidden =
    scopeProjectId !== null && isBoardProjectHidden(boardSettings, scopeProjectId);

  // Every live card of every visible project: a group's rules read across
  // projects, and a child in another project still shows under its group.
  const shells = useMemo(
    () =>
      [...cardsByProject.entries()]
        .filter(([projectId]) => !isBoardProjectHidden(boardSettings, projectId))
        .flatMap(([, columns]) => Object.values(columns).flat()),
    [boardSettings, cardsByProject],
  );
  const inScope = useCallback(
    (card: BoardCardShell) => scopeProjectId === null || card.projectId === scopeProjectId,
    [scopeProjectId],
  );

  // "Needs you" agrees with the board's card faces: same settle grace.
  const threadShellsById = useMemo(() => {
    const threads = Option.getOrNull(shellState.snapshot)?.threads ?? [];
    return new Map(threads.map((thread) => [thread.id, thread]));
  }, [shellState.snapshot]);
  const threadShellOf = useCallback(
    (threadId: ThreadId) => threadShellsById.get(threadId),
    [threadShellsById],
  );
  const { threadIdleSinceByCard, now } = useBoardAttentionSettle({
    cards: shells,
    threadOf: threadShellOf,
  });
  const attentionFor = useCallback(
    (card: BoardCardShell) => {
      const threadIdleSince = threadIdleSinceByCard.get(String(card.cardId));
      return boardCardAttention({
        card: threadIdleSince === undefined ? card : { ...card, threadIdleSince },
        stages: orderedStages,
        now,
      });
    },
    [now, orderedStages, threadIdleSinceByCard],
  );

  const keyPrefixFor = useCallback(
    (projectId: ProjectId) =>
      assignBoardKeyPrefix({
        board: boardSettings,
        projectId,
        projectTitle: allProjects.find((project) => project.id === projectId)?.title ?? "",
      }).prefix,
    [allProjects, boardSettings],
  );

  const query = useBoardUiStore((state) => state.queryByBoard[LIST_QUERY_KEY] ?? "");
  const setBoardQuery = useBoardUiStore((state) => state.setBoardQuery);
  const setQuery = useCallback(
    (next: string) => setBoardQuery(LIST_QUERY_KEY, next),
    [setBoardQuery],
  );

  const patchSearch = useCallback(
    (updater: (previous: BoardSearch) => BoardSearch) => {
      void navigate({ to: ".", search: (previous) => updater(validateBoardSearch(previous)) });
    },
    [navigate],
  );
  const openCard = useCallback(
    (cardId: string) => patchSearch((previous) => ({ ...previous, card: cardId })),
    [patchSearch],
  );
  const closeCard = useCallback(
    () =>
      patchSearch((previous) => {
        const { card: _card, ...rest } = previous;
        return rest;
      }),
    [patchSearch],
  );
  const openBoard = useCallback(
    (parentCardId: string) => {
      void navigate({
        to: "/board/$parentCardId",
        params: { parentCardId },
        search: scopeProjectId === null ? {} : { project: scopeProjectId },
      });
    },
    [navigate, scopeProjectId],
  );
  const scopeName =
    scopeProjectId === null
      ? "All projects"
      : (projects.find((project) => project.id === scopeProjectId)?.title ??
        (scopeIsHidden ? "Hidden project" : "Unknown project"));

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <BoardTopBar mode="list">
        <BoardCardFilterField onQueryChange={setQuery} query={query} />
      </BoardTopBar>
      <div className="flex shrink-0 items-center gap-3 px-3 pt-2 sm:px-5">
        <BoardProjectScopeSelect
          accentNameFor={accentNameFor}
          onChange={(projectId) =>
            patchSearch((previous) => {
              const { project: _project, ...rest } = previous;
              return projectId === null ? rest : { ...rest, project: projectId };
            })
          }
          projects={projects}
          scopeIsHidden={scopeIsHidden}
          scopeIsStale={scopeIsStale}
          scopeProjectId={scopeProjectId}
        />
      </div>
      <BoardListView
        accentNameFor={accentNameFor}
        attentionFor={attentionFor}
        environmentId={environmentId}
        inScope={inScope}
        keyPrefixFor={keyPrefixFor}
        onOpenBoard={openBoard}
        onOpenCard={openCard}
        projects={
          scopeProjectId === null
            ? projects
            : projects.filter((project) => project.id === scopeProjectId)
        }
        query={query}
        scopeName={scopeName}
        shells={shells}
        stages={stageState}
      />
      {search.card !== undefined ? (
        <BoardCardDetail
          cardId={BoardCardId.make(search.card)}
          environmentId={environmentId}
          key={search.card}
          nav={null}
          onClose={closeCard}
          onOpenSubBoard={openBoard}
        />
      ) : null}
    </div>
  );
}

export default BoardListPage;
