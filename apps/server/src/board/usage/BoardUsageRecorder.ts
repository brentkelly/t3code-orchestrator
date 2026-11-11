/**
 * Records each finished provider turn's usage against the card and step whose thread ran
 * it (T3O-77). Pricing reads the rate table, which may load from disk once, so it happens
 * before the caller's transaction; storing runs inside it, beside the caller's cursor.
 * Local threads arrive on the board's thread tail, worker threads on the signal feed.
 */
import type { BoardCardId, ThreadId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";
import type { SqlError } from "effect/sql/SqlError";

import { makeBoardEventStore } from "../boardEventStore.ts";
import { BoardUsagePricing } from "../ports/BoardUsagePricing.ts";
import { LocalThreadGateway, type UsageSignal } from "../ThreadGateway.ts";
import { findUsageTarget, listLocalLinkedThreadIds, storeUsageTurn } from "./boardUsageStore.ts";
import { type BoardUsageTurnPrice, priceBoardUsageTurn } from "./usageTurnPricing.ts";

/** The backfill's marker in `projection_state`: 1 once it has run. */
export const BOARD_USAGE_BACKFILL_MARKER = "projection.board-usage-backfill";
const BACKFILL_BATCH = 25;

export interface PricedUsageSignal {
  readonly signal: UsageSignal;
  readonly price: BoardUsageTurnPrice;
}

export interface BoardUsageRecorderShape {
  /** Price a turn. Run outside any transaction. */
  readonly price: (signal: UsageSignal) => Effect.Effect<PricedUsageSignal>;
  /** Store a priced turn inside the caller's transaction. The card it landed on, or null
      when the thread is no card's, or the turn was stored before. */
  readonly store: (priced: PricedUsageSignal) => Effect.Effect<BoardCardId | null, SqlError>;
  /** After the caller commits: tell the board's clients the card's figure moved. */
  readonly publish: (cardId: BoardCardId) => Effect.Effect<void>;
  /** Cards whose usage changed, live. Attached when this effect returns. */
  readonly subscribeChanges: Effect.Effect<Stream.Stream<BoardCardId>, never, Scope.Scope>;
  /** Price this server's existing turns once, for cards that predate the feature. */
  readonly backfill: Effect.Effect<void>;
}

export class BoardUsageRecorder extends Context.Service<
  BoardUsageRecorder,
  BoardUsageRecorderShape
>()("t3/board/usage/BoardUsageRecorder") {}

export const makeBoardUsageRecorder = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const pricing = yield* BoardUsagePricing;
  const local = yield* Effect.serviceOption(LocalThreadGateway);
  const store = makeBoardEventStore(sql);
  const changes = yield* PubSub.unbounded<BoardCardId>();
  const nowIso = Effect.map(DateTime.now, DateTime.formatIso);

  // Untraced: once per finished turn of every thread on the server.
  const price = Effect.fnUntraced(function* (signal: UsageSignal) {
    const rates = yield* pricing.currentRates;
    return { signal, price: priceBoardUsageTurn(rates, signal.model, signal.usage) };
  });

  const storePriced = Effect.fnUntraced(function* ({ signal, price }: PricedUsageSignal) {
    const target = yield* findUsageTarget(sql, signal.threadId, signal.delegationChain);
    if (target === null) return null;
    const fresh = yield* storeUsageTurn(sql, {
      target,
      threadId: signal.threadId,
      providerTurnId: signal.providerTurnId,
      provider: signal.driver,
      model: signal.model,
      price,
      at: yield* nowIso,
    });
    return fresh ? target.cardId : null;
  });

  const publish = (cardId: BoardCardId) => PubSub.publish(changes, cardId).pipe(Effect.asVoid);

  const backfillBatch = Effect.fn("BoardUsageRecorder.backfillBatch")(function* (
    threadIds: ReadonlyArray<ThreadId>,
  ) {
    if (Option.isNone(local)) return 0;
    const signals = yield* local.value.usageHistory(threadIds);
    let stored = 0;
    for (const signal of signals) {
      const priced = yield* price(signal);
      const cardId = yield* sql.withTransaction(storePriced(priced));
      if (cardId !== null) {
        stored += 1;
        yield* publish(cardId);
      }
    }
    return stored;
  });

  const backfill = Effect.gen(function* () {
    if ((yield* store.getWatermark(BOARD_USAGE_BACKFILL_MARKER)) !== null) return;
    const threadIds = yield* listLocalLinkedThreadIds(sql);
    let turns = 0;
    for (let index = 0; index < threadIds.length; index += BACKFILL_BATCH) {
      turns += yield* backfillBatch(threadIds.slice(index, index + BACKFILL_BATCH));
    }
    yield* store.setWatermark(BOARD_USAGE_BACKFILL_MARKER, 1, yield* nowIso);
    yield* Effect.log("board usage backfill finished").pipe(
      Effect.annotateLogs({ threads: threadIds.length, turns }),
    );
  }).pipe(
    Effect.catchCause((cause) =>
      Effect.logWarning("board usage backfill failed; it runs again next start", { cause }),
    ),
    Effect.withSpan("BoardUsageRecorder.backfill"),
  );

  return {
    price,
    store: storePriced,
    publish,
    subscribeChanges: PubSub.subscribe(changes).pipe(Effect.map(Stream.fromSubscription)),
    backfill,
  } satisfies BoardUsageRecorderShape;
});

export const BoardUsageRecorderLive = Layer.effect(BoardUsageRecorder, makeBoardUsageRecorder);
