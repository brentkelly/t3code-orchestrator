/**
 * T3o (T3O-64): an in-process worker for the workspace suites.
 *
 * `inProcessWorkerGit` answers `WorkerRpc["git"]` by running the worker's
 * real `boardWorker.git.call` handler against a `BoardWorkspacesShape` of the
 * test's choosing, and round-trips every payload, answer and error through the
 * RPC's own schemas — so a remote workspace under test sees exactly what
 * would have crossed the wire. A refusal arrives as the transport delivers
 * one: a `WorkerRpcError` carrying the worker's error as its `cause`.
 *
 * `reachable` is the switch a suite flips to take the worker offline.
 */
import {
  AuthOrchestrationReadScope,
  AuthSessionId,
  AuthSourceControlWriteScope,
  BOARD_WORKER_GIT_CALL_RPCS,
  BOARD_WORKER_GIT_CALL_WS_METHODS,
  EnvironmentId,
  type BoardWorkerGitMethod,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import type { AuthenticatedSession } from "../../auth/EnvironmentAuth.ts";
import { WorkerUnavailable } from "../workers/WorkerConnections.ts";
import { WorkerRpcError, type WorkerRpc } from "../workers/WorkerTransport.ts";
import type { BoardWorkspacesShape } from "./BoardWorkspace.ts";
import { makeRemoteBoardWorkspace } from "./RemoteBoardWorkspace.ts";
import { decodeGitSuccess, encodeGitPayload } from "./gitWire.ts";
import { boardWorkerGitCallRpcHandlers } from "./workerGitRpc.ts";

export const TEST_WORKER_ID = EnvironmentId.make("env-test-worker");

/** The board's own session on a worker: every scope its operations need. */
export const boardSession = (
  scopes: AuthenticatedSession["scopes"] = [
    AuthOrchestrationReadScope,
    AuthSourceControlWriteScope,
  ],
): AuthenticatedSession => ({
  sessionId: AuthSessionId.make("session-board-on-worker"),
  subject: "board",
  method: "bearer-access-token",
  scopes,
});

/** Encode then decode, as the JSON serialisation of the socket would. */
const roundTrip = <S extends Schema.Top>(schema: S, value: unknown) =>
  Schema.encodeUnknownEffect(schema as never)(value).pipe(
    Effect.flatMap((encoded) =>
      Schema.decodeUnknownEffect(schema as never)(
        encoded === undefined ? undefined : JSON.parse(JSON.stringify(encoded)),
      ),
    ),
    Effect.orDie,
  );

export interface InProcessWorker {
  readonly git: WorkerRpc["git"];
  /** Every method the central server called, in order. */
  readonly calls: Array<BoardWorkerGitMethod>;
  /** Flip to false to make the worker unreachable. */
  reachable: boolean;
  /** Methods whose call the connection drops mid-way, as a worker going
      offline during the operation would. */
  readonly dropOn: Set<BoardWorkerGitMethod>;
}

export function makeInProcessWorker(
  workspaces: BoardWorkspacesShape,
  session: AuthenticatedSession = boardSession(),
): InProcessWorker {
  const handle = boardWorkerGitCallRpcHandlers(session, workspaces)[
    BOARD_WORKER_GIT_CALL_WS_METHODS.call
  ];
  const [callRpc] = BOARD_WORKER_GIT_CALL_RPCS;
  const worker: InProcessWorker = {
    calls: [],
    reachable: true,
    dropOn: new Set(),
    git: ((method: BoardWorkerGitMethod, payload: never) =>
      Effect.gen(function* () {
        worker.calls.push(method);
        if (worker.dropOn.has(method)) {
          return yield* new WorkerRpcError({ message: "The connection dropped." });
        }
        const encoded = yield* encodeGitPayload(method, payload).pipe(Effect.orDie);
        const sent = yield* roundTrip(callRpc.payloadSchema, { method, payload: encoded });
        const answer = yield* Effect.exit(handle(sent));
        if (answer._tag === "Failure") {
          const error = answer.cause.reasons.find((reason) => reason._tag === "Fail");
          if (error === undefined) return yield* Effect.die(answer.cause);
          const delivered = yield* roundTrip(callRpc.errorSchema, error.error);
          return yield* new WorkerRpcError({ message: "refused", cause: delivered });
        }
        const received = yield* roundTrip(callRpc.successSchema, answer.value);
        return yield* decodeGitSuccess(method, received).pipe(Effect.orDie);
      })) as WorkerRpc["git"],
  };
  return worker;
}

/** A remote workspace whose worker is `worker`, reached in process. */
export function remoteOver(worker: InProcessWorker, workerId: EnvironmentId = TEST_WORKER_ID) {
  return makeRemoteBoardWorkspace(workerId, {
    get: (id) =>
      worker.reachable
        ? Effect.succeed({ git: worker.git } as unknown as WorkerRpc)
        : Effect.fail(
            new WorkerUnavailable({
              workerId: id,
              state: "offline",
              message: "The worker is offline.",
            }),
          ),
  });
}
