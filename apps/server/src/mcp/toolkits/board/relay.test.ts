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
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";

import { BoardEngine } from "../../../board/BoardEngine.ts";
import { BoardRuntimeLive } from "../../../board/runtimeLayer.ts";
import {
  SupervisorReactor,
  type SupervisorReactorShape,
} from "../../../board/supervisorReactor.ts";
import {
  ThreadGateway,
  UNKNOWN_THREAD_STATE,
  type ThreadSpawnInput,
} from "../../../board/ThreadGateway.ts";
import {
  makeLinkedThreadWorkers,
  makeThreadGatewayRouter,
} from "../../../board/ThreadGatewayRouter.ts";
import { aliveThread, makeFakeThreadGateway } from "../../../board/threadGateway.testkit.ts";
import {
  BoardRelayStore,
  BoardRelayStoreError,
  BoardRelayStoreLive,
} from "../../../board/workers/BoardRelayStore.ts";
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
    const sql = yield* SqlClient.SqlClient;
    const fileSystem = yield* FileSystem.FileSystem;
    const crypto = yield* Crypto.Crypto;
    const router = makeThreadGatewayRouter({
      local: central.gateway,
      connections: env.connections,
      feed: emptyWorkerSignalFeed,
      linkedWorkers: makeLinkedThreadWorkers(sql),
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

  it.effect("refuses a write to a card that runs on another worker", () =>
    inCentral(
      Effect.gen(function* () {
        const world = yield* setup();
        const threadId = ThreadId.make("thread-cross");
        yield* seedCard(world, { cardId: BoardCardId.make("card-own"), threadId }).pipe(
          Effect.provide(world.runtime),
        );
        // Another card, following the default worker: this server.
        const engine = yield* BoardEngine.pipe(Effect.provide(world.runtime));
        const other = BoardCardId.make("card-elsewhere");
        yield* engine.dispatch({
          type: "board.card.create",
          commandId: CommandId.make("cmd-card-elsewhere"),
          cardId: other,
          projectId: PROJECT_ID,
          title: "A card on this server",
          orderKey: "n",
          createdAt: t0,
        });
        const updateCard = relayable("board_update_card", boardHandlers.board_update_card);
        const archiveCard = relayable("board_archive_card", boardHandlers.board_archive_card);

        const refused = yield* Effect.flip(
          onWorker(world, threadId, updateCard({ cardId: other, title: "Renamed" })),
        );
        assert.strictEqual(refused._tag === "BoardToolError" ? refused.code : null, "rejected");
        const archiveRefused = yield* Effect.flip(
          onWorker(world, threadId, archiveCard({ cardId: other })),
        );
        assert.strictEqual(
          archiveRefused._tag === "BoardToolError" ? archiveRefused.code : null,
          "rejected",
        );
        const untouched = (yield* engine.getReadModel).board?.cards.find(
          (card) => card.id === other,
        );
        assert.strictEqual(untouched?.title, "A card on this server");
        assert.isNull(untouched?.archivedAt);

        // Pinned to the calling worker, the same card is the agent's to change.
        yield* engine.dispatch({
          type: "board.worker.register",
          commandId: CommandId.make("cmd-register"),
          mode: "add",
          worker: registeredWorker,
          createdAt: t0,
        });
        yield* engine.dispatch({
          type: "board.card.pin-worker",
          commandId: CommandId.make("cmd-pin"),
          cardId: other,
          workerId: WORKER_ID,
          createdAt: t0,
        });
        yield* onWorker(world, threadId, updateCard({ cardId: other, title: "Renamed" }));
        const renamed = (yield* engine.getReadModel).board?.cards.find((card) => card.id === other);
        assert.strictEqual(renamed?.title, "Renamed");
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

  it.effect("another worker's call under the same call id is not given this one's answer", () =>
    inCentral(
      Effect.gen(function* () {
        const world = yield* setup();
        const cardId = BoardCardId.make("card-replay");
        const threadId = ThreadId.make("thread-replay");
        yield* seedCard(world, { cardId, threadId }).pipe(Effect.provide(world.runtime));
        const request: BoardMcpRelayRequest = {
          callId: "relay:call-replayed",
          toolName: "board_get_card_context",
          params: {},
          threadId,
          providerSessionId: "sess-1",
          providerInstanceId: CODEX,
          stateDir: world.workerStateDir,
        };
        assert.strictEqual((yield* world.relayClient.answer(WORKER_ID, request))._tag, "success");

        // Replayed by a worker the card does not run on: checked afresh, and refused.
        const replayed = yield* world.relayClient.answer(
          EnvironmentId.make("env-other-worker"),
          request,
        );
        assert.strictEqual(replayed._tag === "failure" ? replayed.code : replayed._tag, "rejected");
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
        const error = yield* Effect.flip(onWorker(world, threadId, getContext(undefined)));
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

        const context = yield* onWorker(world, threadId, getContext(undefined));
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
  it.effect("a call whose delivering stream drops mid-run is still answered when redelivered", () =>
    inCentral(
      Effect.gen(function* () {
        const world = yield* setup();
        const cardId = BoardCardId.make("card-interrupt");
        const threadId = ThreadId.make("thread-interrupt");
        yield* seedCard(world, { cardId, threadId }).pipe(Effect.provide(world.runtime));

        // Hold the run at its last step, recording the answer.
        const store = yield* BoardRelayStore;
        const reached = yield* Deferred.make<void>();
        const gate = yield* Deferred.make<void>();
        const relayClient = yield* makeBoardMcpRelayClient.pipe(
          Effect.provide(world.runtime),
          Effect.provideService(BoardRelayStore, {
            ...store,
            recordRelayCall: (...args) =>
              Deferred.succeed(reached, undefined).pipe(
                Effect.andThen(Deferred.await(gate)),
                Effect.andThen(store.recordRelayCall(...args)),
              ),
          }),
        );
        const request: BoardMcpRelayRequest = {
          callId: "relay:call-interrupted",
          toolName: "board_create_card",
          params: { title: "Interrupted" },
          threadId,
          providerSessionId: "sess-1",
          providerInstanceId: CODEX,
          stateDir: world.workerStateDir,
        };
        // The link drops while the call runs: its delivering fiber is
        // interrupted, and the worker sends the call again on the next link.
        const delivering = yield* Effect.forkChild(relayClient.answer(WORKER_ID, request));
        yield* Deferred.await(reached);
        yield* Fiber.interrupt(delivering);
        yield* Deferred.succeed(gate, undefined);
        const redelivered = yield* relayClient.answer(WORKER_ID, request);
        assert.strictEqual(redelivered._tag, "success");

        const engine = yield* BoardEngine.pipe(Effect.provide(world.runtime));
        const titles = ((yield* engine.getReadModel).board?.cards ?? []).map((card) => card.title);
        assert.deepStrictEqual(
          titles.filter((title) => title === "Interrupted"),
          ["Interrupted"],
        );
      }),
    ),
  );

  it.effect("a redelivery whose store lookup races the first run does not run it again", () =>
    inCentral(
      Effect.gen(function* () {
        const world = yield* setup();
        const cardId = BoardCardId.make("card-race");
        const threadId = ThreadId.make("thread-race");
        yield* seedCard(world, { cardId, threadId }).pipe(Effect.provide(world.runtime));

        // The first run is held while it records its answer; a redelivery's
        // lookup reads the store then, and resumes only after that run ends.
        const store = yield* BoardRelayStore;
        const recording = yield* Deferred.make<void>();
        const recordGate = yield* Deferred.make<void>();
        const lookupGate = yield* Deferred.make<void>();
        let lookups = 0;
        const relayClient = yield* makeBoardMcpRelayClient.pipe(
          Effect.provide(world.runtime),
          Effect.provideService(BoardRelayStore, {
            ...store,
            relayCallOutcome: (...args) =>
              store.relayCallOutcome(...args).pipe(
                Effect.tap(() => {
                  lookups += 1;
                  return lookups === 1 ? Effect.void : Deferred.await(lookupGate);
                }),
              ),
            recordRelayCall: (...args) =>
              Deferred.succeed(recording, undefined).pipe(
                Effect.andThen(Deferred.await(recordGate)),
                Effect.andThen(store.recordRelayCall(...args)),
              ),
          }),
        );
        const request: BoardMcpRelayRequest = {
          callId: "relay:call-race",
          toolName: "board_create_card",
          params: { title: "Raced" },
          threadId,
          providerSessionId: "sess-1",
          providerInstanceId: CODEX,
          stateDir: world.workerStateDir,
        };
        const first = yield* Effect.forkChild(relayClient.answer(WORKER_ID, request));
        yield* Deferred.await(recording);
        const redelivered = yield* Effect.forkChild(relayClient.answer(WORKER_ID, request));
        yield* Effect.yieldNow;
        yield* Deferred.succeed(recordGate, undefined);
        const answered = yield* Fiber.join(first);
        yield* Deferred.succeed(lookupGate, undefined);
        assert.deepStrictEqual(yield* Fiber.join(redelivered), answered);

        const engine = yield* BoardEngine.pipe(Effect.provide(world.runtime));
        const titles = ((yield* engine.getReadModel).board?.cards ?? []).map((card) => card.title);
        assert.deepStrictEqual(
          titles.filter((title) => title === "Raced"),
          ["Raced"],
        );
      }),
    ),
  );

  it.effect("an unreachable worker is a retryable answer, not recorded for the call", () =>
    inCentral(
      Effect.gen(function* () {
        const world = yield* setup();
        const cardId = BoardCardId.make("card-blip");
        const threadId = ThreadId.make("thread-blip");
        yield* seedCard(world, { cardId, threadId }).pipe(Effect.provide(world.runtime));

        // The worker cannot be asked about the thread for a moment.
        const blipped = yield* makeBoardMcpRelayClient.pipe(
          Effect.provideService(ThreadGateway, {
            ...world.router,
            threadState: () => Effect.succeed(UNKNOWN_THREAD_STATE),
          }),
          Effect.provide(world.runtime),
        );
        const request: BoardMcpRelayRequest = {
          callId: "relay:call-blip",
          toolName: "board_create_card",
          params: { title: "After the blip" },
          threadId,
          providerSessionId: "sess-1",
          providerInstanceId: CODEX,
          stateDir: world.workerStateDir,
        };
        const during = yield* blipped.answer(WORKER_ID, request);
        assert.deepStrictEqual(
          during._tag === "failure" ? during.code : during._tag,
          "board-unreachable",
        );
        const store = yield* BoardRelayStore;
        assert.isNull(yield* store.relayCallOutcome(WORKER_ID, request.callId));

        // The same call, once the worker answers again, goes through.
        const after = yield* world.relayClient.answer(WORKER_ID, request);
        assert.strictEqual(after._tag, "success");
      }),
    ),
  );

  it.effect("a call whose recorded answer cannot be read is not run again", () =>
    inCentral(
      Effect.gen(function* () {
        const world = yield* setup();
        const cardId = BoardCardId.make("card-unreadable");
        const threadId = ThreadId.make("thread-unreadable");
        yield* seedCard(world, { cardId, threadId }).pipe(Effect.provide(world.runtime));
        const request: BoardMcpRelayRequest = {
          callId: "relay:call-unreadable",
          toolName: "board_create_card",
          params: { title: "Unreadable" },
          threadId,
          providerSessionId: "sess-1",
          providerInstanceId: CODEX,
          stateDir: world.workerStateDir,
        };
        assert.strictEqual((yield* world.relayClient.answer(WORKER_ID, request))._tag, "success");

        // The redelivery cannot read the store, so it cannot know the call ran.
        const store = yield* BoardRelayStore;
        const unreadable = yield* makeBoardMcpRelayClient.pipe(
          Effect.provide(world.runtime),
          Effect.provideService(BoardRelayStore, {
            ...store,
            relayCallOutcome: () =>
              Effect.fail(
                new BoardRelayStoreError({ operation: "relayCallOutcome", cause: "busy" }),
              ),
          }),
        );
        const redelivered = yield* unreadable.answer(WORKER_ID, request);
        assert.strictEqual(
          redelivered._tag === "failure" ? redelivered.code : redelivered._tag,
          "board-unreachable",
        );

        const engine = yield* BoardEngine.pipe(Effect.provide(world.runtime));
        const titles = ((yield* engine.getReadModel).board?.cards ?? []).map((card) => card.title);
        assert.deepStrictEqual(
          titles.filter((title) => title === "Unreadable"),
          ["Unreadable"],
        );
      }),
    ),
  );

  it.effect(
    "a file attached after the spawn is staged on the worker by the next context call",
    () =>
      inCentral(
        Effect.gen(function* () {
          const world = yield* setup();
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const config = yield* ServerConfig.ServerConfig;
          const cardId = BoardCardId.make("card-later");
          const threadId = ThreadId.make("thread-later");
          const engine = yield* BoardEngine.pipe(Effect.provide(world.runtime));
          // The thread is spawned before the card has any files.
          yield* seedCard(world, { cardId, threadId }).pipe(Effect.provide(world.runtime));
          const centralDir = path.join(config.stateDir, "board", "attachments", cardId);
          yield* fs.makeDirectory(centralDir, { recursive: true });
          yield* fs.writeFileString(path.join(centralDir, "later.md"), "# Later");
          yield* engine.dispatch({
            type: "board.card.attach",
            commandId: CommandId.make("cmd-attach-later"),
            cardId,
            attachment: {
              id: BoardCardAttachmentId.make("att-later"),
              name: "later.md",
              type: "file",
              mimeType: "text/markdown",
              sizeBytes: 7,
              addedAt: t0,
            },
            createdAt: t0,
          });

          const context = yield* onWorker(world, threadId, getContext(undefined));
          const [entry] = context.attachments;
          const expected = path.join(
            world.workerStateDir,
            "board",
            "attachments",
            cardId,
            "later.md",
          );
          assert.strictEqual(entry?.path, expected);
          assert.strictEqual(yield* fs.readFileString(expected), "# Later");
        }),
      ),
  );
});
