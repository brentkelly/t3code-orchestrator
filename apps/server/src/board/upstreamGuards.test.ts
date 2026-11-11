import { ThreadId } from "@t3tools/contracts";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as SqlClient from "effect/sql/SqlClient";

import * as ServerConfig from "../config.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import { boardKeptWorktrees, isBoardCardThread } from "./upstreamGuards.ts";
import { CENTRAL_OWNER_MARKER } from "./workspace/LocalBoardWorkspace.ts";

const database = SqlitePersistence.layerMemory.pipe(
  Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "t3o-guards-" })),
  Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
);

const NOW = "2026-11-11T00:00:00.000Z";

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

/** A linked worktree whose private git dir sits elsewhere, as git lays one out. */
const linkedWorktree = (root: string, name: string, centralOwned: boolean) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const worktreePath = path.join(root, name);
    const gitDir = path.join(root, "repo", ".git", "worktrees", name);
    yield* fs.makeDirectory(worktreePath, { recursive: true });
    yield* fs.makeDirectory(gitDir, { recursive: true });
    yield* fs.writeFileString(path.join(worktreePath, ".git"), `gitdir: ${gitDir}\n`);
    if (centralOwned) {
      yield* fs.writeFileString(path.join(gitDir, CENTRAL_OWNER_MARKER), "central\n");
    }
    return worktreePath;
  });

const keptWorktrees = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  return yield* boardKeptWorktrees(sql, yield* FileSystem.FileSystem, yield* Path.Path);
});

describe("boardKeptWorktrees", () => {
  it.effect("keeps card worktrees until reclaimed, and checkouts a central board provisioned", () =>
    Effect.gen(function* () {
      const root = yield* (yield* FileSystem.FileSystem).makeTempDirectoryScoped({
        prefix: "t3o-guards-",
      });
      yield* insertCard("card-ready", { path: `${root}/ready/`, status: "ready" });
      yield* insertCard("card-reclaimed", { path: null, status: "reclaimed" });
      yield* insertCard("card-none", null);
      // A worker's card worktree after every relayed thread on it was deleted.
      const central = yield* linkedWorktree(root, "central", true);
      const plain = yield* linkedWorktree(root, "plain", false);
      const kept = yield* keptWorktrees;
      assert.isTrue(yield* kept(`${root}/ready`));
      assert.isTrue(yield* kept(central));
      assert.isFalse(yield* kept(plain));
      assert.isFalse(yield* kept(`${root}/reclaimed`));
    }).pipe(Effect.scoped, Effect.provide(database)),
  );

  it.effect("keeps every worktree when the board tables cannot be read", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`DROP TABLE boards.board_cards`;
      const kept = yield* keptWorktrees;
      assert.isTrue(yield* kept("/w/anything"));
    }).pipe(Effect.provide(database)),
  );
});
