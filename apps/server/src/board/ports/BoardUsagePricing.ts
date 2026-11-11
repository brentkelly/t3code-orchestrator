/**
 * The board's view of upstream's `UsageService`: the rate table and the user's price
 * overrides it prices each finished turn with (T3O-77). Only `BoardUsagePricing.live.ts`
 * imports upstream.
 */
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";

import type { BoardUsageRates } from "../usage/usageTurnPricing.ts";

export class BoardUsagePricing extends Context.Service<
  BoardUsagePricing,
  { readonly currentRates: Effect.Effect<BoardUsageRates> }
>()("t3/board/ports/BoardUsagePricing") {}
