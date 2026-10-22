/**
 * T3o (T3O-63): the central server driving a worker's threads.
 *
 * The worker is in process (`distributed.testkit.ts`): the real gateway host
 * over an in-memory thread engine, behind the fake transport. The central
 * side is the real router, remote gateway and signal feed — with the feed's
 * cursor in a real board database, so a resume reads what was persisted.
 */
import {
  BoardCardId,
  CommandId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type BoardWorkerId,
} from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import * as Hex from "effect/encoding/Hex";
import * as Base64 from "effect/encoding/Base64";

import * as ServerConfig from "../../config.ts";
import * as SqlitePersistence from "../../persistence/Sqlite.ts";
import { makeThreadGatewayRouter } from "../ThreadGatewayRouter.ts";
import { aliveThread, makeFakeThreadGateway } from "../threadGateway.testkit.ts";
import { UNKNOWN_THREAD_STATE, type ThreadSpawnInput } from "../ThreadGateway.ts";
import { BoardRelayStore, BoardRelayStoreLive } from "./BoardRelayStore.ts";
import {
  CENTRAL_ID,
  makeInProcessWorker,
  redialOnline,
  registeredWorker,
  REPOSITORY,
  waitOffline,
  waitOnline,
  WORKER_ID,
  WORKER_PROJECT_ID,
  WORKER_ROOT,
} from "./distributed.testkit.ts";
import { makeRemoteThreadGateway } from "./RemoteThreadGateway.ts";
import { WorkerConnections } from "./WorkerConnections.ts";
import { makeWorkerSignalFeed } from "./WorkerSignalFeed.ts";

const CENTRAL_PROJECT_ID = ProjectId.make("project-1");
const CENTRAL_ROOT = "/home/central/repo";
/** A board project the worker has no checkout of. */
const OTHER_PROJECT_ID = ProjectId.make("project-2");

/** A real board database, for the feed's cursor and the todo cache. */
const centralDatabase = SqlitePersistence.layerMemory.pipe(
  Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "t3o-central-" })),
  Layer.provideMerge(NodeServices.layer),
);

const spawnInput = (
  threadId: ThreadId,
  extra: Partial<ThreadSpawnInput> = {},
): ThreadSpawnInput => ({
  commandId: CommandId.make(`server:board-spawn:${threadId}`),
  threadId,
  projectId: CENTRAL_PROJECT_ID,
  title: "CARD-1 · Planning",
  modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5-codex" },
  runtimeMode: "full-access",
  interactionMode: "default",
  branch: null,
  worktreePath: CENTRAL_ROOT,
  text: "Plan the card.",
  attachments: [],
  workerId: WORKER_ID,
  ...extra,
});

/** The central server: its own threads, the in-process worker, the feed and
    the router over all of them. */
const setup = (links: ReadonlyMap<string, BoardWorkerId> = new Map()) =>
  Effect.gen(function* () {
    const env = yield* makeInProcessWorker();
    const central = yield* makeFakeThreadGateway({
      projects: [
        {
          id: CENTRAL_PROJECT_ID,
          title: "repo",
          workspaceRoot: CENTRAL_ROOT,
          deleted: false,
          scripts: [],
          repositoryIdentity: REPOSITORY,
        },
        {
          id: OTHER_PROJECT_ID,
          title: "other",
          workspaceRoot: "/home/central/other",
          deleted: false,
          scripts: [],
          repositoryIdentity: { ...REPOSITORY, canonicalKey: "github.com/acme/other" },
        },
      ],
    });
    yield* env.connections.sync([registeredWorker]);
    yield* waitOnline(env.connections);
    const feed = yield* makeWorkerSignalFeed.pipe(
      Effect.provide(Layer.succeed(WorkerConnections, env.connections)),
    );
    const fileSystem = yield* FileSystem.FileSystem;
    const crypto = yield* Crypto.Crypto;
    const router = makeThreadGatewayRouter({
      local: central.gateway,
      connections: env.connections,
      feed,
      linkedWorkers: () =>
        Effect.succeed(
          new Map(
            [...links].map(([threadId, workerId]) => [
              ThreadId.make(threadId),
              { workerId, removed: false },
            ]),
          ),
        ),
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
    return { ...env, central, feed, router };
  });

const turnEnded = (threadId: ThreadId, turnRef: string) =>
  ({
    type: "turn-ended",
    threadId,
    turnRef,
    outcome: "completed",
    errorMessage: null,
  }) as const;

const centralLayer = BoardRelayStoreLive.pipe(Layer.provideMerge(centralDatabase));

/** Each test on a board database of its own: a worker's cursor is durable,
    and one test's must never be the next one's starting point. */
const inCentral = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(Effect.scoped, Effect.provide(centralLayer));

describe("the remote thread gateway", () => {
  it.effect("spawns on the worker in its own checkout and records the board it belongs to", () =>
    inCentral(
      Effect.gen(function* () {
        const { router, threads, relayStore } = yield* setup();
        const threadId = ThreadId.make("thread-spawned");
        yield* router.spawn(spawnInput(threadId));

        const spawn = (yield* threads.calls).find((call) => call.type === "thread.spawn");
        assert.isTrue(spawn?.type === "thread.spawn");
        if (spawn?.type !== "thread.spawn") return;
        assert.strictEqual(spawn.projectId, WORKER_PROJECT_ID);
        assert.strictEqual(spawn.worktreePath, WORKER_ROOT);
        assert.strictEqual(yield* relayStore.store.relayedThreadCentral(threadId), CENTRAL_ID);

        // Read back through the router, in the BOARD's project.
        yield* Ref.update(threads.states, (states) =>
          new Map(states).set(threadId, aliveThread(threadId, { projectId: WORKER_PROJECT_ID })),
        );
        const state = yield* router.threadState(threadId);
        assert.isTrue(state !== null && state !== UNKNOWN_THREAD_STATE);
        if (state === null || state === UNKNOWN_THREAD_STATE) return;
        assert.strictEqual(state.projectId, CENTRAL_PROJECT_ID);
        assert.isTrue(state.alive);
      }),
    ),
  );

  it.effect("refuses a spawn for a project the worker has no checkout of", () =>
    inCentral(
      Effect.gen(function* () {
        const { router, threads } = yield* setup();
        const error = yield* Effect.flip(
          router.spawn(
            spawnInput(ThreadId.make("thread-nowhere"), { projectId: OTHER_PROJECT_ID }),
          ),
        );
        assert.strictEqual(error._tag, "ThreadCommandRefusedError");
        assert.isEmpty(yield* threads.calls);
      }),
    ),
  );

  it.effect("a worker's signals arrive with their position, and the cursor moves with them", () =>
    inCentral(
      Effect.gen(function* () {
        const { router, threads, feed } = yield* setup();
        const signals = yield* feed.subscribeSignals;
        const threadId = ThreadId.make("thread-signals");
        yield* router.spawn(spawnInput(threadId));
        yield* threads.emit(turnEnded(threadId, "run-1"));

        const first = yield* Stream.runHead(signals);
        assert.deepStrictEqual(Option.getOrThrow(first), {
          workerId: WORKER_ID,
          signal: turnEnded(threadId, "run-1"),
        });
        const store = yield* BoardRelayStore;
        assert.strictEqual(yield* store.signalCursor(WORKER_ID), 1);
      }),
    ),
  );

  it.effect("after a dropped connection, the missed signals arrive once, from the cursor", () =>
    inCentral(
      Effect.gen(function* () {
        const { router, threads, feed, kit, worker, connections } = yield* setup();
        const signals = yield* feed.subscribeSignals;
        const threadId = ThreadId.make("thread-resume");
        yield* router.spawn(spawnInput(threadId));
        yield* threads.emit(turnEnded(threadId, "run-1"));
        const delivered: Array<string> = [];
        const collect = (count: number) =>
          signals.pipe(
            Stream.take(count),
            Stream.runForEach((tagged) =>
              Effect.sync(() => {
                if (tagged.signal.type === "turn-ended")
                  delivered.push(tagged.signal.turnRef ?? "");
              }),
            ),
          );
        yield* collect(1);

        // The link drops; two turns end while the board cannot see them.
        yield* kit.fake.drop(worker);
        yield* waitOffline(connections);
        yield* threads.emit(turnEnded(threadId, "run-2"));
        yield* threads.emit(turnEnded(threadId, "run-3"));

        // Redialed: the feed resumes after run-1, and a later turn follows.
        yield* redialOnline(connections);
        yield* collect(2);
        yield* threads.emit(turnEnded(threadId, "run-4"));
        yield* collect(1);
        assert.deepStrictEqual(delivered, ["run-1", "run-2", "run-3", "run-4"]);
        const store = yield* BoardRelayStore;
        assert.strictEqual(yield* store.signalCursor(WORKER_ID), 4);
      }),
    ),
  );

  it.effect("a thread on an unreachable worker is unknown, never gone", () =>
    inCentral(
      Effect.gen(function* () {
        const { router, kit, worker, connections } = yield* setup();
        const threadId = ThreadId.make("thread-offline");
        yield* router.spawn(spawnInput(threadId));
        worker.mode = "unreachable";
        yield* kit.fake.drop(worker);
        yield* waitOffline(connections);

        assert.strictEqual(yield* router.threadState(threadId), UNKNOWN_THREAD_STATE);
        // A command is a typed failure naming the worker, not a refusal.
        const error = yield* Effect.flip(
          router.interrupt({ commandId: CommandId.make("server:board-x:1"), threadId }),
        );
        assert.strictEqual(error._tag, "ThreadCommandFailedError");
        assert.strictEqual(
          (error.cause as { readonly _tag?: string } | undefined)?._tag,
          "WorkerUnavailable",
        );
      }),
    ),
  );

  it.effect("routes each thread to the worker its link names", () =>
    inCentral(
      Effect.gen(function* () {
        const localThread = ThreadId.make("thread-local");
        const remoteThread = ThreadId.make("thread-on-w1");
        const unlinked = ThreadId.make("thread-unlinked");
        const { router, central, threads } = yield* setup(
          new Map<string, BoardWorkerId>([
            [localThread, "local"],
            [remoteThread, WORKER_ID],
          ]),
        );
        const interrupt = (threadId: ThreadId) =>
          router.interrupt({ commandId: CommandId.make(`server:board-x:${threadId}`), threadId });
        yield* interrupt(localThread);
        yield* interrupt(remoteThread);
        yield* interrupt(unlinked);

        const targets = (
          calls: ReadonlyArray<{ readonly type: string; readonly threadId?: ThreadId }>,
        ) => calls.filter((call) => call.type === "thread.interrupt").map((call) => call.threadId);
        assert.deepStrictEqual(targets(yield* central.calls), [localThread, unlinked]);
        assert.deepStrictEqual(targets(yield* threads.calls), [remoteThread]);
      }),
    ),
  );

  it.effect("copies a card's files onto the worker before the thread starts", () =>
    inCentral(
      Effect.gen(function* () {
        const { router, workerStateDir } = yield* setup();
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const source = yield* fs.makeTempDirectoryScoped();
        yield* fs.writeFileString(path.join(source, "brief.md"), "# The brief");
        const cardId = BoardCardId.make("card-staged");
        yield* router.spawn(
          spawnInput(ThreadId.make("thread-staged"), {
            stageAttachments: {
              cardId,
              files: [{ name: "brief.md", path: path.join(source, "brief.md") }],
            },
          }),
        );
        const staged = path.join(workerStateDir, "board", "attachments", cardId, "brief.md");
        assert.strictEqual(yield* fs.readFileString(staged), "# The brief");
      }),
    ),
  );

  it.effect("staging sends only what changed, and drops what the card no longer has", () =>
    inCentral(
      Effect.gen(function* () {
        const { host, workerStateDir } = yield* setup();
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const crypto = yield* Crypto.Crypto;
        const hash = (text: string) =>
          crypto.digest("SHA-256", new TextEncoder().encode(text)).pipe(Effect.map(Hex.encode));
        const file = (name: string, text: string, withContent: boolean) =>
          hash(text).pipe(
            Effect.map((sha256) => ({
              name,
              sha256,
              ...(withContent ? { contentBase64: Base64.encode(text) } : {}),
            })),
          );
        const cardId = "card-hashes";

        const asked = yield* host.stageAttachments({
          cardId,
          files: [yield* file("a.txt", "A", false), yield* file("b.txt", "B", false)],
        });
        assert.deepStrictEqual(asked.needed, ["a.txt", "b.txt"]);
        const sent = yield* host.stageAttachments({
          cardId,
          files: [yield* file("a.txt", "A", true), yield* file("b.txt", "B", true)],
        });
        assert.strictEqual(sent.written, 2);

        // Unchanged: nothing needed. Changed: only that one. Gone: removed.
        const again = yield* host.stageAttachments({
          cardId,
          files: [yield* file("a.txt", "A", false), yield* file("b.txt", "B2", false)],
        });
        assert.deepStrictEqual(again.needed, ["b.txt"]);
        yield* host.stageAttachments({ cardId, files: [yield* file("a.txt", "A", false)] });
        const dir = path.join(workerStateDir, "board", "attachments", cardId);
        assert.deepStrictEqual(yield* fs.readDirectory(dir), ["a.txt"]);
      }),
    ),
  );
});
