/**
 * T3o (T3O-63): the small durable state the remote gateway and the MCP relay
 * keep, in the tables of migration 047.
 *
 * - Worker side: which threads a central server spawned here
 *   (`board_relayed_threads`), so their board tool calls go to that board.
 * - Central side: how far through each worker's signals the board has read
 *   (`board_worker_cursors`), and each relayed call's answer by call id
 *   (`board_mcp_relay_calls`), so a redelivered call is answered, not re-run.
 */
import { BoardMcpRelayOutcome, type EnvironmentId, type ThreadId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as SubscriptionRef from "effect/SubscriptionRef";

export class BoardRelayStoreError extends Schema.TaggedError<BoardRelayStoreError>()(
  "BoardRelayStoreError",
  { operation: Schema.String, cause: Schema.optional(Schema.Defect()) },
) {}

export interface BoardRelayStoreShape {
  /** Worker side: remember that a central server spawned this thread here. */
  readonly recordRelayedThread: (
    threadId: ThreadId,
    centralEnvironmentId: EnvironmentId,
  ) => Effect.Effect<void, BoardRelayStoreError>;
  /** Worker side: the central server a thread's board tools relay to, or null
      for one of this server's own threads. */
  readonly relayedThreadCentral: (
    threadId: ThreadId,
  ) => Effect.Effect<EnvironmentId | null, BoardRelayStoreError>;
  /** Worker side: forget a thread that is gone. */
  readonly forgetRelayedThread: (threadId: ThreadId) => Effect.Effect<void, BoardRelayStoreError>;
  /** Central side: the last worker signal position the board has applied. */
  readonly signalCursor: (workerId: EnvironmentId) => Effect.Effect<number | null>;
  readonly saveSignalCursor: (
    workerId: EnvironmentId,
    cursor: number,
  ) => Effect.Effect<void, BoardRelayStoreError>;
  /** Central side: forget a worker's cursor, so a worker added again starts
      at its log's head rather than replaying what it logged meanwhile. */
  readonly forgetSignalCursor: (
    workerId: EnvironmentId,
  ) => Effect.Effect<void, BoardRelayStoreError>;
  /** Central side: a relayed call's recorded answer, for the worker that
      sent it: call ids are the worker's own, so another worker's same id is
      another call. */
  readonly relayCallOutcome: (
    workerId: EnvironmentId,
    callId: string,
  ) => Effect.Effect<BoardMcpRelayOutcome | null, BoardRelayStoreError>;
  readonly recordRelayCall: (
    callId: string,
    workerId: EnvironmentId,
    outcome: BoardMcpRelayOutcome,
  ) => Effect.Effect<void, BoardRelayStoreError>;
}

export class BoardRelayStore extends Context.Service<BoardRelayStore, BoardRelayStoreShape>()(
  "t3/board/workers/BoardRelayStore",
) {}

const OutcomeJson = Schema.fromJsonString(BoardMcpRelayOutcome);
const encodeOutcome = Schema.encodeEffect(OutcomeJson);
const decodeOutcome = Schema.decodeUnknownEffect(OutcomeJson);

/** How long a relayed call's answer is kept for redelivery. A redelivery only
    happens while the worker still waits on the call, which it gives up on
    within a minute. */
const RELAY_CALL_RETENTION_MS = 24 * 60 * 60 * 1000;

export const BoardRelayStoreLive = Layer.effect(
  BoardRelayStore,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const failed =
      (operation: string) =>
      <A, E, R>(effect: Effect.Effect<A, E, R>) =>
        effect.pipe(Effect.mapError((cause) => new BoardRelayStoreError({ operation, cause })));
    const nowIso = DateTime.now.pipe(Effect.map(DateTime.formatIso));

    return {
      recordRelayedThread: (threadId, centralEnvironmentId) =>
        nowIso.pipe(
          Effect.flatMap(
            (at) => sql`
              INSERT INTO board_relayed_threads (thread_id, central_environment_id, created_at)
              VALUES (${threadId}, ${centralEnvironmentId}, ${at})
              ON CONFLICT (thread_id) DO UPDATE SET
                central_environment_id = excluded.central_environment_id
            `,
          ),
          Effect.asVoid,
          failed("recordRelayedThread"),
        ),
      relayedThreadCentral: (threadId) =>
        sql<{ readonly central: string }>`
          SELECT central_environment_id AS "central"
          FROM board_relayed_threads WHERE thread_id = ${threadId}
        `.pipe(
          Effect.map((rows) => (rows[0]?.central ?? null) as EnvironmentId | null),
          failed("relayedThreadCentral"),
        ),
      forgetRelayedThread: (threadId) =>
        sql`DELETE FROM board_relayed_threads WHERE thread_id = ${threadId}`.pipe(
          Effect.asVoid,
          failed("forgetRelayedThread"),
        ),
      signalCursor: (workerId) =>
        sql<{ readonly cursor: number }>`
          SELECT signal_cursor AS "cursor" FROM board_worker_cursors WHERE worker_id = ${workerId}
        `.pipe(
          Effect.map((rows) => rows[0]?.cursor ?? null),
          Effect.catchCause((cause) =>
            Effect.logWarning("board worker cursor unreadable; resuming from now", {
              cause,
            }).pipe(Effect.as(null)),
          ),
        ),
      saveSignalCursor: (workerId, cursor) =>
        nowIso.pipe(
          Effect.flatMap(
            (at) => sql`
              INSERT INTO board_worker_cursors (worker_id, signal_cursor, updated_at)
              VALUES (${workerId}, ${cursor}, ${at})
              ON CONFLICT (worker_id) DO UPDATE SET
                signal_cursor = excluded.signal_cursor,
                updated_at = excluded.updated_at
            `,
          ),
          Effect.asVoid,
          failed("saveSignalCursor"),
        ),
      forgetSignalCursor: (workerId) =>
        sql`DELETE FROM board_worker_cursors WHERE worker_id = ${workerId}`.pipe(
          Effect.asVoid,
          failed("forgetSignalCursor"),
        ),
      relayCallOutcome: (workerId, callId) =>
        sql<{ readonly outcome: string }>`
          SELECT outcome_json AS "outcome" FROM board_mcp_relay_calls
          WHERE call_id = ${callId} AND worker_id = ${workerId}
        `.pipe(
          Effect.flatMap((rows) =>
            rows[0] === undefined ? Effect.succeed(null) : decodeOutcome(rows[0].outcome),
          ),
          failed("relayCallOutcome"),
        ),
      recordRelayCall: (callId, workerId, outcome) =>
        Effect.gen(function* () {
          const now = yield* DateTime.now;
          const json = yield* encodeOutcome(outcome);
          const cutoff = DateTime.formatIso(
            DateTime.makeUnsafe(now.epochMilliseconds - RELAY_CALL_RETENTION_MS),
          );
          yield* sql`DELETE FROM board_mcp_relay_calls WHERE completed_at < ${cutoff}`;
          yield* sql`
            INSERT INTO board_mcp_relay_calls (call_id, worker_id, outcome_json, completed_at)
            VALUES (${callId}, ${workerId}, ${json}, ${DateTime.formatIso(now)})
            ON CONFLICT (call_id) DO NOTHING
          `;
        }).pipe(failed("recordRelayCall")),
    } satisfies BoardRelayStoreShape;
  }),
);

const relayCallKey = (workerId: EnvironmentId, callId: string) => `${workerId}\u0000${callId}`;

/** An in-memory store, for tests. */
export const makeMemoryBoardRelayStore = Effect.gen(function* () {
  // Watchable, so a test can await a record's removal.
  const relayed = yield* SubscriptionRef.make<ReadonlyMap<string, EnvironmentId>>(new Map());
  const cursors = yield* Ref.make(new Map<string, number>());
  const calls = yield* Ref.make(new Map<string, BoardMcpRelayOutcome>());
  const store: BoardRelayStoreShape = {
    recordRelayedThread: (threadId, central) =>
      SubscriptionRef.update(relayed, (map) => new Map(map).set(threadId, central)),
    relayedThreadCentral: (threadId) =>
      SubscriptionRef.get(relayed).pipe(Effect.map((map) => map.get(threadId) ?? null)),
    forgetRelayedThread: (threadId) =>
      SubscriptionRef.update(relayed, (map) => {
        const next = new Map(map);
        next.delete(threadId);
        return next;
      }),
    signalCursor: (workerId) =>
      Ref.get(cursors).pipe(Effect.map((map) => map.get(workerId) ?? null)),
    saveSignalCursor: (workerId, cursor) =>
      Ref.update(cursors, (map) => new Map(map).set(workerId, cursor)),
    forgetSignalCursor: (workerId) =>
      Ref.update(cursors, (map) => {
        const next = new Map(map);
        next.delete(workerId);
        return next;
      }),
    relayCallOutcome: (workerId, callId) =>
      Ref.get(calls).pipe(
        Effect.map((map) =>
          Option.getOrNull(Option.fromNullishOr(map.get(relayCallKey(workerId, callId)))),
        ),
      ),
    recordRelayCall: (callId, workerId, outcome) =>
      Ref.update(calls, (map) => {
        const key = relayCallKey(workerId, callId);
        return map.has(key) ? map : new Map(map).set(key, outcome);
      }),
  };
  return { store, layer: Layer.succeed(BoardRelayStore, store), cursors, calls, relayed };
});
