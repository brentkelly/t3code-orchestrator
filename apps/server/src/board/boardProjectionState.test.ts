/**
 * Watermark routing (t3o-26 P1).
 *
 * The point of this module is that a board projector's writes and its watermark
 * land in the SAME database, because SQLite drops cross-database atomicity under
 * WAL. So these tests assert PLACEMENT, not just round-tripping: a watermark in
 * the wrong file is the bug, even though every read would still return it.
 */
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { ProjectionStateRepository } from "../persistence/Services/ProjectionState.ts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import {
  BoardAwareProjectionStateRepositoryLive,
  isBoardProjectorName,
} from "./boardProjectionState.ts";

const layer = it.layer(
  BoardAwareProjectionStateRepositoryLive.pipe(Layer.provideMerge(SqlitePersistenceMemory)),
);

const countIn = (schema: "main" | "boards", projector: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const rows =
      schema === "main"
        ? yield* sql<{ readonly n: number }>`
            SELECT COUNT(*) AS n FROM main.projection_state WHERE projector = ${projector}`
        : yield* sql<{ readonly n: number }>`
            SELECT COUNT(*) AS n FROM boards.projection_state WHERE projector = ${projector}`;
    return rows[0]?.n ?? 0;
  });

const at = (projector: string, sequence: number) => ({
  projector,
  lastAppliedSequence: sequence,
  updatedAt: "2026-01-01T00:00:00.000Z",
});

layer("board-aware projection state", (it) => {
  it.effect("recognises board projector names by prefix", () =>
    Effect.sync(() => {
      assert.ok(isBoardProjectorName("projection.board-cards"));
      assert.ok(!isBoardProjectorName("projection.threads"));
      // Prefix, not substring: a projector merely starting with "board" is not one.
      assert.ok(!isBoardProjectorName("projection.boardish"));
    }),
  );

  it.effect("writes a board watermark to the board database and an upstream one to main", () =>
    Effect.gen(function* () {
      const repository = yield* ProjectionStateRepository;

      yield* repository.upsert(at("projection.board-cards", 7));
      yield* repository.upsert(at("projection.threads", 9));

      // Placement is the whole point — a board watermark in main would tear.
      assert.strictEqual(yield* countIn("boards", "projection.board-cards"), 1);
      assert.strictEqual(yield* countIn("main", "projection.board-cards"), 0);
      assert.strictEqual(yield* countIn("main", "projection.threads"), 1);
      assert.strictEqual(yield* countIn("boards", "projection.threads"), 0);
    }),
  );

  it.effect("reads either watermark back, and upserts in place", () =>
    Effect.gen(function* () {
      const repository = yield* ProjectionStateRepository;

      yield* repository.upsert(at("projection.board-cards", 7));
      yield* repository.upsert(at("projection.board-cards", 11));
      yield* repository.upsert(at("projection.threads", 9));

      const board = yield* repository.getByProjector({ projector: "projection.board-cards" });
      assert.strictEqual(Option.getOrNull(board)?.lastAppliedSequence, 11);
      const upstream = yield* repository.getByProjector({ projector: "projection.threads" });
      assert.strictEqual(Option.getOrNull(upstream)?.lastAppliedSequence, 9);
      // Upsert, not insert: the second write replaced the first.
      assert.strictEqual(yield* countIn("boards", "projection.board-cards"), 1);

      const missing = yield* repository.getByProjector({ projector: "projection.nope" });
      assert.ok(Option.isNone(missing));
    }),
  );

  // Callers still see one logical set of watermarks; the split is an
  // implementation detail of where each row is durable.
  it.effect("unions both databases for whole-set reads", () =>
    Effect.gen(function* () {
      const repository = yield* ProjectionStateRepository;

      yield* repository.upsert(at("projection.board-cards", 4));
      yield* repository.upsert(at("projection.threads", 12));

      const all = yield* repository.listAll();
      assert.deepStrictEqual(all.map((row) => row.projector).sort(), [
        "projection.board-cards",
        "projection.threads",
      ]);
      // The minimum has to consider the board's row, or a caller gating on
      // "how far has projection caught up" would read past unapplied board events.
      assert.strictEqual(yield* repository.minLastAppliedSequence(), 4);
    }),
  );
  // Migration 031's cross-database transaction can tear leaving a stale board
  // row in main (its DELETE uncommitted while boards + ledger land), and a
  // downgrade/upgrade cycle writes one back. Since upsert routes board names to
  // boards, a shadowing read would never self-heal — so the reads must make the
  // stale row unreachable, not trust the cleanup.
  it.effect("ignores a stale board watermark stranded in main", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const repository = yield* ProjectionStateRepository;

      yield* repository.upsert(at("projection.board-cards", 500));
      // The stranded row: same projector, frozen at an old sequence, in main.
      yield* sql`
        INSERT INTO main.projection_state (projector, last_applied_sequence, updated_at)
        VALUES ('projection.board-cards', ${100}, '2025-01-01T00:00:00.000Z')
      `;

      const read = yield* repository.getByProjector({ projector: "projection.board-cards" });
      assert.strictEqual(Option.getOrNull(read)?.lastAppliedSequence, 500);

      const all = yield* repository.listAll();
      assert.deepStrictEqual(
        all
          .filter((row) => row.projector === "projection.board-cards")
          .map((row) => row.lastAppliedSequence),
        [500],
      );
      // The stale row must not pin the catch-up minimum either.
      yield* repository.upsert(at("projection.threads", 400));
      assert.strictEqual(yield* repository.minLastAppliedSequence(), 400);
    }),
  );
});
