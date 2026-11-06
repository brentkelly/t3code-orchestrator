/**
 * T3o (T3O-62, D8): what each worker last reported, persisted on the central
 * server so an offline worker still shows its last providers and checkouts
 * ("Last known · offline").
 *
 * Not a projection: connection state is runtime, never event-sourced, and this
 * is its durable residue. Rows live in `board_worker_snapshots` (migration 046)
 * and go with the worker on remove.
 */
import {
  BoardWorkerSnapshot,
  type BoardWorkerStatus,
  type EnvironmentId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

export interface WorkerSnapshotRecord {
  readonly workerId: EnvironmentId;
  readonly t3oVersion: string | null;
  readonly protocolVersion: number | null;
  readonly lastSeenAt: string | null;
  readonly snapshot: BoardWorkerSnapshot | null;
}

export interface WorkerSnapshotStoreShape {
  readonly list: Effect.Effect<ReadonlyArray<WorkerSnapshotRecord>>;
  readonly write: (record: WorkerSnapshotRecord) => Effect.Effect<void>;
  readonly remove: (workerId: EnvironmentId) => Effect.Effect<void>;
}

export class WorkerSnapshotStore extends Context.Service<
  WorkerSnapshotStore,
  WorkerSnapshotStoreShape
>()("t3/board/workers/WorkerSnapshotStore") {}

const decodeSnapshot = Schema.decodeUnknownOption(Schema.fromJsonString(BoardWorkerSnapshot));
const encodeSnapshot = Schema.encodeSync(Schema.fromJsonString(BoardWorkerSnapshot));

const SnapshotRow = Schema.Struct({
  workerId: Schema.String,
  t3oVersion: Schema.NullOr(Schema.String),
  protocolVersion: Schema.NullOr(Schema.Number),
  lastSeenAt: Schema.NullOr(Schema.String),
  snapshotJson: Schema.NullOr(Schema.String),
});
const decodeRows = Schema.decodeUnknownEffect(Schema.Array(SnapshotRow));

/** The status a worker starts from on boot: what it last reported, connecting. */
export function bootStatus(record: WorkerSnapshotRecord | undefined): BoardWorkerStatus {
  return {
    state: "connecting",
    lastSeenAt: record?.lastSeenAt ?? null,
    t3oVersion: record?.t3oVersion ?? null,
    protocolVersion: record?.protocolVersion ?? null,
  };
}

/**
 * A failed read or write is logged and swallowed: the snapshot is a
 * convenience for the offline view, and a broken one must never stop the board
 * from talking to a worker that is online right now.
 */
export const WorkerSnapshotStoreLive = Layer.effect(
  WorkerSnapshotStore,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const logged =
      (message: string) =>
      <A, E>(effect: Effect.Effect<A, E>, fallback: A): Effect.Effect<A> =>
        effect.pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning(message, { cause }).pipe(Effect.as(fallback)),
          ),
        );
    return {
      list: logged("board worker snapshots unreadable")(
        sql`
          SELECT
            worker_id AS "workerId",
            t3o_version AS "t3oVersion",
            protocol_version AS "protocolVersion",
            last_seen_at AS "lastSeenAt",
            snapshot_json AS "snapshotJson"
          FROM board_worker_snapshots
        `.pipe(
          Effect.flatMap(decodeRows),
          Effect.map((rows) =>
            rows.map((row): WorkerSnapshotRecord => ({
              workerId: row.workerId as EnvironmentId,
              t3oVersion: row.t3oVersion,
              protocolVersion: row.protocolVersion,
              lastSeenAt: row.lastSeenAt,
              snapshot:
                row.snapshotJson === null
                  ? null
                  : Option.getOrNull(decodeSnapshot(row.snapshotJson)),
            })),
          ),
        ),
        [],
      ),
      write: (record) =>
        logged("board worker snapshot not saved")(
          sql`
            INSERT INTO board_worker_snapshots (
              worker_id, t3o_version, protocol_version, last_seen_at, snapshot_json
            )
            VALUES (
              ${record.workerId}, ${record.t3oVersion}, ${record.protocolVersion},
              ${record.lastSeenAt},
              ${record.snapshot === null ? null : encodeSnapshot(record.snapshot)}
            )
            ON CONFLICT (worker_id) DO UPDATE SET
              t3o_version = excluded.t3o_version,
              protocol_version = excluded.protocol_version,
              last_seen_at = excluded.last_seen_at,
              snapshot_json = excluded.snapshot_json
          `.pipe(Effect.asVoid),
          undefined,
        ),
      remove: (workerId) =>
        logged("board worker snapshot not removed")(
          sql`DELETE FROM board_worker_snapshots WHERE worker_id = ${workerId}`.pipe(Effect.asVoid),
          undefined,
        ),
    };
  }),
);

/** An in-memory store, for tests. */
export const makeMemoryWorkerSnapshotStore = Effect.gen(function* () {
  const rows = yield* Ref.make(new Map<EnvironmentId, WorkerSnapshotRecord>());
  const store: WorkerSnapshotStoreShape = {
    list: Ref.get(rows).pipe(Effect.map((map) => [...map.values()])),
    write: (record) => Ref.update(rows, (map) => new Map(map).set(record.workerId, record)),
    remove: (workerId) =>
      Ref.update(rows, (map) => {
        const next = new Map(map);
        next.delete(workerId);
        return next;
      }),
  };
  return store;
});
