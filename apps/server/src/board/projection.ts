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
  BoardCardActivityEntry,
  BoardCardExternalRef,
  BoardCardId,
  BoardCardThreadLink,
  BoardLabel,
  BoardLabelId,
  boardLabelsAreSeedOnly,
  BoardPlan,
  BoardPlanId,
  BoardStageDefinition,
  BoardStageId,
  BoardStageRole,
  boardStagesAreSeedOnly,
  BoardStepCompletion,
  BoardCardStepState,
  BoardStageMode,
  compareBoardLabels,
  compareBoardStages,
  BoardCardWorktree,
  isBoardEvent,
  makeBoardCardShell,
  ProviderInstanceId,
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
import {
  boardCardFromCreatedPayload,
  compareBoardCards,
  compareBoardPlans,
  compareBoardStepCompletions,
  compareBoardStepStates,
} from "./projector.ts";

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
  // Per-card human-in-the-loop override (D6): 0/1/NULL (SQLite has no boolean;
  // NULL means untouched).
  humanInLoop: Schema.NullOr(Schema.Int),
  worktree: Schema.NullOr(Schema.fromJsonString(BoardCardWorktree)),
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

// Stage definitions (014_BoardStages). `role` is 'build' | 'review' | 'done' |
// NULL (an ordinary stage). One row per stage; rehydrates `BoardState.stages`.
const BoardStageDbRow = Schema.Struct({
  stageId: BoardStageDefinition.fields.stageId,
  label: BoardStageDefinition.fields.label,
  role: BoardStageDefinition.fields.role,
  orderKey: BoardStageDefinition.fields.orderKey,
  createdAt: BoardStageDefinition.fields.createdAt,
  updatedAt: BoardStageDefinition.fields.updatedAt,
});
type BoardStageDbRow = typeof BoardStageDbRow.Type;

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

// Agent write-path rows (t3o-08). Activity is table-only (D8); step and plan
// rows rehydrate the read-model slices `BoardState.stepCompletions` / `plans`.
const BoardCardActivityDbRow = Schema.Struct({
  activityId: BoardCardActivityEntry.fields.activityId,
  cardId: BoardCardId,
  kind: BoardCardActivityEntry.fields.kind,
  body: BoardCardActivityEntry.fields.body,
  threadId: BoardCardActivityEntry.fields.threadId,
  createdAt: BoardCardActivityEntry.fields.createdAt,
});
type BoardCardActivityDbRow = typeof BoardCardActivityDbRow.Type;

const BoardCardStepDbRow = Schema.Struct({
  cardId: BoardCardId,
  stepId: BoardStepCompletion.fields.stepId,
  outcome: BoardStepCompletion.fields.outcome,
  summary: BoardStepCompletion.fields.summary,
  payload: BoardStepCompletion.fields.payload,
  threadId: BoardStepCompletion.fields.threadId,
  completedAt: BoardStepCompletion.fields.completedAt,
});
type BoardCardStepDbRow = typeof BoardCardStepDbRow.Type;

// Live per-card step state (t3o-10). One row per card. `slotHeld` travels as
// 0/1 (SQLite has no boolean), like `locked` below. Rehydrates the read-model
// slice `BoardState.stepStates`.
const BoardCardStepStateDbRow = Schema.Struct({
  cardId: BoardCardStepState.fields.cardId,
  stepId: BoardCardStepState.fields.stepId,
  stepLabel: BoardCardStepState.fields.stepLabel,
  attempt: BoardCardStepState.fields.attempt,
  // Frozen execution config (D12).
  prompt: BoardCardStepState.fields.prompt,
  providerInstanceId: BoardCardStepState.fields.providerInstanceId,
  model: BoardCardStepState.fields.model,
  mode: BoardCardStepState.fields.mode,
  humanInLoop: Schema.Int,
  maxAttempts: BoardCardStepState.fields.maxAttempts,
  timeoutMs: BoardCardStepState.fields.timeoutMs,
  threadId: BoardCardStepState.fields.threadId,
  status: BoardCardStepState.fields.status,
  slotHeld: Schema.Int,
  startedAt: BoardCardStepState.fields.startedAt,
  updatedAt: BoardCardStepState.fields.updatedAt,
});
type BoardCardStepStateDbRow = typeof BoardCardStepStateDbRow.Type;

// `dependsOn` JSON-encodes; `locked` travels as 0/1 (SQLite has no boolean).
const BoardPlanDbRow = Schema.Struct({
  planId: BoardPlan.fields.planId,
  cardId: BoardCardId,
  title: BoardPlan.fields.title,
  summary: BoardPlan.fields.summary,
  dependsOn: Schema.fromJsonString(Schema.Array(BoardPlanId)),
  ordinal: Schema.Int,
  locked: Schema.Int,
  body: Schema.String,
  createdAt: BoardPlan.fields.createdAt,
  updatedAt: BoardPlan.fields.updatedAt,
});
type BoardPlanDbRow = typeof BoardPlanDbRow.Type;

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
  archivedAt: BoardCard.fields.archivedAt,
  createdAt: BoardCard.fields.createdAt,
});

/** The four columns a resolved dependency edge shows (t3o-13, D4) — enough
    to render a chip or name a card in the archive confirmation, and nothing
    more. */
const BoardCardDependencyRefDbRow = Schema.Struct({
  cardId: BoardCard.fields.id,
  key: BoardCard.fields.key,
  title: BoardCard.fields.title,
  stage: BoardCard.fields.stage,
  archivedAt: BoardCard.fields.archivedAt,
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
    humanInLoop: card.humanInLoop === null ? null : card.humanInLoop ? 1 : 0,
    worktree: card.worktree,
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
    humanInLoop: row.humanInLoop === null ? null : row.humanInLoop !== 0,
    worktree: row.worktree,
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
        human_in_loop,
        worktree,
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
        ${row.humanInLoop},
        ${row.worktree},
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
        human_in_loop = excluded.human_in_loop,
        worktree = excluded.worktree,
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
        human_in_loop AS "humanInLoop",
        worktree,
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
        archived_at AS "archivedAt",
        created_at AS "createdAt"
      FROM board_cards
      WHERE archived_at IS NULL
    `,
  });

  // The archive page's mirror of the shell query (t3o-13, D7): same bounded
  // columns, opposite filter. Archived cards are read on demand by whoever
  // opens the archive, never streamed to every client.
  const listArchivedBoardCardShellRows = SqlSchema.findAll({
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
        archived_at AS "archivedAt",
        created_at AS "createdAt"
      FROM board_cards
      WHERE archived_at IS NOT NULL
    `,
  });

  // Both ends of this card's dependency edges (t3o-13, D4). Archived rows are
  // deliberately included: an archived dependency must read as the card it is,
  // and an archived dependent is still worth showing on the card it points at.
  const listBoardCardDependencyRefRows = SqlSchema.findAll({
    Request: BoardCardId,
    Result: BoardCardDependencyRefDbRow,
    execute: (cardId) => sql`
      SELECT
        card_id AS "cardId",
        key,
        title,
        stage,
        archived_at AS "archivedAt"
      FROM board_cards
      WHERE card_id IN (
        SELECT value FROM json_each((SELECT depends_on FROM board_cards WHERE card_id = ${cardId}))
      )
    `,
  });

  const listBoardCardDependentRefRows = SqlSchema.findAll({
    Request: BoardCardId,
    Result: BoardCardDependencyRefDbRow,
    execute: (cardId) => sql`
      SELECT
        card_id AS "cardId",
        key,
        title,
        stage,
        archived_at AS "archivedAt"
      FROM board_cards
      WHERE EXISTS (
        SELECT 1 FROM json_each(board_cards.depends_on) WHERE value = ${cardId}
      )
      ORDER BY card_number
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
        human_in_loop AS "humanInLoop",
        worktree,
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

  // ── Stages (t3o-15) ──────────────────────────────────────────────────

  const upsertBoardStageRow = SqlSchema.void({
    Request: BoardStageDbRow,
    execute: (row) => sql`
      INSERT INTO board_stages (stage_id, label, role, order_key, created_at, updated_at)
      VALUES (${row.stageId}, ${row.label}, ${row.role}, ${row.orderKey}, ${row.createdAt}, ${row.updatedAt})
      ON CONFLICT (stage_id)
      DO UPDATE SET
        label = excluded.label,
        role = excluded.role,
        order_key = excluded.order_key,
        created_at = excluded.created_at,
        updated_at = excluded.updated_at
    `,
  });

  const deleteBoardStageRow = SqlSchema.void({
    Request: BoardStageId,
    execute: (stageId) => sql`
      DELETE FROM board_stages
      WHERE stage_id = ${stageId}
    `,
  });

  // Read order is advisory only: `loadBoardState` re-sorts with
  // `compareBoardStages`.
  const listBoardStageRows = SqlSchema.findAll({
    Request: Schema.Void,
    Result: BoardStageDbRow,
    execute: () => sql`
      SELECT
        stage_id AS "stageId",
        label,
        role,
        order_key AS "orderKey",
        created_at AS "createdAt",
        updated_at AS "updatedAt"
      FROM board_stages
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

  // ── Agent write path (t3o-08) ────────────────────────────────────────

  // Append-only; `ON CONFLICT DO NOTHING` makes re-applying the same event
  // (replay) a no-op, since `activity_id` is the event's own id.
  const insertBoardCardActivityRow = SqlSchema.void({
    Request: BoardCardActivityDbRow,
    execute: (row) => sql`
      INSERT INTO board_card_activity (activity_id, card_id, kind, body, thread_id, created_at)
      VALUES (${row.activityId}, ${row.cardId}, ${row.kind}, ${row.body}, ${row.threadId}, ${row.createdAt})
      ON CONFLICT (activity_id) DO NOTHING
    `,
  });

  const listBoardCardActivityRowsForCard = SqlSchema.findAll({
    Request: BoardCardId,
    Result: BoardCardActivityDbRow,
    execute: (cardId) => sql`
      SELECT
        activity_id AS "activityId",
        card_id AS "cardId",
        kind,
        body,
        thread_id AS "threadId",
        created_at AS "createdAt"
      FROM board_card_activity
      WHERE card_id = ${cardId}
      ORDER BY created_at ASC, activity_id ASC
    `,
  });

  const upsertBoardCardStepRow = SqlSchema.void({
    Request: BoardCardStepDbRow,
    execute: (row) => sql`
      INSERT INTO board_card_steps (card_id, step_id, outcome, summary, payload, thread_id, completed_at)
      VALUES (${row.cardId}, ${row.stepId}, ${row.outcome}, ${row.summary}, ${row.payload}, ${row.threadId}, ${row.completedAt})
      ON CONFLICT (card_id, step_id)
      DO UPDATE SET
        outcome = excluded.outcome,
        summary = excluded.summary,
        payload = excluded.payload,
        thread_id = excluded.thread_id,
        completed_at = excluded.completed_at
    `,
  });

  const listBoardCardStepRows = SqlSchema.findAll({
    Request: Schema.Void,
    Result: BoardCardStepDbRow,
    execute: () => sql`
      SELECT
        card_id AS "cardId",
        step_id AS "stepId",
        outcome,
        summary,
        payload,
        thread_id AS "threadId",
        completed_at AS "completedAt"
      FROM board_card_steps
    `,
  });

  // One row per card (t3o-10): the card's live step state. Upsert on card_id
  // so a step transition or the next step of a recipe replaces the prior row.
  const upsertBoardCardStepStateRow = SqlSchema.void({
    Request: BoardCardStepStateDbRow,
    execute: (row) => sql`
      INSERT INTO board_card_step_state (
        card_id, step_id, step_label, attempt, prompt, provider_instance_id, model, mode,
        human_in_loop, max_attempts, timeout_ms, thread_id, status, slot_held, started_at, updated_at
      )
      VALUES (
        ${row.cardId}, ${row.stepId}, ${row.stepLabel}, ${row.attempt}, ${row.prompt},
        ${row.providerInstanceId}, ${row.model}, ${row.mode}, ${row.humanInLoop}, ${row.maxAttempts},
        ${row.timeoutMs}, ${row.threadId}, ${row.status}, ${row.slotHeld}, ${row.startedAt}, ${row.updatedAt}
      )
      ON CONFLICT (card_id)
      DO UPDATE SET
        step_id = excluded.step_id,
        step_label = excluded.step_label,
        attempt = excluded.attempt,
        prompt = excluded.prompt,
        provider_instance_id = excluded.provider_instance_id,
        model = excluded.model,
        mode = excluded.mode,
        human_in_loop = excluded.human_in_loop,
        max_attempts = excluded.max_attempts,
        timeout_ms = excluded.timeout_ms,
        thread_id = excluded.thread_id,
        status = excluded.status,
        slot_held = excluded.slot_held,
        started_at = excluded.started_at,
        updated_at = excluded.updated_at
    `,
  });

  const listBoardCardStepStateRows = SqlSchema.findAll({
    Request: Schema.Void,
    Result: BoardCardStepStateDbRow,
    execute: () => sql`
      SELECT
        card_id AS "cardId",
        step_id AS "stepId",
        step_label AS "stepLabel",
        attempt,
        prompt,
        provider_instance_id AS "providerInstanceId",
        model,
        mode,
        human_in_loop AS "humanInLoop",
        max_attempts AS "maxAttempts",
        timeout_ms AS "timeoutMs",
        thread_id AS "threadId",
        status,
        slot_held AS "slotHeld",
        started_at AS "startedAt",
        updated_at AS "updatedAt"
      FROM board_card_step_state
    `,
  });

  // Wholesale rewrite of a card's plan rows from the proposal: idempotent, and
  // structurally incapable of drifting from the read model.
  const deleteBoardPlansForCard = SqlSchema.void({
    Request: BoardCardId,
    execute: (cardId) => sql`
      DELETE FROM board_plans
      WHERE card_id = ${cardId}
    `,
  });

  const insertBoardPlanRow = SqlSchema.void({
    Request: BoardPlanDbRow,
    execute: (row) => sql`
      INSERT INTO board_plans (
        plan_id, card_id, title, summary, depends_on, ordinal, locked, body, created_at, updated_at
      )
      VALUES (
        ${row.planId}, ${row.cardId}, ${row.title}, ${row.summary}, ${row.dependsOn},
        ${row.ordinal}, ${row.locked}, ${row.body}, ${row.createdAt}, ${row.updatedAt}
      )
      ON CONFLICT (plan_id)
      DO UPDATE SET
        card_id = excluded.card_id,
        title = excluded.title,
        summary = excluded.summary,
        depends_on = excluded.depends_on,
        ordinal = excluded.ordinal,
        locked = excluded.locked,
        body = excluded.body,
        created_at = excluded.created_at,
        updated_at = excluded.updated_at
    `,
  });

  const UpdatePlanBodyRequest = Schema.Struct({
    planId: BoardPlanId,
    body: Schema.String,
    updatedAt: BoardPlan.fields.updatedAt,
  });
  const updateBoardPlanBodyRow = SqlSchema.void({
    Request: UpdatePlanBodyRequest,
    execute: (request) => sql`
      UPDATE board_plans
      SET body = ${request.body}, updated_at = ${request.updatedAt}
      WHERE plan_id = ${request.planId}
    `,
  });

  const listBoardPlanRows = SqlSchema.findAll({
    Request: Schema.Void,
    Result: BoardPlanDbRow,
    execute: () => sql`
      SELECT
        plan_id AS "planId",
        card_id AS "cardId",
        title,
        summary,
        depends_on AS "dependsOn",
        ordinal,
        locked,
        body,
        created_at AS "createdAt",
        updated_at AS "updatedAt"
      FROM board_plans
    `,
  });

  const findBoardPlanRow = SqlSchema.findOneOption({
    Request: BoardPlanId,
    Result: BoardPlanDbRow,
    execute: (planId) => sql`
      SELECT
        plan_id AS "planId",
        card_id AS "cardId",
        title,
        summary,
        depends_on AS "dependsOn",
        ordinal,
        locked,
        body,
        created_at AS "createdAt",
        updated_at AS "updatedAt"
      FROM board_plans
      WHERE plan_id = ${planId}
    `,
  });

  return {
    upsertBoardCardRow,
    listBoardCardRows,
    listBoardCardThreadLinkRows,
    listLiveBoardCardThreadLinkRows,
    listBoardCardShellRows,
    listArchivedBoardCardShellRows,
    listBoardCardDependencyRefRows,
    listBoardCardDependentRefRows,
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
    upsertBoardStageRow,
    deleteBoardStageRow,
    listBoardStageRows,
    deleteBoardCardLabelsForCard,
    insertBoardCardLabelRow,
    listBoardCardLabelRows,
    listBoardCardLabelRowsForCard,
    insertBoardCardActivityRow,
    listBoardCardActivityRowsForCard,
    upsertBoardCardStepRow,
    listBoardCardStepRows,
    upsertBoardCardStepStateRow,
    listBoardCardStepStateRows,
    deleteBoardPlansForCard,
    insertBoardPlanRow,
    updateBoardPlanBodyRow,
    listBoardPlanRows,
    findBoardPlanRow,
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

  // ── Agent write path (t3o-08) ────────────────────────────────────────

  const insertActivity = (entry: BoardCardActivityEntry) =>
    queries
      .insertBoardCardActivityRow({
        activityId: entry.activityId,
        cardId: entry.cardId,
        kind: entry.kind,
        body: entry.body,
        threadId: entry.threadId,
        createdAt: entry.createdAt,
      })
      .pipe(Effect.mapError(toPersistenceSqlError("BoardCardsProjection.activity:query")));

  const upsertStep = (completion: BoardStepCompletion) =>
    queries
      .upsertBoardCardStepRow({
        cardId: completion.cardId,
        stepId: completion.stepId,
        outcome: completion.outcome,
        summary: completion.summary,
        payload: completion.payload,
        threadId: completion.threadId,
        completedAt: completion.completedAt,
      })
      .pipe(Effect.mapError(toPersistenceSqlError("BoardCardsProjection.step:query")));

  const upsertStepState = (state: BoardCardStepState) =>
    queries
      .upsertBoardCardStepStateRow({
        cardId: state.cardId,
        stepId: state.stepId,
        stepLabel: state.stepLabel,
        attempt: state.attempt,
        prompt: state.prompt,
        providerInstanceId: state.providerInstanceId,
        model: state.model,
        mode: state.mode,
        humanInLoop: state.humanInLoop ? 1 : 0,
        maxAttempts: state.maxAttempts,
        timeoutMs: state.timeoutMs,
        threadId: state.threadId,
        status: state.status,
        slotHeld: state.slotHeld ? 1 : 0,
        startedAt: state.startedAt,
        updatedAt: state.updatedAt,
      })
      .pipe(Effect.mapError(toPersistenceSqlError("BoardCardsProjection.stepState:query")));

  const upsertStage = (stage: BoardStageDefinition) =>
    queries
      .upsertBoardStageRow({
        stageId: stage.stageId,
        label: stage.label,
        role: stage.role,
        orderKey: stage.orderKey,
        createdAt: stage.createdAt,
        updatedAt: stage.updatedAt,
      })
      .pipe(Effect.mapError(toPersistenceSqlError("BoardCardsProjection.stage:query")));

  const removeStage = (stageId: BoardStageId) =>
    queries
      .deleteBoardStageRow(stageId)
      .pipe(Effect.mapError(toPersistenceSqlError("BoardCardsProjection.stageDelete:query")));

  // Wholesale rewrite of a card's plan rows from the proposal (bodies live
  // here, D8): idempotent, and structurally incapable of drifting from the
  // read-model plan metadata.
  const replacePlans = (
    cardId: BoardCardId,
    plans: ReadonlyArray<BoardPlan & { readonly body: string }>,
  ) =>
    Effect.gen(function* () {
      yield* queries.deleteBoardPlansForCard(cardId);
      for (const plan of plans) {
        yield* queries.insertBoardPlanRow({
          planId: plan.planId,
          cardId: plan.cardId,
          title: plan.title,
          summary: plan.summary,
          dependsOn: plan.dependsOn,
          ordinal: plan.ordinal,
          locked: plan.locked ? 1 : 0,
          body: plan.body,
          createdAt: plan.createdAt,
          updatedAt: plan.updatedAt,
        });
      }
    }).pipe(Effect.mapError(toPersistenceSqlError("BoardCardsProjection.plans:query")));

  const writePlanBody = (planId: BoardPlanId, body: string, updatedAt: string) =>
    queries
      .updateBoardPlanBodyRow({ planId, body, updatedAt })
      .pipe(Effect.mapError(toPersistenceSqlError("BoardCardsProjection.planBody:query")));

  const applyBoardCardsProjection = Effect.fn("applyBoardCardsProjection")(function* (
    event: OrchestrationEvent,
  ) {
    if (!isBoardEvent(event)) return;
    switch (event.type) {
      case "board.card-created": {
        const card = boardCardFromCreatedPayload(event.payload);
        yield* upsertCard(card);
        yield* syncCardLabels(card);
        // A brief captured at creation (t3o-06) writes its body here — the
        // one table bodies ever live in (D8) — mirroring the update path.
        // `upsertCard` already wrote `depends_on` and `brief_ref` from `card`.
        if (event.payload.brief !== undefined) {
          yield* queries
            .upsertBoardCardBodyRow({
              cardId: event.payload.cardId,
              kind: BOARD_CARD_BRIEF_BODY_KIND,
              body: event.payload.brief,
              updatedAt: event.payload.updatedAt,
            })
            .pipe(Effect.mapError(toPersistenceSqlError("BoardCardsProjection.body:query")));
        }
        return;
      }

      case "board.card-moved":
      case "board.card-reordered":
      case "board.card-archived":
      case "board.card-unarchived":
      // Worktree lifecycle (t3o-09): every payload carries the whole card, so
      // the persisted projection is the same idempotent upsert — the worktree
      // column rides `board_cards` with the rest of the aggregate.
      case "board.card-worktree-provisioning":
      case "board.card-worktree-ready":
      case "board.card-worktree-failed":
      case "board.card-worktree-reclaimed":
        yield* upsertCard(event.payload.card);
        return;

      case "board.label-created":
      case "board.label-updated":
      case "board.label-deleted":
      case "board.label-undeleted":
        // Catalogue rows (904); delete/undelete are tombstone upserts.
        yield* upsertLabel(event.payload.label);
        return;

      case "board.stage-created":
      case "board.stage-renamed":
      case "board.stage-reordered":
        // Stage rows (014); the payload carries the whole post-change stage.
        yield* upsertStage(event.payload.stage);
        return;

      case "board.stage-deleted":
        yield* removeStage(event.payload.stageId);
        return;

      case "board.card-stage-thread-requested":
        // A request signal only — the reactor reacts; no table write.
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

      case "board.card-progress-reported":
      case "board.card-input-requested":
        yield* insertActivity(event.payload.entry);
        return;

      case "board.card-step-completed":
        yield* upsertStep(event.payload.completion);
        return;

      case "board.card-step-selected":
      case "board.card-step-admitted":
      case "board.card-step-awaiting-input":
      case "board.card-step-recovered":
      case "board.card-step-settled":
      case "board.card-step-retuned":
        // Live step state (t3o-10): every payload carries the whole computed
        // `BoardCardStepState`, so the persisted projection is one idempotent
        // upsert on card_id — replay and rehydration cannot diverge.
        yield* upsertStepState(event.payload.state);
        return;

      case "board.plans-proposed":
        yield* replacePlans(event.payload.cardId, event.payload.plans);
        return;

      case "board.plan-written":
        yield* writePlanBody(
          event.payload.planId,
          event.payload.body,
          event.payload.plan.updatedAt,
        );
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
    queries.listBoardStageRows(),
    queries.listBoardCardLabelRows(),
    queries.listBoardCardStepRows(),
    queries.listBoardCardStepStateRows(),
    queries.listBoardPlanRows(),
  ]).pipe(
    Effect.map(
      ([
        cardRows,
        linkRows,
        counterRows,
        labelRows,
        stageRows,
        cardLabelRows,
        stepRows,
        stepStateRows,
        planRows,
      ]) => {
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
        const stages = stageRows
          .map(
            (row): BoardStageDefinition => ({
              stageId: row.stageId,
              label: row.label,
              role: row.role,
              orderKey: row.orderKey,
              createdAt: row.createdAt,
              updatedAt: row.updatedAt,
            }),
          )
          .sort(compareBoardStages);
        // A migrated-but-unused board (no cards, catalogue AND stage list still
        // the compiled seeds) reports the board slice as ABSENT — the decider
        // falls back to EMPTY_BOARD_STATE (same seeds), so this equals a
        // from-empty replay where no board event ever fired. The moment a card,
        // a label change or a stage change exists, the slice materialises.
        if (
          cardRows.length === 0 &&
          boardLabelsAreSeedOnly(labels) &&
          boardStagesAreSeedOnly(stages)
        ) {
          return null;
        }

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
        // Agent write-path slices (t3o-08): rehydrated with the same shared JS
        // comparators the replay path uses. Omitted (not empty) when no event
        // has produced them, so a table rehydration equals a from-empty replay
        // where no step/plan event ever fired — the same absent-vs-empty rule
        // the board slice itself follows.
        const stepCompletions = stepRows
          .map((row) => ({
            cardId: row.cardId,
            stepId: row.stepId,
            outcome: row.outcome,
            summary: row.summary,
            payload: row.payload,
            threadId: row.threadId,
            completedAt: row.completedAt,
          }))
          .sort(compareBoardStepCompletions);
        const stepStates = stepStateRows
          .map(
            (row): BoardCardStepState => ({
              cardId: row.cardId,
              stepId: row.stepId,
              stepLabel: row.stepLabel,
              attempt: row.attempt,
              prompt: row.prompt,
              providerInstanceId: row.providerInstanceId,
              model: row.model,
              mode: row.mode,
              humanInLoop: row.humanInLoop !== 0,
              maxAttempts: row.maxAttempts,
              timeoutMs: row.timeoutMs,
              threadId: row.threadId,
              status: row.status,
              slotHeld: row.slotHeld !== 0,
              startedAt: row.startedAt,
              updatedAt: row.updatedAt,
            }),
          )
          .sort(compareBoardStepStates);
        const plans = planRows
          .map((row) => ({
            planId: row.planId,
            cardId: row.cardId,
            title: row.title,
            summary: row.summary,
            dependsOn: row.dependsOn,
            ordinal: row.ordinal,
            locked: row.locked !== 0,
            createdAt: row.createdAt,
            updatedAt: row.updatedAt,
          }))
          .sort(compareBoardPlans);
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
          stages,
          ...(stepCompletions.length > 0 ? { stepCompletions } : {}),
          ...(stepStates.length > 0 ? { stepStates } : {}),
          ...(plans.length > 0 ? { plans } : {}),
          nextCardNumberByProject: Object.fromEntries(
            counterRows.map((row) => [row.projectId, row.maxCardNumber + 1]),
          ),
        };
      },
    ),
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
    // The one step-state field on the bounded shell (t3o-11, D11): a card is
    // `queued` when its live step is holding for a slot. One row per card
    // (D4), so a small map keyed by card id.
    queries.listBoardCardStepStateRows(),
  ]).pipe(Effect.mapError(toPersistenceSqlError("BoardCardsProjection.shell:query")));
  return Effect.all([snapshot, shellRows]).pipe(
    Effect.map(([shell, [cardRows, linkRows, cardLabelRows, stepStateRows]]) => {
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
      const queuedByCard = new Set<BoardCardId>();
      for (const row of stepStateRows) {
        if (row.status === "queued") queuedByCard.add(row.cardId);
      }
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
          archivedAt: row.archivedAt,
          activeThreadId,
          queued: queuedByCard.has(row.cardId),
          thread: activeThreadId === null ? null : (threadsById.get(activeThreadId) ?? null),
        });
      });
      return { ...shell, cards };
    }),
  );
}

/**
 * The archive page's card list (t3o-13, D7), riding the same
 * `getArchivedShellSnapshot` the archived-threads panel already reads — the
 * archive is a page you open, not state every client carries, so it stays off
 * the live snapshot and the delta stream exactly as D15 requires.
 *
 * Newest archive first: the card you just archived by mistake is the one you
 * came to restore. Thread state is left at its resting value — an archived
 * card's threads are not what the archive list is for, and asking for them
 * would cost a query per page open.
 */
export function withBoardArchivedShellCards(
  queries: BoardCardQueries,
  snapshot: Effect.Effect<OrchestrationShellSnapshot, ProjectionRepositoryError>,
): Effect.Effect<OrchestrationShellSnapshot, ProjectionRepositoryError> {
  const shellRows = Effect.all([
    queries.listArchivedBoardCardShellRows(),
    queries.listBoardCardLabelRows(),
  ]).pipe(Effect.mapError(toPersistenceSqlError("BoardCardsProjection.archivedShell:query")));
  return Effect.all([snapshot, shellRows]).pipe(
    Effect.map(([shell, [cardRows, cardLabelRows]]) => {
      if (cardRows.length === 0) return shell;
      const labelsByCard = groupCardLabels(cardLabelRows);
      const cards = [...cardRows]
        .sort(
          (left, right) =>
            (right.archivedAt ?? "").localeCompare(left.archivedAt ?? "") ||
            compareBoardCardShellRows(left, right),
        )
        .map((row) =>
          makeBoardCardShell({
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
            archivedAt: row.archivedAt,
            activeThreadId: null,
          }),
        );
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
      queries.listBoardCardDependencyRefRows(cardId),
      queries.listBoardCardDependentRefRows(cardId),
    ]).pipe(
      Effect.map(([cardRow, linkRows, bodyRow, labelRows, dependencyRows, dependentRows]) => {
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
        const card = rowToBoardCard(cardRow.value, links, labels);
        // `dependsOn` order is the card's order — the SQL returns a set, so
        // the sequence is restored here rather than trusted from the rows.
        // An id whose row is gone is simply dropped: the chip has nothing to
        // show, and the gate already treats it as unmet.
        const dependencyRefsById = new Map(dependencyRows.map((row) => [row.cardId, row]));
        return {
          card,
          brief: Option.match(bodyRow, {
            onNone: () => null,
            onSome: (row) => row.body,
          }),
          dependencies: card.dependsOn.flatMap((dependencyId) => {
            const row = dependencyRefsById.get(dependencyId);
            return row === undefined ? [] : [row];
          }),
          dependents: dependentRows,
        };
      }),
      Effect.mapError(toPersistenceSqlError("BoardCardsProjection.detail:query")),
    );
}

/**
 * A card's activity log for `board_get_card_context` (t3o-08), in chronological
 * order. Table-only data (D8): the read model never holds activity bodies.
 */
export function makeBoardCardActivityLoader(
  queries: BoardCardQueries,
): (
  cardId: BoardCardId,
) => Effect.Effect<ReadonlyArray<BoardCardActivityEntry>, ProjectionRepositoryError> {
  return (cardId) =>
    queries.listBoardCardActivityRowsForCard(cardId).pipe(
      Effect.map((rows) =>
        rows.map((row) => ({
          activityId: row.activityId,
          cardId: row.cardId,
          kind: row.kind,
          body: row.body,
          threadId: row.threadId,
          createdAt: row.createdAt,
        })),
      ),
      Effect.mapError(toPersistenceSqlError("BoardCardsProjection.activityList:query")),
    );
}

/**
 * One plan's body from `board_plans` for `board_get_plan` / `board_write_plan`
 * (t3o-08); null when the plan does not exist. The body lives only in the
 * table (D8); the plan metadata rides the read model.
 */
export function makeBoardPlanBodyLoader(
  queries: BoardCardQueries,
): (planId: BoardPlanId) => Effect.Effect<string | null, ProjectionRepositoryError> {
  return (planId) =>
    queries.findBoardPlanRow(planId).pipe(
      Effect.map(
        Option.match({
          onNone: () => null,
          onSome: (row) => row.body,
        }),
      ),
      Effect.mapError(toPersistenceSqlError("BoardCardsProjection.planBody:query")),
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
  /** A card's activity log for `board_get_card_context` (t3o-08). */
  readonly boardCardActivity: (
    cardId: BoardCardId,
  ) => Effect.Effect<ReadonlyArray<BoardCardActivityEntry>, ProjectionRepositoryError>;
  /** One plan's body for `board_get_plan` (t3o-08); null when absent. */
  readonly boardPlanBody: (
    planId: BoardPlanId,
  ) => Effect.Effect<string | null, ProjectionRepositoryError>;
}

/**
 * Recover the board-only methods from a `ProjectionSnapshotQuery` service
 * instance. Null when the instance was built without the board factory —
 * e.g. upstream tests that mock the service — so callers degrade to a typed
 * error instead of a crash. The `boardCardDetail` presence check gates the
 * whole board method set (they are added together by the one factory).
 */
export function boardSnapshotQueryMethodsOf(service: unknown): BoardSnapshotQueryMethods | null {
  const candidate = service as Partial<BoardSnapshotQueryMethods>;
  return typeof candidate.boardCardDetail === "function" &&
    typeof candidate.boardCardActivity === "function" &&
    typeof candidate.boardPlanBody === "function"
    ? {
        boardCardDetail: candidate.boardCardDetail,
        boardCardActivity: candidate.boardCardActivity,
        boardPlanBody: candidate.boardPlanBody,
      }
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
  base: Pick<
    ProjectionSnapshotQueryShape,
    "getCommandReadModel" | "getShellSnapshot" | "getArchivedShellSnapshot"
  >,
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
    // Archived cards ride the archive page's snapshot (t3o-13, D7), with the
    // catalogue so their label chips render like any other card's.
    getArchivedShellSnapshot: () =>
      withBoardShellLabels(
        queries,
        withBoardArchivedShellCards(queries, base.getArchivedShellSnapshot()),
      ),
    // Board-only detail reader for board.subscribeCard (t3o-04).
    boardCardDetail: makeBoardCardDetailLoader(queries),
    // Board-only readers for the MCP context / plan tools (t3o-08).
    boardCardActivity: makeBoardCardActivityLoader(queries),
    boardPlanBody: makeBoardPlanBodyLoader(queries),
  };
}
