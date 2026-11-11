/**
 * The real stack on in-memory SQLite with no provider: upstream's v2 engine,
 * the v2 thread gateway, and the board's engine, queries and todo tail. The
 * snapshot facade reads the board from its tables, as a restart boots.
 */
import {
  CommandId,
  EventId,
  isBoardCommand,
  NodeId,
  PlanId,
  ProviderDriverKind,
  ProviderInstanceId,
  type BoardCommand,
  type ModelSelection,
  type OrchestrationV2Command,
  type OrchestrationV2DomainEvent,
  type ProjectId,
  type ProjectScript,
  type ProviderInteractionMode,
  type RuntimeMode,
  type ThreadId,
} from "@t3tools/contracts";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";

import { ServerConfig } from "../config.ts";
import { CodexProviderCapabilitiesV2 } from "../orchestration-v2/Adapters/CodexAdapterV2.ts";
import * as CommandReceiptStore from "../orchestration-v2/CommandReceiptStore.ts";
import * as EventSink from "../orchestration-v2/EventSink.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as ProviderAdapterRegistry from "../orchestration-v2/ProviderAdapterRegistry.ts";
import * as RuntimeLayer from "../orchestration-v2/runtimeLayer.ts";
import * as ProviderReplayHarness from "../orchestration-v2/testkit/ProviderReplayHarness.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ProjectEnrichmentService from "../project/ProjectEnrichmentService.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as WorkspacePaths from "../workspace/WorkspacePaths.ts";
import * as ServerSettings from "../serverSettings.ts";
import { BoardEngine, BoardEngineLive } from "./BoardEngine.ts";
import { BoardQueries, BoardQueriesLive } from "./BoardQueries.ts";
import { makeBoardEventStore } from "./boardEventStore.ts";
import { BoardThreadTail } from "./boardThreadTail.ts";
import type { BoardReadModel } from "./projector.ts";
import { BoardRuntimeLive } from "./runtimeLayer.ts";
import { ThreadGatewayV2Live } from "./ThreadGatewayV2.ts";
import { BoardWorkersLocalOnlyTest } from "./workers/boardWorkers.testkit.ts";

const STACK_PROVIDER_INSTANCE_ID = ProviderInstanceId.make("codex");

/** A provider that is never asked to run anything: no effect worker runs in
    the stack, so every turn stays requested and nothing reaches a session. */
const inertAdapter = {
  instanceId: STACK_PROVIDER_INSTANCE_ID,
  driver: ProviderDriverKind.make("codex"),
  getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
  planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" as const }),
  openSession: () => Effect.die("the board stack runs no provider"),
} as ProviderAdapter.ProviderAdapterV2["Service"];

const layerDatabase = SqlitePersistence.layerMemory;

const EMPTY_ENRICHMENT: ProjectEnrichmentService.ProjectEnrichment = {
  repositoryIdentity: null,
  faviconPath: null,
  repositoryIdentityResolved: true,
};

/** Upstream's v2 engine, thread management, stores and project service. */
const orchestrationStack = (prefix: string) =>
  ThreadManagement.layer.pipe(
    Layer.provideMerge(
      Layer.mergeAll(
        ProjectionStore.layer,
        ProjectStore.layer,
        ProviderReplayHarness.layerWithRegistry(
          { name: prefix },
          ProviderAdapterRegistry.layerFromAdapters([inertAdapter]),
          { databaseLayer: layerDatabase, runEffectWorker: false },
        ),
        RuntimeLayer.layerProjectService.pipe(
          Layer.provide(
            Layer.mergeAll(
              // The stack's project roots are names, not directories.
              Layer.mock(WorkspacePaths.WorkspacePaths)({
                normalizeWorkspaceRoot: (workspaceRoot) => Effect.succeed(workspaceRoot),
              }),
              // Repository identity and favicons are read off a real checkout;
              // the stack's projects have none.
              Layer.mock(ProjectEnrichmentService.ProjectEnrichmentService)({
                peek: () => Effect.succeed(EMPTY_ENRICHMENT),
                request: () => Effect.void,
                getAvailable: () => Effect.succeed(EMPTY_ENRICHMENT),
                invalidate: () => Effect.void,
              }),
            ),
          ),
        ),
      ),
    ),
    Layer.provideMerge(ServerSettings.layerTest()),
    Layer.provideMerge(CommandReceiptStore.layer),
    Layer.provideMerge(layerDatabase),
    Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix })),
    Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
  );

/** The whole stack on in-memory SQLite, board included. */
export const makeBoardStackTestLayer = (prefix: string) =>
  BoardRuntimeLive.pipe(
    Layer.provideMerge(ThreadGatewayV2Live),
    Layer.provideMerge(orchestrationStack(prefix)),
    // A local-only board, for the subscription.
    Layer.provideMerge(BoardWorkersLocalOnlyTest),
  );

/** The same, without the board's tail of upstream's log — for a suite that
    starts its own. */
export const makeBoardStackTestLayerWithoutTail = (prefix: string) =>
  BoardEngineLive.pipe(
    Layer.provideMerge(BoardQueriesLive),
    Layer.provideMerge(ThreadGatewayV2Live),
    Layer.provideMerge(orchestrationStack(prefix)),
  );

/** A project, as the suites create one. */
export interface StackProjectCreate {
  readonly type: "project.create";
  readonly commandId: CommandId;
  readonly projectId: ProjectId;
  readonly title: string;
  readonly workspaceRoot: string;
  readonly defaultModelSelection?: ModelSelection | null;
  readonly scripts?: ReadonlyArray<ProjectScript>;
  readonly createdAt?: string;
}

/** A thread, as the suites create one: an ordinary user-made thread. */
export interface StackThreadCreate {
  readonly type: "thread.create";
  readonly commandId: CommandId;
  readonly threadId: ThreadId;
  readonly projectId: ProjectId;
  readonly title: string;
  readonly modelSelection: ModelSelection;
  readonly runtimeMode: RuntimeMode;
  readonly interactionMode: ProviderInteractionMode;
  readonly branch: string | null;
  readonly worktreePath: string | null;
  readonly createdAt?: string;
}

export type StackCommand =
  | BoardCommand
  | StackProjectCreate
  | StackThreadCreate
  | Exclude<OrchestrationV2Command, { readonly type: "thread.create" }>;

/** Dispatch through the right engine, and read either log. */
export const boardStackEngine = Effect.gen(function* () {
  const boardEngine = yield* BoardEngine;
  const threads = yield* ThreadManagement.ThreadManagementService;
  const projects = yield* ProjectService.ProjectService;
  const eventSink = yield* EventSink.EventSinkV2;
  const sql = yield* SqlClient.SqlClient;
  const boardLog = makeBoardEventStore(sql);

  const dispatch = (command: StackCommand) =>
    Effect.gen(function* () {
      // A board refusal is a suite's to assert on; upstream's are defects here.
      if (isBoardCommand(command)) return yield* boardEngine.dispatch(command);
      switch (command.type) {
        case "project.create": {
          yield* projects
            .create({
              commandId: command.commandId,
              projectId: command.projectId,
              title: command.title,
              workspaceRoot: command.workspaceRoot,
              createWorkspaceRootIfMissing: false,
              ...(command.defaultModelSelection === undefined
                ? {}
                : { defaultModelSelection: command.defaultModelSelection }),
              ...(command.scripts === undefined ? {} : { scripts: command.scripts }),
            })
            .pipe(Effect.orDie);
          return { sequence: yield* eventSink.latestSequence().pipe(Effect.orDie) };
        }
        case "thread.create":
          return yield* threads
            .dispatch({
              type: "thread.create",
              commandId: command.commandId,
              threadId: command.threadId,
              projectId: command.projectId,
              title: command.title,
              modelSelection: command.modelSelection,
              runtimeMode: command.runtimeMode,
              interactionMode: command.interactionMode,
              branch: command.branch,
              worktreePath: command.worktreePath,
              createdBy: "user",
              creationSource: "web",
            })
            .pipe(Effect.orDie);
        default:
          return yield* threads.dispatch(command).pipe(Effect.orDie);
      }
    });

  return {
    boardEngine,
    dispatch,
    /** The newest position in upstream's (v2) event log. */
    latestSequence: eventSink.latestSequence().pipe(Effect.orDie),
    /** Upstream's stored events in `(after, upTo]`, `upTo` defaulting to the
        head when the stream opens. Finite. */
    readEvents: (after: number, upTo?: number) =>
      Stream.unwrap(
        Effect.map(
          upTo === undefined ? eventSink.latestSequence().pipe(Effect.orDie) : Effect.succeed(upTo),
          (end) =>
            after >= end
              ? Stream.empty
              : eventSink.stream({ afterSequence: after }).pipe(
                  Stream.takeUntil((stored) => stored.sequence >= end),
                  Stream.orDie,
                ),
        ),
      ),
    /** Every board event in the board's own log, oldest first. Finite. */
    readBoardEvents: (afterSequence = 0) => boardLog.readFrom(afterSequence),
  };
});

/**
 * The board, REHYDRATED from the board tables — what a server restart boots
 * from — so a suite comparing it with a replay of the log is comparing the two
 * durable forms, not the engine's in-memory copy with itself.
 */
export const boardStackSnapshotQuery = Effect.gen(function* () {
  const boardQueries = yield* BoardQueries;
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  return {
    getCommandReadModel: () =>
      boardQueries
        .loadBoardState()
        .pipe(Effect.map((board): BoardReadModel => (board === null ? {} : { board }))),
    /** What `board.subscribeBoard` opens with. */
    getBoardSnapshot: () => boardQueries.boardShellSnapshot(),
    /** What `board.getArchivedCards` answers. */
    getArchivedBoardCards: () =>
      boardQueries.boardArchivedCards().pipe(Effect.map((cards) => ({ cards }))),
    /** Upstream's thread shells. */
    getShellSnapshot: () => projections.getShellSnapshot({}).pipe(Effect.orDie),
  };
});

/** Wait until the board's tail of upstream's log has applied everything. */
export const drainBoardThreadTail = Effect.gen(function* () {
  const tail = yield* BoardThreadTail;
  yield* tail.drain;
});

const V2_PLAN_STEP_STATUS: Readonly<Record<string, "pending" | "running" | "completed">> = {
  pending: "pending",
  inProgress: "running",
  completed: "completed",
};

/**
 * What a provider writes when its agent updates its todo list: a `plan.updated`
 * event, through the engine's own sink so it projects exactly as a provider's
 * would. Steps take the board's (v1) status names; an unnamed step is dropped.
 */
export const writeStackPlan = (
  threadId: ThreadId,
  planId: string,
  steps: ReadonlyArray<{ readonly step: string; readonly status?: string }>,
  createdAt: string,
) =>
  Effect.gen(function* () {
    const sink = yield* EventSink.EventSinkV2;
    yield* sink
      .write({
        events: [
          {
            type: "plan.updated",
            id: EventId.make(`evt-plan-${planId}-${createdAt}`),
            threadId,
            occurredAt: DateTime.makeUnsafe(createdAt),
            payload: {
              id: PlanId.make(`plan-${planId}`),
              threadId,
              runId: null,
              nodeId: NodeId.make(`node-plan-${planId}`),
              status: "active",
              kind: "todo_list",
              steps: steps
                .filter((entry) => entry.step.trim().length > 0)
                .map((entry, index) => ({
                  id: `${planId}-${index}`,
                  text: entry.step,
                  status: V2_PLAN_STEP_STATUS[entry.status ?? "pending"] ?? "pending",
                })),
            },
          } as unknown as OrchestrationV2DomainEvent,
        ],
      })
      .pipe(Effect.orDie);
  });
