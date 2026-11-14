/**
 * Everything the board adds to the server, as one layer. `EventSinkV2` must be upstream's
 * own instance (the gateway subscribes to its live stream), so the seam provides
 * `RuntimeLayer.layerEventSink`, the same layer value the orchestrator is built from.
 */
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import { layer as BoardPullRequestGatewayLive } from "./BoardPullRequestGateway.ts";
import { BoardCapacityClientLive } from "./capacity/BoardCapacityClient.ts";
import { BoardActualsMeterLive } from "./actuals/BoardActualsMeter.ts";
import { BoardActualsRecorderLive } from "./actuals/BoardActualsRecorder.ts";
import { BoardMeasuredCiRunnerLive } from "./actuals/measuredCiRunner.ts";
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
import { BoardUsagePricingLive } from "./ports/BoardUsagePricing.live.ts";
import { BoardUsageRecorder, BoardUsageRecorderLive } from "./usage/BoardUsageRecorder.ts";
import { BoardRelayStoreLive } from "./workers/BoardRelayStore.ts";
import { BoardCardMoverLive } from "./workers/BoardCardMove.ts";
import { BoardPlacementLive } from "./workers/BoardPlacement.ts";
import { BoardWorkersLive } from "./workers/BoardWorkers.ts";
import { McpRelayHostLive } from "./workers/McpRelayHost.ts";
import { WorkerConnectionsLive } from "./workers/WorkerConnections.ts";
import { WorkerGatewayHostLive } from "./workers/WorkerGatewayHost.ts";
import { BoardWorkerCapacityLive } from "./capacity/BoardWorkerCapacityLive.ts";
import { WorkerSignalFeedLive } from "./workers/WorkerSignalFeed.ts";
import { WorkerSnapshotStoreLive } from "./workers/WorkerSnapshotStore.ts";
import { WorkerTransportLive } from "./workers/WorkerTransport.ts";
import { BoardWorkspacesLive } from "./workspace/workspaceLayer.ts";
import { BoardTunnelHostLive } from "./tunnel/BoardTunnelHost.ts";
import { BoardTunnelSeamLive, BoardWorkerJoinLive } from "./tunnel/BoardWorkerJoin.ts";
import { BoardWorkerJoinStoreLive } from "./tunnel/BoardWorkerJoinStore.ts";
import { WorkerTunnelsLive } from "./tunnel/WorkerTunnels.ts";

/** The central server's connections to its workers, each over that worker's
    outbound tunnel (T3O-84). */
const WorkerConnectionsServerLive = WorkerConnectionsLive.pipe(
  Layer.provideMerge(BoardTunnelHostLive),
  Layer.provideMerge(BoardWorkerJoinStoreLive),
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
  // T3o: worker-owned capacity, which the gateway host answers claims from (T3O-86).
  Layer.provideMerge(BoardWorkerCapacityLive),
  // T3o: every heavy step's measured actuals, and the CI runner that measures its passes
  // (T3O-87). Provided here so the gateway host, setup and the supervisor all capture them.
  Layer.provideMerge(BoardMeasuredCiRunnerLive),
  Layer.provideMerge(BoardActualsMeterLive),
  Layer.provideMerge(McpRelayHostLive),
  Layer.provideMerge(BoardRelayStoreLive),
  Layer.provideMerge(WorkerConnectionsServerLive),
  // Prices each finished turn for the card it ran on, local or relayed (T3O-77).
  Layer.provideMerge(BoardUsageRecorderLive.pipe(Layer.provide(BoardUsagePricingLive))),
  Layer.provideMerge(LocalThreadGatewayV2Live),
);

// The relay answers board tool calls with the same handlers `/mcp` runs, and
// they reach the supervisor, so it sits on top.
export const BoardServerLive = BoardMcpRelayClientLive.pipe(
  // The worker side: this server's tunnels to the boards it works for (T3O-84).
  Layer.provideMerge(WorkerTunnelsLive),
  // Routes the HTTP seam's tunnel, join and proxy paths here.
  Layer.provideMerge(BoardTunnelSeamLive),
  // Board code reaches upstream services through ports; the adapters
  // live here so the upstream requirement still flows up to `server.ts`.
  Layer.provideMerge(SupervisorReactorLive.pipe(Layer.provide(BoardSetupScriptRunnerLive))),
  // T3o: stores each heavy step's actuals and learns each project's baseline (T3O-87).
  Layer.provideMerge(BoardActualsRecorderLive),
  // Webhook scheduled tasks reach the board through the runner this registers.
  Layer.provideMerge(BoardWebhookActionsLive),
  // Moving a card to another worker, for the Move dialog's RPCs.
  Layer.provideMerge(BoardCardMoverLive),
  // T3o: the board's side of worker-owned capacity, which replaced its concurrency slots
  // (T3O-86).
  Layer.provideMerge(BoardCapacityClientLive),
  // T3o.json import/export from this server's checkout, for the
  // project config RPCs.
  Layer.provideMerge(BoardProjectFileLive),
  // The workers' state placement gates a step on.
  Layer.provideMerge(BoardPlacementLive),
  Layer.provideMerge(BoardWorkersLive),
  // Join codes and the join endpoint.
  Layer.provideMerge(BoardWorkerJoinLive),
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
).pipe(
  // The one-time usage backfill (T3O-77) runs beside the board, never ahead of it.
  Effect.andThen(
    Effect.flatMap(Effect.serviceOption(BoardUsageRecorder), (recorder) =>
      Option.isSome(recorder) ? Effect.forkDetach(recorder.value.backfill) : Effect.void,
    ),
  ),
);
