/**
 * T3o board MCP toolkit — the central server's end of the relay (T3O-63, D3).
 *
 * For every worker with a live connection, holds that worker's relay stream
 * open and answers each board tool call that arrives on it. A call can arrive
 * twice — a stream dropped between the answer and its delivery — so each is
 * answered once by call id: an answer on record is sent again, and a call
 * still running is waited on rather than run a second time.
 */
import type { BoardMcpRelayOutcome, BoardMcpRelayRequest, EnvironmentId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

import { ServerEnvironment } from "../../../environment/ServerEnvironment.ts";
import { BoardRelayStore } from "../../../board/workers/BoardRelayStore.ts";
import { stageCardFilesOnWorker } from "../../../board/workers/RemoteThreadGateway.ts";
import { runPerOnlineWorker } from "../../../board/workers/perOnlineWorker.ts";
import { WorkerConnections } from "../../../board/workers/WorkerConnections.ts";
import { boardHandlers } from "./handlers.ts";
import { McpInvocationContext } from "../../McpInvocationContext.ts";
import { BoardRelayInvocation, runRelayedBoardTool } from "./relay.ts";

type BoardHandlers = typeof boardHandlers;
/** Everything the board tool handlers need, bar the invocation itself, which
    the relay synthesizes per call. */
type BoardHandlerServices = {
  readonly [K in keyof BoardHandlers]: Effect.Services<ReturnType<BoardHandlers[K]>>;
}[keyof BoardHandlers];

export interface BoardMcpRelayClientShape {
  /** Answer one relayed call, once per call id. */
  readonly answer: (
    workerId: EnvironmentId,
    request: BoardMcpRelayRequest,
  ) => Effect.Effect<BoardMcpRelayOutcome>;
}

export class BoardMcpRelayClient extends Context.Service<
  BoardMcpRelayClient,
  BoardMcpRelayClientShape
>()("t3/mcp/toolkits/board/relayClient/BoardMcpRelayClient") {}

export const makeBoardMcpRelayClient = Effect.gen(function* () {
  const connections = yield* WorkerConnections;
  const store = yield* BoardRelayStore;
  const centralEnvironmentId = yield* Effect.flatMap(
    ServerEnvironment,
    (environment) => environment.getEnvironmentId,
  );
  const context =
    yield* Effect.context<
      Exclude<BoardHandlerServices, McpInvocationContext | BoardRelayInvocation>
    >();
  const handlers = Object.fromEntries(
    Object.entries(boardHandlers).map(([name, handle]) => [
      name,
      (params: unknown) =>
        (handle as (params: unknown) => Effect.Effect<unknown, never, BoardHandlerServices>)(
          params,
        ).pipe(Effect.provide(context)),
    ]),
  );
  const fileSystem = yield* FileSystem.FileSystem;
  const crypto = yield* Crypto.Crypto;
  const scope = yield* Effect.scope;
  const inflight = new Map<string, Deferred.Deferred<BoardMcpRelayOutcome>>();

  const stageCardFilesFor =
    (workerId: EnvironmentId): BoardRelayInvocation["Service"]["stageCardFiles"] =>
    (staging) =>
      connections
        .get(workerId)
        .pipe(
          Effect.flatMap((rpc) => stageCardFilesOnWorker({ rpc, fileSystem, crypto, staging })),
        );

  const answer: BoardMcpRelayClientShape["answer"] = (workerId, request) =>
    Effect.gen(function* () {
      const recorded = yield* store
        .relayCallOutcome(request.callId)
        .pipe(Effect.orElseSucceed(() => null));
      if (recorded !== null) return recorded;
      const running = inflight.get(request.callId);
      if (running !== undefined) return yield* Deferred.await(running);
      const done = yield* Deferred.make<BoardMcpRelayOutcome>();
      inflight.set(request.callId, done);
      // The run belongs to this client, not to the stream that delivered the
      // call: a dropped link interrupts the delivering fiber, and the call
      // redelivered on the next link waits on this same run.
      yield* runRelayedBoardTool({
        workerId,
        centralEnvironmentId,
        request,
        handlers: handlers as never,
        stageCardFiles: stageCardFilesFor(workerId),
      }).pipe(
        Effect.provide(context),
        Effect.tap((outcome) =>
          store
            .recordRelayCall(request.callId, workerId, outcome)
            .pipe(
              Effect.catchCause((cause) =>
                Effect.logWarning("board relay: a call's answer was not recorded", { cause }),
              ),
            ),
        ),
        Effect.exit,
        Effect.flatMap((exit) => Deferred.done(done, exit)),
        Effect.ensuring(Effect.sync(() => inflight.delete(request.callId))),
        Effect.forkIn(scope),
      );
      return yield* Deferred.await(done);
    });

  yield* runPerOnlineWorker(connections, "MCP relay", (workerId, rpc) =>
    rpc.gateway.subscribeMcpRelay(centralEnvironmentId).pipe(
      Stream.mapEffect(
        (request) =>
          answer(workerId, request).pipe(
            Effect.flatMap((outcome) =>
              rpc.gateway.mcpRelayRespond({ callId: request.callId, outcome }),
            ),
            // Undelivered: the worker sends the call again on its next stream.
            Effect.catchCause((cause) =>
              Effect.logWarning("board relay: an answer was not delivered", { workerId, cause }),
            ),
          ),
        { concurrency: "unbounded" },
      ),
      Stream.runDrain,
      Effect.catchCause((cause) =>
        Effect.logWarning("board relay: a worker's relay stream ended", { workerId, cause }),
      ),
    ),
  );

  return { answer } satisfies BoardMcpRelayClientShape;
});

export const BoardMcpRelayClientLive = Layer.effect(BoardMcpRelayClient, makeBoardMcpRelayClient);
