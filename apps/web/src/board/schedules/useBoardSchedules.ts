/**
 * T3o: the board server's t3o.json schedules (T3O-117), read on demand and
 * refreshed after each change this client makes.
 */
import {
  AuthOrchestrationOperateScope,
  type BoardScheduleListResult,
  type EnvironmentId,
  type ProjectId,
} from "@t3tools/contracts";

import { useNowMinute } from "../../hooks/useNowMinute";
import { appAtomRegistry } from "../../rpc/atomRegistry";
import { boardEnvironment } from "../../state/board";
import { useEnvironmentQuery } from "../../state/query";
import { useEnvironmentScope } from "../../state/session";
import { boardScheduleMachineLabel } from "../settings/boardProjectSettings.logic";

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
) {
  return (environmentId: EnvironmentId | null) =>
    boardScheduleMachineLabel(environmentId, list?.serverEnvironmentId ?? null) ?? "Not scheduled";
}

/** Now, re-read once a minute, as epoch millis. */
export function useScheduleNow(): number {
  return Date.parse(useNowMinute());
}
