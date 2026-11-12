import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import { runMigrations } from "../../persistence/Migrations.ts";
import { attachBoardDatabase } from "../boardDatabase.ts";
import { BOARD_MIGRATIONS } from "../migrations/index.ts";
import { BoardWorkerJoinStore, BoardWorkerJoinStoreLive } from "./BoardWorkerJoinStore.ts";

const migrated = Effect.gen(function* () {
  yield* attachBoardDatabase();
  yield* runMigrations();
  for (const [, , migration] of BOARD_MIGRATIONS) yield* migration;
});

it.effect("a proved credential revokes only those issued before it, never a newer one", () =>
  Effect.gen(function* () {
    yield* migrated;
    const store = yield* BoardWorkerJoinStore;
    const issue = (credentialHash: string, issuedAt: string) =>
      store.issueCredential({ workerId: "worker-1", credentialHash, issuedAt });
    yield* issue("first", "2026-01-01T00:00:00.000Z");
    yield* issue("second", "2026-01-02T00:00:00.000Z");
    yield* issue("third", "2026-01-03T00:00:00.000Z");
    yield* store.issueCredential({
      workerId: "worker-2",
      credentialHash: "other",
      issuedAt: "2026-01-01T00:00:00.000Z",
    });

    yield* store.revokeCredentials({ workerId: "worker-1", at: "2026-01-04", keep: "second" });
    assert.isNull(yield* store.verifyCredential("first"));
    assert.strictEqual(yield* store.verifyCredential("second"), "worker-1");
    assert.strictEqual(yield* store.verifyCredential("third"), "worker-1");
    assert.strictEqual(yield* store.verifyCredential("other"), "worker-2");

    yield* store.revokeCredentials({ workerId: "worker-1", at: "2026-01-05" });
    assert.isNull(yield* store.verifyCredential("third"));
  }).pipe(
    Effect.provide(BoardWorkerJoinStoreLive),
    Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" })),
  ),
);
