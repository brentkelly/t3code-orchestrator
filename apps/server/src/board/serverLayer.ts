/**
 * Everything the board adds to the server, as one layer. `EventSinkV2` must be upstream's
 * own instance (the gateway subscribes to its live stream), so the seam provides
 * `RuntimeLayer.layerEventSink`, the same layer value the orchestrator is built from.
 */
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { layer as BoardPullRequestGatewayLive } from "./BoardPullRequestGateway.ts";
import { BoardStepSlotsLive } from "./BoardStepSlots.ts";
import { BoardProjectFileLive } from "./projectConfig/BoardProjectFile.ts";
import { BoardRuntimeLive } from "./runtimeLayer.ts";
import { SupervisorReactor, SupervisorReactorLive } from "./supervisorReactor.ts";
import { BoardMcpRelayClientLive } from "../mcp/toolkits/board/relayClient.ts";
import { ThreadGatewayRouterLive } from "./ThreadGatewayRouter.ts";
import { LocalThreadGatewayV2Live } from "./ThreadGatewayV2.ts";
import { WorktreeRetirerLive } from "./worktreeRetire.ts";
import { BoardWebhookActionsLive } from "./webhookActions.ts";
import { BoardSetupScriptRunnerLive } from "./ports/BoardSetupScriptRunner.live.ts";
import { BoardTerminalsLive } from "./ports/BoardTerminals.live.ts";
import { BoardGitStatusLive } from "./ports/BoardGitStatus.live.ts";
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

/** The central server's connections to its workers. */
const WorkerConnectionsServerLive = WorkerConnectionsLive.pipe(
  Layer.provideMerge(WorkerTransportLive),
  Layer.provide(WorkerSnapshotStoreLive),
);

/**
 * The board's threads: `ThreadGateway` routes between this server's
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
  // Board code reaches upstream services through ports; the adapters
  // live here so the upstream requirement still flows up to `server.ts`.
  Layer.provideMerge(SupervisorReactorLive.pipe(Layer.provide(BoardSetupScriptRunnerLive))),
  // Webhook scheduled tasks reach the board through the runner this registers.
  Layer.provideMerge(BoardWebhookActionsLive),
  // Moving a card to another worker, for the Move dialog's RPCs.
  Layer.provideMerge(BoardCardMoverLive),
  Layer.provide(BoardStepSlotsLive),
  // T3o.json import/export from this server's checkout, for the
  // project config RPCs.
  Layer.provideMerge(BoardProjectFileLive),
  // The workers' state placement gates a step on.
  Layer.provideMerge(BoardPlacementLive),
  Layer.provideMerge(BoardWorkersLive),
  // Where each card's git and forge work runs — on the worker
  // the card is placed on, read off the board's engine.
  Layer.provideMerge(BoardWorkspacesLive),
  Layer.provideMerge(BoardRuntimeLive),
  Layer.provideMerge(BoardPullRequestGatewayLive.pipe(Layer.provide(BoardGitStatusLive))),
  Layer.provideMerge(WorktreeRetirerLive.pipe(Layer.provide(BoardTerminalsLive))),
  Layer.provideMerge(BoardThreadsLive),
  // A board that cannot build is a server that cannot start; nothing upstream
  // can handle the board's own construction failures.
  Layer.orDie,
);

/** The supervisor's start, for the startup seam in `serverRuntimeStartup.ts`.
    Runs after v2's restart recovery has settled every run the restart killed,
    so the boot reconcile reads a dead step as dead. */
export const startBoardSupervisor = Effect.flatMap(SupervisorReactor, (supervisor) =>
  supervisor.start(),
);
