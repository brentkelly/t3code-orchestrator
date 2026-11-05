/**
 * T3o: a project's committed `t3o.json` (T3O-43) — per-project board stage
 * settings. A T3o-owned file and schema, never a key in upstream's `t3.json`.
 *
 * Decoding is forgiving by design: one bad entry is dropped with a warning
 * and the rest of the file still applies, so a typo in one stage's prompt
 * never switches a whole project back to the global pipeline.
 */
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import type { ProjectId } from "./baseSchemas.ts";
import {
  BOARD_STAGE_EXECUTION_PATCH_KEYS,
  BoardStageExecutionPatch,
  boardOrderKeyBetween,
  boardProjectStageId,
  boardStageExecutionKind,
  boardStagesInOrder,
  compareBoardStages,
  effectiveBoardStageRole,
  type BoardProjectStageConfig,
  type BoardProjectStageConfigSource,
  type BoardStageDefinition,
  type BoardStageExecutionKind,
  type BoardStageId,
  type BoardState,
} from "./board.ts";

export const T3O_PROJECT_FILE_NAME = "t3o.json";

export interface ResolvedT3oProjectFile {
  readonly config: BoardProjectStageConfig;
  /** The project-owned stage rows the file declares, placed in board order. */
  readonly stages: ReadonlyArray<BoardStageDefinition>;
}

const STAGE_FILE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const NESTED_STEP_KEYS = new Set(["prompt", "model", "runtimeMode", "timeoutMs", "maxAttempts"]);
const PLAN_REVIEW_KEYS = new Set(["enabledByDefault", "defaultRounds", "prompt"]);
const REVIEW_PHASES = new Set(["review", "triage", "adjudicate"]);

const decodePatch = Schema.decodeUnknownOption(BoardStageExecutionPatch);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Decode one leaf by decoding a patch holding only it, so the field's own
    schema (and nothing else) judges the value. */
function decodeLeaf(
  build: (value: unknown) => Record<string, unknown>,
  value: unknown,
): BoardStageExecutionPatch | null {
  return Option.getOrNull(decodePatch(build(value)));
}

function decodeNested(
  value: unknown,
  allowed: ReadonlySet<string>,
  where: string,
  warnings: string[],
  wrap: (inner: Record<string, unknown>) => Record<string, unknown>,
  pick: (patch: BoardStageExecutionPatch) => object | undefined,
): Record<string, unknown> | null {
  if (!isRecord(value)) {
    warnings.push(`${where}: expected an object; ignored.`);
    return null;
  }
  const out: Record<string, unknown> = {};
  for (const [key, leaf] of Object.entries(value)) {
    if (!allowed.has(key)) {
      warnings.push(`${where}.${key}: not a setting here; ignored.`);
      continue;
    }
    const decoded = decodeLeaf(() => wrap({ [key]: leaf }), leaf);
    const picked = decoded === null ? undefined : (pick(decoded) as Record<string, unknown>);
    if (picked === undefined || picked[key] === undefined) {
      warnings.push(`${where}.${key}: invalid value; ignored.`);
      continue;
    }
    out[key] = picked[key];
  }
  return Object.keys(out).length === 0 ? null : out;
}

/** Decode a stage's partial against the member it resolves to, keeping every
    valid key and warning about the rest. */
function decodeStagePatch(
  value: unknown,
  kind: BoardStageExecutionKind,
  where: string,
  warnings: string[],
  skip: ReadonlySet<string> = new Set(),
): BoardStageExecutionPatch {
  if (!isRecord(value)) {
    warnings.push(`${where}: expected an object of stage settings; ignored.`);
    return {};
  }
  const allowed = new Set<string>(BOARD_STAGE_EXECUTION_PATCH_KEYS[kind]);
  const out: Record<string, unknown> = {};
  for (const [key, leaf] of Object.entries(value)) {
    if (skip.has(key)) continue;
    if (key === "label") {
      warnings.push(`${where}.label: stage labels can't be overridden per project; ignored.`);
      continue;
    }
    if (!allowed.has(key)) {
      warnings.push(`${where}.${key}: not a setting of this stage; ignored.`);
      continue;
    }
    if (key === "phases") {
      if (!isRecord(leaf)) {
        warnings.push(`${where}.phases: expected an object; ignored.`);
        continue;
      }
      const phases: Record<string, unknown> = {};
      for (const [phase, phaseValue] of Object.entries(leaf)) {
        if (!REVIEW_PHASES.has(phase)) {
          warnings.push(`${where}.phases.${phase}: not a review phase; ignored.`);
          continue;
        }
        const decoded = decodeNested(
          phaseValue,
          NESTED_STEP_KEYS,
          `${where}.phases.${phase}`,
          warnings,
          (inner) => ({ phases: { [phase]: inner } }),
          (patch) => patch.phases?.[phase as "review" | "triage" | "adjudicate"],
        );
        if (decoded !== null) phases[phase] = decoded;
      }
      if (Object.keys(phases).length > 0) out.phases = phases;
      continue;
    }
    if (key === "submit" || key === "planReview") {
      const decoded = decodeNested(
        leaf,
        key === "submit" ? NESTED_STEP_KEYS : PLAN_REVIEW_KEYS,
        `${where}.${key}`,
        warnings,
        (inner) => ({ [key]: inner }),
        (patch) => patch[key],
      );
      if (decoded !== null) out[key] = decoded;
      continue;
    }
    const decoded = decodeLeaf(() => ({ [key]: leaf }), leaf);
    const decodedValue = decoded?.[key as keyof BoardStageExecutionPatch];
    if (decoded === null || decodedValue === undefined) {
      warnings.push(`${where}.${key}: invalid value; ignored.`);
      continue;
    }
    out[key] = decodedValue;
  }
  return out as BoardStageExecutionPatch;
}

function mergePatches(
  base: BoardStageExecutionPatch | undefined,
  next: BoardStageExecutionPatch,
): BoardStageExecutionPatch {
  if (base === undefined) return next;
  const phases =
    base.phases === undefined && next.phases === undefined
      ? undefined
      : {
          ...base.phases,
          ...next.phases,
          ...(["review", "triage", "adjudicate"] as const).reduce<Record<string, object>>(
            (acc, phase) => {
              const merged = { ...base.phases?.[phase], ...next.phases?.[phase] };
              if (Object.keys(merged).length > 0) acc[phase] = merged;
              return acc;
            },
            {},
          ),
        };
  return {
    ...base,
    ...next,
    ...(phases === undefined ? {} : { phases }),
    ...(base.submit === undefined && next.submit === undefined
      ? {}
      : { submit: { ...base.submit, ...next.submit } }),
    ...(base.planReview === undefined && next.planReview === undefined
      ? {}
      : { planReview: { ...base.planReview, ...next.planReview } }),
  };
}

interface PendingAdd {
  readonly fileId: string;
  readonly label: string;
  readonly after: string;
  readonly patch: BoardStageExecutionPatch;
}

/**
 * Resolve a project's parsed `t3o.json` against the board's global stages
 * (T3O-43). Never fails: every problem becomes a warning and the entry is
 * dropped. `raw` is the parsed JSON, or null for a missing file.
 */
export function resolveT3oProjectFile(input: {
  readonly raw: unknown;
  readonly board: BoardState;
  readonly projectId: ProjectId;
  readonly source: BoardProjectStageConfigSource | null;
  readonly now: string;
  /** Warnings raised before decoding (an unreadable or unparseable file). */
  readonly warnings?: ReadonlyArray<string>;
}): ResolvedT3oProjectFile {
  const warnings: string[] = [...(input.warnings ?? [])];
  const empty = (): ResolvedT3oProjectFile => ({
    config: {
      removedStageIds: [],
      addedStageIds: [],
      overrides: {},
      warnings,
      source: input.source,
    },
    stages: [],
  });
  if (input.raw === null || input.raw === undefined) return empty();
  if (!isRecord(input.raw)) {
    warnings.push(`${T3O_PROJECT_FILE_NAME} must be a JSON object; ignored.`);
    return empty();
  }
  for (const key of Object.keys(input.raw)) {
    if (key !== "$schema" && key !== "stages") warnings.push(`${key}: unknown key; ignored.`);
  }
  const stagesBlock = input.raw.stages;
  if (stagesBlock === undefined) return empty();
  if (!isRecord(stagesBlock)) {
    warnings.push("stages: expected an object; ignored.");
    return empty();
  }
  for (const key of Object.keys(stagesBlock)) {
    if (key !== "remove" && key !== "add" && key !== "settings") {
      warnings.push(`stages.${key}: unknown key; ignored.`);
    }
  }

  const globalStages = boardStagesInOrder(input.board);
  const globalById = new Map(globalStages.map((stage) => [String(stage.stageId), stage]));

  // ── remove ──
  const removedStageIds: BoardStageId[] = [];
  const removeBlock = stagesBlock.remove;
  if (removeBlock !== undefined && !Array.isArray(removeBlock)) {
    warnings.push("stages.remove: expected a list of stage ids; ignored.");
  } else if (Array.isArray(removeBlock)) {
    for (const entry of removeBlock) {
      if (typeof entry !== "string") {
        warnings.push("stages.remove: entries must be stage ids; one ignored.");
        continue;
      }
      const stage = globalById.get(entry);
      if (stage === undefined) {
        warnings.push(`stages.remove: "${entry}" is not a stage on this board; ignored.`);
        continue;
      }
      const role = effectiveBoardStageRole(stage);
      if (role !== null) {
        warnings.push(
          `stages.remove: "${entry}" (${stage.label}) holds the ${role} role and can't be removed; ignored.`,
        );
        continue;
      }
      if (!removedStageIds.includes(stage.stageId)) removedStageIds.push(stage.stageId);
    }
  }

  // ── add ──
  const pending: PendingAdd[] = [];
  const addBlock = stagesBlock.add;
  if (addBlock !== undefined && !Array.isArray(addBlock)) {
    warnings.push("stages.add: expected a list of stages; ignored.");
  } else if (Array.isArray(addBlock)) {
    addBlock.forEach((entry, index) => {
      const where = `stages.add[${index}]`;
      if (!isRecord(entry)) {
        warnings.push(`${where}: expected an object; ignored.`);
        return;
      }
      const { id, label, after } = entry;
      if (typeof id !== "string" || !STAGE_FILE_ID_PATTERN.test(id)) {
        warnings.push(
          `${where}.id: needs letters, digits, "-" or "_" (at most 64); stage ignored.`,
        );
        return;
      }
      if (globalById.has(id)) {
        warnings.push(`${where}: "${id}" is already a board stage id; stage ignored.`);
        return;
      }
      if (pending.some((candidate) => candidate.fileId === id)) {
        warnings.push(`${where}: "${id}" is added twice; the later one is ignored.`);
        return;
      }
      if (typeof label !== "string" || label.trim().length === 0) {
        warnings.push(`${where}.label: required; stage "${id}" ignored.`);
        return;
      }
      if (typeof after !== "string" || after.trim().length === 0) {
        warnings.push(`${where}.after: required; stage "${id}" ignored.`);
        return;
      }
      pending.push({
        fileId: id,
        label: label.trim(),
        after,
        patch: decodeStagePatch(
          entry,
          "simple",
          `${where}`,
          warnings,
          new Set(["id", "label", "after"]),
        ),
      });
    });
  }

  // Place each add directly after its anchor. Siblings are placed in reverse
  // file order so two stages after the same anchor keep their file order.
  const placed = new Map<string, BoardStageDefinition>();
  const combined: BoardStageDefinition[] = [...globalStages];
  let remaining = [...pending].reverse();
  for (let progress = true; progress && remaining.length > 0; ) {
    progress = false;
    const next: PendingAdd[] = [];
    for (const add of remaining) {
      const anchor =
        globalById.get(add.after) ??
        placed.get(add.after) ??
        (pending.some((candidate) => candidate.fileId === add.after) ? undefined : null);
      if (anchor === undefined) {
        next.push(add);
        continue;
      }
      if (anchor === null) {
        warnings.push(
          `stages.add: "${add.fileId}" is after "${add.after}", which is not a stage; stage ignored.`,
        );
        continue;
      }
      if (effectiveBoardStageRole(anchor) === "done") {
        warnings.push(
          `stages.add: "${add.fileId}" can't come after ${anchor.label}, the last stage; stage ignored.`,
        );
        continue;
      }
      combined.sort(compareBoardStages);
      const position = combined.findIndex((stage) => stage.stageId === anchor.stageId);
      const following = combined[position + 1];
      const orderKey = boardOrderKeyBetween(anchor.orderKey, following?.orderKey ?? null);
      if (orderKey === null) {
        warnings.push(`stages.add: no room to place "${add.fileId}"; stage ignored.`);
        continue;
      }
      const stage: BoardStageDefinition = {
        stageId: boardProjectStageId(input.projectId, add.fileId),
        label: add.label,
        role: null,
        orderKey,
        createdAt: input.now,
        updatedAt: input.now,
        projectId: input.projectId,
      };
      placed.set(add.fileId, stage);
      combined.push(stage);
      progress = true;
    }
    remaining = next;
  }
  for (const add of remaining) {
    warnings.push(
      `stages.add: "${add.fileId}" is after "${add.after}", which could not be placed; stage ignored.`,
    );
  }

  const overrides: Record<string, BoardStageExecutionPatch> = {};
  const addedStageIds: BoardStageId[] = [];
  for (const add of pending) {
    const stage = placed.get(add.fileId);
    if (stage === undefined) continue;
    addedStageIds.push(stage.stageId);
    if (Object.keys(add.patch).length > 0) overrides[stage.stageId] = add.patch;
  }

  // ── settings ──
  const settingsBlock = stagesBlock.settings;
  if (settingsBlock !== undefined && !isRecord(settingsBlock)) {
    warnings.push("stages.settings: expected an object keyed by stage id; ignored.");
  } else if (isRecord(settingsBlock)) {
    for (const [stageKey, value] of Object.entries(settingsBlock)) {
      const where = `stages.settings.${stageKey}`;
      const global = globalById.get(stageKey);
      const added = placed.get(stageKey);
      if (global === undefined && added === undefined) {
        warnings.push(`${where}: "${stageKey}" is not a stage on this board; ignored.`);
        continue;
      }
      const targetId = (global ?? added)!.stageId;
      const kind = global === undefined ? "simple" : boardStageExecutionKind(global.stageId);
      const patch = decodeStagePatch(value, kind, where, warnings);
      if (Object.keys(patch).length === 0) continue;
      overrides[targetId] = mergePatches(overrides[targetId], patch);
    }
  }

  return {
    config: { removedStageIds, addedStageIds, overrides, warnings, source: input.source },
    stages: [...placed.values()].sort(compareBoardStages),
  };
}

/** Parse a `t3o.json` body to JSON, or a warning saying why it could not be. */
export function parseT3oProjectFile(
  text: string,
): { readonly raw: unknown; readonly warning: null } | { readonly raw: null; readonly warning: string } {
  try {
    return { raw: JSON.parse(text) as unknown, warning: null };
  } catch (cause) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    return { raw: null, warning: `${T3O_PROJECT_FILE_NAME} is not valid JSON (${detail}); ignored.` };
  }
}
