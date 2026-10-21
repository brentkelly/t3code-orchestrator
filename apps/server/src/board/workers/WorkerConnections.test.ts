import {
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  type BoardWorker,
  type BoardWorkerConnectionState,
} from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { TestClock } from "effect/testing";

import {
  encodeWorkerToken,
  makeWorkerConnections,
  workerSecretName,
  type WorkerConnectionsShape,
} from "./WorkerConnections.ts";
import {
  makeFakeWorkerLayer,
  helloFor,
  SESSION_LIFETIME_MS,
  type FakeWorker,
} from "./workers.testkit.ts";

const WORKER_ID = EnvironmentId.make("env-linux-box");
const URL = "http://linux-box:3773";

const registered: BoardWorker = {
  id: WORKER_ID,
  label: "linux-box",
  url: URL,
  addedAt: "2026-10-21T10:00:00.000Z",
};

/** Resolve once the worker reaches `state` — read atomically with
    subscribing, so a change between the two is never missed. */
const waitFor = (connections: WorkerConnectionsShape, state: BoardWorkerConnectionState) =>
  connections.states.pipe(
    Stream.filter((runtime) => runtime.get(WORKER_ID)?.status.state === state),
    Stream.runHead,
  );

const statusOf = (connections: WorkerConnectionsShape) =>
  connections.current.pipe(Effect.map((runtime) => runtime.get(WORKER_ID)));

/** A connection manager over one scripted worker that has a stored token. */
const setup = (configure?: (worker: FakeWorker) => void) =>
  Effect.gen(function* () {
    const kit = yield* makeFakeWorkerLayer;
    const worker = yield* kit.fake.add(URL, WORKER_ID);
    worker.projects = [
      {
        projectId: ProjectId.make("worker-project"),
        title: "t3code",
        workspaceRoot: "/home/dev/t3code",
        repositoryIdentity: {
          canonicalKey: "github.com/pingdotgg/t3code",
          locator: {
            source: "git-remote",
            remoteName: "upstream",
            remoteUrl: "https://github.com/pingdotgg/t3code.git",
          },
          origin: { canonicalKey: "github.com/brentkelly/t3code" },
        },
      },
    ];
    worker.providers = [
      {
        instanceId: ProviderInstanceId.make("claudeAgent"),
        driver: "claudeAgent",
        displayName: "Claude",
        enabled: true,
        models: [{ slug: "claude-opus-5-5", name: "Opus 5.5" }],
      },
    ];
    configure?.(worker);
    yield* kit.secrets.store.set(workerSecretName(WORKER_ID), encodeWorkerToken("token-1"));
    const connections = yield* makeWorkerConnections.pipe(Effect.provide(kit.layer));
    return { kit, worker, connections };
  });

it.effect("goes online, and reports the worker's providers and checkouts", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { worker, connections } = yield* setup();
      yield* connections.sync([registered]);
      yield* waitFor(connections, "online");
      const runtime = yield* statusOf(connections);
      assert.strictEqual(runtime?.status.t3oVersion, "0.0.45");
      assert.strictEqual(runtime?.status.protocolVersion, 1);
      assert.deepStrictEqual(worker.dialedTokens, ["token-1"]);
      assert.deepStrictEqual(
        runtime?.snapshot?.checkouts.map((checkout) => checkout.repositoryKey),
        ["github.com/brentkelly/t3code"],
      );
      assert.deepStrictEqual(
        runtime?.snapshot?.providers.map((provider) => provider.instanceId),
        ["claudeAgent"],
      );
      const rpc = yield* connections.get(WORKER_ID);
      assert.strictEqual((yield* rpc.hello).environmentId, WORKER_ID);
    }),
  ),
);

it.effect(
  "goes offline when the connection drops, keeps the last-known snapshot, and reconnects",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { kit, worker, connections } = yield* setup();
        yield* connections.sync([registered]);
        yield* waitFor(connections, "online");

        worker.mode = "unreachable";
        yield* kit.fake.drop(worker);
        yield* waitFor(connections, "offline");
        const offline = yield* statusOf(connections);
        assert.isNotNull(offline?.status.lastSeenAt);
        // Offline is never a reason to forget what the worker had.
        assert.strictEqual(offline?.snapshot?.checkouts.length, 1);
        const unavailable = yield* Effect.flip(connections.get(WORKER_ID));
        assert.strictEqual(unavailable.state, "offline");

        // The redial while it is still unreachable keeps it offline...
        yield* TestClock.adjust("1 second");
        assert.strictEqual((yield* statusOf(connections))?.status.state, "offline");
        // ...and the next one, once it is back, brings it online.
        worker.mode = "ok";
        yield* TestClock.adjust("2 seconds");
        yield* waitFor(connections, "online");
        assert.strictEqual(worker.dialedTokens.length, 2);
      }),
    ),
);

it.effect("persists the snapshot, so a fresh manager starts from the last-known one", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { kit, worker, connections } = yield* setup();
      yield* connections.sync([registered]);
      yield* waitFor(connections, "online");

      worker.mode = "unreachable";
      const rebooted = yield* makeWorkerConnections.pipe(Effect.provide(kit.layer));
      yield* rebooted.sync([registered]);
      yield* waitFor(rebooted, "offline");
      const runtime = (yield* rebooted.current).get(WORKER_ID);
      assert.strictEqual(runtime?.snapshot?.checkouts[0]?.title, "t3code");
      assert.strictEqual(runtime?.status.t3oVersion, "0.0.45");
    }),
  ),
);

it.effect("a revoked session is unauthorized and is not redialed until re-paired", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { kit, worker, connections } = yield* setup();
      yield* connections.sync([registered]);
      yield* waitFor(connections, "online");

      // Revoked on the worker: the open socket closes and every dial is 401.
      worker.mode = "unauthorized";
      yield* kit.fake.drop(worker);
      yield* TestClock.adjust("1 second");
      yield* waitFor(connections, "unauthorized");
      yield* TestClock.adjust("1 minute");
      assert.strictEqual((yield* statusOf(connections))?.status.state, "unauthorized");
      assert.strictEqual(worker.dialedTokens.length, 1);

      // Re-pair: a new token, then a redial.
      worker.mode = "ok";
      yield* kit.secrets.store.set(workerSecretName(WORKER_ID), encodeWorkerToken("token-2"));
      yield* connections.restart(WORKER_ID);
      yield* waitFor(connections, "online");
      assert.deepStrictEqual(worker.dialedTokens, ["token-1", "token-2"]);
    }),
  ),
);

it.effect("a worker below the protocol floor, or with no handshake at all, is incompatible", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const old = yield* setup((worker) => {
        worker.hello = { ...helloFor(WORKER_ID, 0), t3oVersion: "0.0.11" };
      });
      yield* old.connections.sync([registered]);
      yield* waitFor(old.connections, "incompatible");
      assert.strictEqual((yield* statusOf(old.connections))?.status.t3oVersion, "0.0.11");

      const upstream = yield* setup((worker) => {
        worker.hello = null;
      });
      yield* upstream.connections.sync([registered]);
      yield* waitFor(upstream.connections, "incompatible");
    }),
  ),
);

it.effect("another server answering at the worker's address is unauthorized", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { connections } = yield* setup((worker) => {
        worker.hello = helloFor("env-someone-else");
      });
      yield* connections.sync([registered]);
      yield* waitFor(connections, "unauthorized");
    }),
  ),
);

it.effect("a worker with no stored token is unauthorized without dialing", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { kit, worker, connections } = yield* setup();
      yield* kit.secrets.store.remove(workerSecretName(WORKER_ID));
      yield* connections.sync([registered]);
      yield* waitFor(connections, "unauthorized");
      assert.deepStrictEqual(worker.dialedTokens, []);
    }),
  ),
);

it.effect("removing a worker from the registry stops dialing it and forgets its snapshot", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { kit, worker, connections } = yield* setup();
      yield* connections.sync([registered]);
      yield* waitFor(connections, "online");
      yield* connections.sync([]);
      assert.isUndefined(yield* statusOf(connections));
      assert.deepStrictEqual(yield* kit.snapshots.list, []);
      worker.mode = "ok";
      yield* TestClock.adjust("1 minute");
      assert.strictEqual(worker.dialedTokens.length, 1);
    }),
  ),
);

it.effect("redials an offline worker quietly: it stays offline, never blue connecting", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { worker, connections } = yield* setup((worker) => {
        worker.mode = "unreachable";
      });
      yield* connections.sync([registered]);
      yield* waitFor(connections, "offline");

      const seen: Array<string | undefined> = [];
      yield* connections.states.pipe(
        Stream.runForEach((runtime) =>
          Effect.sync(() => seen.push(runtime.get(WORKER_ID)?.status.state)),
        ),
        Effect.forkScoped,
      );
      yield* Effect.yieldNow;
      // Several redials, all still unreachable.
      yield* TestClock.adjust("2 minutes");
      assert.deepStrictEqual(seen, ["offline"]);

      // Back: straight from offline to online.
      worker.mode = "ok";
      yield* TestClock.adjust("30 seconds");
      yield* waitFor(connections, "online");
      assert.deepStrictEqual(seen, ["offline", "online"]);
    }),
  ),
);

it.effect("a handshake that fails on the wire is offline, not incompatible", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { worker, connections } = yield* setup((worker) => {
        worker.helloFails = true;
      });
      yield* connections.sync([registered]);
      yield* waitFor(connections, "offline");

      worker.helloFails = false;
      yield* TestClock.adjust("1 second");
      yield* waitFor(connections, "online");
    }),
  ),
);

it.effect("renews the board's session before it expires, and stays online throughout", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { kit, worker, connections } = yield* setup((worker) => {
        worker.sessionExpiry.set("token-1", SESSION_LIFETIME_MS);
      });
      yield* connections.sync([registered]);
      yield* waitFor(connections, "online");
      const firstSeen = (yield* statusOf(connections))?.status.lastSeenAt;

      const seen: Array<string | undefined> = [];
      yield* connections.states.pipe(
        Stream.runForEach((runtime) =>
          Effect.sync(() => seen.push(runtime.get(WORKER_ID)?.status.state)),
        ),
        Effect.forkScoped,
      );
      yield* Effect.yieldNow;

      // A week before the 30 days are up, the session is swapped for its successor.
      yield* TestClock.adjust("23 days");
      yield* connections.states.pipe(
        Stream.filter((runtime) => runtime.get(WORKER_ID)?.status.lastSeenAt !== firstSeen),
        Stream.runHead,
      );
      assert.deepStrictEqual(worker.renewedTokens, ["token-1"]);
      assert.deepStrictEqual(worker.releasedTokens, ["token-1"]);
      assert.deepStrictEqual(worker.dialedTokens, ["token-1", "token-1-renewed"]);
      const stored = yield* kit.secrets.store.get(workerSecretName(WORKER_ID));
      assert.strictEqual(
        new TextDecoder().decode(stored._tag === "Some" ? stored.value : new Uint8Array()),
        "token-1-renewed",
      );
      assert.isTrue(seen.every((state) => state === "online"));
      assert.isTrue((yield* connections.get(WORKER_ID)) !== undefined);

      // The successor is good for another 30 days, so nothing renews again soon.
      yield* TestClock.adjust("1 day");
      assert.deepStrictEqual(worker.renewedTokens, ["token-1"]);
    }),
  ),
);
