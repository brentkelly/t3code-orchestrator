/**
 * T3o (T3O-65): what the Worker field needs for one project — the board's
 * workers, the Pin to rows with their load, the project's name as the rows say
 * it, and Set up on worker.
 */
import { useAtomValue } from "@effect/atom-react";
import {
  boardRepositoryGroupingKey,
  type BoardWorkerId,
  type BoardWorkersState,
  type EnvironmentId,
  type ProjectId,
} from "@t3tools/contracts";
import * as Option from "effect/Option";
import { useCallback, useMemo } from "react";

import { usePrimarySettings } from "../../hooks/useSettings";
import { boardEnvironment } from "../../state/board";
import { environmentShell } from "../../state/shell";
import { useAtomCommand } from "../../state/use-atom-command";
import {
  boardShowsWorkers,
  boardWorkerChoices,
  boardWorkerRunningCounts,
  type BoardWorkerChoice,
} from "./cardWorker";

export interface BoardWorkerChoices {
  readonly workers: BoardWorkersState;
  /** False on a board with one worker: render no Worker field at all. */
  readonly shown: boolean;
  readonly choices: ReadonlyArray<BoardWorkerChoice>;
  readonly projectName: string;
  readonly projectRepositoryKey: string | null;
  readonly setUp: (workerId: BoardWorkerId) => void;
}

export function useBoardWorkerChoices(
  environmentId: EnvironmentId,
  projectId: ProjectId | null,
): BoardWorkerChoices {
  const workers = useAtomValue(boardEnvironment.workersAtom(environmentId));
  const cardsByProject = useAtomValue(boardEnvironment.cardsByProjectAtom(environmentId));
  const shellState = useAtomValue(environmentShell.stateValueAtom(environmentId));
  const concurrency = usePrimarySettings((settings) => settings.board.concurrency);
  const setupProject = useAtomCommand(boardEnvironment.setupWorkerProject);
  const shown = boardShowsWorkers(workers);

  const project = useMemo(
    () =>
      projectId === null
        ? null
        : ((Option.getOrNull(shellState.snapshot)?.projects ?? []).find(
            (candidate) => candidate.id === projectId,
          ) ?? null),
    [projectId, shellState.snapshot],
  );
  const projectRepositoryKey = boardRepositoryGroupingKey(project?.repositoryIdentity);
  const projectName =
    project?.repositoryIdentity?.name ??
    projectRepositoryKey?.split("/").at(-1) ??
    project?.title ??
    "this project";

  const choices = useMemo(() => {
    if (!shown || projectId === null) return [];
    const cards = [...cardsByProject.values()].flatMap((byStage) => Object.values(byStage).flat());
    return boardWorkerChoices({
      state: workers,
      projectId,
      projectRepositoryKey,
      projectName,
      running: boardWorkerRunningCounts(cards, workers),
      concurrency,
    });
  }, [cardsByProject, concurrency, projectId, projectName, projectRepositoryKey, shown, workers]);

  const setUp = useCallback(
    (workerId: BoardWorkerId) => {
      if (projectId === null || workerId === "local") return;
      void setupProject({ environmentId, input: { projectId, workerId } });
    },
    [environmentId, projectId, setupProject],
  );

  return { workers, shown, choices, projectName, projectRepositoryKey, setUp };
}
