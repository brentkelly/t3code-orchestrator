/**
 * What browsers read of worker capacity (T3O-86): the capacity stream the Workers page, the
 * pin picker and a queued card open, and the actions a human takes on readiness and setup.
 */
import {
  boardReadinessIsFor,
  BOARD_LOCAL_WORKER_ID,
  BoardWorkerActionError,
  boardCardBoundWorkerId,
  boardCardHoldsWorktree,
  boardProjectStageConfig,
  boardRepositoryGroupingKey,
  EMPTY_BOARD_STATE,
  resolveBoardProjectResourceSettings,
  type BoardCard,
  type BoardResourceProfile,
  type BoardWorkerCapacityItem,
  type BoardWorkerCapacitySnapshot,
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

/**
 * What this board's own placed cards hold on a worker, from their grants: disk always, CPU and
 * RAM while the grant is heavy or the worker reports a turn running. Mirrors the worker's count.
 */
export function boardCardsHeldOnWorker(
  cards: ReadonlyArray<
    Pick<
      BoardCard,
      "id" | "worktree" | "pinnedWorkerId" | "placedWorkerId" | "archivedAt" | "resources"
    >
  >,
  workerId: BoardWorkerId,
  heavyCards: ReadonlyArray<string>,
): BoardResourceProfile {
  const heavy = new Set(heavyCards);
  let held = { cpuCores: 0, ramGiB: 0, diskGB: 0 };
  for (const card of cards) {
    const grant = card.resources?.grant ?? null;
    if (grant === null || card.archivedAt !== null || !boardCardHoldsWorktree(card)) continue;
    if (boardCardBoundWorkerId(card) !== workerId) continue;
    const counted = grant.heavy || heavy.has(card.id);
    held = {
      cpuCores: held.cpuCores + (counted ? grant.profile.cpuCores : 0),
      ramGiB: held.ramGiB + (counted ? grant.profile.ramGiB : 0),
      diskGB: held.diskGB + grant.profile.diskGB,
    };
  }
  return held;
}

/** Every worker's snapshot now, then each change, with what this board's cards hold there. */
export const boardCapacityStream: Stream.Stream<
  BoardWorkerCapacityItem,
  never,
  BoardCapacityClient | BoardEngine
> = Stream.unwrap(
  Effect.gen(function* () {
    const client = yield* BoardCapacityClient;
    const engine = yield* BoardEngine;
    const item = (workerId: BoardWorkerId, snapshot: BoardWorkerCapacitySnapshot) =>
      engine.getReadModel.pipe(
        Effect.map((model): BoardWorkerCapacityItem => ({
          workerId,
          snapshot,
          held: boardCardsHeldOnWorker(
            (model.board ?? EMPTY_BOARD_STATE).cards,
            workerId,
            snapshot.heavyCards,
          ),
        })),
      );
    const initial = yield* Effect.forEach([...(yield* client.all)], ([workerId, snapshot]) =>
      item(workerId, snapshot),
    );
    const changes = client.changes.pipe(
      Stream.mapEffect((workerId) =>
        client
          .latest(workerId)
          .pipe(
            Effect.flatMap((snapshot) =>
              snapshot === null
                ? Effect.succeed([])
                : Effect.map(item(workerId, snapshot), (one) => [one]),
            ),
          ),
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
      readonly projectId?: string;
      readonly state: string;
    }>;
  } | null,
  repositoryKey: string | null,
  workerLabel: string,
  projectId = "",
): string | null {
  const entry = snapshot?.readiness.find((candidate) =>
    boardReadinessIsFor(candidate, repositoryKey, projectId),
  );
  if (entry === undefined || entry.state === "ready") return null;
  return `${workerLabel} isn't ready for this project yet (${entry.state}). Set it up or re-check it first.`;
}

/** The refusal for a pin (on a card, or at its creation), read off the latest snapshot of
    its worker. */
export const boardPinRefusal = Effect.fn("BoardCapacityRpc.pinRefusal")(function* (
  target: { readonly cardId: string } | { readonly projectId: ProjectId },
  workerId: BoardWorkerId | null | undefined,
) {
  if (workerId == null) return null;
  const client = yield* BoardCapacityClient;
  const engine = yield* BoardEngine;
  const threads = yield* ThreadGateway;
  const board = (yield* engine.getReadModel).board ?? EMPTY_BOARD_STATE;
  const projectId =
    "projectId" in target
      ? target.projectId
      : board.cards.find((candidate) => candidate.id === target.cardId)?.projectId;
  if (projectId === undefined) return null;
  const project = yield* threads.project(projectId).pipe(Effect.orElseSucceed(() => null));
  const label =
    workerId === BOARD_LOCAL_WORKER_ID
      ? "This server"
      : ((board.workers ?? []).find((worker) => worker.id === workerId)?.label ?? workerId);
  return boardPinReadinessRefusal(
    yield* client.latest(workerId),
    boardRepositoryGroupingKey(project?.repositoryIdentity),
    label,
    projectId,
  );
});
