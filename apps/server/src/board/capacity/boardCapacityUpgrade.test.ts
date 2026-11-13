import {
  BOARD_LOCAL_WORKER_ID,
  type BoardCard,
  type BoardCommand,
  type BoardState,
} from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import { buildingCard, readyWorktree } from "../supervisorHarness.testkit.ts";
import { runBoardCapacityUpgrade } from "./boardCapacityUpgrade.ts";
import { makeFakeCapacity, roomForCards } from "./capacityClient.testkit.ts";

const NOW = "2026-01-01T00:00:00.000Z";

it.effect("the upgrade is recorded done only once every command landed; CI counts as active", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`CREATE TABLE board_capacity_upgrade (id TEXT PRIMARY KEY, completed_at TEXT)`;
    const fake = yield* makeFakeCapacity(roomForCards(4));
    const snapshot = (yield* fake.client.latest(BOARD_LOCAL_WORKER_ID))!;
    const inCi: BoardCard = {
      ...buildingCard("a", "a"),
      worktree: readyWorktree("a"),
      ci: { phase: "running" } as BoardCard["ci"],
    };
    const board: BoardState = { cards: [inCi], nextCardNumberByProject: {} };
    const sent: Array<BoardCommand> = [];
    let refuse = true;
    const run = runBoardCapacityUpgrade({
      sql,
      client: { ...fake.client, all: Effect.succeed(new Map([[BOARD_LOCAL_WORKER_ID, snapshot]])) },
      readBoard: Effect.succeed(board),
      concurrency: Effect.succeed({ perInstance: {}, globalMaxConcurrent: 2, workers: {} }),
      liveWorkers: Effect.succeed([]),
      dispatch: (command) =>
        Effect.sync(() => {
          sent.push(command);
          return !(refuse && command.type === "board.card.record-grant");
        }),
      commandId: (tag) => Effect.succeed(`cmd-${tag}` as BoardCommand["commandId"]),
      nowIso: Effect.succeed(NOW),
    });
    // The backfill didn't land: not done, and the next pass tries again.
    assert.isFalse(yield* run);
    refuse = false;
    assert.isTrue(yield* run);
    const rows = yield* sql`SELECT id FROM board_capacity_upgrade`;
    assert.lengthOf(rows, 1);
    const grants = sent.filter(
      (command): command is Extract<BoardCommand, { type: "board.card.record-grant" }> =>
        command.type === "board.card.record-grant",
    );
    assert.lengthOf(grants, 2);
    // A card with a CI pass running holds its CPU and RAM.
    assert.isTrue(grants[1]?.heavy);
  }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
);
