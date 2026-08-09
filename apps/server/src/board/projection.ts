/**
 * T3o board persisted projection and snapshot enrichment.
 *
 * `makeBoardProjectors` returns the `board_cards` projector definition that
 * the upstream ProjectionPipeline spreads into its projector list — same
 * transaction, same cursor bookkeeping as the stock projectors. It owns all
 * three board tables (`board_cards`, `board_card_bodies`,
 * `board_card_thread_links`) so a card and its side rows always commit
 * together. `BOARD_PROJECTOR_NAMES` is spread into the pipeline's name
 * registry the same way; new board projectors register in both, never at the
 * seam.
 *
 * `boardSnapshotQueryMethods` wraps the upstream snapshot queries at their
 * assembly point (spread after the base methods so the board-wrapped
 * versions override), so every consumer (engine bootstrap, subscribeShell,
 * HTTP snapshot) sees board state without further seams. The card read runs
 * just after the wrapped query's transaction; a card committed in that
 * window also arrives as a live `card-upserted` delta with a higher
 * sequence, and the client upsert is idempotent, so nothing is lost.
 */
import {
  BOARD_CARD_BRIEF_BODY_KIND,
  BoardCard,
  BoardCardExternalRef,
  BoardCardId,
  BoardCardRecipeSnapshot,
  BoardCardThreadLink,
  isBoardEvent,
  type BoardState,
  type OrchestrationEvent,
  type OrchestrationReadModel,
  type OrchestrationShellSnapshot,
  ProjectId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";

import { toPersistenceSqlError, type ProjectionRepositoryError } from "../persistence/Errors.ts";
import type { ProjectionSnapshotQueryShape } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { boardCardFromCreatedPayload } from "./projector.ts";

export const BOARD_CARDS_PROJECTOR_NAME = "projection.board-cards" as const;

/**
 * Spread into upstream's `ORCHESTRATION_PROJECTOR_NAMES`. Keeping board
 * projectors inside that record (rather than only widening the name type)
 * keeps `Object.keys(ORCHESTRATION_PROJECTOR_NAMES)` equal to the set of
 * projection_state rows the pipeline writes, which upstream tests assert on.
 */
export const BOARD_PROJECTOR_NAMES = {
  boardCards: BOARD_CARDS_PROJECTOR_NAME,
} as const;

// `blocked` travels as 0/1 (SQLite has no boolean); the JSON-shaped columns
// encode/decode through fromJsonString so the row schema's Type side stays
// the domain shape.
const BoardCardDbRow = Schema.Struct({
  cardId: BoardCard.fields.id,
  key: BoardCard.fields.key,
  cardNumber: BoardCard.fields.cardNumber,
  projectId: BoardCard.fields.projectId,
  cardType: BoardCard.fields.type,
  stage: BoardCard.fields.stage,
  orderKey: BoardCard.fields.orderKey,
  title: BoardCard.fields.title,
  briefRef: BoardCard.fields.briefRef,
  dependsOn: Schema.fromJsonString(Schema.Array(BoardCardId)),
  parentCardId: BoardCard.fields.parentCardId,
  externalRef: Schema.NullOr(Schema.fromJsonString(BoardCardExternalRef)),
  recipeSnapshot: Schema.NullOr(Schema.fromJsonString(BoardCardRecipeSnapshot)),
  blocked: Schema.Int,
  archivedAt: BoardCard.fields.archivedAt,
  createdAt: BoardCard.fields.createdAt,
  updatedAt: BoardCard.fields.updatedAt,
});
type BoardCardDbRow = typeof BoardCardDbRow.Type;

const BoardCardThreadLinkDbRow = Schema.Struct({
  threadId: BoardCardThreadLink.fields.threadId,
  cardId: BoardCardId,
  role: BoardCardThreadLink.fields.role,
  linkedAt: BoardCardThreadLink.fields.linkedAt,
  tombstonedAt: BoardCardThreadLink.fields.tombstonedAt,
});
type BoardCardThreadLinkDbRow = typeof BoardCardThreadLinkDbRow.Type;

const NextCardNumberDbRow = Schema.Struct({
  projectId: ProjectId,
  maxCardNumber: Schema.Int,
});

function boardCardToRow(card: BoardCard): BoardCardDbRow {
  return {
    cardId: card.id,
    key: card.key,
    cardNumber: card.cardNumber,
    projectId: card.projectId,
    cardType: card.type,
    stage: card.stage,
    orderKey: card.orderKey,
    title: card.title,
    briefRef: card.briefRef,
    dependsOn: card.dependsOn,
    parentCardId: card.parentCardId,
    externalRef: card.externalRef,
    recipeSnapshot: card.recipeSnapshot,
    blocked: card.blocked ? 1 : 0,
    archivedAt: card.archivedAt,
    createdAt: card.createdAt,
    updatedAt: card.updatedAt,
  };
}

function rowToBoardCard(
  row: BoardCardDbRow,
  threadLinks: ReadonlyArray<BoardCardThreadLink>,
): BoardCard {
  return {
    id: row.cardId,
    key: row.key,
    cardNumber: row.cardNumber,
    projectId: row.projectId,
    type: row.cardType,
    stage: row.stage,
    orderKey: row.orderKey,
    title: row.title,
    briefRef: row.briefRef,
    dependsOn: row.dependsOn,
    parentCardId: row.parentCardId,
    externalRef: row.externalRef,
    recipeSnapshot: row.recipeSnapshot,
    blocked: row.blocked !== 0,
    threadLinks,
    archivedAt: row.archivedAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function makeBoardCardQueries(sql: SqlClient.SqlClient) {
  const upsertBoardCardRow = SqlSchema.void({
    Request: BoardCardDbRow,
    execute: (row) => sql`
      INSERT INTO board_cards (
        card_id,
        key,
        card_number,
        project_id,
        card_type,
        stage,
        order_key,
        title,
        brief_ref,
        depends_on,
        parent_card_id,
        external_ref,
        recipe_snapshot,
        blocked,
        archived_at,
        created_at,
        updated_at
      )
      VALUES (
        ${row.cardId},
        ${row.key},
        ${row.cardNumber},
        ${row.projectId},
        ${row.cardType},
        ${row.stage},
        ${row.orderKey},
        ${row.title},
        ${row.briefRef},
        ${row.dependsOn},
        ${row.parentCardId},
        ${row.externalRef},
        ${row.recipeSnapshot},
        ${row.blocked},
        ${row.archivedAt},
        ${row.createdAt},
        ${row.updatedAt}
      )
      ON CONFLICT (card_id)
      DO UPDATE SET
        key = excluded.key,
        card_number = excluded.card_number,
        project_id = excluded.project_id,
        card_type = excluded.card_type,
        stage = excluded.stage,
        order_key = excluded.order_key,
        title = excluded.title,
        brief_ref = excluded.brief_ref,
        depends_on = excluded.depends_on,
        parent_card_id = excluded.parent_card_id,
        external_ref = excluded.external_ref,
        recipe_snapshot = excluded.recipe_snapshot,
        blocked = excluded.blocked,
        archived_at = excluded.archived_at,
        created_at = excluded.created_at,
        updated_at = excluded.updated_at
    `,
  });

  // Canonical card order: matches the in-memory projector's
  // `compareBoardCards` (see projector.ts) so replay equals rehydration.
  const listBoardCardRows = SqlSchema.findAll({
    Request: Schema.Void,
    Result: BoardCardDbRow,
    execute: () => sql`
      SELECT
        card_id AS "cardId",
        key,
        card_number AS "cardNumber",
        project_id AS "projectId",
        card_type AS "cardType",
        stage,
        order_key AS "orderKey",
        title,
        brief_ref AS "briefRef",
        depends_on AS "dependsOn",
        parent_card_id AS "parentCardId",
        external_ref AS "externalRef",
        recipe_snapshot AS "recipeSnapshot",
        blocked,
        archived_at AS "archivedAt",
        created_at AS "createdAt",
        updated_at AS "updatedAt"
      FROM board_cards
      ORDER BY created_at ASC, card_id ASC
    `,
  });

  // Canonical link order: matches `sortBoardCardThreadLinks` in contracts.
  const listBoardCardThreadLinkRows = SqlSchema.findAll({
    Request: Schema.Void,
    Result: BoardCardThreadLinkDbRow,
    execute: () => sql`
      SELECT
        thread_id AS "threadId",
        card_id AS "cardId",
        role,
        linked_at AS "linkedAt",
        tombstoned_at AS "tombstonedAt"
      FROM board_card_thread_links
      ORDER BY linked_at ASC, thread_id ASC
    `,
  });

  // MAX over ALL rows — archived cards keep their numbers reserved, so a
  // future D15 cleanup that drops archived cards from the read model can
  // never re-issue a key.
  const listNextCardNumberRows = SqlSchema.findAll({
    Request: Schema.Void,
    Result: NextCardNumberDbRow,
    execute: () => sql`
      SELECT
        project_id AS "projectId",
        MAX(card_number) AS "maxCardNumber"
      FROM board_cards
      GROUP BY project_id
    `,
  });

  const deleteBoardCardThreadLinksForCard = SqlSchema.void({
    Request: BoardCardId,
    execute: (cardId) => sql`
      DELETE FROM board_card_thread_links
      WHERE card_id = ${cardId}
    `,
  });

  const insertBoardCardThreadLinkRow = SqlSchema.void({
    Request: BoardCardThreadLinkDbRow,
    execute: (row) => sql`
      INSERT INTO board_card_thread_links (
        thread_id,
        card_id,
        role,
        linked_at,
        tombstoned_at
      )
      VALUES (
        ${row.threadId},
        ${row.cardId},
        ${row.role},
        ${row.linkedAt},
        ${row.tombstonedAt}
      )
      ON CONFLICT (thread_id)
      DO UPDATE SET
        card_id = excluded.card_id,
        role = excluded.role,
        linked_at = excluded.linked_at,
        tombstoned_at = excluded.tombstoned_at
    `,
  });

  const BoardCardBodyDbRow = Schema.Struct({
    cardId: BoardCardId,
    kind: Schema.String,
    body: Schema.String,
    updatedAt: BoardCard.fields.updatedAt,
  });

  const upsertBoardCardBodyRow = SqlSchema.void({
    Request: BoardCardBodyDbRow,
    execute: (row) => sql`
      INSERT INTO board_card_bodies (card_id, kind, body, updated_at)
      VALUES (${row.cardId}, ${row.kind}, ${row.body}, ${row.updatedAt})
      ON CONFLICT (card_id, kind)
      DO UPDATE SET
        body = excluded.body,
        updated_at = excluded.updated_at
    `,
  });

  const DeleteBodyRequest = Schema.Struct({ cardId: BoardCardId, kind: Schema.String });
  const deleteBoardCardBodyRow = SqlSchema.void({
    Request: DeleteBodyRequest,
    execute: (request) => sql`
      DELETE FROM board_card_bodies
      WHERE card_id = ${request.cardId} AND kind = ${request.kind}
    `,
  });

  return {
    upsertBoardCardRow,
    listBoardCardRows,
    listBoardCardThreadLinkRows,
    listNextCardNumberRows,
    deleteBoardCardThreadLinksForCard,
    insertBoardCardThreadLinkRow,
    upsertBoardCardBodyRow,
    deleteBoardCardBodyRow,
  };
}

export function makeBoardProjectors(sql: SqlClient.SqlClient): ReadonlyArray<{
  readonly name: typeof BOARD_CARDS_PROJECTOR_NAME;
  readonly apply: (event: OrchestrationEvent) => Effect.Effect<void, ProjectionRepositoryError>;
}> {
  const queries = makeBoardCardQueries(sql);

  const upsertCard = (card: BoardCard) =>
    queries
      .upsertBoardCardRow(boardCardToRow(card))
      .pipe(Effect.mapError(toPersistenceSqlError("BoardCardsProjection.upsert:query")));

  // Wholesale rewrite of a card's link rows from the event's card state:
  // idempotent, and structurally incapable of drifting from the read model.
  const syncThreadLinks = (card: BoardCard) =>
    Effect.gen(function* () {
      yield* queries.deleteBoardCardThreadLinksForCard(card.id);
      for (const link of card.threadLinks) {
        yield* queries.insertBoardCardThreadLinkRow({
          threadId: link.threadId,
          cardId: card.id,
          role: link.role,
          linkedAt: link.linkedAt,
          tombstonedAt: link.tombstonedAt,
        });
      }
    }).pipe(Effect.mapError(toPersistenceSqlError("BoardCardsProjection.threadLinks:query")));

  const applyBoardCardsProjection = Effect.fn("applyBoardCardsProjection")(function* (
    event: OrchestrationEvent,
  ) {
    if (!isBoardEvent(event)) return;
    switch (event.type) {
      case "board.card-created":
        yield* upsertCard(boardCardFromCreatedPayload(event.payload));
        return;

      case "board.card-moved":
      case "board.card-reordered":
      case "board.card-archived":
      case "board.card-unarchived":
        yield* upsertCard(event.payload.card);
        return;

      case "board.card-updated": {
        yield* upsertCard(event.payload.card);
        // Bodies live only in this table (D8); absent means unchanged.
        if (event.payload.brief === null) {
          yield* queries
            .deleteBoardCardBodyRow({
              cardId: event.payload.cardId,
              kind: BOARD_CARD_BRIEF_BODY_KIND,
            })
            .pipe(Effect.mapError(toPersistenceSqlError("BoardCardsProjection.body:query")));
        } else if (event.payload.brief !== undefined) {
          yield* queries
            .upsertBoardCardBodyRow({
              cardId: event.payload.cardId,
              kind: BOARD_CARD_BRIEF_BODY_KIND,
              body: event.payload.brief,
              updatedAt: event.payload.card.updatedAt,
            })
            .pipe(Effect.mapError(toPersistenceSqlError("BoardCardsProjection.body:query")));
        }
        return;
      }

      case "board.card-thread-linked":
      case "board.card-thread-unlinked":
        yield* upsertCard(event.payload.card);
        yield* syncThreadLinks(event.payload.card);
        return;

      default: {
        event satisfies never;
        return;
      }
    }
  });

  return [
    {
      name: BOARD_CARDS_PROJECTOR_NAME,
      apply: applyBoardCardsProjection,
    },
  ];
}

/**
 * The board slice rehydrated from the projection tables, or null when no
 * card has ever been created (the board field stays absent then — see the
 * enricher note below). Archived cards are included: they stay in the read
 * model so unarchive and replay work; the shell filter drops them.
 */
export function loadBoardState(
  sql: SqlClient.SqlClient,
): Effect.Effect<BoardState | null, ProjectionRepositoryError> {
  const queries = makeBoardCardQueries(sql);
  return Effect.all([
    queries.listBoardCardRows(),
    queries.listBoardCardThreadLinkRows(),
    queries.listNextCardNumberRows(),
  ]).pipe(
    Effect.map(([cardRows, linkRows, counterRows]) => {
      if (cardRows.length === 0) return null;
      const linksByCard = new Map<BoardCardId, BoardCardThreadLink[]>();
      for (const row of linkRows) {
        const links = linksByCard.get(row.cardId) ?? [];
        links.push({
          threadId: row.threadId,
          role: row.role,
          linkedAt: row.linkedAt,
          tombstonedAt: row.tombstonedAt,
        });
        linksByCard.set(row.cardId, links);
      }
      return {
        cards: cardRows.map((row) => rowToBoardCard(row, linksByCard.get(row.cardId) ?? [])),
        nextCardNumberByProject: Object.fromEntries(
          counterRows.map((row) => [row.projectId, row.maxCardNumber + 1]),
        ),
      };
    }),
    Effect.mapError(toPersistenceSqlError("BoardCardsProjection.list:query")),
  );
}

// Both enrichers omit the board data entirely when no card has ever been
// created. A never-used board is represented as an *absent* field, never as
// `{ cards: [] }`, for two reasons: (1) it makes a from-empty replay's read
// model equal the table-rehydrated one for the no-cards case —
// createEmptyReadModel and projectBoardEvent never synthesize an empty
// `board`, so rehydration must not either; (2) it keeps an empty `cards: []`
// off every shell payload (payload discipline). Every consumer already reads
// through `board ?? EMPTY_BOARD_STATE` / `cards ?? []`, so absent and empty
// are equivalent downstream.
export function withBoardReadModel(
  sql: SqlClient.SqlClient,
  readModel: Effect.Effect<OrchestrationReadModel, ProjectionRepositoryError>,
): Effect.Effect<OrchestrationReadModel, ProjectionRepositoryError> {
  return Effect.all([readModel, loadBoardState(sql)]).pipe(
    Effect.map(([model, board]) => (board === null ? model : { ...model, board })),
  );
}

export function withBoardShellCards(
  sql: SqlClient.SqlClient,
  snapshot: Effect.Effect<OrchestrationShellSnapshot, ProjectionRepositoryError>,
): Effect.Effect<OrchestrationShellSnapshot, ProjectionRepositoryError> {
  return Effect.all([snapshot, loadBoardState(sql)]).pipe(
    Effect.map(([shell, board]) => {
      // Archived cards leave the shell snapshot (D15) but stay in the table
      // and the read model, so unarchive can bring them back.
      const cards = (board?.cards ?? []).filter((card) => card.archivedAt === null);
      return cards.length === 0 ? shell : { ...shell, cards };
    }),
  );
}

/**
 * Board-wrapped snapshot query methods, spread over the base methods in the
 * upstream ProjectionSnapshotQuery's returned object literal. The board
 * module decides which methods it wraps; when a future spec needs to wrap
 * another one (e.g. `getSnapshot`), only this factory grows.
 */
export function boardSnapshotQueryMethods(
  sql: SqlClient.SqlClient,
  base: Pick<ProjectionSnapshotQueryShape, "getCommandReadModel" | "getShellSnapshot">,
  // Typed Partial deliberately: the spread in the upstream object literal sits
  // after the base methods, and TS rejects a spread that *definitely* rewrites
  // an earlier key (TS2783). Optional keys express "board may override any
  // subset", so wrapping more methods later needs no seam change.
): Partial<ProjectionSnapshotQueryShape> {
  return {
    // Board cards join the engine's command read model (D8).
    getCommandReadModel: () => withBoardReadModel(sql, base.getCommandReadModel()),
    // Board cards ride the shell snapshot (D2).
    getShellSnapshot: () => withBoardShellCards(sql, base.getShellSnapshot()),
  };
}
