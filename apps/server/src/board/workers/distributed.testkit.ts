/**
 * T3o (T3O-63): an in-process worker for the distributed-board suites.
 *
 * The worker is the real `WorkerGatewayHost` over an in-memory thread gateway
 * of its own, wired into the fake worker transport, so the central server's
 * `WorkerConnections`, `RemoteThreadGateway`, signal feed and MCP relay talk
 * to exactly the code a real worker runs — just without a socket. Dropping
 * the fake link ends every stream the central server holds, as a network
 * blip would.
 */
import {
  EnvironmentId,
  ProjectId,
  type BoardWorker,
  type RepositoryIdentity,
} from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import { TestClock } from "effect/testing";

import * as ServerConfig from "../../config.ts";
import { makeFakeThreadGateway, type FakeThreadGatewayOptions } from "../threadGateway.testkit.ts";
import { makeMemoryBoardRelayStore } from "./BoardRelayStore.ts";
import { makeMcpRelayHost, McpRelayHost } from "./McpRelayHost.ts";
import {
  encodeWorkerToken,
  makeWorkerConnections,
  workerSecretName,
  type WorkerConnectionsShape,
} from "./WorkerConnections.ts";
import { makeWorkerGatewayHost } from "./WorkerGatewayHost.ts";
import { makeFakeWorkerLayer } from "./workers.testkit.ts";

export const CENTRAL_ID = EnvironmentId.make("env-central");
export const WORKER_ID = EnvironmentId.make("env-w1");
export const WORKER_URL = "http://w1:3773";

/** The repository both servers have a checkout of. */
export const REPOSITORY: RepositoryIdentity = {
  canonicalKey: "github.com/acme/repo",
  locator: {
    source: "git-remote",
    remoteName: "origin",
    remoteUrl: "git@github.com:acme/repo.git",
  },
  provider: "github",
  owner: "acme",
  name: "repo",
};

export const WORKER_PROJECT_ID = ProjectId.make("worker-project");
export const WORKER_ROOT = "/home/worker/repo";

export const registeredWorker: BoardWorker = {
  id: WORKER_ID,
  label: "w1",
  url: WORKER_URL,
  addedAt: "2026-10-21T10:00:00.000Z",
};

/**
 * A central server's connections to one in-process worker, online. `stateDir`
 * prefixes the worker's own state directory.
 */
export const makeInProcessWorker = (
  options: {
    readonly relayTimeout?: Duration.Input;
    /** Runs before each call the worker's thread engine takes. */
    readonly onThreadCall?: FakeThreadGatewayOptions["onCall"];
  } = {},
) =>
  Effect.gen(function* () {
    const kit = yield* makeFakeWorkerLayer;
    const threads = yield* makeFakeThreadGateway({
      ...(options.onThreadCall === undefined ? {} : { onCall: options.onThreadCall }),
      projects: [
        {
          id: WORKER_PROJECT_ID,
          title: "repo",
          workspaceRoot: WORKER_ROOT,
          deleted: false,
          scripts: [],
          repositoryIdentity: REPOSITORY,
        },
      ],
    });
    const relayStore = yield* makeMemoryBoardRelayStore;
    const workerServices = Layer.mergeAll(
      threads.localLayer,
      relayStore.layer,
      ServerConfig.layerTest(process.cwd(), { prefix: "t3o-worker-" }),
    ).pipe(Layer.provideMerge(NodeServices.layer));
    // Built once: each build of the config makes a state directory of its own.
    const workerContext = yield* Layer.build(workerServices);
    const relayHost = yield* makeMcpRelayHost(options.relayTimeout).pipe(
      Effect.provide(workerContext),
    );
    const host = yield* makeWorkerGatewayHost.pipe(
      Effect.provideService(McpRelayHost, relayHost),
      Effect.provide(workerContext),
    );
    const workerConfig = yield* ServerConfig.ServerConfig.pipe(Effect.provide(workerContext));
    const worker = yield* kit.fake.add(WORKER_URL, WORKER_ID);
    worker.gateway = host;
    worker.projects = [
      {
        projectId: WORKER_PROJECT_ID,
        title: "repo",
        workspaceRoot: WORKER_ROOT,
        repositoryIdentity: REPOSITORY,
      },
    ];
    yield* kit.secrets.store.set(workerSecretName(WORKER_ID), encodeWorkerToken("token-1"));
    const connections = yield* makeWorkerConnections.pipe(Effect.provide(kit.layer));
    return {
      kit,
      worker,
      threads,
      relayStore,
      relayHost,
      host,
      connections,
      workerConfig,
      workerStateDir: workerConfig.stateDir,
    };
  });

/** Resolve once the worker is online — read atomically with subscribing. */
export const waitOnline = (connections: WorkerConnectionsShape) =>
  connections.states.pipe(
    Stream.filter((runtime) => runtime.get(WORKER_ID)?.status.state === "online"),
    Stream.runHead,
  );

/** Bring a dropped worker back: advance the clock through its redial delay
    until it is online. The redial's sleep may not have started yet when this
    begins, so the clock is moved until the connection says so. */
export const redialOnline = (connections: WorkerConnectionsShape) =>
  Effect.raceFirst(
    waitOnline(connections),
    Effect.forever(TestClock.adjust("1 second").pipe(Effect.andThen(Effect.yieldNow))),
  );

/** Resolve once the worker is no longer online. */
export const waitOffline = (connections: WorkerConnectionsShape) =>
  connections.states.pipe(
    Stream.filter((runtime) => runtime.get(WORKER_ID)?.status.state !== "online"),
    Stream.runHead,
  );
