/**
 * The board's own engine (T3O-56), on real SQLite.
 *
 * What the engine promises, and what these pin: a command's events, their
 * projection, its receipt and the watermark commit together or not at all, and
 * only then is anything published; a command id is decided once; a subscriber
 * that catches up from the log and then follows the live tail sees every event
 * exactly once, in order; and nothing a board command does lands in upstream's
 * log.
 */
import {
  BoardCardId,
  BoardStageId,
  CommandId,
  ProjectId,
  ProviderInstanceId,
  type BoardCommand,
  type BoardEvent,
} from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";

import { BoardEngine, BOARD_EVENTS_PROJECTOR, BoardEngineLive } from "./BoardEngine.ts";
import { BoardQueries, BoardQueriesLive } from "./BoardQueries.ts";
import { boardStackEngine, makeBoardStackTestLayer } from "./boardStack.testkit.ts";

const t0 = "2026-01-01T00:00:00.000Z";
/** Each case shares the layer, so each gets its own project: card `x-1` lives
    in the project `createProject("x")` made. */
const projectOf = (name: string) => ProjectId.make(`project-${name.split("-")[0]}`);

const createProject = (suffix: string) =>
  ({
    type: "project.create",
    commandId: CommandId.make(`cmd-project-${suffix}`),
    projectId: projectOf(suffix),
    title: "Engine project",
    workspaceRoot: `/tmp/engine-${suffix}`,
    defaultModelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5-codex" },
    createdAt: t0,
  }) as const;

const createCard = (id: string): BoardCommand => ({
  type: "board.card.create",
  commandId: CommandId.make(`cmd-create-${id}`),
  cardId: BoardCardId.make(id),
  projectId: projectOf(id),
  title: `Card ${id}`,
  createdAt: t0,
});

const moveCard = (id: string, n: number, toStage: string): BoardCommand => ({
  type: "board.card.move",
  commandId: CommandId.make(`cmd-move-${id}-${n}`),
  cardId: BoardCardId.make(id),
  toStage: BoardStageId.make(toStage),
  createdAt: t0,
});

const count = (sql: SqlClient.SqlClient, table: string) =>
  sql<{ readonly n: number }>`SELECT COUNT(*) AS n FROM ${sql(table)}`.pipe(
    Effect.map((rows) => rows[0]?.n ?? 0),
  );

it.layer(makeBoardStackTestLayer("t3o-board-engine-"))("BoardEngine", (it) => {
  it.effect("commits the event, its projection, the receipt and the watermark together", () =>
    Effect.gen(function* () {
      const engine = yield* boardStackEngine;
      const sql = yield* SqlClient.SqlClient;
      yield* engine.dispatch(createProject("commit"));

      const subscription = yield* engine.boardEngine.subscribeBoardEvents;
      const { sequence } = yield* engine.dispatch(createCard("commit-1"));
      const published = yield* Stream.runHead(subscription);

      const logged = yield* sql<{ readonly sequence: number; readonly type: string }>`
        SELECT sequence, event_type AS "type" FROM boards.board_events WHERE sequence = ${sequence}`;
      assert.deepStrictEqual(logged, [{ sequence, type: "board.card-created" }]);
      const cards = yield* sql`SELECT card_id FROM boards.board_cards WHERE card_id = 'commit-1'`;
      assert.strictEqual(cards.length, 1);
      const receipts = yield* sql<{ readonly status: string; readonly resultSequence: number }>`
        SELECT status, result_sequence AS "resultSequence"
        FROM boards.board_command_receipts WHERE command_id = 'cmd-create-commit-1'`;
      assert.deepStrictEqual(receipts, [{ status: "accepted", resultSequence: sequence }]);
      const watermark = yield* sql<{ readonly sequence: number }>`
        SELECT last_applied_sequence AS "sequence" FROM boards.projection_state
        WHERE projector = ${BOARD_EVENTS_PROJECTOR}`;
      assert.deepStrictEqual(watermark, [{ sequence }]);

      // Published after commit, with the logged sequence.
      assert.strictEqual(published._tag, "Some");
      if (published._tag === "Some") assert.strictEqual(published.value.sequence, sequence);
      // And the in-memory model moved with it.
      const model = yield* engine.boardEngine.getReadModel;
      assert.ok(model.board?.cards.some((card) => card.id === "commit-1"));
      assert.strictEqual(yield* engine.boardEngine.latestSequence, sequence);
    }).pipe(Effect.scoped),
  );

  it.effect("rolls everything back when the projection fails, and publishes nothing", () =>
    Effect.gen(function* () {
      const engine = yield* boardStackEngine;
      const sql = yield* SqlClient.SqlClient;
      yield* engine.dispatch(createProject("rollback"));
      const eventsBefore = yield* count(sql, "boards.board_events");
      const headBefore = yield* engine.boardEngine.latestSequence;
      const modelBefore = yield* engine.boardEngine.getReadModel;

      // The activity row the projector writes for a create has nowhere to go.
      yield* sql`ALTER TABLE boards.board_card_activity RENAME TO board_card_activity_away`;
      const subscription = yield* engine.boardEngine.subscribeBoardEvents;
      const failure = yield* Effect.flip(engine.dispatch(createCard("rollback-1")));
      yield* sql`ALTER TABLE boards.board_card_activity_away RENAME TO board_card_activity`;

      assert.strictEqual(failure._tag, "PersistenceSqlError");
      assert.strictEqual(yield* count(sql, "boards.board_events"), eventsBefore);
      const cards = yield* sql`SELECT card_id FROM boards.board_cards WHERE card_id = 'rollback-1'`;
      assert.strictEqual(cards.length, 0);
      const receipts = yield* sql`
        SELECT command_id FROM boards.board_command_receipts
        WHERE command_id = 'cmd-create-rollback-1'`;
      assert.strictEqual(receipts.length, 0);
      assert.strictEqual(yield* engine.boardEngine.latestSequence, headBefore);
      assert.deepStrictEqual(yield* engine.boardEngine.getReadModel, modelBefore);

      // The same command goes through once the table is back — nothing of the
      // failed attempt was left to trip it — and it is the FIRST thing published.
      const { sequence } = yield* engine.dispatch(createCard("rollback-1"));
      const first = yield* Stream.runHead(subscription);
      assert.strictEqual(first._tag === "Some" ? first.value.sequence : -1, sequence);
    }).pipe(Effect.scoped),
  );

  it.effect("answers a repeated command id from its receipt instead of deciding it again", () =>
    Effect.gen(function* () {
      const engine = yield* boardStackEngine;
      const sql = yield* SqlClient.SqlClient;
      yield* engine.dispatch(createProject("replay"));
      const first = yield* engine.dispatch(createCard("replay-1"));
      const eventsAfterFirst = yield* count(sql, "boards.board_events");
      const second = yield* engine.dispatch(createCard("replay-1"));
      assert.deepStrictEqual(second, first);
      assert.strictEqual(yield* count(sql, "boards.board_events"), eventsAfterFirst);
    }),
  );

  it.effect("replays a command whose last event landed on another card", () =>
    Effect.gen(function* () {
      const engine = yield* boardStackEngine;
      const sql = yield* SqlClient.SqlClient;
      yield* engine.dispatch(createProject("multi"));
      yield* engine.dispatch(createCard("multi-1"));
      yield* engine.dispatch(createCard("multi-2"));
      yield* engine.dispatch({
        ...moveCard("multi-2", 1, "building"),
        override: true,
      } as BoardCommand);
      yield* engine.dispatch({
        type: "board.card.update",
        commandId: CommandId.make("cmd-depend-multi-2"),
        cardId: BoardCardId.make("multi-2"),
        dependsOn: [BoardCardId.make("multi-1")],
        createdAt: t0,
      } as BoardCommand);
      // Archiving the dependency unblocks its dependent: two events, the last
      // one on `multi-2`.
      const archive: BoardCommand = {
        type: "board.card.archive",
        commandId: CommandId.make("cmd-archive-multi-1"),
        cardId: BoardCardId.make("multi-1"),
        createdAt: t0,
      };
      const before = yield* count(sql, "boards.board_events");
      const first = yield* engine.dispatch(archive);
      assert.strictEqual((yield* count(sql, "boards.board_events")) - before, 2);
      assert.deepStrictEqual(yield* engine.dispatch(archive), first);

      // A receipt written before the fix (or migrated from v1) names the last
      // event's card; a retry still replays rather than reporting a conflict.
      yield* sql`UPDATE boards.board_command_receipts SET aggregate_id = 'multi-2'
        WHERE command_id = 'cmd-archive-multi-1'`;
      assert.deepStrictEqual(yield* engine.dispatch(archive), first);
    }),
  );

  it.effect("records a refusal, and answers a retry with the same refusal", () =>
    Effect.gen(function* () {
      const engine = yield* boardStackEngine;
      // No project: the decider refuses.
      const command: BoardCommand = {
        type: "board.card.create",
        commandId: CommandId.make("cmd-create-orphan"),
        cardId: BoardCardId.make("orphan"),
        projectId: ProjectId.make("project-nowhere"),
        title: "Orphan",
        createdAt: t0,
      };
      const refused = yield* Effect.flip(engine.dispatch(command));
      assert.strictEqual(refused._tag, "BoardCommandInvariantError");
      assert.include(refused.message, "Available projects");
      const replayed = yield* Effect.flip(engine.dispatch(command));
      assert.strictEqual(replayed._tag, "BoardCommandPreviouslyRejectedError");
    }),
  );

  it.effect("refuses a command id already used for another aggregate", () =>
    Effect.gen(function* () {
      const engine = yield* boardStackEngine;
      yield* engine.dispatch(createProject("conflict"));
      yield* engine.dispatch(createCard("conflict-1"));
      const reused = {
        ...createCard("conflict-2"),
        commandId: CommandId.make("cmd-create-conflict-1"),
      };
      const failure = yield* Effect.flip(engine.dispatch(reused));
      assert.strictEqual(failure._tag, "BoardCommandIdConflictError");
    }),
  );

  it.effect(
    "streams the log after a cursor and then the live tail, each event once, in order",
    () =>
      Effect.gen(function* () {
        const engine = yield* boardStackEngine;
        yield* engine.dispatch(createProject("stream"));
        yield* engine.dispatch(createCard("stream-1"));
        const cursor = yield* engine.boardEngine.latestSequence;
        yield* engine.dispatch(moveCard("stream-1", 1, "sprint"));
        yield* engine.dispatch(moveCard("stream-1", 2, "planning"));

        // Two from the log, then two more dispatched while the stream is live.
        const collected = yield* Effect.forkChild(
          Stream.runCollect(
            engine.boardEngine.streamBoardEvents({ afterSequence: cursor }).pipe(Stream.take(4)),
          ),
        );
        yield* engine.dispatch(moveCard("stream-1", 3, "ready"));
        yield* engine.dispatch(moveCard("stream-1", 4, "planning"));
        const events: ReadonlyArray<BoardEvent> = Array.from(yield* Fiber.join(collected));

        assert.deepStrictEqual(
          events.map((event) => event.sequence),
          [cursor + 1, cursor + 2, cursor + 3, cursor + 4],
        );
      }),
  );

  it.effect("writes nothing to upstream's log or receipts", () =>
    Effect.gen(function* () {
      const engine = yield* boardStackEngine;
      const sql = yield* SqlClient.SqlClient;
      yield* engine.dispatch(createProject("legible"));
      yield* engine.dispatch(createCard("legible-1"));
      yield* engine.dispatch(moveCard("legible-1", 1, "sprint"));

      const boardRows = yield* sql<{ readonly n: number }>`
        SELECT COUNT(*) AS n FROM main.orchestration_events
        WHERE substr(event_type, 1, 6) = 'board.' OR aggregate_kind NOT IN ('project', 'thread')`;
      assert.strictEqual(boardRows[0]?.n, 0);
      const boardReceipts = yield* sql<{ readonly n: number }>`
        SELECT COUNT(*) AS n FROM main.orchestration_command_receipts
        WHERE aggregate_kind NOT IN ('project', 'thread')`;
      assert.strictEqual(boardReceipts[0]?.n, 0);
    }),
  );
});

// A second engine over the same file must fold in anything the log holds that
// the tables do not — the shape a database migrated from the v1 log can boot in.
it.layer(makeBoardStackTestLayer("t3o-board-engine-catchup-"))("BoardEngine boot", (it) => {
  it.effect("projects logged events past the watermark before it starts", () =>
    Effect.gen(function* () {
      const engine = yield* boardStackEngine;
      const sql = yield* SqlClient.SqlClient;
      yield* engine.dispatch(createProject("catchup"));
      yield* engine.dispatch(createCard("catchup-1"));

      // Forget the projection of that card, and say so in the watermark.
      yield* sql`DELETE FROM boards.board_cards WHERE card_id = 'catchup-1'`;
      yield* sql`
        UPDATE boards.projection_state SET last_applied_sequence = 0
        WHERE projector = ${BOARD_EVENTS_PROJECTOR}`;

      const rebooted = yield* Effect.gen(function* () {
        const fresh = yield* BoardEngine;
        return yield* fresh.getReadModel;
      }).pipe(Effect.provide(BoardEngineLive.pipe(Layer.provide(BoardQueriesLive), Layer.fresh)));

      assert.ok(rebooted.board?.cards.some((card) => card.id === "catchup-1"));
      const cards = yield* sql`SELECT card_id FROM boards.board_cards WHERE card_id = 'catchup-1'`;
      assert.strictEqual(cards.length, 1);
      const queries = yield* BoardQueries;
      const state = yield* queries.loadBoardState();
      assert.ok(state?.cards.some((card) => card.id === "catchup-1"));
    }),
  );
});
