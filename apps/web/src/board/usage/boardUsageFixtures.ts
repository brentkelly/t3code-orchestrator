/** A card usage row for tests, every field filled. */
import { ThreadId, type BoardCardUsageRow } from "@t3tools/contracts";

export const usageRow = (overrides: Partial<BoardCardUsageRow> = {}): BoardCardUsageRow => ({
  stepId: "building",
  threadId: ThreadId.make("thread-build"),
  provider: "claudeAgent",
  model: "claude-sonnet",
  uncachedInputTokens: 1000,
  cachedInputTokens: 4000,
  cacheCreationTokens: 200,
  outputTokens: 300,
  reasoningTokens: 100,
  costUsd: 1,
  turnsReported: 0,
  turnsOverride: 2,
  turnsListPriced: 0,
  turnsUnpriced: 0,
  turnsNoUsage: 0,
  updatedAt: "2026-01-01T00:00:00.000Z",
  ...overrides,
});
