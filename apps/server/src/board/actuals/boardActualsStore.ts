/**
 * The board's actuals table (T3O-87, migration 075): one row per card step a worker measured.
 * A row is upserted while its step runs (figures so far) and once more when it ends.
 */
import {
  BoardResourceProfile,
  BoardStepReading,
  boardStepNotMeasured,
  type BoardActualsStepKind,
  type BoardCardActualsRow,
  type BoardCardId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import type * as SqlClient from "effect/sql/SqlClient";

const ReadingJson = Schema.fromJsonString(BoardStepReading);
const ProfileJson = Schema.fromJsonString(BoardResourceProfile);
const encodeReading = Schema.encodeSync(ReadingJson);
const encodeProfile = Schema.encodeSync(ProfileJson);
const decodeReading = Schema.decodeUnknownOption(ReadingJson);
const decodeProfile = Schema.decodeUnknownOption(ProfileJson);

interface DbRow {
  readonly cardId: BoardCardId;
  readonly stepKey: string;
  readonly kind: BoardActualsStepKind;
  readonly stepId: string | null;
  readonly label: string;
  readonly workerId: string;
  readonly grantedProfile: string | null;
  readonly startedAt: string;
  readonly endedAt: string | null;
  readonly reading: string;
  readonly updatedAt: string;
}

export type BoardStoredActualsRow = BoardCardActualsRow & { readonly cardId: BoardCardId };

const fromDb = (row: DbRow): BoardStoredActualsRow => ({
  cardId: row.cardId,
  stepKey: row.stepKey,
  kind: row.kind,
  stepId: row.stepId,
  label: row.label,
  workerId: row.workerId,
  grantedProfile:
    row.grantedProfile === null ? null : Option.getOrNull(decodeProfile(row.grantedProfile)),
  startedAt: row.startedAt,
  endedAt: row.endedAt,
  // A row that no longer decodes still says something was there, never a 0.
  reading: Option.getOrElse(decodeReading(row.reading), () =>
    boardStepNotMeasured("The stored reading could not be read."),
  ),
  updatedAt: row.updatedAt,
});

const COLUMNS = `
  card_id AS "cardId", step_key AS "stepKey", kind, step_id AS "stepId", label,
  worker_id AS "workerId", granted_profile AS "grantedProfile", started_at AS "startedAt",
  ended_at AS "endedAt", reading, updated_at AS "updatedAt"
`;

export const upsertActualsRow = Effect.fn("boardActualsStore.upsertActualsRow")(function* (
  sql: SqlClient.SqlClient,
  row: BoardStoredActualsRow,
) {
  yield* sql`
    INSERT INTO boards.board_card_actuals (
      card_id, step_key, kind, step_id, label, worker_id, granted_profile,
      started_at, ended_at, reading, updated_at
    ) VALUES (
      ${row.cardId}, ${row.stepKey}, ${row.kind}, ${row.stepId}, ${row.label}, ${row.workerId},
      ${row.grantedProfile === null ? null : encodeProfile(row.grantedProfile)},
      ${row.startedAt}, ${row.endedAt}, ${encodeReading(row.reading)}, ${row.updatedAt}
    )
    ON CONFLICT (card_id, step_key) DO UPDATE SET
      ended_at = excluded.ended_at,
      reading = excluded.reading,
      updated_at = excluded.updated_at
  `;
});

/** One card's rows for its detail, oldest first. */
export const listCardActualsRows = Effect.fn("boardActualsStore.listCardActualsRows")(function* (
  sql: SqlClient.SqlClient,
  cardId: BoardCardId,
) {
  const rows = yield* sql<DbRow>`
    SELECT ${sql.literal(COLUMNS)} FROM boards.board_card_actuals
    WHERE card_id = ${cardId}
    ORDER BY started_at, step_key
  `;
  return rows.map((row): BoardCardActualsRow => {
    const { cardId: _cardId, ...rest } = fromDb(row);
    return rest;
  });
});

/** Whether a step already has its row, open or ended. */
export const hasActualsRow = Effect.fn("boardActualsStore.hasActualsRow")(function* (
  sql: SqlClient.SqlClient,
  cardId: BoardCardId,
  stepKey: string,
) {
  const rows = yield* sql<{ readonly one: number }>`
    SELECT 1 AS one FROM boards.board_card_actuals
    WHERE card_id = ${cardId} AND step_key = ${stepKey}
    LIMIT 1
  `;
  return rows.length > 0;
});

/** Every row whose step hasn't ended, to read again or end. */
export const listOpenActualsRows = Effect.fn("boardActualsStore.listOpenActualsRows")(function* (
  sql: SqlClient.SqlClient,
) {
  const rows = yield* sql<DbRow>`
    SELECT ${sql.literal(COLUMNS)} FROM boards.board_card_actuals
    WHERE ended_at IS NULL
  `;
  return rows.map(fromDb);
});

/** The rows of these cards that ended since `since`, for learning. */
export const listEndedActualsRows = Effect.fn("boardActualsStore.listEndedActualsRows")(function* (
  sql: SqlClient.SqlClient,
  cardIds: ReadonlyArray<BoardCardId>,
  since: string,
) {
  if (cardIds.length === 0) return [];
  const rows = yield* sql<DbRow>`
    SELECT ${sql.literal(COLUMNS)} FROM boards.board_card_actuals
    WHERE card_id IN ${sql.in(cardIds)} AND ended_at IS NOT NULL AND ended_at >= ${since}
  `;
  return rows.map(fromDb);
});
