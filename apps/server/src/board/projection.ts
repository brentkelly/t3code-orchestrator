/**
 * T3o board persisted projection and snapshot enrichment.
 *
 * `makeBoardProjectors` returns the `board_cards` projector definition that
 * the upstream ProjectionPipeline spreads into its projector list — same
 * transaction, same cursor bookkeeping as the stock projectors.
 *
 * `withBoardReadModel` / `withBoardShellCards` wrap the upstream snapshot
 * queries at their assembly point, so every consumer (engine bootstrap,
 * subscribeShell, HTTP snapshot) sees board state without further seams. The
 * card read runs just after the wrapped query's transaction; a card committed
 * in that window also arrives as a live `card-upserted` delta with a higher
 * sequence, and the client upsert is idempotent, so nothing is lost.
 */
import {
  BoardCard,
  type OrchestrationEvent,
  type OrchestrationReadModel,
  type OrchestrationShellSnapshot,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";

import { toPersistenceSqlError, type ProjectionRepositoryError } from "../persistence/Errors.ts";

export const BOARD_CARDS_PROJECTOR_NAME = "projection.board-cards" as const;

const BoardCardDbRow = Schema.Struct({
  cardId: BoardCard.fields.id,
  projectId: BoardCard.fields.projectId,
  title: BoardCard.fields.title,
  createdAt: BoardCard.fields.createdAt,
  updatedAt: BoardCard.fields.updatedAt,
});

function makeBoardCardQueries(sql: SqlClient.SqlClient) {
  const upsertBoardCardRow = SqlSchema.void({
    Request: BoardCardDbRow,
    execute: (row) => sql`
      INSERT INTO board_cards (
        card_id,
        project_id,
        title,
        created_at,
        updated_at
      )
      VALUES (
        ${row.cardId},
        ${row.projectId},
        ${row.title},
        ${row.createdAt},
        ${row.updatedAt}
      )
      ON CONFLICT (card_id)
      DO UPDATE SET
        project_id = excluded.project_id,
        title = excluded.title,
        created_at = excluded.created_at,
        updated_at = excluded.updated_at
    `,
  });

  const listBoardCardRows = SqlSchema.findAll({
    Request: Schema.Void,
    Result: BoardCardDbRow,
    execute: () => sql`
      SELECT
        card_id AS "cardId",
        project_id AS "projectId",
        title,
        created_at AS "createdAt",
        updated_at AS "updatedAt"
      FROM board_cards
      ORDER BY created_at ASC, card_id ASC
    `,
  });

  return { upsertBoardCardRow, listBoardCardRows };
}

export function makeBoardProjectors(sql: SqlClient.SqlClient): ReadonlyArray<{
  readonly name: typeof BOARD_CARDS_PROJECTOR_NAME;
  readonly apply: (event: OrchestrationEvent) => Effect.Effect<void, ProjectionRepositoryError>;
}> {
  const { upsertBoardCardRow } = makeBoardCardQueries(sql);

  const applyBoardCardsProjection = Effect.fn("applyBoardCardsProjection")(function* (
    event: OrchestrationEvent,
  ) {
    switch (event.type) {
      case "board.card-created":
        yield* upsertBoardCardRow({
          cardId: event.payload.cardId,
          projectId: event.payload.projectId,
          title: event.payload.title,
          createdAt: event.payload.createdAt,
          updatedAt: event.payload.updatedAt,
        }).pipe(Effect.mapError(toPersistenceSqlError("BoardCardsProjection.upsert:query")));
        return;

      default:
        return;
    }
  });

  return [
    {
      name: BOARD_CARDS_PROJECTOR_NAME,
      apply: applyBoardCardsProjection,
    },
  ];
}

export function listBoardCards(
  sql: SqlClient.SqlClient,
): Effect.Effect<ReadonlyArray<BoardCard>, ProjectionRepositoryError> {
  const { listBoardCardRows } = makeBoardCardQueries(sql);
  return listBoardCardRows().pipe(
    Effect.map((rows) =>
      rows.map((row) => ({
        id: row.cardId,
        projectId: row.projectId,
        title: row.title,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
      })),
    ),
    Effect.mapError(toPersistenceSqlError("BoardCardsProjection.list:query")),
  );
}

export function withBoardReadModel(
  sql: SqlClient.SqlClient,
  readModel: Effect.Effect<OrchestrationReadModel, ProjectionRepositoryError>,
): Effect.Effect<OrchestrationReadModel, ProjectionRepositoryError> {
  return Effect.all([readModel, listBoardCards(sql)]).pipe(
    Effect.map(([model, cards]) => ({ ...model, board: { cards } })),
  );
}

export function withBoardShellCards(
  sql: SqlClient.SqlClient,
  snapshot: Effect.Effect<OrchestrationShellSnapshot, ProjectionRepositoryError>,
): Effect.Effect<OrchestrationShellSnapshot, ProjectionRepositoryError> {
  return Effect.all([snapshot, listBoardCards(sql)]).pipe(
    Effect.map(([shell, cards]) => ({ ...shell, cards })),
  );
}
