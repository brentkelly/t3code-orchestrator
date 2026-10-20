// T3O-56: the board's own event log, command receipts and watermarks.
//
// Board commands used to ride upstream's orchestration engine, so their events
// sat in `main.orchestration_events` and their receipts in
// `main.orchestration_command_receipts`. The board now has its own engine
// (`BoardEngine.ts`); this creates the tables it writes, in `boards.sqlite`, and
// copies the history across.
//
// - `board_events` has upstream's event DDL with its OWN `AUTOINCREMENT`
//   sequence. The two logs share no sequence space and define no interleaving.
// - History is copied in sequence order and renumbered 1..N. The source rows are
//   LEFT in `main`: v1 replay tolerates them, v2 ignores v1-version rows, and
//   leaving them keeps a rollback to an older build possible.
// - Receipts carry a result sequence, which is renumbered into the board's
//   space: an accepted receipt points at its own last event, a rejected one at
//   the board head when it was refused.
// - The old `projection.board-cards` watermark counted MAIN sequences. It splits
//   in two: the board log projector's watermark in board sequences, and the
//   cursor of the read-only tail of upstream's thread events (todo cache), which
//   stays in main sequences.
//
// Re-runnable: every insert skips rows already present, so a second run is a
// no-op. The migrator runs it once; idempotence is what makes a torn first run
// safe to retry.
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/** The pre-T3O-56 board projector's watermark, in MAIN sequences. */
const LEGACY_BOARD_PROJECTOR = "projection.board-cards";
/** Kept in step with `BOARD_EVENTS_PROJECTOR` in `BoardEngine.ts`. */
const BOARD_EVENTS_PROJECTOR = "projection.board-events";
/** Kept in step with `BOARD_THREAD_TAIL_PROJECTOR` in `boardThreadTail.ts`. */
const BOARD_THREAD_TAIL_PROJECTOR = "projection.board-thread-tail";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE IF NOT EXISTS boards.board_events (
      sequence INTEGER PRIMARY KEY AUTOINCREMENT,
      event_id TEXT NOT NULL UNIQUE,
      aggregate_kind TEXT NOT NULL,
      stream_id TEXT NOT NULL,
      stream_version INTEGER NOT NULL,
      event_type TEXT NOT NULL,
      occurred_at TEXT NOT NULL,
      command_id TEXT,
      causation_event_id TEXT,
      correlation_id TEXT,
      actor_kind TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      metadata_json TEXT NOT NULL
    )
  `;
  yield* sql`
    CREATE UNIQUE INDEX IF NOT EXISTS boards.idx_board_events_stream_version
    ON board_events(aggregate_kind, stream_id, stream_version)
  `;
  yield* sql`
    CREATE INDEX IF NOT EXISTS boards.idx_board_events_command_id
    ON board_events(command_id)
  `;

  yield* sql`
    CREATE TABLE IF NOT EXISTS boards.board_command_receipts (
      command_id TEXT PRIMARY KEY,
      aggregate_kind TEXT NOT NULL,
      aggregate_id TEXT NOT NULL,
      accepted_at TEXT NOT NULL,
      result_sequence INTEGER NOT NULL,
      status TEXT NOT NULL,
      error TEXT
    )
  `;

  // A database that never ran an older build has no upstream log to read from
  // in this lineage's test layer; `main.orchestration_events` always exists in
  // production because upstream's migrations run first.
  const [sourceTable] = yield* sql<{ readonly n: number }>`
    SELECT COUNT(*) AS n FROM main.sqlite_master
    WHERE type = 'table' AND name = 'orchestration_events'
  `;
  if ((sourceTable?.n ?? 0) > 0) {
    // Renumbered after whatever is already there, in main's order. `NOT EXISTS`
    // on the unique event id is the idempotence. The offset is read first so the
    // insert never reads the table it is writing.
    const [head] = yield* sql<{ readonly sequence: number }>`
      SELECT COALESCE(MAX(sequence), 0) AS sequence FROM boards.board_events
    `;
    const offset = head?.sequence ?? 0;
    yield* sql`
      INSERT INTO boards.board_events (
        sequence, event_id, aggregate_kind, stream_id, stream_version, event_type,
        occurred_at, command_id, causation_event_id, correlation_id, actor_kind,
        payload_json, metadata_json
      )
      SELECT
        ${offset} + ROW_NUMBER() OVER (ORDER BY source.sequence),
        source.event_id, source.aggregate_kind, source.stream_id, source.stream_version,
        source.event_type, source.occurred_at, source.command_id, source.causation_event_id,
        source.correlation_id, source.actor_kind, source.payload_json, source.metadata_json
      FROM main.orchestration_events AS source
      WHERE substr(source.event_type, 1, 6) = 'board.'
        AND NOT EXISTS (
          SELECT 1 FROM boards.board_events AS copied WHERE copied.event_id = source.event_id
        )
      ORDER BY source.sequence
    `;

    // Main sequence -> board sequence for every copied event, so receipts and
    // the watermark can be renumbered with an index-served lookup.
    yield* sql`DROP TABLE IF EXISTS temp.t3o_board_event_sequence_map`;
    yield* sql`
      CREATE TEMP TABLE t3o_board_event_sequence_map (
        main_sequence INTEGER PRIMARY KEY,
        board_sequence INTEGER NOT NULL
      )
    `;
    yield* sql`
      INSERT INTO temp.t3o_board_event_sequence_map (main_sequence, board_sequence)
      SELECT source.sequence, copied.sequence
      FROM boards.board_events AS copied
      JOIN main.orchestration_events AS source ON source.event_id = copied.event_id
    `;

    // The board head as of a main sequence: the last copied event at or below it.
    yield* sql`
      INSERT OR IGNORE INTO boards.board_command_receipts (
        command_id, aggregate_kind, aggregate_id, accepted_at, result_sequence, status, error
      )
      SELECT
        receipt.command_id, receipt.aggregate_kind, receipt.aggregate_id, receipt.accepted_at,
        COALESCE((
          SELECT map.board_sequence FROM temp.t3o_board_event_sequence_map AS map
          WHERE map.main_sequence <= receipt.result_sequence
          ORDER BY map.main_sequence DESC
          LIMIT 1
        ), 0),
        receipt.status, receipt.error
      FROM main.orchestration_command_receipts AS receipt
      WHERE receipt.aggregate_kind IN ('card', 'label', 'stage', 'provider-limit')
    `;

    // The legacy watermark splits: the board log projector resumes at the last
    // copied event it had already applied, and the upstream tail resumes at the
    // legacy watermark itself.
    yield* sql`
      INSERT OR IGNORE INTO boards.projection_state (projector, last_applied_sequence, updated_at)
      SELECT
        ${BOARD_EVENTS_PROJECTOR},
        COALESCE((
          SELECT map.board_sequence FROM temp.t3o_board_event_sequence_map AS map
          WHERE map.main_sequence <= legacy.last_applied_sequence
          ORDER BY map.main_sequence DESC
          LIMIT 1
        ), 0),
        legacy.updated_at
      FROM boards.projection_state AS legacy
      WHERE legacy.projector = ${LEGACY_BOARD_PROJECTOR}
    `;
    yield* sql`DROP TABLE IF EXISTS temp.t3o_board_event_sequence_map`;
  }

  yield* sql`
    INSERT OR IGNORE INTO boards.projection_state (projector, last_applied_sequence, updated_at)
    SELECT ${BOARD_THREAD_TAIL_PROJECTOR}, last_applied_sequence, updated_at
    FROM boards.projection_state
    WHERE projector = ${LEGACY_BOARD_PROJECTOR}
  `;
  yield* sql`DELETE FROM boards.projection_state WHERE projector = ${LEGACY_BOARD_PROJECTOR}`;
});
