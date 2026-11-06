/**
 * T3o (T3O-64, D21): a worker's named board git and forge operations, run on
 * that worker over the connection the central server holds to it.
 *
 * Each operation is one `boardWorker.git.*` call, answered by the worker's own
 * `LocalBoardWorkspace`. Failures keep the line `BoardWorkspace` draws:
 *
 * - the worker refused or the operation failed there: its `BoardWorkerGitError`,
 *   as is;
 * - the worker has no such call (an older T3o): a `BoardWorkerGitError` saying
 *   so, since waiting will not change it;
 * - the worker is not online, or the connection dropped mid-call:
 *   `WorkerUnavailable`;
 * - anything else (a call or answer that will not decode): a
 *   `BoardWorkerGitError`, so a fault that repeats is never retried as an
 *   outage.
 */
import {
  BOARD_WORKER_GIT_WS_METHODS,
  BoardWorkerGitError,
  type BoardWorkerGitOperation,
  type EnvironmentId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { WorkerUnavailable, type WorkerConnectionsShape } from "../workers/WorkerConnections.ts";
import type { WorkerRpcError } from "../workers/WorkerTransport.ts";
import {
  bindBoardWorkspace,
  reclaimThroughOperations,
  type BoardCardWorkspace,
  type BoardWorkspace,
  type BoardWorkspacePlacement,
  type BoardWorkspaceInput,
  type BoardWorkspaceOperations,
  type BoardWorkspaceFailure,
} from "./BoardWorkspace.ts";

const isGitError = Schema.is(BoardWorkerGitError);

const failureOf =
  (workerId: EnvironmentId, operation: BoardWorkerGitOperation) =>
  (error: WorkerRpcError | WorkerUnavailable): BoardWorkspaceFailure => {
    if (error._tag === "WorkerUnavailable") return error;
    if (isGitError(error.cause)) return error.cause;
    if (error.unsupported === true) {
      return new BoardWorkerGitError({
        operation,
        detail: "This worker's T3o is too old for the board's git operations; update it.",
      });
    }
    const tag = (error.cause as { readonly _tag?: unknown } | undefined)?._tag;
    if (tag === "EnvironmentAuthorizationError") {
      return new BoardWorkerGitError({
        operation,
        detail: "The worker refused the board's session for this operation.",
      });
    }
    if (connectionLost(error.cause)) {
      return new WorkerUnavailable({
        workerId,
        state: "unknown",
        message: `The connection to the worker dropped during ${operation}.`,
      });
    }
    // Anything else — a payload or answer that will not decode, a protocol
    // fault — fails the same way on every retry, so it is not an outage.
    return new BoardWorkerGitError({
      operation,
      detail: `The worker's answer could not be used: ${error.message}`,
    });
  };

/**
 * Whether an RPC failure is the connection going, which a retry may outlive:
 * a socket, HTTP or worker transport failure, or a drop with no cause at all.
 * An `RpcClientDefect` is the client failing to encode or decode the call.
 */
const connectionLost = (cause: unknown): boolean => {
  if (cause === undefined) return true;
  const failure = cause as {
    readonly _tag?: unknown;
    readonly reason?: { readonly _tag?: unknown };
  };
  return failure._tag === "RpcClientError" && failure.reason?._tag !== "RpcClientDefect";
};

export function makeRemoteBoardWorkspace(
  workerId: EnvironmentId,
  connections: Pick<WorkerConnectionsShape, "get">,
): BoardWorkspace {
  const operation =
    <Op extends BoardWorkerGitOperation>(op: Op) =>
    (input: BoardWorkspaceInput<Op>) =>
      connections.get(workerId).pipe(
        Effect.flatMap((rpc) => rpc.git(BOARD_WORKER_GIT_WS_METHODS[op], input)),
        Effect.mapError(failureOf(workerId, op)),
      );
  const operations = Object.fromEntries(
    (Object.keys(BOARD_WORKER_GIT_WS_METHODS) as Array<BoardWorkerGitOperation>).map((op) => [
      op,
      operation(op),
    ]),
  ) as unknown as BoardWorkspaceOperations<BoardWorkspaceFailure>;
  const workspace: BoardWorkspace = {
    ...operations,
    workerId,
    reclaimWorktree: (input, stillWanted) =>
      reclaimThroughOperations(workspace, input, stillWanted),
  };
  return workspace;
}

/**
 * A placed card's workspace on its worker, bound to the worker's checkout.
 * The checkout path comes from the worker's last-known snapshot, so a card on
 * an offline worker still names where its checkout is.
 */
export const remoteCardWorkspace =
  (connections: Pick<WorkerConnectionsShape, "get" | "current">) =>
  (placement: BoardWorkspacePlacement): Effect.Effect<BoardCardWorkspace> =>
    connections.current.pipe(
      Effect.map((runtimes) =>
        bindBoardWorkspace({
          workspace: makeRemoteBoardWorkspace(placement.workerId, connections),
          projectId: placement.projectId,
          checkoutPath:
            runtimes
              .get(placement.workerId)
              ?.snapshot?.checkouts.find((checkout) => checkout.projectId === placement.projectId)
              ?.workspaceRoot ?? null,
        }),
      ),
    );
