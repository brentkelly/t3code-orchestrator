/**
 * T3o: the board's workers as targets for t3o.json schedule runs (T3O-118). A run goes to a
 * worker only when it could start there now; otherwise it is skipped with the reason.
 */
import {
  BOARD_WORKER_SCHEDULE_PROTOCOL,
  boardReadinessIsFor,
  boardRepositoryGroupingKey,
  type BoardWorkerCapacitySnapshot,
  type BoardWorkersState,
  type EnvironmentId,
  type ProjectId,
  type ProviderInstanceId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import { ServerEnvironment } from "../../environment/ServerEnvironment.ts";
import { BoardCapacityClient } from "../capacity/BoardCapacityClient.ts";
import { ThreadGateway } from "../ThreadGateway.ts";
import { BoardPlacement, boardPlacementGate } from "../workers/BoardPlacement.ts";
import { WorkerConnections } from "../workers/WorkerConnections.ts";
import type { BoardScheduleWorkerTarget, BoardScheduleWorkers } from "./BoardSchedules.ts";

/**
 * Whether a run can go to the worker now, checked in the order a human fixes them: online,
 * new enough, a checkout ready for the project, then a signed-in provider for the model.
 */
export function scheduleWorkerTarget(input: {
  readonly workerId: EnvironmentId;
  readonly workers: BoardWorkersState;
  readonly snapshot: BoardWorkerCapacitySnapshot | null;
  readonly repositoryKey: string | null;
  readonly projectTitle: string;
  readonly providerInstanceId: ProviderInstanceId;
}): BoardScheduleWorkerTarget {
  const worker = input.workers.workers.find((candidate) => candidate.id === input.workerId);
  if (worker === undefined) {
    return { kind: "skip", reason: `${input.workerId} isn't one of this board's workers` };
  }
  const label = worker.label;
  const skip = (reason: string): BoardScheduleWorkerTarget => ({
    kind: "skip",
    reason: `${label} ${reason}`,
  });
  if (worker.status.state === "incompatible") return skip("needs a T3o update");
  if (worker.status.state !== "online") return skip("is offline");
  if ((worker.status.protocolVersion ?? 0) < BOARD_WORKER_SCHEDULE_PROTOCOL) {
    return skip("needs a T3o update");
  }
  const gate = boardPlacementGate({
    workerId: input.workerId,
    workers: input.workers,
    projectRepositoryKey: input.repositoryKey,
    providerInstanceId: input.providerInstanceId,
  });
  if (gate.kind === "no-checkout") return skip(`has no checkout of ${input.projectTitle}`);
  const workerProjectId = gate.kind === "ready" ? gate.workerProjectId : null;
  const readiness = input.snapshot?.readiness.find((entry) =>
    boardReadinessIsFor(entry, input.repositoryKey, String(workerProjectId ?? "")),
  );
  if (readiness !== undefined && readiness.state !== "ready") {
    return skip(`isn't ready for ${input.projectTitle}`);
  }
  if (gate.kind === "provider-missing") {
    return skip(`has no ${input.providerInstanceId} provider`);
  }
  if (gate.kind !== "ready" || workerProjectId === null) return skip("is offline");
  const provider = input.snapshot?.providers.find(
    (candidate) => candidate.instanceId === input.providerInstanceId,
  );
  if (provider?.account.status === "signed-out") {
    return skip(`isn't signed in to ${input.providerInstanceId}`);
  }
  return { kind: "ready", workerProjectId, label };
}

/** The board's workers, over its placement summary, capacity snapshots and connections. */
export const makeBoardScheduleWorkers = Effect.gen(function* () {
  const placement = yield* BoardPlacement;
  const capacity = yield* Effect.serviceOption(BoardCapacityClient);
  const threads = yield* ThreadGateway;
  const connections = yield* WorkerConnections;
  const centralEnvironmentId = yield* Effect.flatMap(
    ServerEnvironment,
    (environment) => environment.getEnvironmentId,
  );
  const labels = placement.workers.pipe(
    Effect.map(
      (state) =>
        new Map(state.workers.map((worker) => [worker.id, worker.label] as const)) as ReadonlyMap<
          EnvironmentId,
          string
        >,
    ),
  );
  return {
    labels,
    target: Effect.fn("BoardScheduleWorkers.target")(function* ({
      workerId,
      projectId,
      modelSelection,
    }: {
      readonly workerId: EnvironmentId;
      readonly projectId: ProjectId;
      readonly modelSelection: { readonly instanceId: ProviderInstanceId };
    }) {
      const detail = yield* threads.project(projectId).pipe(Effect.orElseSucceed(() => null));
      return scheduleWorkerTarget({
        workerId,
        workers: yield* placement.workers,
        snapshot: Option.isSome(capacity) ? yield* capacity.value.latest(workerId) : null,
        repositoryKey:
          detail === null ? null : boardRepositoryGroupingKey(detail.repositoryIdentity),
        projectTitle: detail?.title ?? String(projectId),
        providerInstanceId: modelSelection.instanceId,
      });
    }),
    launch: (workerId, input) =>
      connections.get(workerId).pipe(
        Effect.mapError((unavailable) => ({ message: unavailable.message, agentCap: false })),
        Effect.flatMap((rpc) =>
          rpc.gateway
            .launchScheduleRun({
              commandId: input.commandId,
              threadId: input.threadId,
              projectId: input.workerProjectId,
              title: input.title,
              prompt: input.prompt,
              modelSelection: input.modelSelection,
              branch: input.branch,
              centralEnvironmentId,
              previousRuns: input.previousRuns,
            })
            .pipe(
              Effect.mapError((error) =>
                error._tag === "BoardWorkerGatewayError"
                  ? { message: error.detail, agentCap: error.reason === "agent-cap" }
                  : { message: error.message, agentCap: false },
              ),
            ),
        ),
        Effect.map((result) => result.pruned),
      ),
  } satisfies BoardScheduleWorkers;
});
