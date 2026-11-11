import { describe, expect, it } from "vite-plus/test";

import {
  BOARD_USAGE_OTHER_PROVIDER,
  BOARD_USAGE_SHELL_PROVIDERS_MAX,
  boardCardUsageSummaryFromRows,
  boardUsageStageOfStep,
  sumBoardCardUsageSummaries,
  type BoardUsageRowTotals,
} from "./boardUsage.ts";

const row = (overrides: Partial<BoardUsageRowTotals> = {}): BoardUsageRowTotals => ({
  provider: "claudeAgent",
  uncachedInputTokens: 100,
  cachedInputTokens: 50,
  cacheCreationTokens: 10,
  outputTokens: 40,
  costUsd: 0.25,
  turnsReported: 0,
  turnsOverride: 1,
  turnsListPriced: 0,
  turnsUnpriced: 0,
  turnsNoUsage: 0,
  ...overrides,
});

describe("a card's usage summary", () => {
  it("is absent when nothing is known, never a $0", () => {
    expect(boardCardUsageSummaryFromRows([], false)).toBeNull();
    expect(boardCardUsageSummaryFromRows([], true)).toEqual({
      tokens: 0,
      costUsd: 0,
      partial: true,
      providers: [],
    });
  });

  it("is exact when every priced turn used an override, and says so by omission", () => {
    expect(boardCardUsageSummaryFromRows([row(), row()], false)).toEqual({
      tokens: 400,
      costUsd: 0.5,
      costKnown: true,
      providers: [{ provider: "claudeAgent", tokens: 400, costUsd: 0.5 }],
    });
  });

  it("is an estimate when any turn was list-priced, and partial when any was unpriced or empty", () => {
    const summary = boardCardUsageSummaryFromRows(
      [
        row({ turnsOverride: 0, turnsListPriced: 2 }),
        row({ provider: "codex", costUsd: 0, turnsOverride: 0, turnsUnpriced: 1 }),
        row({
          provider: "cursor",
          uncachedInputTokens: 0,
          cachedInputTokens: 0,
          cacheCreationTokens: 0,
          outputTokens: 0,
          costUsd: 0,
          turnsOverride: 0,
          turnsNoUsage: 3,
        }),
      ],
      false,
    );
    expect(summary).toMatchObject({ costKnown: true, estimated: true, partial: true });
    expect(summary?.providers).toEqual([
      { provider: "claudeAgent", tokens: 200, costUsd: 0.25, estimated: true },
      { provider: "codex", tokens: 200, costUsd: 0, partial: true },
      { provider: "cursor", tokens: 0, costUsd: 0, partial: true },
    ]);
  });

  it("knows no cost when no turn was priced", () => {
    const summary = boardCardUsageSummaryFromRows(
      [row({ costUsd: 0, turnsOverride: 0, turnsUnpriced: 1 })],
      false,
    );
    expect(summary?.costKnown).toBeUndefined();
    expect(summary?.partial).toBe(true);
  });

  it("caps the providers it carries, folding the cheapest into one", () => {
    const providers = ["a", "b", "c", "d", "e", "f"];
    const summary = boardCardUsageSummaryFromRows(
      providers.map((provider, index) => row({ provider, costUsd: 6 - index })),
      false,
    );
    expect(summary?.providers.map((entry) => entry.provider)).toEqual([
      "a",
      "b",
      "c",
      BOARD_USAGE_OTHER_PROVIDER,
    ]);
    expect(summary?.providers).toHaveLength(BOARD_USAGE_SHELL_PROVIDERS_MAX);
    expect(summary?.providers.at(-1)?.costUsd).toBe(3 + 2 + 1);
    expect(summary?.costUsd).toBe(21);
  });

  it("sums cents without drifting", () => {
    const summary = boardCardUsageSummaryFromRows(
      Array.from({ length: 10 }, () => row({ costUsd: 0.1 })),
      false,
    );
    expect(summary?.costUsd).toBe(1);
  });
});

describe("summing summaries", () => {
  it("carries every child's flags and adds providers up, uncapped", () => {
    const left = boardCardUsageSummaryFromRows(
      [row({ turnsOverride: 0, turnsListPriced: 1 })],
      false,
    );
    const right = boardCardUsageSummaryFromRows(
      [row({ provider: "codex", costUsd: 1 }), row({ costUsd: 0.5 })],
      true,
    );
    expect(sumBoardCardUsageSummaries([left, null, undefined, right])).toEqual({
      tokens: 600,
      costUsd: 1.75,
      costKnown: true,
      estimated: true,
      partial: true,
      providers: [
        { provider: "codex", tokens: 200, costUsd: 1 },
        { provider: "claudeAgent", tokens: 400, costUsd: 0.75, estimated: true },
      ],
    });
  });

  it("is absent when no child has a figure", () => {
    expect(sumBoardCardUsageSummaries([null, undefined])).toBeNull();
  });
});

describe("the stage a step's usage belongs to", () => {
  it("groups a review round's phases and every CI step, and keeps a stage role as itself", () => {
    expect(boardUsageStageOfStep("review@2")).toBe("review");
    expect(boardUsageStageOfStep("triage@1")).toBe("review");
    expect(boardUsageStageOfStep("adjudicate@3")).toBe("review");
    expect(boardUsageStageOfStep("sync@2")).toBe("review");
    expect(boardUsageStageOfStep("ci-fix@1.2")).toBe("ci");
    expect(boardUsageStageOfStep("ci@run-1#0")).toBe("ci");
    expect(boardUsageStageOfStep("building")).toBe("building");
    expect(boardUsageStageOfStep("planning")).toBe("planning");
  });
});
