import { ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { deriveBoardUsageBreakdown } from "./boardUsageBreakdown";
import { usageRow } from "./boardUsageFixtures";

const STAGES = [
  { stageId: "planning", label: "Planning" },
  { stageId: "building", label: "Building" },
  { stageId: "review", label: "Code review" },
];

describe("a card's usage breakdown", () => {
  const rows = [
    usageRow({ stepId: "review@1", threadId: ThreadId.make("t-r1"), costUsd: 0.5 }),
    usageRow(),
    usageRow({
      stepId: "triage@1",
      threadId: ThreadId.make("t-t1"),
      provider: "codex",
      model: "gpt-5-codex",
      costUsd: 0.25,
      turnsOverride: 0,
      turnsListPriced: 1,
    }),
    usageRow({
      stepId: "adjudicate@1",
      threadId: ThreadId.make("t-a1"),
      provider: "cursor",
      model: null,
      uncachedInputTokens: 0,
      cachedInputTokens: 0,
      cacheCreationTokens: 0,
      outputTokens: 0,
      reasoningTokens: 0,
      costUsd: 0,
      turnsOverride: 0,
      turnsNoUsage: 1,
    }),
  ];
  const breakdown = deriveBoardUsageBreakdown({
    rows,
    historyPartial: false,
    stages: STAGES,
    runningThreadId: ThreadId.make("t-t1"),
  });

  it("groups a review round's phases under Code review, in board order", () => {
    expect(breakdown.stages.map((stage) => [stage.label, stage.lines.length])).toEqual([
      ["Building", 1],
      ["Code review", 3],
    ]);
    expect(breakdown.stages[1]?.models).toBe("3 threads · 3 models");
  });

  it("counts a review stage's rounds across every loop phase, not only review@N", () => {
    expect(breakdown.stages.map((stage) => stage.rounds)).toEqual([0, 1]);
    const later = deriveBoardUsageBreakdown({
      rows: [
        usageRow({ stepId: "review@1", threadId: ThreadId.make("t-r1") }),
        usageRow({ stepId: "retriage@2", threadId: ThreadId.make("t-t2") }),
        usageRow({ stepId: "sync@3", threadId: ThreadId.make("t-s3") }),
      ],
      historyPartial: false,
      stages: STAGES,
      runningThreadId: null,
    });
    expect(later.stages[0]?.rounds).toBe(3);
  });

  it("splits input from cache reads, counting cache writes as input", () => {
    expect(breakdown.stages[0]).toMatchObject({ input: 1200, cached: 4000, output: 300 });
  });

  it("tags each row by where its cost came from, and a running row so far", () => {
    expect(breakdown.stages[1]?.lines.map((line) => [line.stepId, line.tag])).toEqual([
      ["review@1", null],
      ["triage@1", "est."],
      ["adjudicate@1", "no usage"],
    ]);
    expect(breakdown.stages[1]?.running).toBe(true);
    expect(breakdown.running).toBe(true);
  });

  it("names every step that leaves the total partial, and the ones it estimated", () => {
    expect(breakdown.summary).toMatchObject({ costUsd: 1.75, estimated: true, partial: true });
    expect(breakdown.partialSteps).toEqual(["adjudicate@1"]);
    expect(breakdown.estimatedSteps).toEqual(["triage@1"]);
    expect(breakdown.missing[0]?.text).toContain("reported no tokens");
  });

  it("lists models costliest first", () => {
    expect(breakdown.models.map((model) => model.model)).toEqual([
      "claude-sonnet",
      "gpt-5-codex",
      "Unknown model",
    ]);
    expect(breakdown.models[0]?.steps).toEqual(["review@1", "building"]);
  });

  it("notes every cause that leaves one row partial", () => {
    const mixed = deriveBoardUsageBreakdown({
      rows: [usageRow({ turnsOverride: 0, turnsNoUsage: 1, turnsUnpriced: 1, turnsPartial: 1 })],
      historyPartial: false,
      stages: STAGES,
      runningThreadId: null,
    });
    expect(mixed.missing.map((entry) => entry.text)).toEqual([
      expect.stringContaining("reported no tokens"),
      expect.stringContaining("has no price"),
      expect.stringContaining("reported only part of its usage"),
    ]);
  });

  it("says when worker history predates tracking", () => {
    const history = deriveBoardUsageBreakdown({
      rows: [],
      historyPartial: true,
      stages: STAGES,
      runningThreadId: null,
    });
    expect(history.summary).toMatchObject({ partial: true });
    expect(history.missing.map((entry) => entry.stepId)).toEqual(["Earlier work"]);
  });
});
