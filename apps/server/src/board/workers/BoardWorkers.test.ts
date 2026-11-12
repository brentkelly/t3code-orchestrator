import {
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  AuthFilesystemReadScope,
  BOARD_LOCAL_WORKER_ID,
  BoardCardId,
  CommandId,
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  T3O_TUNNEL_PROTOCOL_VERSION,
  ThreadId,
  type BoardWorkerConnectionState,
  type BoardWorkerSetup,
  type ExecutionEnvironmentDescriptor,
} from "@t3tools/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { TestClock } from "effect/testing";

import { ServerEnvironment } from "../../environment/ServerEnvironment.ts";
import { BoardEngine, type BoardEngineShape } from "../BoardEngine.ts";
import { BoardProjectorDecodeError } from "../errors.ts";
import { GitVcsDriver } from "../../vcs/GitVcsDriver.ts";
import {
  boardStackEngine,
  boardStackSnapshotQuery,
  makeBoardStackTestLayer,
} from "../boardStack.testkit.ts";
import { BoardWorkerJoin, makeBoardWorkerJoin, type BoardWorkerJoinShape } from "../tunnel/BoardWorkerJoin.ts";
import {
  BoardWorkerJoinStore,
  hashSecret,
  makeMemoryBoardWorkerJoinStore,
} from "../tunnel/BoardWorkerJoinStore.ts";
import { makeMemoryBoardRelayStore } from "./BoardRelayStore.ts";
import { makeBoardWorkers, type BoardWorkersShape } from "./BoardWorkers.ts";
import {
  encodeWorkerToken,
  makeWorkerConnections,
  WorkerConnections,
  workerSecretName,
  type WorkerConnectionsShape,
} from "./WorkerConnections.ts";
import { WorkerRpcError } from "./WorkerTransport.ts";
import {
  helloFor,
  makeFakeWorkerLayer,
  unsupportedGateway,
  type FakeWorker,
} from "./workers.testkit.ts";

const BOARD_ENVIRONMENT_ID = EnvironmentId.make("env-board");
const WORKER_ID = EnvironmentId.make("env-linux-box");
const WORKER_URL = "http://127.0.0.1:41001";
const PROJECT_ID = ProjectId.make("project-app");
const ORIGIN_URL = "git@github.com:acme/app.git";
const t0 = "2026-10-21T10:00:00.000Z";

const descriptor = (environmentId: string, label: string): ExecutionEnvironmentDescriptor => ({
  environmentId: EnvironmentId.make(environmentId),
  label,
  platform: { os: "linux", arch: "x64" },
  serverVersion: "0.0.45",
  capabilities: { repositoryIdentity: true },
});

const gitStub = Layer.succeed(GitVcsDriver, {
  readConfigValue: (_cwd: string, key: string) =>
    Effect.succeed(key === "remote.origin.url" ? ORIGIN_URL : null),
} as unknown as GitVcsDriver["Service"]);

const environmentStub = Layer.succeed(ServerEnvironment, {
  getEnvironmentId: Effect.succeed(BOARD_ENVIRONMENT_ID),
  getDescriptor: Effect.succeed(descriptor(BOARD_ENVIRONMENT_ID, "studio")),
});

const layer = makeBoardStackTestLayer("t3o-board-workers-").pipe(
  Layer.provideMerge(gitStub),
  Layer.provideMerge(environmentStub),
);

let projectCommands = 0;

/** A board with a project, a worker's scripted connection behind a fake tunnel, the
    join service, and the service under test. `dispatch` stands in front of the board
    engine's, for a dispatch that fails. */
const setupWith = (
  options: {
    readonly dispatch?: (real: BoardEngineShape["dispatch"]) => BoardEngineShape["dispatch"];
  } = {},
) =>
  Effect.gen(function* () {
    const engine = yield* boardStackEngine;
    yield* engine.dispatch({
      type: "project.create",
      commandId: CommandId.make(`cmd-project-${++projectCommands}`),
      projectId: PROJECT_ID,
      title: "app",
      workspaceRoot: "/tmp/app",
      createdAt: t0,
    });
    const kit = yield* makeFakeWorkerLayer;
    const worker = yield* kit.fake.add(WORKER_URL, WORKER_ID);
    worker.providers = [
      {
        instanceId: ProviderInstanceId.make("claudeAgent"),
        driver: "claudeAgent",
        displayName: "Claude",
        enabled: true,
        models: [],
      },
    ];
    const joinStore = yield* makeMemoryBoardWorkerJoinStore;
    const connections = yield* makeWorkerConnections.pipe(Effect.provide(kit.layer));
    const relay = yield* makeMemoryBoardRelayStore;
    const boardEngine = yield* BoardEngine;
    const engineForTest = {
      ...boardEngine,
      dispatch: options.dispatch?.(boardEngine.dispatch) ?? boardEngine.dispatch,
    };
    const join = yield* makeBoardWorkerJoin.pipe(
      Effect.provideService(BoardEngine, engineForTest),
      Effect.provideService(BoardWorkerJoinStore, joinStore),
      Effect.provide(relay.layer.pipe(Layer.provideMerge(kit.layer))),
    );
    const workers = yield* makeBoardWorkers.pipe(
      Effect.provideService(WorkerConnections, connections),
      Effect.provideService(BoardEngine, engineForTest),
      Effect.provideService(BoardWorkerJoin, join),
      Effect.provideService(BoardWorkerJoinStore, joinStore),
      Effect.provide(relay.layer.pipe(Layer.provideMerge(kit.layer))),
    );
    return { kit, worker, connections, workers, relay, join, joinStore };
  });

const setup = setupWith();

const waitFor = (
  connections: WorkerConnectionsShape,
  state: BoardWorkerConnectionState,
  workerId = WORKER_ID,
) =>
  connections.states.pipe(
    Stream.filter((runtime) => runtime.get(workerId)?.status.state === state),
    Stream.runHead,
  );

const joinRequest = (code: string, extra: Record<string, unknown> = {}) => ({
  code,
  environmentId: WORKER_ID,
  label: "linux-box",
  t3oRelease: "t3o0.1.8.3",
  tunnelProtocol: T3O_TUNNEL_PROTOCOL_VERSION,
  ...extra,
});

/**
 * Join the worker with a fresh code, as `t3o-worker join` would, then hand the board its
 * session as the tunnel's hello would. The fake tunnel is ready as soon as it is opened.
 */
const joinWorker = (
  input: {
    readonly workers: BoardWorkersShape;
    readonly join: BoardWorkerJoinShape;
    readonly kit: Effect.Success<typeof makeFakeWorkerLayer>;
    readonly connections: WorkerConnectionsShape;
  },
  token = "access-one-time",
) =>
  Effect.gen(function* () {
    const created = yield* input.workers.createJoinCode;
    const outcome = yield* input.join.join(joinRequest(created.code), "203.0.113.7");
    assert.strictEqual(outcome._tag, "accepted");
    yield* input.kit.secrets.store.set(workerSecretName(WORKER_ID), encodeWorkerToken(token));
    // The engine's registry change reaches the connections through this sync.
    const registry = (yield* (yield* BoardEngine).getReadModel).board?.workers ?? [];
    yield* input.connections.sync(registry);
    return { created, outcome };
  });

/** Each test on its own board: the stack's database is fresh per build. */
const test = <A, E>(
  name: string,
  body: () => Effect.Effect<A, E, Layer.Success<typeof layer> | Scope.Scope>,
) => it.effect(name, () => Effect.scoped(body()).pipe(Effect.provide(layer)));

describe("BoardWorkers", () => {
  test("removes a worker: gives the session back, then forgets token and record", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const context = yield* setup;
        const { kit, worker, connections, workers } = context;
        yield* joinWorker(context);
        yield* waitFor(connections, "online");
        // The session goes back only once the removal has landed.
        const registeredAtRelease: Array<boolean> = [];
        worker.onRelease = workers.state.pipe(
          Effect.map((current) => current.workers.some((entry) => entry.id === WORKER_ID)),
          Effect.flatMap((registered) => Effect.sync(() => registeredAtRelease.push(registered))),
        );
        const removed = yield* workers.remove(WORKER_ID);
        assert.isTrue(removed.revoked);
        assert.deepStrictEqual(registeredAtRelease, [false]);
        assert.strictEqual(worker.released, 1);
        assert.strictEqual(kit.secrets.secrets.size, 0);
        assert.deepStrictEqual((yield* workers.state).workers, []);
        assert.deepStrictEqual(yield* kit.snapshots.list, []);
      }),
    ));

  test("a worker removed and added back reads its signals from its log's head", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const context = yield* setup;
        const { connections, workers, relay } = context;
        yield* joinWorker(context);
        yield* waitFor(connections, "online");
        yield* relay.store.saveSignalCursor(WORKER_ID, 7);

        yield* workers.remove(WORKER_ID);
        assert.isNull(yield* relay.store.signalCursor(WORKER_ID));

        // A cursor left behind (a crash between the removal and forgetting
        // it) doesn't survive adding the worker back either.
        yield* relay.store.saveSignalCursor(WORKER_ID, 7);
        yield* joinWorker(context, "access-again");
        assert.isNull(yield* relay.store.signalCursor(WORKER_ID));
      }),
    ));

  test("removal previews and applies D22: default fallback, holds, and a stopped step", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const context = yield* setup;
        const { worker, connections, workers } = context;
        const engine = yield* boardStackEngine;
        // The gateway is bound to each link as it is made.
        const stopped: Array<string> = [];
        worker.gateway = {
          ...unsupportedGateway,
          stopSession: (input) => Effect.sync(() => void stopped.push(input.threadId)),
        };
        yield* joinWorker(context);
        yield* waitFor(connections, "online");
        const create = (id: string, title: string) =>
          engine.dispatch({
            type: "board.card.create",
            commandId: CommandId.make(`cmd-create-${id}`),
            cardId: BoardCardId.make(id),
            projectId: PROJECT_ID,
            title,
            orderKey: `m-${id}`,
            pinnedWorkerId: WORKER_ID,
            createdAt: t0,
          });
        // Pinned there, nothing on it yet.
        yield* create("card-idle", "Stream build logs");
        // A step running there.
        yield* create("card-busy", "Typed IPC boundaries");
        const busy = BoardCardId.make("card-busy");
        const threadId = ThreadId.make("thread-busy");
        // Its worktree is cut on the worker it is pinned to.
        yield* engine.dispatch({
          type: "board.card.provision-worktree",
          commandId: CommandId.make("cmd-provision"),
          cardId: busy,
          branch: "board/card-busy",
          baseRefName: "main",
          createdAt: t0,
        });
        yield* engine.dispatch({
          type: "board.card.record-worktree",
          commandId: CommandId.make("cmd-record"),
          cardId: busy,
          path: "/home/linux-box/worktrees/card-busy",
          createdAt: t0,
        });
        yield* engine.dispatch({
          type: "board.card.select-step",
          commandId: CommandId.make("cmd-select"),
          cardId: busy,
          stepId: "build",
          stepLabel: "Build",
          stageLabel: "Building",
          prompt: "build it",
          providerInstanceId: ProviderInstanceId.make("claudeAgent"),
          model: "claude",
          mode: "build",
          runtimeMode: "auto",
          humanInLoop: false,
          maxAttempts: 3,
          timeoutMs: 60_000,
          baseTipAtRoundStart: null,
          createdAt: t0,
        });
        yield* engine.dispatch({
          type: "board.card.admit-step",
          commandId: CommandId.make("cmd-admit"),
          cardId: busy,
          stepId: "build",
          admitted: true,
          threadId,
          createdAt: t0,
        });

        const preview = yield* workers.removePreview(WORKER_ID);
        assert.strictEqual(preview.workerLabel, "linux-box");
        assert.strictEqual(preview.defaultWorkerLabel, "This server (local)");
        assert.deepStrictEqual(
          preview.toDefault.map((card) => [card.cardId, card.title]),
          [["card-idle", "Stream build logs"]],
        );
        assert.deepStrictEqual(
          preview.byHand.map((card) => [card.cardId, card.detail, card.running]),
          [["card-busy", "Build step running", true]],
        );
        assert.isFalse(preview.toDefault[0]?.running);

        const removed = yield* workers.remove(WORKER_ID);
        assert.isTrue(removed.revoked);
        // The running step was stopped on the worker, which still answered.
        assert.deepStrictEqual(stopped, ["thread-busy"]);
        // Read back from the board's tables, as a restart would load it.
        const board = (yield* (yield* boardStackSnapshotQuery).getCommandReadModel()).board!;
        const idle = board.cards.find((card) => card.id === "card-idle")!;
        assert.isNull(idle.pinnedWorkerId);
        assert.isNull(idle.placementOrphaned);
        const held = board.cards.find((card) => card.id === busy)!;
        assert.strictEqual(held.placementOrphaned?.workerId, WORKER_ID);
        assert.strictEqual(held.placementOrphaned?.workerLabel, "linux-box");
      }),
    ));

  test("a removal preview with nothing there, and none for the default worker", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const context = yield* setup;
        const { connections, workers } = context;
        yield* joinWorker(context);
        yield* waitFor(connections, "online");
        const preview = yield* workers.removePreview(WORKER_ID);
        assert.deepStrictEqual([preview.toDefault, preview.byHand], [[], []]);
        yield* workers.setDefault(WORKER_ID);
        const refusal = yield* Effect.flip(workers.removePreview(WORKER_ID));
        assert.strictEqual(refusal.code, "is-default");
      }),
    ));

  test("refuses removing the default worker, and making an offline one the default", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const context = yield* setup;
        const { worker, kit, connections, workers } = context;
        yield* joinWorker(context);
        yield* waitFor(connections, "online");
        yield* workers.setDefault(WORKER_ID);
        assert.strictEqual((yield* workers.state).defaultWorkerId, WORKER_ID);
        const refusal = yield* Effect.flip(workers.remove(WORKER_ID));
        assert.strictEqual(refusal.code, "is-default");
        assert.strictEqual(refusal.message, "Make another worker the default first.");

        yield* workers.setDefault(BOARD_LOCAL_WORKER_ID);
        worker.mode = "unreachable";
        yield* kit.fake.drop(worker);
        yield* waitFor(connections, "offline");
        const offline = yield* Effect.flip(workers.setDefault(WORKER_ID));
        assert.strictEqual(offline.code, "not-online");
      }),
    ));

  test("sets a project up on a worker: clones its origin into the projects folder", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const context = yield* setup;
        const { worker, connections, workers } = context;
        yield* joinWorker(context);
        yield* waitFor(connections, "online");

        const started = yield* workers.setupProject({ projectId: PROJECT_ID, workerId: WORKER_ID });
        assert.strictEqual(started.phase, "cloning");
        assert.strictEqual(started.destinationPath, "~/projects/app");
        const [start] = worker.cloneStarts;
        assert.strictEqual(start?.remoteUrl, ORIGIN_URL);
        assert.strictEqual(start?.destinationPath, "~/projects/app");
        assert.strictEqual(start?.title, "app");

        yield* reportClone(worker, start!.projectId, {
          phase: "running",
          stage: "receiving",
          percent: 40,
        });
        yield* waitForSetup(workers, (setup) => setup.percent === 40);
        yield* reportClone(worker, start!.projectId, {
          phase: "done",
          stage: "checkout",
          percent: 100,
        });
        const done = yield* waitForSetup(workers, (setup) => setup.phase === "done");
        assert.isNotNull(done.endedAt);
      }),
    ));

  test("two Set up calls at once for the same project and worker start one clone", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const context = yield* setup;
        const { worker, connections, workers } = context;
        yield* joinWorker(context);
        yield* waitFor(connections, "online");

        // The worker takes a moment to accept the clone.
        const accepted = yield* Deferred.make<void>();
        const accept = worker.startClone;
        worker.startClone = (input) => Deferred.await(accepted).pipe(Effect.andThen(accept(input)));
        const both = yield* Effect.all(
          [
            workers.setupProject({ projectId: PROJECT_ID, workerId: WORKER_ID }),
            workers.setupProject({ projectId: PROJECT_ID, workerId: WORKER_ID }),
          ],
          { concurrency: 2 },
        ).pipe(Effect.forkScoped);
        yield* Effect.yieldNow;
        yield* Deferred.succeed(accepted, undefined);
        const [first, second] = yield* Fiber.join(both);
        assert.strictEqual(worker.cloneStarts.length, 1);
        assert.strictEqual(first.phase, "cloning");
        assert.strictEqual(second.phase, "cloning");
      }),
    ));

  test("a Set up interrupted before the worker answers leaves no stuck clone", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const context = yield* setup;
        const { worker, connections, workers } = context;
        yield* joinWorker(context);
        yield* waitFor(connections, "online");

        // The worker never answers, and the client gives up on the call.
        worker.startClone = () => Effect.never;
        const call = yield* workers
          .setupProject({ projectId: PROJECT_ID, workerId: WORKER_ID })
          .pipe(Effect.forkScoped);
        yield* waitForSetup(workers, (setup) => setup.phase === "cloning");
        yield* Fiber.interrupt(call);
        const left = yield* waitForSetup(workers, (setup) => setup.phase !== "cloning");
        assert.strictEqual(left.phase, "failed");
        assert.strictEqual(left.failure?.kind, "worker-offline");

        // So a second Set up starts afresh instead of joining a dead one.
        worker.startClone = (input) =>
          Effect.succeed({
            projectId: input.projectId,
            cwd: input.destinationPath,
            remoteUrl: input.remoteUrl ?? "",
            repository: null,
          });
        const again = yield* workers.setupProject({ projectId: PROJECT_ID, workerId: WORKER_ID });
        assert.strictEqual(again.phase, "cloning");
        assert.isNotNull(again.workerProjectId);
      }),
    ));

  test("a Set up abandoned after the worker accepted follows that clone next time", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const context = yield* setup;
        const { worker, connections, workers } = context;
        yield* joinWorker(context);
        yield* waitFor(connections, "online");

        // The worker starts cloning, but its answer never reaches the board.
        const accept = worker.startClone;
        worker.startClone = (input) =>
          reportClone(worker, input.projectId, {
            phase: "running",
            stage: "receiving",
            percent: 10,
          }).pipe(Effect.andThen(Effect.never));
        const call = yield* workers
          .setupProject({ projectId: PROJECT_ID, workerId: WORKER_ID })
          .pipe(Effect.forkScoped);
        yield* waitForSetup(workers, (setup) => setup.phase === "cloning");
        yield* Fiber.interrupt(call);
        yield* waitForSetup(workers, (setup) => setup.phase === "failed");
        worker.startClone = accept;

        // Set up again picks up the running clone rather than starting a
        // second one into the same folder.
        const [first] = worker.cloneStarts;
        const again = yield* workers.setupProject({ projectId: PROJECT_ID, workerId: WORKER_ID });
        assert.strictEqual(again.phase, "cloning");
        assert.strictEqual(again.workerProjectId, first?.projectId);
        assert.strictEqual(worker.cloneStarts.length, 1);
        assert.deepStrictEqual(worker.cloneRetries, []);
        yield* reportClone(worker, first!.projectId, {
          phase: "done",
          stage: "checkout",
          percent: 100,
        });
        yield* waitForSetup(workers, (setup) => setup.phase === "done");
      }),
    ));

  test("a worker that never accepts the clone fails Set up instead of hanging", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const context = yield* setup;
        const { worker, connections, workers } = context;
        yield* joinWorker(context);
        yield* waitFor(connections, "online");

        worker.startClone = () => Effect.never;
        const call = yield* workers
          .setupProject({ projectId: PROJECT_ID, workerId: WORKER_ID })
          .pipe(Effect.forkScoped);
        yield* waitForSetup(workers, (setup) => setup.phase === "cloning");
        yield* TestClock.adjust("30 seconds");
        const result = yield* Fiber.join(call);
        assert.strictEqual(result.phase, "failed");
      }),
    ));

  test("classifies a failed clone and keeps its log", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const context = yield* setup;
        const { worker, connections, workers } = context;
        yield* joinWorker(context);
        yield* waitFor(connections, "online");
        yield* workers.setupProject({
          projectId: PROJECT_ID,
          workerId: WORKER_ID,
          folder: "/srv/code/app",
        });
        const [start] = worker.cloneStarts;
        assert.strictEqual(start?.destinationPath, "/srv/code/app");
        yield* reportClone(worker, start!.projectId, {
          phase: "failed",
          stage: "connecting",
          percent: null,
          error: "git@github.com: Permission denied (publickey).",
        });
        const failed = yield* waitForSetup(workers, (setup) => setup.phase === "failed");
        assert.strictEqual(failed.failure?.kind, "no-credentials");
        assert.include(failed.failure?.log, "Permission denied");

        // Retry clones the same project in place on the worker.
        const retried = yield* workers.setupProject({
          projectId: PROJECT_ID,
          workerId: WORKER_ID,
          folder: "/srv/code/app",
        });
        assert.strictEqual(retried.phase, "cloning");
        assert.deepStrictEqual(worker.cloneRetries, [start!.projectId]);
      }),
    ));

  test("a retry the worker no longer tracks starts a fresh clone instead of hanging", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const context = yield* setup;
        const { worker, connections, workers } = context;
        yield* joinWorker(context);
        yield* waitFor(connections, "online");
        yield* workers.setupProject({ projectId: PROJECT_ID, workerId: WORKER_ID });
        const [first] = worker.cloneStarts;
        yield* reportClone(worker, first!.projectId, {
          phase: "failed",
          stage: "connecting",
          percent: null,
          error: "fatal: unable to access: Could not resolve host: github.com",
        });
        yield* waitForSetup(workers, (setup) => setup.phase === "failed");

        // The worker restarted and forgot the failed clone.
        worker.retryApplied = false;
        yield* SubscriptionRef.set(worker.clones, []);
        const retried = yield* workers.setupProject({ projectId: PROJECT_ID, workerId: WORKER_ID });
        assert.deepStrictEqual(worker.cloneRetries, [first!.projectId]);
        const second = worker.cloneStarts[1];
        assert.isDefined(second);
        assert.strictEqual(second?.projectId, first?.projectId);
        assert.strictEqual(retried.workerProjectId, second?.projectId);

        // Its progress is followed to the end.
        yield* reportClone(worker, second!.projectId, {
          phase: "done",
          stage: "checkout",
          percent: 100,
        });
        yield* waitForSetup(workers, (setup) => setup.phase === "done");
      }),
    ));

  test("a clone the worker refuses to start fails as setup, with its reason", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const context = yield* setup;
        const { worker, connections, workers } = context;
        yield* joinWorker(context);
        yield* waitFor(connections, "online");
        worker.startClone = () =>
          Effect.fail(
            new WorkerRpcError({
              message: "The worker couldn't start the clone.",
              cause: {
                detail:
                  "Destination '/home/dev/projects/app' already exists and is not an empty directory.",
              },
            }),
          );
        const failed = yield* workers.setupProject({ projectId: PROJECT_ID, workerId: WORKER_ID });
        assert.strictEqual(failed.phase, "failed");
        assert.strictEqual(failed.failure?.kind, "folder-exists");
      }),
    ));

  test("a worker going offline mid-clone fails the setup as interrupted", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const context = yield* setup;
        const { kit, worker, connections, workers } = context;
        yield* joinWorker(context);
        yield* waitFor(connections, "online");
        yield* workers.setupProject({ projectId: PROJECT_ID, workerId: WORKER_ID });
        const [start] = worker.cloneStarts;
        yield* reportClone(worker, start!.projectId, {
          phase: "running",
          stage: "receiving",
          percent: 10,
        });
        yield* waitForSetup(workers, (setup) => setup.percent === 10);
        worker.mode = "unreachable";
        yield* kit.fake.drop(worker);
        const failed = yield* waitForSetup(workers, (setup) => setup.phase === "failed");
        assert.strictEqual(failed.failure?.kind, "worker-offline");
      }),
    ));

  test("refuses a project with no remote, and a worker that is not online", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const context = yield* setup;
        const { kit, worker, connections, workers } = context;
        yield* joinWorker(context);
        yield* waitFor(connections, "online");
        worker.mode = "unreachable";
        yield* kit.fake.drop(worker);
        yield* waitFor(connections, "offline");
        const offline = yield* Effect.flip(
          workers.setupProject({ projectId: PROJECT_ID, workerId: WORKER_ID }),
        );
        assert.strictEqual(offline.code, "not-online");
      }),
    ));
});

const reportClone = (
  worker: FakeWorker,
  projectId: ProjectId,
  input: {
    readonly phase: "running" | "done" | "failed" | "cancelled";
    readonly stage: "connecting" | "counting" | "receiving" | "resolving" | "checkout";
    readonly percent: number | null;
    readonly error?: string;
  },
) =>
  SubscriptionRef.set(worker.clones, [
    {
      projectId,
      remoteUrl: ORIGIN_URL,
      destinationPath: "~/projects/app",
      repository: null,
      phase: input.phase,
      stage: input.stage,
      percent: input.percent,
      detail: null,
      error: input.error ?? null,
      startedAt: t0,
      endedAt: input.phase === "running" ? null : t0,
      sequence: 1,
    },
  ]);

/** The board's one setup, once it matches. */
const waitForSetup = (
  workers: BoardWorkersShape,
  predicate: (setup: BoardWorkerSetup) => boolean,
) =>
  workers.states.pipe(
    Stream.map((state) => state.setups[0]),
    Stream.filter((setup): setup is BoardWorkerSetup => setup !== undefined && predicate(setup)),
    Stream.runHead,
    Effect.map(Option.getOrThrow),
  );
