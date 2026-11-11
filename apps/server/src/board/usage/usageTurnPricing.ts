/**
 * One finished provider turn, split into the board's token columns and priced with the
 * Usage page's rate table and the user's price overrides (T3O-77). Pure, so the board's
 * arithmetic is tested without a server.
 */
import type { BoardGatewayTurnUsage, UsageTokenTotals } from "@t3tools/contracts";

import { priceUsage, type RateTable } from "../../usage/usagePricing.ts";

/** Where a turn's price came from. `override` is a user price and counts as exact;
    `priceUsage` labels it `modelPriced`, so it is told apart here. */
export type BoardUsageTurnSource = "reported" | "override" | "listPriced" | "unpriced" | "noUsage";

export interface BoardUsageTurnPrice {
  readonly totals: UsageTokenTotals;
  readonly costUsd: number;
  readonly source: BoardUsageTurnSource;
}

export interface BoardUsageRates {
  readonly table: RateTable;
  readonly overrides: RateTable;
}

const ZERO: UsageTokenTotals = {
  uncachedInputTokens: 0,
  cachedInputTokens: 0,
  cacheCreationTokens: 0,
  outputTokens: 0,
  reasoningTokens: 0,
};

/**
 * `inputTokens` includes cache reads and writes, and `reasoningTokens` is part of
 * `outputTokens`. `otherUsage` (native subagents, compaction) is added as uncached input
 * and output: the ledger does not split its cache. A turn that reported nothing, or
 * `unavailable`, is a no-usage turn and makes the figure partial.
 */
export function boardUsageTurnTotals(
  usage: BoardGatewayTurnUsage | null,
): UsageTokenTotals | null {
  if (usage === null || usage.usageStatus === "unavailable") return null;
  if (
    usage.inputTokens === undefined &&
    usage.outputTokens === undefined &&
    usage.otherUsage === undefined
  ) {
    return null;
  }
  const input = usage.inputTokens ?? 0;
  const cached = Math.min(usage.cachedInputTokens ?? 0, input);
  const creation = Math.min(usage.cacheCreationTokens ?? 0, input - cached);
  return {
    uncachedInputTokens: input - cached - creation + (usage.otherUsage?.inputTokens ?? 0),
    cachedInputTokens: cached,
    cacheCreationTokens: creation,
    outputTokens: (usage.outputTokens ?? 0) + (usage.otherUsage?.outputTokens ?? 0),
    reasoningTokens: usage.reasoningTokens ?? 0,
  };
}

export function priceBoardUsageTurn(
  rates: BoardUsageRates,
  model: string | null,
  usage: BoardGatewayTurnUsage | null,
): BoardUsageTurnPrice {
  const totals = boardUsageTurnTotals(usage);
  if (totals === null) return { totals: ZERO, costUsd: 0, source: "noUsage" };
  if (model === null) return { totals, costUsd: 0, source: "unpriced" };
  const priced = priceUsage(
    rates.table,
    { model, totals, speed: "standard", reportedCostUsd: null },
    rates.overrides,
  );
  if (priced.costSource === "unpriced") return { totals, costUsd: 0, source: "unpriced" };
  const source: BoardUsageTurnSource =
    priced.costSource === "providerReported"
      ? "reported"
      : rates.overrides.has(model.trim())
        ? "override"
        : "listPriced";
  return { totals, costUsd: priced.costUsd, source };
}
