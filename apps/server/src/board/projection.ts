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
  activeBoardCardThreadId,
  BOARD_CARD_BRIEF_BODY_KIND,
  BoardCard,
  BoardCardExternalRef,
  BoardCardId,
  BoardCardRecipeSnapshot,
  BoardCardThreadLink,
  BoardLabel,
  BoardLabelId,
  boardLabelsAreSeedOnly,
  compareBoardLabels,
  isBoardEvent,
  makeBoardCardShell,
  sortBoardCardThreadLinks,
  type BoardCardDetail,
  type BoardState,
  type OrchestrationEvent,
  type OrchestrationReadModel,
  type OrchestrationShellSnapshot,
  ProjectId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";

import { toPersistenceSqlError, type ProjectionRepositoryError } from "../persistence/Errors.ts";
import type { ProjectionSnapshotQueryShape } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { boardCardFromCreatedPayload, compareBoardCards } from "./projector.ts";

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

// Label catalogue row (904_BoardLabels). `deletedAt` NULL means live.
const BoardLabelDbRow = Schema.Struct({
  labelId: BoardLabel.fields.labelId,
  name: BoardLabel.fields.name,
  colour: BoardLabel.fields.colour,
  deletedAt: BoardLabel.fields.deletedAt,
  createdAt: BoardLabel.fields.createdAt,
  updatedAt: BoardLabel.fields.updatedAt,
});
type BoardLabelDbRow = typeof BoardLabelDbRow.Type;

// Card↔label join row (905_BoardCardLabels). `ordinal` preserves the card's
// label order so rehydration reproduces the array the decider computed.
const BoardCardLabelDbRow = Schema.Struct({
  cardId: BoardCardId,
  labelId: BoardLabelId,
  ordinal: Schema.Int,
});
type BoardCardLabelDbRow = typeof BoardCardLabelDbRow.Type;

const NextCardNumberDbRow = Schema.Struct({
  projectId: ProjectId,
  maxCardNumber: Schema.Int,
});

/**
 * The narrow row behind `BoardCardShell` (t3o-04): exactly the columns the
 * shell needs, computed in SQL — never `SELECT *` mapped down. `dependsOn`,
 * `externalRef`, `recipeSnapshot` and the other heavy columns are not read
 * at all; the point of the shell split is to stop moving those bytes, not
 * to move them and discard them. `createdAt` is fetched for canonical
 * ordering only and never enters the shell.
 */
const BoardCardShellDbRow = Schema.Struct({
  cardId: BoardCard.fields.id,
  key: BoardCard.fields.key,
  projectId: BoardCard.fields.projectId,
  stage: BoardCard.fields.stage,
  orderKey: BoardCard.fields.orderKey,
  title: BoardCard.fields.title,
  blocked: Schema.Int,
  dependencyCount: Schema.Int,
  hasBrief: Schema.Int,
  createdAt: BoardCard.fields.createdAt,
});

function boardCardToRow(card: BoardCard): BoardCardDbRow {
  return {
    cardId: card.id,
    key: card.key,
    cardNumber: card.cardNumber,
    projectId: card.projectId,
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
  labels: ReadonlyArray<BoardLabelId>,
): BoardCard {
  return {
    id: row.cardId,
    key: row.key,
    cardNumber: row.cardNumber,
    projectId: row.projectId,
    labels,
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

/** Card ids in `ordinal` order from raw join rows, grouped per card — the
    shared shape both the shell path and rehydration read the join into. */
function groupCardLabels(
  rows: ReadonlyArray<BoardCardLabelDbRow>,
): Map<BoardCardId, BoardLabelId[]> {
  const byCard = new Map<
    BoardCardId,
    Array<{ readonly labelId: BoardLabelId; readonly ordinal: number }>
  >();
  for (const row of rows) {
    const list = byCard.get(row.cardId) ?? [];
    list.push({ labelId: row.labelId, ordinal: row.ordinal });
    byCard.set(row.cardId, list);
  }
  const ordered = new Map<BoardCardId, BoardLabelId[]>();
  for (const [cardId, list] of byCard) {
    ordered.set(
      cardId,
      [...list].sort((left, right) => left.ordinal - right.ordinal).map((entry) => entry.labelId),
    );
  }
  return ordered;
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

  // Read order is advisory only: `loadBoardState` re-sorts with the same
  // JS comparators the replay path uses (`compareBoardCards`,
  // `sortBoardCardThreadLinks`), so SQL collation can never make
  // rehydration order diverge from replay order.
  const listBoardCardRows = SqlSchema.findAll({
    Request: Schema.Void,
    Result: BoardCardDbRow,
    execute: () => sql`
      SELECT
        card_id AS "cardId",
        key,
        card_number AS "cardNumber",
        project_id AS "projectId",
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

  // Live links only, for the shell path: tombstoned links and links whose
  // card is archived can never contribute an activeThreadId, so they should
  // never leave the table — the reconnect read must scale with the current
  // board, not with link history.
  const listLiveBoardCardThreadLinkRows = SqlSchema.findAll({
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
      WHERE tombstoned_at IS NULL
        AND card_id IN (SELECT card_id FROM board_cards WHERE archived_at IS NULL)
    `,
  });

  // Shell rows exclude archived cards at the source (D15): they never reach
  // the wire, so they should never leave the table either.
  const listBoardCardShellRows = SqlSchema.findAll({
    Request: Schema.Void,
    Result: BoardCardShellDbRow,
    execute: () => sql`
      SELECT
        card_id AS "cardId",
        key,
        project_id AS "projectId",
        stage,
        order_key AS "orderKey",
        title,
        blocked,
        json_array_length(depends_on) AS "dependencyCount",
        CASE WHEN brief_ref IS NULL THEN 0 ELSE 1 END AS "hasBrief",
        created_at AS "createdAt"
      FROM board_cards
      WHERE archived_at IS NULL
    `,
  });

  const findBoardCardRow = SqlSchema.findOneOption({
    Request: BoardCardId,
    Result: BoardCardDbRow,
    execute: (cardId) => sql`
      SELECT
        card_id AS "cardId",
        key,
        card_number AS "cardNumber",
        project_id AS "projectId",
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
      WHERE card_id = ${cardId}
    `,
  });

  const listBoardCardThreadLinkRowsForCard = SqlSchema.findAll({
    Request: BoardCardId,
    Result: BoardCardThreadLinkDbRow,
    execute: (cardId) => sql`
      SELECT
        thread_id AS "threadId",
        card_id AS "cardId",
        role,
        linked_at AS "linkedAt",
        tombstoned_at AS "tombstonedAt"
      FROM board_card_thread_links
      WHERE card_id = ${cardId}
    `,
  });

  const findBoardCardBodyRow = SqlSchema.findOneOption({
    Request: Schema.Struct({ cardId: BoardCardId, kind: Schema.String }),
    Result: Schema.Struct({ body: Schema.String }),
    execute: (request) => sql`
      SELECT body
      FROM board_card_bodies
      WHERE card_id = ${request.cardId} AND kind = ${request.kind}
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

  // ── Labels (t3o-06a) ─────────────────────────────────────────────────

  const upsertBoardLabelRow = SqlSchema.void({
    Request: BoardLabelDbRow,
    execute: (row) => sql`
      INSERT INTO board_labels (label_id, name, colour, deleted_at, created_at, updated_at)
      VALUES (${row.labelId}, ${row.name}, ${row.colour}, ${row.deletedAt}, ${row.createdAt}, ${row.updatedAt})
      ON CONFLICT (label_id)
      DO UPDATE SET
        name = excluded.name,
        colour = excluded.colour,
        deleted_at = excluded.deleted_at,
        created_at = excluded.created_at,
        updated_at = excluded.updated_at
    `,
  });

  // Read order is advisory only: `loadBoardState` re-sorts with
  // `compareBoardLabels`, so SQL collation can never make rehydration order
  // diverge from replay order.
  const listBoardLabelRows = SqlSchema.findAll({
    Request: Schema.Void,
    Result: BoardLabelDbRow,
    execute: () => sql`
      SELECT
        label_id AS "labelId",
        name,
        colour,
        deleted_at AS "deletedAt",
        created_at AS "createdAt",
        updated_at AS "updatedAt"
      FROM board_labels
    `,
  });

  // Wholesale rewrite of a card's label rows from the card's authoritative
  // ordered label list: idempotent, and structurally incapable of drifting
  // from the read model (mirrors the thread-link sync).
  const deleteBoardCardLabelsForCard = SqlSchema.void({
    Request: BoardCardId,
    execute: (cardId) => sql`
      DELETE FROM board_card_labels
      WHERE card_id = ${cardId}
    `,
  });

  const insertBoardCardLabelRow = SqlSchema.void({
    Request: BoardCardLabelDbRow,
    execute: (row) => sql`
      INSERT INTO board_card_labels (card_id, label_id, ordinal)
      VALUES (${row.cardId}, ${row.labelId}, ${row.ordinal})
      ON CONFLICT (card_id, label_id)
      DO UPDATE SET ordinal = excluded.ordinal
    `,
  });

  const listBoardCardLabelRows = SqlSchema.findAll({
    Request: Schema.Void,
    Result: BoardCardLabelDbRow,
    execute: () => sql`
      SELECT card_id AS "cardId", label_id AS "labelId", ordinal
      FROM board_card_labels
    `,
  });

  const listBoardCardLabelRowsForCard = SqlSchema.findAll({
    Request: BoardCardId,
    Result: BoardCardLabelDbRow,
    execute: (cardId) => sql`
      SELECT card_id AS "cardId", label_id AS "labelId", ordinal
      FROM board_card_labels
      WHERE card_id = ${cardId}
      ORDER BY ordinal ASC
    `,
  });

  return {
    upsertBoardCardRow,
    listBoardCardRows,
    listBoardCardThreadLinkRows,
    listLiveBoardCardThreadLinkRows,
    listBoardCardShellRows,
    findBoardCardRow,
    listBoardCardThreadLinkRowsForCard,
    findBoardCardBodyRow,
    listNextCardNumberRows,
    deleteBoardCardThreadLinksForCard,
    insertBoardCardThreadLinkRow,
    upsertBoardCardBodyRow,
    deleteBoardCardBodyRow,
    upsertBoardLabelRow,
    listBoardLabelRows,
    deleteBoardCardLabelsForCard,
    insertBoardCardLabelRow,
    listBoardCardLabelRows,
    listBoardCardLabelRowsForCard,
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

  // Same wholesale-rewrite discipline for the card↔label join (t3o-06a): the
  // card's ordered label list is authoritative, and `ordinal` preserves its
  // order for rehydration. Synced only where labels can change (create /
  // update), mirroring the thread-link sync's link/unlink scope.
  const syncCardLabels = (card: BoardCard) =>
    Effect.gen(function* () {
      yield* queries.deleteBoardCardLabelsForCard(card.id);
      for (let ordinal = 0; ordinal < card.labels.length; ordinal += 1) {
        yield* queries.insertBoardCardLabelRow({
          cardId: card.id,
          labelId: card.labels[ordinal]!,
          ordinal,
        });
      }
    }).pipe(Effect.mapError(toPersistenceSqlError("BoardCardsProjection.cardLabels:query")));

  const upsertLabel = (label: BoardLabel) =>
    queries
      .upsertBoardLabelRow({
        labelId: label.labelId,
        name: label.name,
        colour: label.colour,
        deletedAt: label.deletedAt,
        createdAt: label.createdAt,
        updatedAt: label.updatedAt,
      })
      .pipe(Effect.mapError(toPersistenceSqlError("BoardCardsProjection.label:query")));

  const applyBoardCardsProjection = Effect.fn("applyBoardCardsProjection")(function* (
    event: OrchestrationEvent,
  ) {
    if (!isBoardEvent(event)) return;
    switch (event.type) {
      case "board.card-created": {
        const card = boardCardFromCreatedPayload(event.payload);
        yield* upsertCard(card);
        yield* syncCardLabels(card);
        return;
      }

      case "board.card-moved":
      case "board.card-reordered":
      case "board.card-archived":
      case "board.card-unarchived":
        yield* upsertCard(event.payload.card);
        return;

      case "board.label-created":
      case "board.label-updated":
      case "board.label-deleted":
      case "board.label-undeleted":
        // Catalogue rows (904); delete/undelete are tombstone upserts.
        yield* upsertLabel(event.payload.label);
        return;

      case "board.card-updated": {
        yield* upsertCard(event.payload.card);
        yield* syncCardLabels(event.payload.card);
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

/** The compiled query set — built once at snapshot-query assembly and
    threaded through every reader below, never rebuilt per call. */
type BoardCardQueries = ReturnType<typeof makeBoardCardQueries>;

/**
 * The board slice rehydrated from the projection tables, or null when no
 * card has ever been created (the board field stays absent then — see the
 * enricher note below). Archived cards are included: they stay in the read
 * model so unarchive and replay work; the shell filter drops them.
 */
export function loadBoardState(
  queries: BoardCardQueries,
): Effect.Effect<BoardState | null, ProjectionRepositoryError> {
  return Effect.all([
    queries.listBoardCardRows(),
    queries.listBoardCardThreadLinkRows(),
    queries.listNextCardNumberRows(),
    queries.listBoardLabelRows(),
    queries.listBoardCardLabelRows(),
  ]).pipe(
    Effect.map(([cardRows, linkRows, counterRows, labelRows, cardLabelRows]) => {
      // Canonical ordering comes from the shared JS comparators — the same
      // ones the replay path uses — never from SQL collation.
      const labels = labelRows
        .map((row) => ({
          labelId: row.labelId,
          name: row.name,
          colour: row.colour,
          deletedAt: row.deletedAt,
          createdAt: row.createdAt,
          updatedAt: row.updatedAt,
        }))
        .sort(compareBoardLabels);
      // A migrated-but-unused board (no cards, catalogue still the compiled
      // seeds) reports the board slice as ABSENT — the decider falls back to
      // EMPTY_BOARD_STATE (same seeds), so this equals a from-empty replay
      // where no board event ever fired. The moment a card or a label change
      // exists, the slice materialises.
      if (cardRows.length === 0 && boardLabelsAreSeedOnly(labels)) return null;

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
      const labelsByCard = groupCardLabels(cardLabelRows);
      return {
        cards: cardRows
          .map((row) =>
            rowToBoardCard(
              row,
              sortBoardCardThreadLinks(linksByCard.get(row.cardId) ?? []),
              labelsByCard.get(row.cardId) ?? [],
            ),
          )
          .sort(compareBoardCards),
        labels,
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
  queries: BoardCardQueries,
  readModel: Effect.Effect<OrchestrationReadModel, ProjectionRepositoryError>,
): Effect.Effect<OrchestrationReadModel, ProjectionRepositoryError> {
  return Effect.all([readModel, loadBoardState(queries)]).pipe(
    Effect.map(([model, board]) => (board === null ? model : { ...model, board })),
  );
}

/** Canonical shell-row order, same comparator family as `compareBoardCards`
    ((createdAt, cardId) by code units) applied to the narrow rows. */
function compareBoardCardShellRows(
  left: { readonly createdAt: string; readonly cardId: string },
  right: { readonly createdAt: string; readonly cardId: string },
): number {
  const compare = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
  return compare(left.createdAt, right.createdAt) || compare(left.cardId, right.cardId);
}

/**
 * Bounded `BoardCardShell`s ride the shell snapshot (t3o-04, D7): a narrow
 * SQL projection of the live (non-archived) cards, joined in JS against the
 * snapshot's own thread shells for the thread-derived fields — the thread
 * data is already in the snapshot being enriched, so no thread SQL is
 * needed. Archived cards leave the shell (D15) but stay in the table and
 * the read model, so unarchive can bring them back.
 */
export function withBoardShellCards(
  queries: BoardCardQueries,
  snapshot: Effect.Effect<OrchestrationShellSnapshot, ProjectionRepositoryError>,
): Effect.Effect<OrchestrationShellSnapshot, ProjectionRepositoryError> {
  const shellRows = Effect.all([
    queries.listBoardCardShellRows(),
    queries.listLiveBoardCardThreadLinkRows(),
    queries.listBoardCardLabelRows(),
  ]).pipe(Effect.mapError(toPersistenceSqlError("BoardCardsProjection.shell:query")));
  return Effect.all([snapshot, shellRows]).pipe(
    Effect.map(([shell, [cardRows, linkRows, cardLabelRows]]) => {
      if (cardRows.length === 0) return shell;
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
      const labelsByCard = groupCardLabels(cardLabelRows);
      const threadsById = new Map(shell.threads.map((thread) => [thread.id, thread]));
      const cards = [...cardRows].sort(compareBoardCardShellRows).map((row) => {
        const activeThreadId = activeBoardCardThreadId(linksByCard.get(row.cardId) ?? []);
        return makeBoardCardShell({
          cardId: row.cardId,
          key: row.key,
          projectId: row.projectId,
          labelIds: labelsByCard.get(row.cardId) ?? [],
          stage: row.stage,
          orderKey: row.orderKey,
          title: row.title,
          blocked: row.blocked !== 0,
          dependencyCount: row.dependencyCount,
          hasBrief: row.hasBrief !== 0,
          activeThreadId,
          thread: activeThreadId === null ? null : (threadsById.get(activeThreadId) ?? null),
        });
      });
      return { ...shell, cards };
    }),
  );
}

/**
 * The label catalogue rides the shell snapshot ONCE (t3o-06a): N labels for
 * the whole board, never denormalised per card. Includes tombstoned labels so
 * a client can render a retired-label chip muted; the picker filters them.
 * Sorted canonically for a stable picker order. Attached whenever the
 * catalogue has any rows — post-migration it always has the seeds — so even an
 * empty board's shell carries the vocabulary the picker needs.
 */
export function withBoardShellLabels(
  queries: BoardCardQueries,
  snapshot: Effect.Effect<OrchestrationShellSnapshot, ProjectionRepositoryError>,
): Effect.Effect<OrchestrationShellSnapshot, ProjectionRepositoryError> {
  const labelRows = queries
    .listBoardLabelRows()
    .pipe(Effect.mapError(toPersistenceSqlError("BoardCardsProjection.shellLabels:query")));
  return Effect.all([snapshot, labelRows]).pipe(
    Effect.map(([shell, rows]) => {
      if (rows.length === 0) return shell;
      const boardLabels = rows
        .map((row) => ({
          labelId: row.labelId,
          name: row.name,
          colour: row.colour,
          deletedAt: row.deletedAt,
          createdAt: row.createdAt,
          updatedAt: row.updatedAt,
        }))
        .sort(compareBoardLabels);
      return { ...shell, boardLabels };
    }),
  );
}

/**
 * Full detail for one open card (`board.subscribeCard`, t3o-04): the whole
 * aggregate (thread links incl. tombstones from 902) plus the brief body
 * from `board_card_bodies` (901). Archived cards resolve too — an archive
 * landing while the card is open must not kill the viewer's subscription.
 * Null when the card has never existed.
 *
 * A maker (queries compiled once at assembly) rather than a per-call
 * loader: the reader runs on every board event for a subscribed card.
 */
export function makeBoardCardDetailLoader(
  queries: BoardCardQueries,
): (cardId: BoardCardId) => Effect.Effect<BoardCardDetail | null, ProjectionRepositoryError> {
  return (cardId) =>
    Effect.all([
      queries.findBoardCardRow(cardId),
      queries.listBoardCardThreadLinkRowsForCard(cardId),
      queries.findBoardCardBodyRow({ cardId, kind: BOARD_CARD_BRIEF_BODY_KIND }),
      queries.listBoardCardLabelRowsForCard(cardId),
    ]).pipe(
      Effect.map(([cardRow, linkRows, bodyRow, labelRows]) => {
        if (Option.isNone(cardRow)) return null;
        const links = sortBoardCardThreadLinks(
          linkRows.map((row) => ({
            threadId: row.threadId,
            role: row.role,
            linkedAt: row.linkedAt,
            tombstonedAt: row.tombstonedAt,
          })),
        );
        const labels = [...labelRows]
          .sort((left, right) => left.ordinal - right.ordinal)
          .map((row) => row.labelId);
        return {
          card: rowToBoardCard(cardRow.value, links, labels),
          brief: Option.match(bodyRow, {
            onNone: () => null,
            onSome: (row) => row.body,
          }),
        };
      }),
      Effect.mapError(toPersistenceSqlError("BoardCardsProjection.detail:query")),
    );
}

/**
 * Board-only methods riding the `ProjectionSnapshotQuery` record (t3o-04).
 *
 * The upstream service's declared shape erases these keys, so consumers
 * recover them with `boardSnapshotQueryMethodsOf` (a runtime-checked,
 * board-owned accessor). This is deliberate: the snapshot-query assembly is
 * the one place the board already receives the `SqlClient`, so a board
 * reader added HERE needs no new upstream seam — while a board reader
 * anywhere else would either grow the ws layer's requirements (leaking
 * `SqlClient` into every upstream test context) or need a new service
 * layer provided in upstream composition. Growth stays inside this factory,
 * which is exactly what the t3o-02a seam comment promises ("board module
 * wraps what it needs").
 */
export interface BoardSnapshotQueryMethods {
  /** Full detail for `board.subscribeCard`; null when the card does not exist. */
  readonly boardCardDetail: (
    cardId: BoardCardId,
  ) => Effect.Effect<BoardCardDetail | null, ProjectionRepositoryError>;
}

/**
 * Recover the board-only methods from a `ProjectionSnapshotQuery` service
 * instance. Null when the instance was built without the board factory —
 * e.g. upstream tests that mock the service — so callers degrade to a typed
 * error instead of a crash.
 */
export function boardSnapshotQueryMethodsOf(service: unknown): BoardSnapshotQueryMethods | null {
  const candidate = service as Partial<BoardSnapshotQueryMethods>;
  return typeof candidate.boardCardDetail === "function"
    ? { boardCardDetail: candidate.boardCardDetail }
    : null;
}

/**
 * Board-wrapped snapshot query methods, spread over the base methods in the
 * upstream ProjectionSnapshotQuery's returned object literal. The board
 * module decides which methods it wraps; when a future spec needs to wrap
 * another one (e.g. `getSnapshot`), only this factory grows. Board-only
 * additions (`BoardSnapshotQueryMethods`) ride the same spread — TS's
 * excess-property checking does not apply to spread members, so the
 * upstream `satisfies ProjectionSnapshotQueryShape` stays intact.
 */
export function boardSnapshotQueryMethods(
  sql: SqlClient.SqlClient,
  base: Pick<ProjectionSnapshotQueryShape, "getCommandReadModel" | "getShellSnapshot">,
  // Typed Partial deliberately: the spread in the upstream object literal sits
  // after the base methods, and TS rejects a spread that *definitely* rewrites
  // an earlier key (TS2783). Optional keys express "board may override any
  // subset", so wrapping more methods later needs no seam change.
): Partial<ProjectionSnapshotQueryShape> & BoardSnapshotQueryMethods {
  // Compiled once here — every reader below closes over the same query set.
  const queries = makeBoardCardQueries(sql);
  return {
    // Board cards join the engine's command read model (D8).
    getCommandReadModel: () => withBoardReadModel(queries, base.getCommandReadModel()),
    // Bounded card shells + the label catalogue ride the shell snapshot
    // (D2/D7; catalogue once, t3o-06a).
    getShellSnapshot: () =>
      withBoardShellLabels(queries, withBoardShellCards(queries, base.getShellSnapshot())),
    // Board-only detail reader for board.subscribeCard (t3o-04).
    boardCardDetail: makeBoardCardDetailLoader(queries),
  };
}
