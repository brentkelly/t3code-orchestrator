/**
 * T3o: the board server's t3o.json schedules (T3O-117), read on demand and
 * refreshed after each change this client makes.
 */
import { useAtomValue } from "@effect/atom-react";
import {
  AuthOrchestrationOperateScope,
  boardRepositoryGroupingKey,
  type BoardScheduleListResult,
  type BoardWorkerCapacitySnapshot,
  type BoardWorkersState,
  type EnvironmentId,
  type ProjectId,
} from "@t3tools/contracts";
import * as Option from "effect/Option";
import { AsyncResult } from "effect/reactivity";

import { useNowMinute } from "../../hooks/useNowMinute";
import { appAtomRegistry } from "../../rpc/atomRegistry";
import { boardEnvironment } from "../../state/board";
import { useEnvironmentQuery } from "../../state/query";
import { useEnvironmentScope } from "../../state/session";
import { environmentShell } from "../../state/shell";
import type { BoardWorkerChoice } from "../workers/cardWorker";
import {
  boardScheduleMachineChoices,
  boardScheduleMachineName,
  boardScheduleWorkerStatus,
  type BoardScheduleWorkerStatus,
} from "./scheduleMachines";

const schedulesAtom = (environmentId: EnvironmentId, projectId: ProjectId | undefined) =>
  boardEnvironment.schedulesAtom({
    environmentId,
    input: projectId === undefined ? {} : { projectId },
  });

export function useBoardSchedules(
  environmentId: EnvironmentId | null,
  projectId?: ProjectId,
): BoardScheduleListResult | null {
  return useEnvironmentQuery(
    environmentId === null ? null : schedulesAtom(environmentId, projectId),
  ).data;
}

/** Re-read both the project's list and the all-projects list the chips use. */
export function refreshBoardSchedules(environmentId: EnvironmentId, projectId?: ProjectId) {
  appAtomRegistry.refresh(schedulesAtom(environmentId, undefined));
  if (projectId !== undefined) appAtomRegistry.refresh(schedulesAtom(environmentId, projectId));
  appAtomRegistry.refresh(boardEnvironment.managedScheduleTasksAtom({ environmentId, input: {} }));
}

/** Moving or running an unattended full-access agent is a board write. */
export const useCanOperateSchedules = (environmentId: EnvironmentId | null) =>
  useEnvironmentScope(environmentId, AuthOrchestrationOperateScope);

/** The machine-name resolver for a list result. */
export function boardScheduleMachineNamer(
  list: Pick<BoardScheduleListResult, "serverEnvironmentId"> | null,
  workers: BoardWorkersState | null = null,
) {
  return (environmentId: EnvironmentId | null) =>
    environmentId === null
      ? "Not scheduled"
      : boardScheduleMachineName(environmentId, list?.serverEnvironmentId ?? null, workers);
}

/** Now, re-read once a minute, as epoch millis. */
export function useScheduleNow(): number {
  return Date.parse(useNowMinute());
}

export interface BoardScheduleMachines {
  /** The Run on rows: the board server, then each worker with its status. */
  readonly choices: ReadonlyArray<BoardWorkerChoice>;
  /** A machine's name, or "Not scheduled". */
  readonly name: (environmentId: EnvironmentId | null) => string;
  /** A worker's status for this project; null for the board server and unknown ids. */
  readonly status: (environmentId: EnvironmentId | null) => BoardScheduleWorkerStatus | null;
}

/** The machines one project's schedules can run on, as the board sees them now (T3O-118). */
export function useBoardScheduleMachines(
  environmentId: EnvironmentId,
  projectId: ProjectId,
  serverEnvironmentId: EnvironmentId,
): BoardScheduleMachines {
  const workers = useAtomValue(boardEnvironment.workersAtom(environmentId));
  const shellState = useAtomValue(environmentShell.stateValueAtom(environmentId));
  const capacityResult = useAtomValue(boardEnvironment.capacityAtom({ environmentId, input: {} }));
  const capacity: ReadonlyMap<string, BoardWorkerCapacitySnapshot> = AsyncResult.isSuccess(
    capacityResult,
  )
    ? capacityResult.value
    : new Map();
  const project =
    (Option.getOrNull(shellState.snapshot)?.projects ?? []).find(
      (candidate) => candidate.id === projectId,
    ) ?? null;
  const projectRepositoryKey = boardRepositoryGroupingKey(project?.repositoryIdentity);
  const facts = {
    projectId,
    projectRepositoryKey,
    projectName: project?.title ?? "this project",
  };
  return {
    choices: boardScheduleMachineChoices({
      state: workers,
      serverEnvironmentId,
      project: facts,
      capacity,
    }),
    name: (target) =>
      target === null
        ? "Not scheduled"
        : boardScheduleMachineName(target, serverEnvironmentId, workers),
    status: (target) => {
      const worker = workers.workers.find((candidate) => candidate.id === target);
      return worker === undefined
        ? null
        : boardScheduleWorkerStatus(worker, facts, capacity.get(worker.id));
    },
  };
}
