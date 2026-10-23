/**
 * Everything the board adds to the server, as one layer (T3O-59): the
 * supervisor and its slots, the board's engine, queries and thread tail, its
 * workers (T3O-62), where each card's git runs (T3O-64), its window onto the
 * forge, worktree retirement, and the v2 thread gateway below them all — on a
 * central server, the router over this server's threads and every worker's
 * (T3O-63). `server.ts` merges it into the runtime with one seam and provides
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
import { BoardMcpRelayClientLive } from "../mcp/toolkits/board/relayClient.ts";
import { ThreadGatewayRouterLive } from "./ThreadGatewayRouter.ts";
import { LocalThreadGatewayV2Live } from "./ThreadGatewayV2.ts";
import { UsageLimitDetectorLive } from "./UsageLimitDetector.ts";
import { WorktreeRetirerLive } from "./worktreeRetire.ts";
import { BoardRelayStoreLive } from "./workers/BoardRelayStore.ts";
import { BoardCardMoverLive } from "./workers/BoardCardMove.ts";
import { BoardPlacementLive } from "./workers/BoardPlacement.ts";
import { BoardWorkersLive } from "./workers/BoardWorkers.ts";
import { McpRelayHostLive } from "./workers/McpRelayHost.ts";
import { WorkerConnectionsLive } from "./workers/WorkerConnections.ts";
import { WorkerGatewayHostLive } from "./workers/WorkerGatewayHost.ts";
import { WorkerSignalFeedLive } from "./workers/WorkerSignalFeed.ts";
import { WorkerSnapshotStoreLive } from "./workers/WorkerSnapshotStore.ts";
import { WorkerTransportLive } from "./workers/WorkerTransport.ts";
import { BoardWorkspacesLive } from "./workspace/workspaceLayer.ts";

/** The central server's connections to its workers (T3O-62, D19). */
const WorkerConnectionsServerLive = WorkerConnectionsLive.pipe(
  Layer.provideMerge(WorkerTransportLive),
  Layer.provide(WorkerSnapshotStoreLive),
);

/**
 * The board's threads (T3O-63): `ThreadGateway` routes between this server's
 * own threads and every worker's, and merges their signals. Beside it, the
 * worker side every T3o server runs whether or not it hosts a board: its own
 * threads served to a central board, and the relay for board tool calls.
 */
const BoardThreadsLive = ThreadGatewayRouterLive.pipe(
  Layer.provideMerge(WorkerSignalFeedLive),
  Layer.provideMerge(WorkerGatewayHostLive),
  Layer.provideMerge(McpRelayHostLive),
  Layer.provideMerge(BoardRelayStoreLive),
  Layer.provideMerge(WorkerConnectionsServerLive),
  Layer.provideMerge(LocalThreadGatewayV2Live),
);

// The relay answers board tool calls with the same handlers `/mcp` runs, and
// they reach the supervisor, so it sits on top.
export const BoardServerLive = BoardMcpRelayClientLive.pipe(
  Layer.provideMerge(SupervisorReactorLive),
  // T3O-65: moving a card to another worker (D20), for the Move dialog's RPCs.
  Layer.provideMerge(BoardCardMoverLive),
  Layer.provide(BoardStepSlotsLive),
  Layer.provide(UsageLimitDetectorLive),
  // T3O-65: the workers' state placement gates a step on (D20).
  Layer.provideMerge(BoardPlacementLive),
  Layer.provideMerge(BoardWorkersLive),
  // T3O-64: where each card's git and forge work runs (D21) — on the worker
  // the card is placed on, read off the board's engine (T3O-65).
  Layer.provideMerge(BoardWorkspacesLive),
  Layer.provideMerge(BoardRuntimeLive),
  Layer.provideMerge(BoardPullRequestGatewayLive),
  Layer.provideMerge(WorktreeRetirerLive),
  Layer.provideMerge(BoardThreadsLive),
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
