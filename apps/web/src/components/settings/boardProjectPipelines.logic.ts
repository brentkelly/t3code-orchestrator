/**
 * T3o: Settings → Board's read-only Project pipelines rows (T3O-43). What each
 * project's committed `t3o.json` changes from the global pipeline: summary
 * chips, the resolved stage sequence, and every overridden setting beside the
 * global value it replaces.
 */
import {
  boardAllStages,
  boardProjectStageConfig,
  boardProjectStagesInOrder,
  boardStageById,
  compareBoardStages,
  resolveBoardStageExecution,
  type BoardProjectStageConfig,
  type BoardSettings,
  type BoardStageExecutionPatch,
  type BoardStageId,
  type BoardStageView,
  type ProjectId,
} from "@t3tools/contracts";

const plural = (count: number, one: string, many: string) =>
  `${count} ${count === 1 ? one : many}`;

export interface BoardProjectPipelineOverride {
  readonly stageLabel: string;
  /** The field's path inside the stage's settings, e.g. `phases.triage.prompt`. */
  readonly field: string;
  readonly projectValue: string;
  readonly globalValue: string;
}

export interface BoardProjectPipelineStep {
  readonly stageId: BoardStageId;
  readonly label: string;
  readonly change: "added" | "removed" | null;
}

export interface BoardProjectPipelineSummary {
  /** No file: the project follows the global pipeline exactly. */
  readonly followsGlobal: boolean;
  readonly chips: ReadonlyArray<string>;
  readonly warnings: ReadonlyArray<string>;
  readonly sequence: ReadonlyArray<BoardProjectPipelineStep>;
  readonly overrides: ReadonlyArray<BoardProjectPipelineOverride>;
  readonly path: string | null;
  readonly commitSha: string | null;
}

/** A setting's value, short enough for one table cell. */
export function formatBoardSettingValue(value: unknown): string {
  if (value === undefined) return "—";
  if (value === null) return "default";
  if (typeof value === "string") {
    const flat = value.replace(/\s+/g, " ").trim();
    if (flat.length === 0) return "(empty)";
    return flat.length > 80 ? `${flat.slice(0, 79)}…` : flat;
  }
  if (typeof value === "object" && "model" in value && typeof value.model === "string") {
    return value.model;
  }
  return JSON.stringify(value);
}

/** Every leaf of a patch as `[path, value]`, nested step configs flattened. */
function patchLeaves(patch: BoardStageExecutionPatch): Array<readonly [string, unknown]> {
  const leaves: Array<readonly [string, unknown]> = [];
  const walk = (prefix: string, value: object) => {
    for (const [key, leaf] of Object.entries(value)) {
      const path = prefix === "" ? key : `${prefix}.${key}`;
      const nested = key === "phases" || key === "submit" || key === "planReview" || prefix === "phases";
      if (nested && typeof leaf === "object" && leaf !== null && !("instanceId" in leaf)) {
        walk(path, leaf);
      } else {
        leaves.push([path, leaf] as const);
      }
    }
  };
  walk("", patch);
  return leaves;
}

function valueAt(source: unknown, path: string): unknown {
  let current = source;
  for (const key of path.split(".")) {
    if (typeof current !== "object" || current === null) return undefined;
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}

export function boardProjectPipelineSummary(input: {
  readonly view: BoardStageView;
  readonly projectId: ProjectId;
  readonly settings: BoardSettings;
}): BoardProjectPipelineSummary {
  const config: BoardProjectStageConfig | null = boardProjectStageConfig(input.view, input.projectId);
  if (config === null || config.source === null) {
    return {
      followsGlobal: config === null || (config.warnings.length === 0 && config.source === null),
      chips: config === null || config.warnings.length === 0 ? [] : [plural(config.warnings.length, "ignored entry", "ignored entries")],
      warnings: config?.warnings ?? [],
      sequence: [],
      overrides: [],
      path: null,
      commitSha: null,
    };
  }
  const removed = new Set<string>(config.removedStageIds);
  const used = new Set<string>(
    boardProjectStagesInOrder(input.view, input.projectId).map((stage) => stage.stageId),
  );
  const sequence = [...boardAllStages(input.view)]
    .sort(compareBoardStages)
    .filter(
      (stage) =>
        (stage.projectId === null && (used.has(stage.stageId) || removed.has(stage.stageId))) ||
        config.addedStageIds.includes(stage.stageId),
    )
    .map(
      (stage): BoardProjectPipelineStep => ({
        stageId: stage.stageId,
        label: stage.label,
        change: stage.projectId !== null ? "added" : removed.has(stage.stageId) ? "removed" : null,
      }),
    );

  const overrides: Array<BoardProjectPipelineOverride> = [];
  for (const [stageId, patch] of Object.entries(config.overrides)) {
    const stage = boardStageById(input.view, stageId as BoardStageId);
    const global = resolveBoardStageExecution(input.settings, stageId as BoardStageId);
    for (const [field, value] of patchLeaves(patch)) {
      overrides.push({
        stageLabel: stage?.label ?? stageId,
        field,
        projectValue: formatBoardSettingValue(value),
        // A project-added stage has no global value; the simple defaults stand in.
        globalValue: formatBoardSettingValue(valueAt(global, field)),
      });
    }
  }

  const chips: Array<string> = [];
  if (config.addedStageIds.length > 0) {
    chips.push(`+${plural(config.addedStageIds.length, "stage", "stages")}`);
  }
  if (config.removedStageIds.length > 0) {
    chips.push(`−${plural(config.removedStageIds.length, "stage", "stages")}`);
  }
  if (overrides.length > 0) chips.push(plural(overrides.length, "override", "overrides"));
  if (config.warnings.length > 0) {
    chips.push(plural(config.warnings.length, "ignored entry", "ignored entries"));
  }
  return {
    followsGlobal: false,
    chips,
    warnings: config.warnings,
    sequence,
    overrides,
    path: config.source.path,
    commitSha: config.source.commitSha,
  };
}
