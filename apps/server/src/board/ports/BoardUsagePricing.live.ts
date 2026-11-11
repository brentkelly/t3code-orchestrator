import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { UsageService } from "../../usage/UsageService.ts";
import { BoardUsagePricing } from "./BoardUsagePricing.ts";

export const BoardUsagePricingLive = Layer.effect(
  BoardUsagePricing,
  Effect.map(UsageService, (usage) => BoardUsagePricing.of({ currentRates: usage.currentRates })),
);
