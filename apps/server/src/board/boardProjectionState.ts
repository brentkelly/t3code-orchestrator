/**
 * Projector watermarks, routed to the database that owns them (t3o-26 P1).
 *
 * The projection pipeline commits a projector's writes and its watermark inside
 * ONE `sql.withTransaction`. Once the board's tables moved into `boards.sqlite`,
 * a board projector's transaction would have spanned two attached databases —
 * and SQLite drops cross-database atomicity in WAL mode, committing each
 * database separately.
 *
 * Of the two ways that can tear, one is harmless and one is not:
 *
 * - board rows committed, watermark not → the events replay on the next boot,
 *   and every board write is an upsert, so the result is identical.
 * - watermark committed, board rows not → the projector skips events it never
 *   applied. A card update is lost, permanently and silently.
 *
 * Routing the board's watermark into `boards.projection_state` keeps a board
 * projector's whole transaction inside one file, which SQLite does commit
 * atomically. Upstream projectors are untouched and still read and write
 * `main.projection_state`.
 *
 * Reads that span all projectors (`listAll`, `minLastAppliedSequence`) union the
 * two tables, so callers still see one logical set of watermarks.
 */
import { NonNegativeInt } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";

import { toPersistenceSqlError } from "../persistence/Errors.ts";
import {
  GetProjectionStateInput,
  ProjectionStateRepository,
  type ProjectionStateRepositoryShape,
  ProjectionState,
} from "../persistence/Services/ProjectionState.ts";

/**
 * Board projector names share this prefix, and migration 031 moves exactly the
 * rows matching it. Keep the two in step: a board projector whose name does not
 * match would silently keep its watermark in `main`, reopening the tear this
 * module exists to close.
 */
export const BOARD_PROJECTOR_NAME_PREFIX = "projection.board-";

export const isBoardProjectorName = (projector: string): boolean =>
  projector.startsWith(BOARD_PROJECTOR_NAME_PREFIX);

/**
 * The prefix as a LIKE pattern, used to EXCLUDE board rows from every main-side
 * read. A stale `projection.board-*` row can exist in `main` — migration 031's
 * cross-database transaction can tear leaving its DELETE uncommitted, and a
 * downgrade/upgrade cycle writes one back — and since `upsert` routes board
 * names to `boards`, a shadowing read would never self-heal: the projector
 * would bootstrap from the frozen `main` watermark on every boot, replaying an
 * ever-growing tail of the log forever. Excluding it in the reads makes the
 * stale row unreachable no matter how it got there. (`_` matters in LIKE, but
 * the prefix contains none.)
 */
const BOARD_PROJECTOR_NAME_LIKE = `${BOARD_PROJECTOR_NAME_PREFIX}%`;

const MinRowSchema = Schema.Struct({
  minLastAppliedSequence: Schema.NullOr(NonNegativeInt),
});

const makeBoardAwareProjectionStateRepository = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const upsertMain = SqlSchema.void({
    Request: ProjectionState,
    execute: (row) => sql`
      INSERT INTO main.projection_state (projector, last_applied_sequence, updated_at)
      VALUES (${row.projector}, ${row.lastAppliedSequence}, ${row.updatedAt})
      ON CONFLICT (projector) DO UPDATE SET
        last_applied_sequence = excluded.last_applied_sequence,
        updated_at = excluded.updated_at
    `,
  });

  const upsertBoard = SqlSchema.void({
    Request: ProjectionState,
    execute: (row) => sql`
      INSERT INTO boards.projection_state (projector, last_applied_sequence, updated_at)
      VALUES (${row.projector}, ${row.lastAppliedSequence}, ${row.updatedAt})
      ON CONFLICT (projector) DO UPDATE SET
        last_applied_sequence = excluded.last_applied_sequence,
        updated_at = excluded.updated_at
    `,
  });

  const selectAll = SqlSchema.findAll({
    Request: Schema.Void,
    Result: ProjectionState,
    execute: () => sql`
      SELECT projector, last_applied_sequence AS "lastAppliedSequence", updated_at AS "updatedAt"
      FROM main.projection_state
      WHERE projector NOT LIKE ${BOARD_PROJECTOR_NAME_LIKE}
      UNION ALL
      SELECT projector, last_applied_sequence AS "lastAppliedSequence", updated_at AS "updatedAt"
      FROM boards.projection_state
    `,
  });

  const selectByProjector = SqlSchema.findOneOption({
    Request: GetProjectionStateInput,
    Result: ProjectionState,
    execute: ({ projector }) => sql`
      SELECT projector, last_applied_sequence AS "lastAppliedSequence", updated_at AS "updatedAt"
      FROM main.projection_state
      WHERE projector = ${projector}
        AND projector NOT LIKE ${BOARD_PROJECTOR_NAME_LIKE}
      UNION ALL
      SELECT projector, last_applied_sequence AS "lastAppliedSequence", updated_at AS "updatedAt"
      FROM boards.projection_state WHERE projector = ${projector}
    `,
  });

  const selectMin = SqlSchema.findOne({
    Request: Schema.Void,
    Result: MinRowSchema,
    execute: () => sql`
      SELECT MIN(last_applied_sequence) AS "minLastAppliedSequence" FROM (
        SELECT last_applied_sequence FROM main.projection_state
        WHERE projector NOT LIKE ${BOARD_PROJECTOR_NAME_LIKE}
        UNION ALL
        SELECT last_applied_sequence FROM boards.projection_state
      )
    `,
  });

  const upsert: ProjectionStateRepositoryShape["upsert"] = (row) =>
    (isBoardProjectorName(row.projector) ? upsertBoard(row) : upsertMain(row)).pipe(
      Effect.mapError(toPersistenceSqlError("ProjectionStateRepository.upsert:query")),
    );

  const getByProjector: ProjectionStateRepositoryShape["getByProjector"] = (input) =>
    selectByProjector(input).pipe(
      Effect.mapError(toPersistenceSqlError("ProjectionStateRepository.getByProjector:query")),
    );

  const listAll: ProjectionStateRepositoryShape["listAll"] = () =>
    selectAll(undefined).pipe(
      Effect.mapError(toPersistenceSqlError("ProjectionStateRepository.listAll:query")),
    );

  const minLastAppliedSequence: ProjectionStateRepositoryShape["minLastAppliedSequence"] = () =>
    selectMin(undefined).pipe(
      Effect.mapError(
        toPersistenceSqlError("ProjectionStateRepository.minLastAppliedSequence:query"),
      ),
      Effect.map((row) => row.minLastAppliedSequence),
    );

  return {
    upsert,
    getByProjector,
    listAll,
    minLastAppliedSequence,
  } satisfies ProjectionStateRepositoryShape;
});

export const BoardAwareProjectionStateRepositoryLive = Layer.effect(
  ProjectionStateRepository,
  makeBoardAwareProjectionStateRepository,
);
