/**
 * Everything the board adds to the server, as one layer (T3O-59): the
 * supervisor and its slots, the board's engine, queries and thread tail, its
 * workers (T3O-62), its window onto the forge, worktree retirement, and the v2
 * thread gateway below them all. `server.ts` merges it into the runtime with one seam and provides
 * the upstream services it needs from the same graph.
 *
 * `EventSinkV2` must be upstream's own instance (the gateway subscribes to its
 * live stream), which is why the seam provides `RuntimeLayer.layerEventSink` —
 * the same layer value the orchestrator is built from, so the runtime builds it
 * once.
 */
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { layer as BoardPullRequestGatewayLive } from "./BoardPullRequestGateway.ts";
import { BoardStepSlotsLive } from "./BoardStepSlots.ts";
import { BoardRuntimeLive } from "./runtimeLayer.ts";
import { SupervisorReactor, SupervisorReactorLive } from "./supervisorReactor.ts";
import { ThreadGatewayV2Live } from "./ThreadGatewayV2.ts";
import { UsageLimitDetectorLive } from "./UsageLimitDetector.ts";
import { WorktreeRetirerLive } from "./worktreeRetire.ts";
import { BoardWorkersLive } from "./workers/BoardWorkers.ts";
import { WorkerConnectionsLive } from "./workers/WorkerConnections.ts";
import { WorkerSnapshotStoreLive } from "./workers/WorkerSnapshotStore.ts";
import { WorkerTransportLive } from "./workers/WorkerTransport.ts";

/** The distributed board (T3O-62): worker management over the connections the
    central server holds to each worker. */
const BoardWorkersServerLive = BoardWorkersLive.pipe(
  Layer.provideMerge(WorkerConnectionsLive),
  Layer.provideMerge(WorkerTransportLive),
  Layer.provide(WorkerSnapshotStoreLive),
);

export const BoardServerLive = SupervisorReactorLive.pipe(
  Layer.provide(BoardStepSlotsLive),
  Layer.provide(UsageLimitDetectorLive),
  Layer.provideMerge(BoardWorkersServerLive),
  Layer.provideMerge(BoardRuntimeLive),
  Layer.provideMerge(BoardPullRequestGatewayLive),
  Layer.provideMerge(WorktreeRetirerLive),
  Layer.provideMerge(ThreadGatewayV2Live),
  // A board that cannot build is a server that cannot start; nothing upstream
  // can handle the board's own construction failures.
  Layer.orDie,
);

/** The supervisor's start, for the startup seam in `serverRuntimeStartup.ts`.
    Runs after v2's restart recovery has settled every run the restart killed,
    so the boot reconcile reads a dead step as dead (t3o-10, D3). */
export const startBoardSupervisor = Effect.flatMap(SupervisorReactor, (supervisor) =>
  supervisor.start(),
);
