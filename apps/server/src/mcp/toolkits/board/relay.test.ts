/**
 * T3o board MCP toolkit — the relay (T3O-63, D3).
 *
 * The central server runs the real board engine, queries and handlers on a
 * real board database, behind the thread router; the worker is in process
 * (`distributed.testkit.ts`). An agent's call on the worker goes through
 * `relayable` → the worker's relay host → the central server's relay client →
 * the handlers, and back, exactly as it would across the wire.
 */
import {
  BoardCardAttachmentId,
  BoardCardId,
  CommandId,
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  boardCardStepCompletions,
  type BoardMcpRelayRequest,
} from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";

import { BoardEngine } from "../../../board/BoardEngine.ts";
import { makeBoardQueries } from "../../../board/projection.ts";
import { BoardRuntimeLive } from "../../../board/runtimeLayer.ts";
import {
  SupervisorReactor,
  type SupervisorReactorShape,
} from "../../../board/supervisorReactor.ts";
import { ThreadGateway, type ThreadSpawnInput } from "../../../board/ThreadGateway.ts";
import { makeThreadGatewayRouter } from "../../../board/ThreadGatewayRouter.ts";
import { aliveThread, makeFakeThreadGateway } from "../../../board/threadGateway.testkit.ts";
import { BoardRelayStore, BoardRelayStoreLive } from "../../../board/workers/BoardRelayStore.ts";
import {
  CENTRAL_ID,
  makeInProcessWorker,
  registeredWorker,
  REPOSITORY,
  waitOnline,
  WORKER_ID,
} from "../../../board/workers/distributed.testkit.ts";
import { McpRelayHost } from "../../../board/workers/McpRelayHost.ts";
import { makeRemoteThreadGateway } from "../../../board/workers/RemoteThreadGateway.ts";
import { WorkerConnections } from "../../../board/workers/WorkerConnections.ts";
import { emptyWorkerSignalFeed } from "../../../board/workers/WorkerSignalFeed.ts";
import * as ServerConfig from "../../../config.ts";
import { ServerEnvironment } from "../../../environment/ServerEnvironment.ts";
import * as SqlitePersistence from "../../../persistence/Sqlite.ts";
import * as ServerSettings from "../../../serverSettings.ts";
import { McpInvocationContext, type McpInvocationScope } from "../../McpInvocationContext.ts";
import { boardHandlers } from "./handlers.ts";
import { relayable } from "./relay.ts";
import { makeBoardMcpRelayClient } from "./relayClient.ts";

const t0 = "2026-01-01T00:00:00.000Z";
const PROJECT_ID = ProjectId.make("project-1");
const CENTRAL_ROOT = "/home/central/repo";
const CODEX = ProviderInstanceId.make("codex");

/** The central server's database, settings and files. */
const centralBase = Layer.mergeAll(ServerSettings.layerTest(), BoardRelayStoreLive).pipe(
  Layer.provideMerge(SqlitePersistence.layerMemory),
  Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "t3o-relay-central-" })),
  Layer.provideMerge(NodeServices.layer),
);

/** The supervisor is not this suite's subject; the tools here never reach it. */
const supervisorStub = Layer.succeed(SupervisorReactor, {} as SupervisorReactorShape);

/**
 * A central board over one in-process worker. `relay` starts the central
 * server's relay client (absent: no board is connected to the worker).
 */
const setup = (options: { readonly relay?: boolean } = {}) =>
  Effect.gen(function* () {
    const env = yield* makeInProcessWorker();
    const central = yield* makeFakeThreadGateway({
      projects: [
        {
          id: PROJECT_ID,
          title: "repo",
          workspaceRoot: CENTRAL_ROOT,
          deleted: false,
          scripts: [],
          repositoryIdentity: REPOSITORY,
        },
      ],
    });
    yield* env.connections.sync([registeredWorker]);
    yield* waitOnline(env.connections);
    const queries = makeBoardQueries(yield* SqlClient.SqlClient);
    const fileSystem = yield* FileSystem.FileSystem;
    const crypto = yield* Crypto.Crypto;
    const router = makeThreadGatewayRouter({
      local: central.gateway,
      connections: env.connections,
      feed: emptyWorkerSignalFeed,
      linkedWorker: queries.boardThreadWorker,
      remote: (workerId) =>
        makeRemoteThreadGateway({
          workerId,
          connections: env.connections,
          local: central.gateway,
          centralEnvironmentId: CENTRAL_ID,
          fileSystem,
          crypto,
        }),
    });
    const runtime = yield* Layer.build(
      BoardRuntimeLive.pipe(
        Layer.provideMerge(
          Layer.mergeAll(
            Layer.succeed(ThreadGateway, router),
            Layer.succeed(WorkerConnections, env.connections),
            Layer.succeed(ServerEnvironment, {
              getEnvironmentId: Effect.succeed(CENTRAL_ID),
              getDescriptor: Effect.die("unused"),
            }),
            supervisorStub,
          ),
        ),
      ),
    );
    const relayClient = yield* makeBoardMcpRelayClient.pipe(Effect.provide(runtime));
    if (options.relay !== false) {
      yield* env.relayHost.connected.pipe(
        Stream.filter((boards) => boards.has(CENTRAL_ID)),
        Stream.runHead,
      );
    }
    return { ...env, router, runtime, relayClient };
  });

type Setup = Effect.Success<ReturnType<typeof setup>>;

/** Put a card on the board and a live thread for it on the worker. */
const seedCard = Effect.fn("seedCard")(function* (
  world: Setup,
  input: {
    readonly cardId: BoardCardId;
    readonly threadId: ThreadId;
    readonly linkedTo?: "worker" | "local";
  },
) {
  const engine = yield* BoardEngine;
  yield* engine.dispatch({
    type: "board.card.create",
    commandId: CommandId.make(`cmd-card-${input.cardId}`),
    cardId: input.cardId,
    projectId: PROJECT_ID,
    title: "A card on the worker",
    orderKey: "m",
    createdAt: t0,
  });
  const spawn: ThreadSpawnInput = {
    commandId: CommandId.make(`server:board-spawn:${input.threadId}`),
    threadId: input.threadId,
    projectId: PROJECT_ID,
    title: "Planning",
    modelSelection: { instanceId: CODEX, model: "gpt-5-codex" },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: CENTRAL_ROOT,
    text: "Plan it.",
    attachments: [],
    workerId: WORKER_ID,
  };
  yield* world.router.spawn(spawn);
  // The agent is mid-turn on the worker.
  yield* Ref.update(world.threads.states, (states) =>
    new Map(states).set(
      input.threadId,
      aliveThread(input.threadId, { activeTurnRef: "run-1", modelSelection: spawn.modelSelection }),
    ),
  );
  yield* engine.dispatch({
    type: "board.card.link-thread",
    commandId: CommandId.make(`cmd-link-${input.threadId}`),
    cardId: input.cardId,
    threadId: input.threadId,
    role: "planning",
    ...(input.linkedTo === "local" ? {} : { workerId: WORKER_ID }),
    createdAt: t0,
  });
  yield* engine.dispatch({
    type: "board.card.select-step",
    commandId: CommandId.make(`cmd-select-${input.cardId}`),
    cardId: input.cardId,
    stepId: "planning",
    stepLabel: "Planning",
    stageLabel: "Planning",
    prompt: "",
    providerInstanceId: CODEX,
    model: "gpt-5-codex",
    mode: "plan",
    runtimeMode: "auto",
    humanInLoop: false,
    maxAttempts: 3,
    timeoutMs: 60_000,
    baseTipAtRoundStart: null,
    createdAt: t0,
  });
});

/** The agent on the worker calling a board tool, through the worker's own
    `/mcp` handler: its scope, its relay host and its relayed-thread registry. */
const onWorker = <A, E, R>(world: Setup, threadId: ThreadId, effect: Effect.Effect<A, E, R>) => {
  const scope: McpInvocationScope = {
    environmentId: WORKER_ID,
    capabilities: new Set(["board"]),
    issuedAt: 0,
    requestNamespace: "sess-1",
    thread: { threadId, providerSessionId: "sess-1", providerInstanceId: CODEX },
    client: undefined,
  };
  return effect.pipe(
    Effect.provideService(McpInvocationContext, scope),
    Effect.provideService(McpRelayHost, world.relayHost),
    Effect.provideService(BoardRelayStore, world.relayStore.store),
    Effect.provideService(ServerConfig.ServerConfig, world.workerConfig),
    Effect.provide(world.runtime),
  );
};

const completeStep = relayable("board_complete_step", boardHandlers.board_complete_step);
const getContext = relayable("board_get_card_context", boardHandlers.board_get_card_context);

const inCentral = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(Effect.scoped, Effect.provide(centralBase));

describe("the board MCP relay", () => {
  it.effect("board_complete_step from a relayed thread completes the central card's step", () =>
    inCentral(
      Effect.gen(function* () {
        const world = yield* setup();
        const cardId = BoardCardId.make("card-relay");
        const threadId = ThreadId.make("thread-relay");
        yield* seedCard(world, { cardId, threadId }).pipe(Effect.provide(world.runtime));

        const result = yield* onWorker(
          world,
          threadId,
          completeStep({ stepId: "planning", outcome: "succeeded", summary: "Planned." }),
        );
        assert.strictEqual(result.alreadyCompleted, false);

        const engine = yield* BoardEngine.pipe(Effect.provide(world.runtime));
        const board = (yield* engine.getReadModel).board;
        assert.isNotNull(board);
        if (board === null || board === undefined) return;
        const completions = boardCardStepCompletions(board, cardId);
        assert.deepStrictEqual(
          completions.map((completion) => [completion.stepId, completion.outcome]),
          [["planning", "succeeded"]],
        );
      }),
    ),
  );

  it.effect("refuses a thread whose card does not run on the worker that sent the call", () =>
    inCentral(
      Effect.gen(function* () {
        const world = yield* setup();
        const cardId = BoardCardId.make("card-local");
        const threadId = ThreadId.make("thread-local-link");
        yield* seedCard(world, { cardId, threadId, linkedTo: "local" }).pipe(
          Effect.provide(world.runtime),
        );

        const error = yield* Effect.flip(
          onWorker(
            world,
            threadId,
            completeStep({ stepId: "planning", outcome: "succeeded", summary: "Planned." }),
          ),
        );
        assert.strictEqual(error._tag, "BoardToolError");
        assert.strictEqual(error._tag === "BoardToolError" ? error.code : null, "rejected");
      }),
    ),
  );

  it.effect("applies a call delivered twice under one call id once", () =>
    inCentral(
      Effect.gen(function* () {
        const world = yield* setup();
        const cardId = BoardCardId.make("card-dedupe");
        const threadId = ThreadId.make("thread-dedupe");
        yield* seedCard(world, { cardId, threadId }).pipe(Effect.provide(world.runtime));

        // board_create_card is not idempotent by itself: two runs would make
        // two cards.
        const request: BoardMcpRelayRequest = {
          callId: "relay:call-1",
          toolName: "board_create_card",
          params: { title: "Follow-up" },
          threadId,
          providerSessionId: "sess-1",
          providerInstanceId: CODEX,
          stateDir: world.workerStateDir,
        };
        const first = yield* world.relayClient.answer(WORKER_ID, request);
        const second = yield* world.relayClient.answer(WORKER_ID, request);
        assert.strictEqual(first._tag, "success");
        assert.deepStrictEqual(second, first);

        const engine = yield* BoardEngine.pipe(Effect.provide(world.runtime));
        const titles = ((yield* engine.getReadModel).board?.cards ?? []).map((card) => card.title);
        assert.deepStrictEqual(
          titles.filter((title) => title === "Follow-up"),
          ["Follow-up"],
        );
      }),
    ),
  );

  it.effect("with no board connected, a relayed thread's call is a retryable error", () =>
    inCentral(
      Effect.gen(function* () {
        const world = yield* setup({ relay: false });
        const threadId = ThreadId.make("thread-alone");
        // A thread a board placed here, whose board is not listening.
        yield* world.relayStore.store.recordRelayedThread(threadId, EnvironmentId.make("env-gone"));
        const error = yield* Effect.flip(onWorker(world, threadId, getContext()));
        assert.strictEqual(error._tag, "BoardToolError");
        assert.strictEqual(
          error._tag === "BoardToolError" ? error.code : null,
          "board-unreachable",
        );
      }),
    ),
  );

  it.effect("the card's files are staged on the worker, and the context names them there", () =>
    inCentral(
      Effect.gen(function* () {
        const world = yield* setup();
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const config = yield* ServerConfig.ServerConfig;
        const cardId = BoardCardId.make("card-files");
        const threadId = ThreadId.make("thread-files");
        const engine = yield* BoardEngine.pipe(Effect.provide(world.runtime));
        // The brief's file, on the central server.
        const centralDir = path.join(config.stateDir, "board", "attachments", cardId);
        yield* fs.makeDirectory(centralDir, { recursive: true });
        yield* fs.writeFileString(path.join(centralDir, "brief.md"), "# Brief");

        yield* seedCard(world, { cardId, threadId }).pipe(Effect.provide(world.runtime));
        yield* engine.dispatch({
          type: "board.card.attach",
          commandId: CommandId.make("cmd-attach"),
          cardId,
          attachment: {
            id: BoardCardAttachmentId.make("att-1"),
            name: "brief.md",
            type: "file",
            mimeType: "text/markdown",
            sizeBytes: 7,
            addedAt: t0,
          },
          createdAt: t0,
        });
        // A second thread spawned for the card stages its files first.
        yield* world.router.spawn({
          commandId: CommandId.make("server:board-spawn:files-2"),
          threadId: ThreadId.make("thread-files-2"),
          projectId: PROJECT_ID,
          title: "Planning again",
          modelSelection: { instanceId: CODEX, model: "gpt-5-codex" },
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: CENTRAL_ROOT,
          text: "Plan it.",
          attachments: [],
          workerId: WORKER_ID,
          stageAttachments: {
            cardId,
            files: [{ name: "brief.md", path: path.join(centralDir, "brief.md") }],
          },
        });

        const context = yield* onWorker(world, threadId, getContext());
        const [entry] = context.attachments;
        const expected = path.join(
          world.workerStateDir,
          "board",
          "attachments",
          cardId,
          "brief.md",
        );
        assert.strictEqual(entry?.path, expected);
        assert.strictEqual(yield* fs.readFileString(expected), "# Brief");
      }),
    ),
  );
});
