/**
 * A card's usage rows as the Summary pane's Usage section draws them (T3O-77): by stage,
 * each stage's steps one row per thread and model, or by model; the per-stage bar; and
 * the note naming every step that leaves the figure partial.
 */
import {
  boardCardUsageSummaryFromRows,
  boardUsageStageOfStep,
  type BoardCardUsageRow,
  type BoardCardUsageSummary,
  type ThreadId,
} from "@t3tools/contracts";

import { boardUsageProviderLabel } from "./boardUsageFormat";

export type BoardUsageTag = "est." | "unpriced" | "no usage" | "so far";

export interface BoardUsageColumns {
  /** Uncached input, cache writes included: what was not a cache read. */
  readonly input: number;
  readonly cached: number;
  /** Includes reasoning. */
  readonly output: number;
  readonly reasoning: number;
}

export interface BoardUsageLine extends BoardUsageColumns {
  readonly key: string;
  readonly stepId: string;
  readonly threadId: ThreadId;
  readonly model: string;
  readonly provider: string;
  readonly costUsd: number;
  readonly costKnown: boolean;
  readonly estimated: boolean;
  /** No token counts at all: every turn of the row reported nothing. */
  readonly noUsage: boolean;
  readonly unpriced: boolean;
  readonly running: boolean;
  readonly tag: BoardUsageTag | null;
}

export interface BoardUsageStageGroup extends BoardUsageColumns {
  readonly stageId: string;
  readonly label: string;
  readonly summary: BoardCardUsageSummary;
  readonly running: boolean;
  /** `3 threads · 2 models`, or the one model. */
  readonly models: string;
  readonly lines: ReadonlyArray<BoardUsageLine>;
}

export interface BoardUsageModelGroup extends BoardUsageColumns {
  readonly key: string;
  readonly model: string;
  readonly provider: string;
  readonly steps: ReadonlyArray<string>;
  readonly summary: BoardCardUsageSummary;
  readonly tag: BoardUsageTag | null;
}

export interface BoardUsageMissing {
  readonly stepId: string;
  readonly text: string;
}

export interface BoardUsageBreakdown {
  readonly summary: BoardCardUsageSummary | null;
  readonly totals: BoardUsageColumns;
  readonly threadCount: number;
  readonly providerCount: number;
  readonly stages: ReadonlyArray<BoardUsageStageGroup>;
  readonly models: ReadonlyArray<BoardUsageModelGroup>;
  readonly missing: ReadonlyArray<BoardUsageMissing>;
  readonly estimatedSteps: ReadonlyArray<string>;
  readonly partialSteps: ReadonlyArray<string>;
  readonly running: boolean;
}

const STAGE_FALLBACK_LABELS: Readonly<Record<string, string>> = {
  review: "Code review",
  ci: "CI",
  linked: "Linked threads",
};

const UNKNOWN_MODEL = "Unknown model";

const columnsOf = (rows: ReadonlyArray<BoardCardUsageRow>): BoardUsageColumns => {
  let input = 0;
  let cached = 0;
  let output = 0;
  let reasoning = 0;
  for (const row of rows) {
    input += row.uncachedInputTokens + row.cacheCreationTokens;
    cached += row.cachedInputTokens;
    output += row.outputTokens;
    reasoning += row.reasoningTokens;
  }
  return { input, cached, output, reasoning };
};

const priced = (row: BoardCardUsageRow) =>
  row.turnsReported + row.turnsOverride + row.turnsListPriced > 0;

const tagOf = (input: {
  readonly costKnown: boolean;
  readonly estimated: boolean;
  readonly noUsage: boolean;
  readonly running: boolean;
}): BoardUsageTag | null => {
  if (input.noUsage) return "no usage";
  if (!input.costKnown) return "unpriced";
  if (input.estimated) return "est.";
  return input.running ? "so far" : null;
};

const uniqueInOrder = (values: Iterable<string>): ReadonlyArray<string> => [...new Set(values)];

export function deriveBoardUsageBreakdown(input: {
  readonly rows: ReadonlyArray<BoardCardUsageRow>;
  readonly historyPartial: boolean;
  /** Stage ids in board order, with their labels. */
  readonly stages: ReadonlyArray<{ readonly stageId: string; readonly label: string }>;
  /** The thread whose step is running now, or null. */
  readonly runningThreadId: ThreadId | null;
}): BoardUsageBreakdown {
  const { rows } = input;
  const lines: Array<BoardUsageLine & { readonly row: BoardCardUsageRow }> = rows.map((row) => {
    const costKnown = priced(row);
    const noUsage = !costKnown && row.turnsUnpriced === 0 && row.turnsNoUsage > 0;
    const running = input.runningThreadId !== null && row.threadId === input.runningThreadId;
    const estimated = row.turnsListPriced > 0;
    return {
      row,
      key: `${row.stepId}|${row.threadId}|${row.provider}|${row.model ?? ""}`,
      stepId: row.stepId,
      threadId: row.threadId,
      model: row.model ?? UNKNOWN_MODEL,
      provider: boardUsageProviderLabel(row.provider),
      costUsd: row.costUsd,
      costKnown,
      estimated,
      noUsage,
      unpriced: !costKnown && !noUsage,
      running,
      tag: tagOf({ costKnown, estimated, noUsage, running }),
      ...columnsOf([row]),
    };
  });

  const order = new Map(input.stages.map((stage, index) => [stage.stageId, index] as const));
  const labels = new Map(input.stages.map((stage) => [stage.stageId, stage.label] as const));
  const byStage = new Map<string, Array<(typeof lines)[number]>>();
  for (const line of lines) {
    const stageId = boardUsageStageOfStep(line.stepId);
    const held = byStage.get(stageId);
    if (held === undefined) byStage.set(stageId, [line]);
    else held.push(line);
  }
  const stages = [...byStage.entries()]
    .map(([stageId, stageLines]): BoardUsageStageGroup => {
      const models = uniqueInOrder(stageLines.map((line) => line.model));
      return {
        stageId,
        label: labels.get(stageId) ?? STAGE_FALLBACK_LABELS[stageId] ?? stageId,
        summary: boardCardUsageSummaryFromRows(
          stageLines.map((line) => line.row),
          false,
        ) as BoardCardUsageSummary,
        running: stageLines.some((line) => line.running),
        models:
          stageLines.length > 1
            ? `${stageLines.length} threads · ${models.length} ${models.length === 1 ? "model" : "models"}`
            : (models[0] ?? UNKNOWN_MODEL),
        lines: stageLines,
        ...columnsOf(stageLines.map((line) => line.row)),
      };
    })
    .sort(
      (a, b) =>
        (order.get(a.stageId) ?? Number.MAX_SAFE_INTEGER) -
          (order.get(b.stageId) ?? Number.MAX_SAFE_INTEGER) || (a.label < b.label ? -1 : 1),
    );

  const byModel = new Map<string, Array<(typeof lines)[number]>>();
  for (const line of lines) {
    const key = `${line.row.provider}|${line.row.model ?? ""}`;
    const held = byModel.get(key);
    if (held === undefined) byModel.set(key, [line]);
    else held.push(line);
  }
  const models = [...byModel.entries()]
    .map(([key, modelLines]): BoardUsageModelGroup => {
      const summary = boardCardUsageSummaryFromRows(
        modelLines.map((line) => line.row),
        false,
      ) as BoardCardUsageSummary;
      return {
        key,
        model: modelLines[0]!.model,
        provider: modelLines[0]!.provider,
        steps: uniqueInOrder(modelLines.map((line) => line.stepId)),
        summary,
        tag: tagOf({
          costKnown: summary.costKnown === true,
          estimated: summary.estimated === true,
          noUsage: modelLines.every((line) => line.noUsage),
          running: false,
        }),
        ...columnsOf(modelLines.map((line) => line.row)),
      };
    })
    .sort((a, b) => b.summary.costUsd - a.summary.costUsd || b.summary.tokens - a.summary.tokens);

  const missing = lines.flatMap((line): ReadonlyArray<BoardUsageMissing> => {
    if (line.row.turnsNoUsage > 0) {
      return [
        {
          stepId: line.stepId,
          text: `${line.model} (${line.provider}) reported no tokens for ${line.row.turnsNoUsage === 1 ? "a turn" : `${line.row.turnsNoUsage} turns`}. Usage unknown.`,
        },
      ];
    }
    if (line.row.turnsUnpriced > 0) {
      const tokens = line.input + line.cached + line.output;
      return [
        {
          stepId: line.stepId,
          text: `${line.model} via ${line.provider} has no price. ${tokens.toLocaleString()} tokens not costed.`,
        },
      ];
    }
    return [];
  });
  if (input.historyPartial) {
    missing.push({
      stepId: "Earlier work",
      text: "This card ran on a worker before usage was tracked, so that work is not counted.",
    });
  }

  return {
    summary: boardCardUsageSummaryFromRows(rows, input.historyPartial),
    totals: columnsOf(rows),
    threadCount: new Set(rows.map((row) => row.threadId)).size,
    providerCount: new Set(rows.map((row) => row.provider)).size,
    stages,
    models,
    missing,
    estimatedSteps: uniqueInOrder(
      lines.filter((line) => line.estimated).map((line) => line.stepId),
    ),
    partialSteps: uniqueInOrder(missing.map((entry) => entry.stepId)),
    running: lines.some((line) => line.running),
  };
}
