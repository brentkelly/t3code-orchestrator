/**
 * T3o: the machines a t3o.json schedule can run on (T3O-118): the board server, then each
 * worker with whether it could take a run now. A run due while its worker can't take it is
 * skipped, so only a ready worker can be picked; the board server always can.
 */
import {
  BOARD_WORKER_SCHEDULE_PROTOCOL,
  boardReadinessIsFor,
  resolveBoardWorkerCheckout,
  type BoardWorkerCapacitySnapshot,
  type BoardWorkersState,
  type BoardWorkerView,
  type EnvironmentId,
} from "@t3tools/contracts";

import type { BoardWorkerChoice } from "../workers/cardWorker";
import { localWorkerLabel } from "../workers/threadWorker";
import { clockTime } from "../workers/workerCopy";

export interface BoardScheduleWorkerStatus {
  /** The picker row's sub-line. */
  readonly text: string;
  /** Amber: a run due now would be skipped. */
  readonly warning: boolean;
  /** Offline, rather than reachable but not ready. */
  readonly offline: boolean;
}

export interface BoardScheduleProjectFacts {
  readonly projectId: string;
  readonly projectRepositoryKey: string | null;
  readonly projectName: string;
}

/** Whether a worker could take a schedule run of the project now, as the runner checks it. */
export function boardScheduleWorkerStatus(
  worker: BoardWorkerView,
  project: BoardScheduleProjectFacts,
  snapshot: BoardWorkerCapacitySnapshot | undefined,
): BoardScheduleWorkerStatus {
  const notReady = (reason: string): BoardScheduleWorkerStatus => ({
    text: `Not ready for ${project.projectName} · ${reason}`,
    warning: true,
    offline: false,
  });
  if (worker.status.state === "incompatible") return notReady("needs a T3o update");
  if (worker.status.state !== "online") {
    return {
      text:
        worker.status.lastSeenAt === null
          ? "Offline"
          : `Offline · last seen ${clockTime(worker.status.lastSeenAt)}`,
      warning: true,
      offline: true,
    };
  }
  if ((worker.status.protocolVersion ?? 0) < BOARD_WORKER_SCHEDULE_PROTOCOL) {
    return notReady("needs a T3o update");
  }
  const checkout = resolveBoardWorkerCheckout(
    project.projectRepositoryKey,
    worker.snapshot?.checkouts ?? [],
  );
  if (checkout === null) return notReady("no checkout");
  const readiness = snapshot?.readiness.find((entry) =>
    boardReadinessIsFor(entry, project.projectRepositoryKey, checkout.projectId),
  );
  if (readiness !== undefined && readiness.state !== "ready") {
    return notReady(readiness.state === "checking" ? "checking" : "readiness check fails");
  }
  return {
    text: `Connected · ready for ${project.projectName}`,
    warning: false,
    offline: false,
  };
}

/** The Run on rows: the board server, then every worker with its status sub-line. */
export function boardScheduleMachineChoices(input: {
  readonly state: BoardWorkersState;
  readonly serverEnvironmentId: EnvironmentId;
  readonly project: BoardScheduleProjectFacts;
  readonly capacity: ReadonlyMap<string, BoardWorkerCapacitySnapshot>;
}): ReadonlyArray<BoardWorkerChoice> {
  const server: BoardWorkerChoice = {
    workerId: input.serverEnvironmentId,
    label: localWorkerLabel(input.state),
    detail: "Board",
    selectable: true,
    tooltip: null,
    canSetUp: false,
    cloning: false,
  };
  return [
    server,
    ...input.state.workers.map((worker): BoardWorkerChoice => {
      const status = boardScheduleWorkerStatus(
        worker,
        input.project,
        input.capacity.get(worker.id),
      );
      return {
        workerId: worker.id,
        label: worker.label,
        detail: "",
        selectable: !status.warning,
        tooltip: status.warning
          ? `${worker.label} can't take a run now (${status.text.toLowerCase()}); a run due then is skipped.`
          : null,
        canSetUp: false,
        cloning: false,
        sub: { text: status.text, warning: status.warning },
      };
    }),
  ];
}

/** A machine's name: "This server" (or its Workers-page name), a worker's label, or its id. */
export function boardScheduleMachineName(
  environmentId: EnvironmentId,
  serverEnvironmentId: EnvironmentId | null,
  state: BoardWorkersState | null,
): string {
  if (environmentId === serverEnvironmentId) {
    return state === null ? "This server" : localWorkerLabel(state);
  }
  return state?.workers.find((worker) => worker.id === environmentId)?.label ?? environmentId;
}
