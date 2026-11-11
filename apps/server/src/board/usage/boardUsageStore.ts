/**
 * The board's usage tables (T3O-77, migration 062): one row per card, step, thread,
 * provider and model, and the ingested-turn keys that make every turn count once. Cost is
 * stored in micro-dollars so SQL sums are exact.
 */
import {
  type BoardCardId,
  type BoardCardUsageRow,
  type BoardCardUsageSummary,
  type BoardUsageRowTotals,
  boardCardUsageSummaryFromRows,
  type ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import type * as SqlClient from "effect/sql/SqlClient";

import type { BoardUsageTurnPrice } from "./usageTurnPricing.ts";

const MICRO = 1_000_000;

interface TotalsDbRow {
  readonly provider: string;
  readonly uncachedInput: number;
  readonly cachedInput: number;
  readonly cacheCreation: number;
  readonly output: number;
  readonly costMicroUsd: number;
  readonly turnsReported: number;
  readonly turnsOverride: number;
  readonly turnsListPriced: number;
  readonly turnsUnpriced: number;
  readonly turnsNoUsage: number;
  readonly turnsPartial: number;
}

const toTotals = (row: TotalsDbRow): BoardUsageRowTotals => ({
  provider: row.provider,
  uncachedInputTokens: row.uncachedInput,
  cachedInputTokens: row.cachedInput,
  cacheCreationTokens: row.cacheCreation,
  outputTokens: row.output,
  costUsd: row.costMicroUsd / MICRO,
  turnsReported: row.turnsReported,
  turnsOverride: row.turnsOverride,
  turnsListPriced: row.turnsListPriced,
  turnsUnpriced: row.turnsUnpriced,
  turnsNoUsage: row.turnsNoUsage,
  turnsPartial: row.turnsPartial,
});

/** Where a thread's usage lands: its own link, or the nearest link up the chain of
    threads it was delegated from. A human's unlink (a tombstone) stops it counting. */
export interface BoardUsageTarget {
  readonly cardId: BoardCardId;
  readonly stepId: string;
}

// Untraced: runs for every finished turn of every thread, under BoardUsageRecorder.price.
export const findUsageTarget = Effect.fnUntraced(function* (
  sql: SqlClient.SqlClient,
  threadId: ThreadId,
  delegationChain: ReadonlyArray<ThreadId>,
) {
  for (const id of [threadId, ...delegationChain]) {
    const [link] = yield* sql<{ readonly cardId: BoardCardId; readonly stepId: string }>`
      SELECT card_id AS "cardId", role AS "stepId" FROM boards.board_card_thread_links
      WHERE thread_id = ${id} AND tombstoned_at IS NULL
    `;
    if (link !== undefined) return link as BoardUsageTarget;
  }
  return null;
});

/**
 * Store one priced turn, unless it was stored before. Run inside the caller's
 * transaction, beside its cursor. True when the turn was new, or replaced a no-usage count.
 */
export const storeUsageTurn = Effect.fn("boardUsageStore.storeUsageTurn")(function* (
  sql: SqlClient.SqlClient,
  input: {
    readonly target: BoardUsageTarget;
    readonly threadId: ThreadId;
    readonly providerTurnId: string;
    readonly provider: string;
    readonly model: string | null;
    readonly price: BoardUsageTurnPrice;
    readonly at: string;
  },
) {
  const { price } = input;
  const noUsage = price.source === "noUsage";
  const model = input.model ?? "";
  const fresh = yield* sql<{ readonly threadId: string }>`
    INSERT INTO boards.board_usage_ingested (
      thread_id, provider_turn_id,
      no_usage_card_id, no_usage_step_id, no_usage_provider, no_usage_model
    ) VALUES (
      ${input.threadId}, ${input.providerTurnId},
      ${noUsage ? input.target.cardId : null}, ${noUsage ? input.target.stepId : null},
      ${noUsage ? input.provider : null}, ${noUsage ? model : null}
    )
    ON CONFLICT DO NOTHING
    RETURNING thread_id AS "threadId"
  `;
  if (fresh.length === 0) {
    // A stopped turn's first finished event can carry no usage and a later one the real
    // figure: the later one replaces the no-usage count. Anything else is a replay.
    if (noUsage) return false;
    const [replaced] = yield* sql<{
      readonly cardId: string;
      readonly stepId: string;
      readonly provider: string;
      readonly model: string;
    }>`
      SELECT no_usage_card_id AS "cardId", no_usage_step_id AS "stepId",
        no_usage_provider AS "provider", no_usage_model AS "model"
      FROM boards.board_usage_ingested
      WHERE thread_id = ${input.threadId} AND provider_turn_id = ${input.providerTurnId}
        AND no_usage_card_id IS NOT NULL
    `;
    if (replaced === undefined) return false;
    yield* sql`
      UPDATE boards.board_usage_ingested
      SET no_usage_card_id = NULL, no_usage_step_id = NULL,
          no_usage_provider = NULL, no_usage_model = NULL
      WHERE thread_id = ${input.threadId} AND provider_turn_id = ${input.providerTurnId}
    `;
    yield* sql`
      UPDATE boards.board_card_usage SET turns_no_usage = turns_no_usage - 1
      WHERE card_id = ${replaced.cardId} AND step_id = ${replaced.stepId}
        AND thread_id = ${input.threadId} AND provider = ${replaced.provider}
        AND model = ${replaced.model}
    `;
    // The new contribution may land on another row (a model the first event lacked).
    yield* sql`
      DELETE FROM boards.board_card_usage
      WHERE card_id = ${replaced.cardId} AND step_id = ${replaced.stepId}
        AND thread_id = ${input.threadId} AND provider = ${replaced.provider}
        AND model = ${replaced.model}
        AND turns_reported + turns_override + turns_list_priced + turns_unpriced
          + turns_no_usage = 0
    `;
  }
  const one = (source: BoardUsageTurnPrice["source"]) => (price.source === source ? 1 : 0);
  yield* sql`
    INSERT INTO boards.board_card_usage (
      card_id, step_id, thread_id, provider, model,
      uncached_input, cached_input, cache_creation, output, reasoning, cost_micro_usd,
      turns_reported, turns_override, turns_list_priced, turns_unpriced, turns_no_usage,
      turns_partial, updated_at
    ) VALUES (
      ${input.target.cardId}, ${input.target.stepId}, ${input.threadId}, ${input.provider},
      ${model},
      ${price.totals.uncachedInputTokens}, ${price.totals.cachedInputTokens},
      ${price.totals.cacheCreationTokens}, ${price.totals.outputTokens},
      ${price.totals.reasoningTokens}, ${Math.round(price.costUsd * MICRO)},
      ${one("reported")}, ${one("override")}, ${one("listPriced")}, ${one("unpriced")},
      ${one("noUsage")}, ${price.partial ? 1 : 0}, ${input.at}
    )
    ON CONFLICT (card_id, step_id, thread_id, provider, model) DO UPDATE SET
      uncached_input = uncached_input + excluded.uncached_input,
      cached_input = cached_input + excluded.cached_input,
      cache_creation = cache_creation + excluded.cache_creation,
      output = output + excluded.output,
      reasoning = reasoning + excluded.reasoning,
      cost_micro_usd = cost_micro_usd + excluded.cost_micro_usd,
      turns_reported = turns_reported + excluded.turns_reported,
      turns_override = turns_override + excluded.turns_override,
      turns_list_priced = turns_list_priced + excluded.turns_list_priced,
      turns_unpriced = turns_unpriced + excluded.turns_unpriced,
      turns_no_usage = turns_no_usage + excluded.turns_no_usage,
      turns_partial = turns_partial + excluded.turns_partial,
      updated_at = excluded.updated_at
  `;
  return true;
});

/** One card's rows for its detail, oldest first. */
export const listCardUsageRows = Effect.fn("boardUsageStore.listCardUsageRows")(function* (
  sql: SqlClient.SqlClient,
  cardId: BoardCardId,
) {
  const rows = yield* sql<
    TotalsDbRow & {
      readonly stepId: string;
      readonly threadId: ThreadId;
      readonly model: string;
      readonly reasoning: number;
      readonly updatedAt: string;
    }
  >`
    SELECT
      step_id AS "stepId", thread_id AS "threadId", provider, model,
      uncached_input AS "uncachedInput", cached_input AS "cachedInput",
      cache_creation AS "cacheCreation", output, reasoning,
      cost_micro_usd AS "costMicroUsd",
      turns_reported AS "turnsReported", turns_override AS "turnsOverride",
      turns_list_priced AS "turnsListPriced", turns_unpriced AS "turnsUnpriced",
      turns_no_usage AS "turnsNoUsage", turns_partial AS "turnsPartial",
      updated_at AS "updatedAt"
    FROM boards.board_card_usage
    WHERE card_id = ${cardId}
    ORDER BY updated_at, step_id, thread_id, provider, model
  `;
  return rows.map((row): BoardCardUsageRow => ({
    ...toTotals(row),
    stepId: row.stepId,
    threadId: row.threadId,
    model: row.model === "" ? null : row.model,
    reasoningTokens: row.reasoning,
    updatedAt: row.updatedAt,
  }));
});

export const cardUsageHistoryPartial = Effect.fn("boardUsageStore.cardUsageHistoryPartial")(
  function* (sql: SqlClient.SqlClient, cardId: BoardCardId) {
    const [row] = yield* sql<{ readonly partial: number }>`
      SELECT usage_history_partial AS partial FROM boards.board_cards WHERE card_id = ${cardId}
    `;
    return (row?.partial ?? 0) !== 0;
  },
);

/** The JS producer of one card's shell summary, for the `card-usage` delta. */
export const cardUsageSummary = Effect.fn("boardUsageStore.cardUsageSummary")(function* (
  sql: SqlClient.SqlClient,
  cardId: BoardCardId,
) {
  const rows = yield* listCardUsageRows(sql, cardId);
  const partial = yield* cardUsageHistoryPartial(sql, cardId);
  return boardCardUsageSummaryFromRows(rows, partial);
});

/**
 * The SQL producer: every live card's summary, summed per provider in SQL. Feeds the
 * snapshot and a resume's resync. `cardMetaShellFields.test.ts` holds it to the JS one.
 */
export const allCardUsageSummaries = Effect.fn("boardUsageStore.allCardUsageSummaries")(function* (
  sql: SqlClient.SqlClient,
) {
  const rows = yield* sql<TotalsDbRow & { readonly cardId: BoardCardId }>`
    SELECT
      usage.card_id AS "cardId", usage.provider,
      SUM(usage.uncached_input) AS "uncachedInput", SUM(usage.cached_input) AS "cachedInput",
      SUM(usage.cache_creation) AS "cacheCreation", SUM(usage.output) AS output,
      SUM(usage.cost_micro_usd) AS "costMicroUsd",
      SUM(usage.turns_reported) AS "turnsReported", SUM(usage.turns_override) AS "turnsOverride",
      SUM(usage.turns_list_priced) AS "turnsListPriced",
      SUM(usage.turns_unpriced) AS "turnsUnpriced", SUM(usage.turns_no_usage) AS "turnsNoUsage",
      SUM(usage.turns_partial) AS "turnsPartial"
    FROM boards.board_card_usage AS usage
    INNER JOIN boards.board_cards AS cards
      ON cards.card_id = usage.card_id AND cards.archived_at IS NULL
    GROUP BY usage.card_id, usage.provider
  `;
  const partialRows = yield* sql<{ readonly cardId: BoardCardId }>`
    SELECT card_id AS "cardId" FROM boards.board_cards
    WHERE usage_history_partial <> 0 AND archived_at IS NULL
  `;
  const byCard = new Map<BoardCardId, Array<BoardUsageRowTotals>>();
  for (const row of rows) {
    const held = byCard.get(row.cardId);
    if (held === undefined) byCard.set(row.cardId, [toTotals(row)]);
    else held.push(toTotals(row));
  }
  const partial = new Set(partialRows.map((row) => row.cardId));
  const summaries = new Map<BoardCardId, BoardCardUsageSummary>();
  for (const cardId of new Set([...byCard.keys(), ...partial])) {
    const summary = boardCardUsageSummaryFromRows(byCard.get(cardId) ?? [], partial.has(cardId));
    if (summary !== null) summaries.set(cardId, summary);
  }
  return summaries;
});

/** The central server's own linked threads, for the one-time backfill. */
export const listLocalLinkedThreadIds = Effect.fn("boardUsageStore.listLocalLinkedThreadIds")(
  function* (sql: SqlClient.SqlClient) {
    const rows = yield* sql<{ readonly threadId: ThreadId }>`
      SELECT thread_id AS "threadId" FROM boards.board_card_thread_links
      WHERE tombstoned_at IS NULL AND (worker_id IS NULL OR worker_id = 'local')
      ORDER BY linked_at, thread_id
    `;
    return rows.map((row) => row.threadId);
  },
);

/** Mark partial every card with a live thread on a worker that reports no usage. The
    cards newly marked, for their `card-usage` delta. */
export const markWorkerCardsPartial = Effect.fn("boardUsageStore.markWorkerCardsPartial")(
  function* (sql: SqlClient.SqlClient, workerId: string) {
    const rows = yield* sql<{ readonly cardId: BoardCardId }>`
      UPDATE boards.board_cards SET usage_history_partial = 1
      WHERE usage_history_partial = 0 AND card_id IN (
        SELECT card_id FROM boards.board_card_thread_links
        WHERE worker_id = ${workerId} AND tombstoned_at IS NULL
      )
      RETURNING card_id AS "cardId"
    `;
    return rows.map((row) => row.cardId);
  },
);
