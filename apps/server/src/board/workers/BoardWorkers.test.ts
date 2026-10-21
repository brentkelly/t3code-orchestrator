// @effect-diagnostics nodeBuiltinImport:off - the worker's HTTP endpoints are a real local server.
import * as NodeHttp from "node:http";

import {
  BOARD_LOCAL_WORKER_ID,
  CommandId,
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  type BoardWorkerAddError,
  type BoardWorkerConnectionState,
  type BoardWorkerSetup,
  type ExecutionEnvironmentDescriptor,
} from "@t3tools/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { FetchHttpClient } from "effect/http";
import { TestClock } from "effect/testing";

import { ServerEnvironment } from "../../environment/ServerEnvironment.ts";
import { GitVcsDriver } from "../../vcs/GitVcsDriver.ts";
import { boardStackEngine, makeBoardStackTestLayer } from "../boardStack.testkit.ts";
import { makeBoardWorkers, type BoardWorkersShape } from "./BoardWorkers.ts";
import {
  makeWorkerConnections,
  WorkerConnections,
  workerSecretName,
  type WorkerConnectionsShape,
} from "./WorkerConnections.ts";
import { WorkerRpcError } from "./WorkerTransport.ts";
import { helloFor, makeFakeWorkerLayer, type FakeWorker } from "./workers.testkit.ts";

const BOARD_ENVIRONMENT_ID = EnvironmentId.make("env-board");
const WORKER_ID = EnvironmentId.make("env-linux-box");
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

/** The worker's upstream HTTP endpoints: its descriptor, and a token exchange
    that honours each one-time token once. */
interface WorkerHttp {
  readonly origin: string;
  descriptor: ExecutionEnvironmentDescriptor;
  readonly tokens: Map<string, string>;
  /** Every token exchange the board attempted. */
  readonly exchanges: Array<string>;
}

const withWorkerHttp = Effect.acquireRelease(
  Effect.callback<{ server: NodeHttp.Server; http: WorkerHttp }>((resume) => {
    const http: WorkerHttp = {
      origin: "",
      descriptor: descriptor(WORKER_ID, "linux-box"),
      tokens: new Map(),
      exchanges: [],
    };
    const server = NodeHttp.createServer((request, response) => {
      if (request.url === "/.well-known/t3/environment") {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify(http.descriptor));
        return;
      }
      if (request.url === "/oauth/token" && request.method === "POST") {
        let body = "";
        request.on("data", (chunk) => (body += String(chunk)));
        request.on("end", () => {
          const form = new URLSearchParams(body);
          const token = form.get("subject_token") ?? "";
          http.exchanges.push(`${token}:${form.get("client_label") ?? ""}`);
          const access = http.tokens.get(token);
          if (access === undefined) {
            response.writeHead(400, { "content-type": "application/json" });
            response.end(JSON.stringify({ error: "invalid_grant" }));
            return;
          }
          http.tokens.delete(token);
          response.writeHead(200, { "content-type": "application/json" });
          response.end(
            JSON.stringify({
              access_token: access,
              issued_token_type: "urn:ietf:params:oauth:token-type:access_token",
              token_type: "Bearer",
              expires_in: 2_592_000,
              scope: "orchestration:read orchestration:operate",
            }),
          );
        });
        return;
      }
      response.writeHead(404);
      response.end();
    });
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") return;
      Object.assign(http, { origin: `http://127.0.0.1:${String(address.port)}` });
      resume(Effect.succeed({ server, http }));
    });
  }),
  ({ server }) => Effect.sync(() => server.close()),
).pipe(Effect.map(({ http }) => http));

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
  Layer.provideMerge(FetchHttpClient.layer),
);

let projectCommands = 0;

/** A board with a project, a worker's HTTP endpoints, its scripted
    connection, and the service under test. */
const setup = Effect.gen(function* () {
  const engine = yield* boardStackEngine;
  yield* engine.dispatch({
    type: "project.create",
    commandId: CommandId.make(`cmd-project-${++projectCommands}`),
    projectId: PROJECT_ID,
    title: "app",
    workspaceRoot: "/tmp/app",
    createdAt: t0,
  });
  const http = yield* withWorkerHttp;
  const kit = yield* makeFakeWorkerLayer;
  const worker = yield* kit.fake.add(http.origin, WORKER_ID);
  worker.providers = [
    {
      instanceId: ProviderInstanceId.make("claudeAgent"),
      driver: "claudeAgent",
      displayName: "Claude",
      enabled: true,
      models: [],
    },
  ];
  const connections = yield* makeWorkerConnections.pipe(Effect.provide(kit.layer));
  const workers = yield* makeBoardWorkers.pipe(
    Effect.provideService(WorkerConnections, connections),
    Effect.provide(kit.layer),
  );
  return { http, kit, worker, connections, workers };
});

const waitFor = (
  connections: WorkerConnectionsShape,
  state: BoardWorkerConnectionState,
  workerId = WORKER_ID,
) =>
  connections.states.pipe(
    Stream.filter((runtime) => runtime.get(workerId)?.status.state === state),
    Stream.runHead,
  );

const addWithToken = (
  workers: BoardWorkersShape,
  http: WorkerHttp,
  token = "one-time",
  extra: { readonly expectedEnvironmentId?: EnvironmentId } = {},
) => {
  if (!http.tokens.has(token)) http.tokens.set(token, `access-${token}`);
  return workers.add({
    url: http.origin,
    credential: { kind: "pairing-token", token },
    label: "linux-box",
    ...extra,
  });
};

const addError = <A>(effect: Effect.Effect<A, BoardWorkerAddError>) =>
  Effect.flip(effect).pipe(Effect.map((error) => error.code));

/** Each test on its own board: the stack's database is fresh per build. */
const test = <A, E>(
  name: string,
  body: () => Effect.Effect<A, E, Layer.Success<typeof layer> | Scope.Scope>,
) => it.effect(name, () => Effect.scoped(body()).pipe(Effect.provide(layer)));

describe("BoardWorkers", () => {
  test("adds a worker from a minted token: its own session, stored, registered, dialed", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { http, kit, worker, connections, workers } = yield* setup;
        const result = yield* addWithToken(workers, http);
        assert.strictEqual(result.worker.id, WORKER_ID);
        assert.strictEqual(result.worker.label, "linux-box");
        assert.strictEqual(result.worker.url, http.origin);
        assert.strictEqual(result.totalProjects, 1);
        assert.deepStrictEqual(
          result.worker.snapshot?.providers.map((provider) => provider.instanceId),
          ["claudeAgent"],
        );
        // The board's own session, labelled for the worker's Clients list.
        assert.deepStrictEqual(http.exchanges, ["one-time:T3o board (studio)"]);
        assert.deepStrictEqual([...kit.secrets.secrets.keys()], [workerSecretName(WORKER_ID)]);
        yield* waitFor(connections, "online");
        assert.strictEqual(worker.dialedTokens.at(-1), "access-one-time");
        const state = yield* workers.state;
        assert.deepStrictEqual(
          state.workers.map((entry) => entry.id),
          [WORKER_ID],
        );
      }),
    ));

  test("adds a worker from a pasted pairing link", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { http, workers } = yield* setup;
        http.tokens.set("link-token", "access-link");
        const result = yield* workers.add({
          credential: { kind: "pairing-url", pairingUrl: `${http.origin}/pair#token=link-token` },
          label: "linux-box",
        });
        assert.strictEqual(result.worker.url, http.origin);
        assert.deepStrictEqual(http.exchanges, ["link-token:T3o board (studio)"]);
      }),
    ));

  test("names every way adding a worker fails", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { http, worker, workers } = yield* setup;

        // An expired or used token.
        assert.strictEqual(
          yield* addError(
            workers.add({
              url: http.origin,
              credential: { kind: "pairing-token", token: "expired" },
              label: "linux-box",
            }),
          ),
          "invalid-credential",
        );
        // A link that is not a link.
        assert.strictEqual(
          yield* addError(
            workers.add({
              credential: { kind: "pairing-url", pairingUrl: "not a link" },
              label: "linux-box",
            }),
          ),
          "invalid-credential",
        );
        // Nothing listening: the BOARD server can't reach it.
        assert.strictEqual(
          yield* addError(
            workers.add({
              url: "http://127.0.0.1:9",
              credential: { kind: "pairing-token", token: "t" },
              label: "linux-box",
            }),
          ),
          "unreachable",
        );

        // A different server than the one picked: refused before the one-time
        // token is spent.
        const exchangesBefore = http.exchanges.length;
        assert.strictEqual(
          yield* addError(
            addWithToken(workers, http, "unspent", {
              expectedEnvironmentId: EnvironmentId.make("env-studio-pc"),
            }),
          ),
          "different-server",
        );
        assert.strictEqual(http.exchanges.length, exchangesBefore);
        assert.isTrue(http.tokens.has("unspent"));

        // Below the protocol floor: refused, and its new session handed back.
        worker.hello = { ...helloFor(WORKER_ID, 0), t3oVersion: "0.0.11" };
        const incompatible = yield* Effect.flip(addWithToken(workers, http, "old"));
        assert.strictEqual(incompatible.code, "incompatible");
        assert.strictEqual(incompatible.workerVersion, "0.0.45");
        assert.strictEqual(worker.released, 1);
        worker.hello = helloFor(WORKER_ID);

        // The board server's own link.
        http.descriptor = descriptor(BOARD_ENVIRONMENT_ID, "studio");
        assert.strictEqual(yield* addError(addWithToken(workers, http, "self")), "board-server");
        http.descriptor = descriptor(WORKER_ID, "linux-box");

        // Already a worker.
        yield* addWithToken(workers, http, "first");
        assert.strictEqual(yield* addError(addWithToken(workers, http, "again")), "already-worker");
      }),
    ));

  test("removes a worker: gives the session back, then forgets token and record", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { http, kit, worker, connections, workers } = yield* setup;
        yield* addWithToken(workers, http);
        yield* waitFor(connections, "online");
        const removed = yield* workers.remove(WORKER_ID);
        assert.isTrue(removed.revoked);
        assert.strictEqual(worker.released, 1);
        assert.strictEqual(kit.secrets.secrets.size, 0);
        assert.deepStrictEqual((yield* workers.state).workers, []);
        assert.deepStrictEqual(yield* kit.snapshots.list, []);
      }),
    ));

  test("refuses removing the default worker, and making an offline one the default", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { http, worker, kit, connections, workers } = yield* setup;
        yield* addWithToken(workers, http);
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

  test("re-pairs a revoked worker, keeping its label", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { http, kit, worker, connections, workers } = yield* setup;
        yield* addWithToken(workers, http);
        yield* waitFor(connections, "online");

        // Revoked on the worker: the socket closes, and the redial is refused.
        worker.mode = "unauthorized";
        yield* kit.fake.drop(worker);
        yield* waitFor(connections, "offline");
        yield* TestClock.adjust("1 second");
        yield* waitFor(connections, "unauthorized");

        // A link from another server is refused for this worker.
        http.descriptor = descriptor("env-ci-runner-3", "ci-runner-3");
        http.tokens.set("wrong", "access-wrong");
        const wrong = yield* Effect.flip(
          workers.repair({
            workerId: WORKER_ID,
            credential: { kind: "pairing-token", token: "wrong" },
          }),
        );
        assert.strictEqual(wrong.code, "different-server");
        http.descriptor = descriptor(WORKER_ID, "linux-box");

        worker.mode = "ok";
        http.tokens.set("fresh", "access-fresh");
        const repaired = yield* workers.repair({
          workerId: WORKER_ID,
          credential: { kind: "pairing-token", token: "fresh" },
        });
        assert.strictEqual(repaired.worker.label, "linux-box");
        yield* waitFor(connections, "online");
        assert.strictEqual(worker.dialedTokens.at(-1), "access-fresh");
      }),
    ));

  test("sets a project up on a worker: clones its origin into the projects folder", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { http, worker, connections, workers } = yield* setup;
        yield* addWithToken(workers, http);
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

  test("classifies a failed clone and keeps its log", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { http, worker, connections, workers } = yield* setup;
        yield* addWithToken(workers, http);
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
        const { http, worker, connections, workers } = yield* setup;
        yield* addWithToken(workers, http);
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
        assert.notStrictEqual(second?.projectId, first?.projectId);
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
        const { http, worker, connections, workers } = yield* setup;
        yield* addWithToken(workers, http);
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
        const { http, kit, worker, connections, workers } = yield* setup;
        yield* addWithToken(workers, http);
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
        const { http, kit, worker, connections, workers } = yield* setup;
        yield* addWithToken(workers, http);
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
