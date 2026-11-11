import { describe, expect, it } from "@effect/vitest";

import { createOverrideRateTable, parseRateTable } from "../../usage/usagePricing.ts";
import { boardUsageTurnTotals, priceBoardUsageTurn } from "./usageTurnPricing.ts";

const rates = {
  table: parseRateTable({
    "listed-model": {
      input_cost_per_token: 1e-6,
      output_cost_per_token: 10e-6,
      cache_read_input_token_cost: 0.1e-6,
      cache_creation_input_token_cost: 2e-6,
    },
  }),
  overrides: createOverrideRateTable({
    "custom-model": { inputCostPerMillionTokens: 3, outputCostPerMillionTokens: 30 },
  }),
};

const complete = (counts: Record<string, unknown>) => ({
  usageStatus: "complete" as const,
  inputTokens: 0,
  outputTokens: 0,
  ...counts,
});

describe("a finished turn's board usage", () => {
  it("splits cache reads and writes out of input, and adds subagent and compaction counts", () => {
    expect(
      boardUsageTurnTotals(
        complete({
          inputTokens: 1000,
          cachedInputTokens: 600,
          cacheCreationTokens: 100,
          outputTokens: 200,
          reasoningTokens: 50,
          otherUsage: { inputTokens: 40, outputTokens: 4 },
        }),
      ),
    ).toEqual({
      uncachedInputTokens: 340,
      cachedInputTokens: 600,
      cacheCreationTokens: 100,
      outputTokens: 204,
      reasoningTokens: 50,
    });
  });

  it("never reads more cache than input, so uncached input cannot go negative", () => {
    expect(
      boardUsageTurnTotals(complete({ inputTokens: 10, cachedInputTokens: 50 }))
        ?.uncachedInputTokens,
    ).toBe(0);
  });

  it("reads a turn that reported nothing, or unavailable, as no usage", () => {
    expect(boardUsageTurnTotals(null)).toBeNull();
    expect(boardUsageTurnTotals({ usageStatus: "unavailable", inputTokens: 5 })).toBeNull();
    expect(boardUsageTurnTotals({ usageStatus: "partial" })).toBeNull();
    expect(priceBoardUsageTurn(rates, "listed-model", null)).toMatchObject({
      source: "noUsage",
      costUsd: 0,
    });
  });

  it("names where each price came from: list, override, or none", () => {
    const usage = complete({ inputTokens: 1_000_000, outputTokens: 100_000 });
    expect(priceBoardUsageTurn(rates, "listed-model", usage)).toEqual({
      totals: expect.objectContaining({ uncachedInputTokens: 1_000_000 }),
      costUsd: 2,
      source: "listPriced",
    });
    expect(priceBoardUsageTurn(rates, "custom-model", usage)).toMatchObject({
      costUsd: 6,
      source: "override",
    });
    expect(priceBoardUsageTurn(rates, "unknown-model", usage)).toMatchObject({
      costUsd: 0,
      source: "unpriced",
    });
    expect(priceBoardUsageTurn(rates, null, usage)).toMatchObject({ source: "unpriced" });
  });

  it("prices cache reads and writes at their own rates", () => {
    expect(
      priceBoardUsageTurn(
        rates,
        "listed-model",
        complete({ inputTokens: 2_000_000, cachedInputTokens: 1_000_000, cacheCreationTokens: 1_000_000 }),
      ).costUsd,
    ).toBeCloseTo(0.1 + 2, 9);
  });
});
