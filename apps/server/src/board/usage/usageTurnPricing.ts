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
  /** The provider marked the turn `partial` (stopped, failed, a billed field missing), or its
      legacy `otherUsage` was dropped or split by guess: the figure is a lower bound. */
  readonly partial: boolean;
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

type OtherUsage = NonNullable<BoardGatewayTurnUsage["otherUsage"]>;

/**
 * `otherUsage` split into the board's columns. Legacy `otherUsage` (no cache fields: turns
 * stored before T3O-90, or an old worker) folded cache into input. With no subagents it was a
 * resumed process's restored totals or compaction, so it is dropped; otherwise its input is
 * split by the main turn's own cache ratios. Either guess makes the turn partial, except a
 * split known to have subagents.
 */
function otherUsageTotals(
  usage: BoardGatewayTurnUsage,
  other: OtherUsage,
): { readonly totals: UsageTokenTotals; readonly partial: boolean } {
  if (other.cachedInputTokens !== undefined || other.cacheCreationTokens !== undefined) {
    const cached = Math.min(other.cachedInputTokens ?? 0, other.inputTokens);
    const creation = Math.min(other.cacheCreationTokens ?? 0, other.inputTokens - cached);
    return {
      totals: {
        ...ZERO,
        uncachedInputTokens: other.inputTokens - cached - creation,
        cachedInputTokens: cached,
        cacheCreationTokens: creation,
        outputTokens: other.outputTokens,
      },
      partial: false,
    };
  }
  if (usage.hasSubagents === false) {
    return { totals: ZERO, partial: other.inputTokens + other.outputTokens > 0 };
  }
  const mainInput = usage.inputTokens ?? 0;
  const cachedRatio = mainInput === 0 ? 0 : Math.min(usage.cachedInputTokens ?? 0, mainInput) / mainInput;
  const creationRatio =
    mainInput === 0
      ? 0
      : Math.min(usage.cacheCreationTokens ?? 0, mainInput) / mainInput;
  const cached = Math.round(other.inputTokens * cachedRatio);
  const creation = Math.min(Math.round(other.inputTokens * creationRatio), other.inputTokens - cached);
  return {
    totals: {
      ...ZERO,
      uncachedInputTokens: other.inputTokens - cached - creation,
      cachedInputTokens: cached,
      cacheCreationTokens: creation,
      outputTokens: other.outputTokens,
    },
    partial: usage.hasSubagents === undefined,
  };
}

function turnTotals(
  usage: BoardGatewayTurnUsage | null,
): { readonly totals: UsageTokenTotals; readonly partial: boolean } | null {
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
  const other =
    usage.otherUsage === undefined
      ? { totals: ZERO, partial: false }
      : otherUsageTotals(usage, usage.otherUsage);
  return {
    totals: {
      uncachedInputTokens: input - cached - creation + other.totals.uncachedInputTokens,
      cachedInputTokens: cached + other.totals.cachedInputTokens,
      cacheCreationTokens: creation + other.totals.cacheCreationTokens,
      outputTokens: (usage.outputTokens ?? 0) + other.totals.outputTokens,
      reasoningTokens: usage.reasoningTokens ?? 0,
    },
    partial: usage.usageStatus === "partial" || other.partial,
  };
}

/**
 * `inputTokens` includes cache reads and writes, and `reasoningTokens` is part of
 * `outputTokens`. `otherUsage` (native subagents, compaction) is added column by column.
 * A turn that reported nothing, or `unavailable`, is a no-usage turn and makes the figure
 * partial.
 */
export function boardUsageTurnTotals(usage: BoardGatewayTurnUsage | null): UsageTokenTotals | null {
  return turnTotals(usage)?.totals ?? null;
}

export function priceBoardUsageTurn(
  rates: BoardUsageRates,
  model: string | null,
  usage: BoardGatewayTurnUsage | null,
): BoardUsageTurnPrice {
  const turn = turnTotals(usage);
  if (turn === null) return { totals: ZERO, costUsd: 0, source: "noUsage", partial: false };
  const { totals, partial } = turn;
  if (model === null) return { totals, costUsd: 0, source: "unpriced", partial };
  const priced = priceUsage(
    rates.table,
    { model, totals, speed: "standard", reportedCostUsd: null },
    rates.overrides,
  );
  if (priced.costSource === "unpriced") return { totals, costUsd: 0, source: "unpriced", partial };
  const source: BoardUsageTurnSource =
    priced.costSource === "providerReported"
      ? "reported"
      : rates.overrides.has(model.trim())
        ? "override"
        : "listPriced";
  return { totals, costUsd: priced.costUsd, source, partial };
}
