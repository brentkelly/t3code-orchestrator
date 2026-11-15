/** A relayed thread's central is read once and kept in step by the store's own writes (T3O-108). */
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";

import * as ServerConfig from "../../config.ts";
import * as SqlitePersistence from "../../persistence/Sqlite.ts";
import { BoardRelayStore, BoardRelayStoreLive } from "./BoardRelayStore.ts";

const layer = BoardRelayStoreLive.pipe(
  Layer.provideMerge(SqlitePersistence.layerMemory),
  Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "t3o-relay-store-" })),
  Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
);

const thread = ThreadId.make("thread-relayed");
const centralA = EnvironmentId.make("env-central-a");
const centralB = EnvironmentId.make("env-central-b");

it.effect("serves a thread's central from memory, and re-reads after its own writes", () =>
  Effect.gen(function* () {
    const store = yield* BoardRelayStore;
    const sql = yield* SqlClient.SqlClient;
    yield* store.recordRelayedThread(thread, centralA);
    assert.strictEqual(yield* store.relayedThreadCentral(thread), centralA);
    // Removed behind the store's back: the memo answers, proving no second read.
    yield* sql`DELETE FROM board_relayed_threads WHERE thread_id = ${thread}`;
    assert.strictEqual(yield* store.relayedThreadCentral(thread), centralA);

    yield* store.recordRelayedThread(thread, centralB);
    assert.strictEqual(yield* store.relayedThreadCentral(thread), centralB);
    yield* store.forgetRelayedThread(thread);
    assert.isNull(yield* store.relayedThreadCentral(thread));
    yield* store.recordRelayedThread(thread, centralA);
    assert.strictEqual(yield* store.relayedThreadCentral(thread), centralA);
  }).pipe(Effect.provide(layer)),
);

it.effect("bounds the memo, dropping its oldest answer first", () =>
  Effect.gen(function* () {
    const store = yield* BoardRelayStore;
    const sql = yield* SqlClient.SqlClient;
    yield* store.recordRelayedThread(thread, centralA);
    assert.strictEqual(yield* store.relayedThreadCentral(thread), centralA);
    yield* sql`DELETE FROM board_relayed_threads WHERE thread_id = ${thread}`;
    for (let index = 0; index < 1024; index += 1) {
      yield* store.relayedThreadCentral(ThreadId.make(`thread-other-${index}`));
    }
    // Evicted, so this is a fresh read of the row deleted behind the store's back.
    assert.isNull(yield* store.relayedThreadCentral(thread));
  }).pipe(Effect.provide(layer)),
);
