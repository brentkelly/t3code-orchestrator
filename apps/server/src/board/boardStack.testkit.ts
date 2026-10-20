/**
 * The real stack, board included (T3O-56): upstream's v1 engine, projection
 * pipeline and snapshot query on in-memory SQLite, plus the board's own engine,
 * queries and upstream tail on the same connection.
 *
 * `boardStackEngine` and `boardStackSnapshotQuery` are the two facades suites
 * talk to. The engine facade routes a board command to the board engine and
 * anything else to upstream's, exactly as the server's transports do; the
 * snapshot facade puts the board engine's board slice back on the command read
 * model, so a suite asserting on threads and cards together reads one model.
 */
import {
  isBoardCommand,
  type BoardCommand,
  type OrchestrationCommand,
  type OrchestrationReadModel,
} from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { ServerConfig } from "../config.ts";
import { OrchestrationEngineLive } from "../orchestration/Layers/OrchestrationEngine.ts";
import { OrchestrationProjectionPipelineLive } from "../orchestration/Layers/ProjectionPipeline.ts";
import { OrchestrationProjectionSnapshotQueryLive } from "../orchestration/Layers/ProjectionSnapshotQuery.ts";
import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import * as ThreadBackgroundLiveness from "../orchestration/ThreadBackgroundLiveness.ts";
import * as ThreadPlanProgress from "../orchestration/ThreadPlanProgress.ts";
import { OrchestrationCommandReceiptRepositoryLive } from "../persistence/Layers/OrchestrationCommandReceipts.ts";
import { OrchestrationEventStoreLive } from "../persistence/Layers/OrchestrationEventStore.ts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import * as RepositoryIdentityResolver from "../project/RepositoryIdentityResolver.ts";
import { BoardEngine } from "./BoardEngine.ts";
import { BoardQueries } from "./BoardQueries.ts";
import { projectBoardEvent, type BoardReadModel } from "./projector.ts";
import { makeBoardEventStore } from "./boardEventStore.ts";
import { BoardThreadTail } from "./boardThreadTail.ts";
import { BoardRuntimeLive } from "./runtimeLayer.ts";

/** Upstream's engine, pipeline and snapshot query, without persistence. */
const orchestrationStack = Layer.mergeAll(
  OrchestrationEngineLive.pipe(
    Layer.provide(OrchestrationProjectionSnapshotQueryLive),
    Layer.provide(OrchestrationProjectionPipelineLive),
  ),
  OrchestrationProjectionSnapshotQueryLive,
).pipe(
  Layer.provide(ThreadBackgroundLiveness.layer),
  Layer.provide(ThreadPlanProgress.layer),
  Layer.provide(OrchestrationEventStoreLive),
  Layer.provide(OrchestrationCommandReceiptRepositoryLive),
  Layer.provide(RepositoryIdentityResolver.layer),
);

/** The whole stack on in-memory SQLite, board included. */
export const makeBoardStackTestLayer = (prefix: string) =>
  BoardRuntimeLive.pipe(
    Layer.provideMerge(orchestrationStack),
    Layer.provideMerge(SqlitePersistenceMemory),
    Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix })),
    Layer.provideMerge(NodeServices.layer),
  );

/** Dispatch through the right engine, and read either log. */
export const boardStackEngine = Effect.gen(function* () {
  const engine = yield* OrchestrationEngineService;
  const boardEngine = yield* BoardEngine;
  const sql = yield* SqlClient.SqlClient;
  const boardLog = makeBoardEventStore(sql);
  return {
    ...engine,
    boardEngine,
    dispatch: (command: OrchestrationCommand | BoardCommand) =>
      isBoardCommand(command) ? boardEngine.dispatch(command) : engine.dispatch(command),
    /** Every board event in the board's own log, oldest first. Finite. */
    readBoardEvents: (afterSequence = 0) => boardLog.readFrom(afterSequence),
  };
});

/**
 * Upstream's snapshot query, with the board on the command model. The board is
 * REHYDRATED from the board tables — what a server restart boots from — so a
 * suite comparing it with a replay of the log is comparing the two durable
 * forms, not the engine's in-memory copy with itself.
 */
export const boardStackSnapshotQuery = Effect.gen(function* () {
  const snapshotQuery = yield* ProjectionSnapshotQuery;
  const boardQueries = yield* BoardQueries;
  return {
    ...snapshotQuery,
    getCommandReadModel: () =>
      Effect.all([snapshotQuery.getCommandReadModel(), boardQueries.loadBoardState()]).pipe(
        Effect.map(
          ([model, board]): OrchestrationReadModel =>
            board === null ? model : { ...model, board },
        ),
      ),
  };
});

/** The board a from-empty replay of the board log lands on. */
export const replayBoardLog = Effect.gen(function* () {
  const engine = yield* boardStackEngine;
  const events = yield* Stream.runCollect(engine.readBoardEvents());
  let model: BoardReadModel = {};
  for (const event of events) model = yield* projectBoardEvent(model, event);
  return model.board;
});

/** Wait until the board's tail of upstream's log has applied everything. */
export const drainBoardThreadTail = Effect.gen(function* () {
  const tail = yield* BoardThreadTail;
  yield* tail.drain;
});
