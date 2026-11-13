/**
 * What browsers read of worker capacity (T3O-86): the capacity stream the Workers page, the
 * pin picker and a queued card open, and the actions a human takes on readiness and setup.
 */
import {
  BOARD_LOCAL_WORKER_ID,
  BoardWorkerActionError,
  boardProjectStageConfig,
  boardRepositoryGroupingKey,
  EMPTY_BOARD_STATE,
  resolveBoardProjectResourceSettings,
  type BoardWorkerCapacityItem,
  type BoardWorkerId,
  type BoardWorkersCapacityActionInput,
  type ProjectId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";

import { BoardEngine } from "../BoardEngine.ts";
import { ThreadGateway } from "../ThreadGateway.ts";
import { BoardWorkspaces } from "../workspace/BoardWorkspace.ts";
import { BoardCapacityClient } from "./BoardCapacityClient.ts";

/** Every worker's snapshot now, then each change. */
export const boardCapacityStream: Stream.Stream<
  BoardWorkerCapacityItem,
  never,
  BoardCapacityClient
> = Stream.unwrap(
  Effect.gen(function* () {
    const client = yield* BoardCapacityClient;
    const initial = [...(yield* client.all)].map(([workerId, snapshot]) => ({
      workerId,
      snapshot,
    }));
    const changes = client.changes.pipe(
      Stream.mapEffect((workerId) =>
        client
          .latest(workerId)
          .pipe(Effect.map((snapshot) => (snapshot === null ? [] : [{ workerId, snapshot }]))),
      ),
      Stream.flatMap((items) => Stream.fromIterable(items)),
    );
    return Stream.concat(Stream.fromIterable(initial), changes);
  }),
);

const notFound = (message: string) => new BoardWorkerActionError({ code: "not-found", message });

/** Readiness for one project on one worker, asked again now. */
const recheck = Effect.fn("BoardCapacityRpc.recheck")(function* (
  workerId: BoardWorkerId,
  projectId: ProjectId,
) {
  const client = yield* BoardCapacityClient;
  const engine = yield* BoardEngine;
  const threads = yield* ThreadGateway;
  const workspaces = yield* BoardWorkspaces;
  const board = (yield* engine.getReadModel).board ?? EMPTY_BOARD_STATE;
  const project = yield* threads.project(projectId).pipe(Effect.orElseSucceed(() => null));
  const settings = resolveBoardProjectResourceSettings(
    boardProjectStageConfig(board, projectId)?.resources ?? null,
  );
  const workspace = yield* workspaces.forWorker(workerId, projectId);
  if (workspace.checkoutPath === null) return null;
  const result = yield* client.checkReadiness(workerId, {
    repositoryKey: boardRepositoryGroupingKey(project?.repositoryIdentity),
    path: settings.readinessPath,
    timeoutSeconds: settings.readinessTimeoutSeconds,
    projectId: String(workspace.projectId),
    requested: true,
  });
  return result === null ? null : result.state;
});

export const boardCapacityAction = Effect.fn("BoardCapacityRpc.action")(function* (
  input: BoardWorkersCapacityActionInput,
) {
  const client = yield* BoardCapacityClient;
  const engine = yield* BoardEngine;
  const board = (yield* engine.getReadModel).board ?? EMPTY_BOARD_STATE;
  switch (input.action) {
    case "recheck": {
      // Re-check all projects: every project with open cards.
      const projects =
        input.projectId === null
          ? [
              ...new Set(
                board.cards
                  .filter((card) => card.archivedAt === null)
                  .map((card) => card.projectId),
              ),
            ]
          : [input.projectId];
      for (const projectId of projects) {
        yield* recheck(input.workerId, projectId).pipe(Effect.forkDetach);
      }
      return null;
    }
    case "readinessOutput": {
      const threads = yield* ThreadGateway;
      const project = yield* threads
        .project(input.projectId)
        .pipe(Effect.orElseSucceed(() => null));
      const settings = resolveBoardProjectResourceSettings(
        boardProjectStageConfig(board, input.projectId)?.resources ?? null,
      );
      return yield* client.readinessOutput(
        input.workerId,
        boardRepositoryGroupingKey(project?.repositoryIdentity),
        settings.readinessPath,
      );
    }
    case "setupLog": {
      const card = board.cards.find((candidate) => candidate.id === input.cardId);
      if (card === undefined || card.worktree?.path == null) {
        return yield* notFound("The card has no worktree.");
      }
      const workerId = card.placedWorkerId ?? board.defaultWorkerId ?? BOARD_LOCAL_WORKER_ID;
      return yield* client.readSetupLog(workerId, card.worktree.path);
    }
  }
});

/**
 * Why a worker can't be a project's pin or default yet: it isn't ready for it (T3O-86).
 * Null when its readiness is ready, or when the worker hasn't reported the project.
 */
export function boardPinReadinessRefusal(
  snapshot: {
    readonly readiness: ReadonlyArray<{
      readonly repositoryKey: string | null;
      readonly state: string;
    }>;
  } | null,
  repositoryKey: string | null,
  workerLabel: string,
): string | null {
  const entry = snapshot?.readiness.find((candidate) => candidate.repositoryKey === repositoryKey);
  if (entry === undefined || entry.state === "ready") return null;
  return `${workerLabel} isn't ready for this project yet (${entry.state}). Set it up or re-check it first.`;
}

/** The refusal for a pin command, read off the latest snapshot of its worker. */
export const boardPinRefusal = Effect.fn("BoardCapacityRpc.pinRefusal")(function* (
  cardId: string,
  workerId: BoardWorkerId | null,
) {
  if (workerId === null) return null;
  const client = yield* BoardCapacityClient;
  const engine = yield* BoardEngine;
  const threads = yield* ThreadGateway;
  const board = (yield* engine.getReadModel).board ?? EMPTY_BOARD_STATE;
  const card = board.cards.find((candidate) => candidate.id === cardId);
  if (card === undefined) return null;
  const project = yield* threads.project(card.projectId).pipe(Effect.orElseSucceed(() => null));
  const label =
    workerId === BOARD_LOCAL_WORKER_ID
      ? "This server"
      : ((board.workers ?? []).find((worker) => worker.id === workerId)?.label ?? workerId);
  return boardPinReadinessRefusal(
    yield* client.latest(workerId),
    boardRepositoryGroupingKey(project?.repositoryIdentity),
    label,
  );
});
