import { ThreadId } from "@t3tools/contracts";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";

import * as ServerConfig from "../config.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import { boardKeptWorktrees, isBoardCardThread } from "./upstreamGuards.ts";

const database = SqlitePersistence.layerMemory.pipe(
  Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "t3o-guards-" })),
  Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
);

const NOW = "2026-11-11T00:00:00.000Z";

const insertThread = (threadId: string, worktreePath: string | null) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`
      INSERT INTO orchestration_v2_projection_threads
        (thread_id, project_id, title, default_provider, runtime_mode, interaction_mode,
         created_at, updated_at, deleted_at, payload_json)
      VALUES (${threadId}, 'proj', 'Thread', 'codex', 'full-access', 'default', ${NOW}, ${NOW},
        NULL, ${JSON.stringify({ worktreePath })})
    `;
  });

const insertCard = (cardId: string, worktree: unknown) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`
      INSERT INTO boards.board_cards (card_id, project_id, title, created_at, updated_at, worktree)
      VALUES (${cardId}, 'proj', 'Card', ${NOW}, ${NOW},
        ${worktree === null ? null : JSON.stringify(worktree)})
    `;
  });

describe("isBoardCardThread", () => {
  it.effect("answers true for linked, tombstoned and relayed threads only", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`
        INSERT INTO boards.board_card_thread_links (thread_id, card_id, role, linked_at, tombstoned_at)
        VALUES ('thread-linked', 'card-1', 'building', ${NOW}, NULL),
               ('thread-tombstoned', 'card-1', 'planning', ${NOW}, ${NOW})
      `;
      yield* sql`
        INSERT INTO boards.board_relayed_threads (thread_id, central_environment_id, created_at)
        VALUES ('thread-relayed', 'env-central', ${NOW})
      `;
      const check = (id: string) => isBoardCardThread(sql, ThreadId.make(id));
      assert.isTrue(yield* check("thread-linked"));
      assert.isTrue(yield* check("thread-tombstoned"));
      assert.isTrue(yield* check("thread-relayed"));
      assert.isFalse(yield* check("thread-plain"));
    }).pipe(Effect.provide(database)),
  );

  it.effect("fails closed when the board tables cannot be read", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`DROP TABLE boards.board_relayed_threads`;
      assert.isTrue(yield* isBoardCardThread(sql, ThreadId.make("thread-plain")));
    }).pipe(Effect.provide(database)),
  );
});

describe("boardKeptWorktrees", () => {
  it.effect("keeps card worktrees until reclaimed and relayed threads' worktrees", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* insertCard("card-ready", { path: "/w/ready/", status: "ready" });
      yield* insertCard("card-reclaimed", { path: null, status: "reclaimed" });
      yield* insertCard("card-none", null);
      yield* insertThread("thread-relayed", "/w/relayed");
      yield* insertThread("thread-plain", "/w/plain");
      yield* sql`
        INSERT INTO boards.board_relayed_threads (thread_id, central_environment_id, created_at)
        VALUES ('thread-relayed', 'env-central', ${NOW})
      `;
      const kept = yield* boardKeptWorktrees(sql, (path) => path.replace(/\/$/, ""));
      assert.isTrue(kept("/w/ready"));
      assert.isTrue(kept("/w/relayed"));
      assert.isFalse(kept("/w/plain"));
      assert.isFalse(kept("/w/reclaimed"));
    }).pipe(Effect.provide(database)),
  );

  it.effect("keeps every worktree when the board tables cannot be read", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`DROP TABLE boards.board_cards`;
      const kept = yield* boardKeptWorktrees(sql, (path) => path);
      assert.isTrue(kept("/w/anything"));
    }).pipe(Effect.provide(database)),
  );
});
