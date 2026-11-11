import { describe, expect, it } from "vite-plus/test";

import type { BoardCardUsageSummary } from "@t3tools/contracts";

import {
  formatBoardTokens,
  formatBoardUsageCost,
  isBoardUsageEmphasized,
} from "./boardUsageFormat";

const usage = (overrides: Partial<BoardCardUsageSummary> = {}): BoardCardUsageSummary => ({
  tokens: 1200,
  costUsd: 1.84,
  costKnown: true,
  providers: [],
  ...overrides,
});

describe("how a card's cost is written", () => {
  it.each([
    ["exact", usage(), "$1.84"],
    ["estimated", usage({ estimated: true }), "≈$1.84"],
    ["partial", usage({ partial: true }), "$1.84+"],
    ["estimated and partial", usage({ estimated: true, partial: true }), "≈$1.84+"],
    ["nothing known", null, "—"],
    ["tokens but no price", usage({ costKnown: false, costUsd: 0, partial: true }), "—"],
    ["under a cent", usage({ costUsd: 0.001 }), "<$0.01"],
  ])("%s", (_name, input, text) => {
    expect(formatBoardUsageCost(input).text).toBe(text);
  });

  it("never writes $0 for a card that reported nothing, and the face may say so in words", () => {
    const empty = usage({ tokens: 0, costUsd: 0, costKnown: false, partial: true });
    expect(formatBoardUsageCost(empty).text).toBe("—");
    expect(formatBoardUsageCost(empty, { noUsageWord: true }).text).toBe("no usage");
    expect(formatBoardUsageCost(empty).known).toBe(false);
  });

  it("names the steps behind ≈ and + in its tooltip", () => {
    const { tooltip } = formatBoardUsageCost(usage({ estimated: true, partial: true }), {
      steps: { estimated: ["review@2"], partial: ["ci-fix@1.2", "adjudicate@1"] },
    });
    expect(tooltip).toContain("(ci-fix@1.2, adjudicate@1)");
    expect(tooltip).toContain("lower bound");
    expect(tooltip).toContain("(review@2)");
  });

  it("emphasises at or over the threshold, and never a figure with no cost", () => {
    expect(isBoardUsageEmphasized(usage({ costUsd: 5 }), 5)).toBe(true);
    expect(isBoardUsageEmphasized(usage({ costUsd: 4.99 }), 5)).toBe(false);
    expect(isBoardUsageEmphasized(usage({ costKnown: false, costUsd: 9 }), 5)).toBe(false);
  });
});

describe("token counts", () => {
  it.each([
    [812, "812"],
    [12_400, "12.4k"],
    [1_240_000, "1.24M"],
    [null, "—"],
  ])("%s", (tokens, text) => {
    expect(formatBoardTokens(tokens)).toBe(text);
  });
});
