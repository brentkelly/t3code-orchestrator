// T3o: a project's committed `t3o.json`, never a key in upstream's
// `t3.json`. Decoding is forgiving: a bad entry is dropped with a warning and
// the rest of the file applies, so one typo never resets a whole project.
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import type { ProjectId } from "./baseSchemas.ts";
import {
  BOARD_CI_MAX_STEPS,
  BOARD_SEED_STAGE_IDS,
  BOARD_STAGE_EXECUTION_PATCH_KEYS,
  BoardCiStep,
  BoardStageExecutionPatch,
  boardLegacyCiStepId,
  boardNewStageOrderKey,
  boardOrderKeyBetween,
  boardCiStopsOnFailure,
  boardStageById,
  boardStageDefaultForProjects,
  boardStageExecutionKind,
  boardStagesInOrder,
  compareBoardStages,
  effectiveBoardStageRole,
  isBoardStageSwitchable,
  type BoardProjectImportDelta,
  type BoardProjectStageConfig,
  type BoardStageDefinition,
  type BoardStageExecutionKind,
  type BoardStageId,
  type BoardState,
} from "./board.ts";
import { normalizeBoardReadinessPath, type BoardProjectResources } from "./boardCapacity.ts";

// T3o: a `t3o.json` is only an import/export format for a
// project's delta, never read at run time.
export const T3O_PROJECT_FILE_NAME = "t3o.json";
const T3O_PROJECT_FILE_VERSION = 2;

/** What a `t3o.json` would make a project's delta, before normalization. */
export interface ResolvedT3oProjectFile {
  readonly delta: BoardProjectImportDelta;
  /** Stages the import creates: default off, on for this project. */
  readonly createStages: ReadonlyArray<BoardStageDefinition>;
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

const decodeStep = Schema.decodeUnknownOption(BoardCiStep);

/** The step kinds this board can run; the rest are ignored on import. */
export const BOARD_CI_RUNNABLE_STEP_KINDS: ReadonlySet<BoardCiStep["kind"]> = new Set([
  "script",
  "agent",
  "forge-checks",
]);

function decodeCiSteps(value: unknown, where: string, legacy: boolean, warnings: string[]) {
  if (!Array.isArray(value)) {
    warnings.push(`${where}: expected a list of steps; ignored.`);
    return [];
  }
  const steps: BoardCiStep[] = [];
  const ids = new Set<string>();
  value.forEach((entry, index) => {
    const at = `${where}[${index}]`;
    if (!isRecord(entry)) {
      warnings.push(`${at}: expected an object; ignored.`);
      return;
    }
    const raw = {
      kind: "script",
      ...entry,
      id:
        typeof entry.id === "string"
          ? entry.id
          : legacy
            ? boardLegacyCiStepId(index)
            : `step-${index + 1}`,
    };
    const decoded = Option.getOrNull(decodeStep(raw));
    if (decoded === null) {
      warnings.push(`${at}: not a valid ${String(raw.kind)} step (or too long); ignored.`);
      return;
    }
    if (!BOARD_CI_RUNNABLE_STEP_KINDS.has(decoded.kind)) {
      warnings.push(`${at}: ${decoded.kind} steps aren't supported on this board yet; ignored.`);
      return;
    }
    if (ids.has(decoded.id)) {
      warnings.push(`${at}: the id "${decoded.id}" is used twice; ignored.`);
      return;
    }
    if (steps.length >= BOARD_CI_MAX_STEPS) {
      warnings.push(`${at}: at most ${BOARD_CI_MAX_STEPS} steps; ignored.`);
      return;
    }
    const previous = steps.at(-1);
    const parallel = decoded.parallel && decoded.kind === "script" && previous?.kind === "script";
    if (decoded.parallel && !parallel) {
      warnings.push(`${at}: only a script after a script can run in parallel; it runs on its own.`);
    }
    ids.add(decoded.id);
    steps.push({ ...decoded, parallel });
  });
  return steps;
}

function stageIdList(value: unknown, where: string, warnings: string[]): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    warnings.push(`${where}: expected a list of stage ids; ignored.`);
    return [];
  }
  return value.flatMap((entry) => {
    if (typeof entry === "string") return [entry];
    warnings.push(`${where}: entries must be stage ids; one ignored.`);
    return [];
  });
}

/**
 * The delta importing a parsed `t3o.json` (v1 or v2) would set. Never fails:
 * a bad entry becomes a warning. An added stage reuses one with its id (or the
 * project-scoped `<projectId>:<id>`) and label, else is created off by default.
 */
export function resolveT3oProjectFile(input: {
  readonly raw: unknown;
  readonly board: BoardState;
  readonly projectId: ProjectId;
  readonly now: string;
  readonly warnings?: ReadonlyArray<string>;
}): ResolvedT3oProjectFile {
  const warnings: string[] = [...(input.warnings ?? [])];
  const stageSwitches: Record<string, boolean> = {};
  const overrides: Record<string, BoardStageExecutionPatch> = {};
  let steps: BoardCiStep[] = [];
  // Stored only as false; absent is Yes.
  let stopOnFailure = true;
  let resources: BoardProjectResources | undefined;
  const result = (createStages: ReadonlyArray<BoardStageDefinition> = []) => ({
    delta: {
      stageSwitches,
      overrides,
      ci: stopOnFailure ? { steps } : { steps, stopOnFailure: false },
      warnings,
      ...(resources === undefined ? {} : { resources }),
    },
    createStages,
  });
  if (input.raw === null || input.raw === undefined) return result();
  if (!isRecord(input.raw)) {
    warnings.push(`${T3O_PROJECT_FILE_NAME} must be a JSON object; ignored.`);
    return result();
  }
  for (const key of Object.keys(input.raw)) {
    if (!["$schema", "version", "stages", "ci", "resources"].includes(key)) {
      warnings.push(`${key}: unknown key; ignored.`);
    }
  }
  if (input.raw.resources !== undefined) {
    resources = decodeResources(input.raw.resources, warnings);
  }
  const stagesBlock = input.raw.stages ?? {};
  if (!isRecord(stagesBlock)) {
    warnings.push("stages: expected an object; ignored.");
    return result();
  }
  for (const key of Object.keys(stagesBlock)) {
    if (!["enable", "remove", "add", "settings"].includes(key)) {
      warnings.push(`stages.${key}: unknown key; ignored.`);
    }
  }

  const switchTarget = (stageId: string, on: boolean, where: string) => {
    const stage = boardStageById(input.board, stageId as BoardStageId);
    if (stage === null) {
      warnings.push(`${where}: "${stageId}" is not a stage on this board; ignored.`);
      return;
    }
    if (stage.stageId === BOARD_SEED_STAGE_IDS.ci) {
      warnings.push(`${where}: "${stageId}" is switched with ci.enabled; ignored.`);
      return;
    }
    if (!isBoardStageSwitchable(input.board, stage)) {
      const role = effectiveBoardStageRole(stage);
      warnings.push(
        role === null
          ? `${where}: "${stageId}" (${stage.label}) is where cards wait to build and is always on; ignored.`
          : `${where}: "${stageId}" (${stage.label}) holds the ${role} role and is always on; ignored.`,
      );
      return;
    }
    stageSwitches[stage.stageId] = on;
  };
  for (const stageId of stageIdList(stagesBlock.remove, "stages.remove", warnings)) {
    switchTarget(stageId, false, "stages.remove");
  }
  for (const stageId of stageIdList(stagesBlock.enable, "stages.enable", warnings)) {
    switchTarget(stageId, true, "stages.enable");
  }

  // Stages the file adds: reuse a same-label stage, else create one.
  const createStages: BoardStageDefinition[] = [];
  const addedIds = new Map<string, BoardStageId>();
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
      if (addedIds.has(id)) {
        warnings.push(`${where}: "${id}" is added twice; the later one is ignored.`);
        return;
      }
      if (typeof label !== "string" || label.trim().length === 0) {
        warnings.push(`${where}.label: required; stage "${id}" ignored.`);
        return;
      }
      const existing =
        boardStageById(input.board, id as BoardStageId) ??
        boardStageById(input.board, `${input.projectId}:${id}` as BoardStageId);
      let stageId: BoardStageId;
      if (existing !== null) {
        if (existing.label !== label.trim()) {
          warnings.push(
            `${where}: "${id}" is already the ${existing.label} stage, with a different label; stage ignored.`,
          );
          return;
        }
        if (
          !isBoardStageSwitchable(input.board, existing) ||
          existing.stageId === BOARD_SEED_STAGE_IDS.ci
        ) {
          warnings.push(`${where}: "${id}" is a built-in stage; stage ignored.`);
          return;
        }
        stageId = existing.stageId;
      } else {
        const orderKey = placeNewStage(input.board, createStages, after, where, warnings);
        if (orderKey === null) {
          warnings.push(`${where}: no room to place "${id}"; stage ignored.`);
          return;
        }
        stageId = id as BoardStageId;
        createStages.push({
          stageId,
          label: label.trim(),
          role: null,
          orderKey,
          createdAt: input.now,
          updatedAt: input.now,
          projectId: input.projectId,
          defaultForProjects: false,
        });
      }
      addedIds.set(id, stageId);
      stageSwitches[stageId] = true;
      const patch = decodeStagePatch(
        entry,
        "simple",
        where,
        warnings,
        new Set(["id", "label", "after"]),
      );
      if (Object.keys(patch).length > 0) overrides[stageId] = patch;
    });
  }

  // Per-stage settings. v1 kept CI's steps and switch in `settings.ci`.
  let legacyCi: { readonly steps: unknown; readonly enabled: unknown } | null = null;
  const settingsBlock = stagesBlock.settings;
  if (settingsBlock !== undefined && !isRecord(settingsBlock)) {
    warnings.push("stages.settings: expected an object keyed by stage id; ignored.");
  } else if (isRecord(settingsBlock)) {
    for (const [stageKey, rawValue] of Object.entries(settingsBlock)) {
      const where = `stages.settings.${stageKey}`;
      let value = rawValue;
      if (stageKey === BOARD_SEED_STAGE_IDS.ci && isRecord(rawValue)) {
        const { steps: legacySteps, enabled, ...rest } = rawValue;
        if (legacySteps !== undefined || enabled !== undefined) {
          legacyCi = { steps: legacySteps, enabled };
        }
        value = rest;
      }
      const target =
        addedIds.get(stageKey) ?? boardStageById(input.board, stageKey as BoardStageId)?.stageId;
      if (target === undefined) {
        warnings.push(`${where}: "${stageKey}" is not a stage on this board; ignored.`);
        continue;
      }
      const kind = addedIds.has(stageKey) ? "simple" : boardStageExecutionKind(target);
      const patch = decodeStagePatch(value, kind, where, warnings);
      if (Object.keys(patch).length === 0) continue;
      overrides[target] = mergePatches(overrides[target], patch);
    }
  }

  // CI: v2's top-level `ci`, else v1's `stages.settings.ci`.
  const ciBlock = input.raw.ci;
  let ciEnabled: unknown;
  if (ciBlock !== undefined) {
    if (!isRecord(ciBlock)) {
      warnings.push("ci: expected an object; ignored.");
    } else {
      for (const key of Object.keys(ciBlock)) {
        if (key !== "enabled" && key !== "steps" && key !== "stopOnFailure") {
          warnings.push(`ci.${key}: unknown key; ignored.`);
        }
      }
      if (ciBlock.steps !== undefined)
        steps = decodeCiSteps(ciBlock.steps, "ci.steps", false, warnings);
      ciEnabled = ciBlock.enabled;
      if (ciBlock.stopOnFailure !== undefined) {
        if (typeof ciBlock.stopOnFailure === "boolean") stopOnFailure = ciBlock.stopOnFailure;
        else warnings.push("ci.stopOnFailure: expected true or false; ignored.");
      }
    }
  } else if (legacyCi !== null) {
    const legacy = legacyCi as { readonly steps: unknown; readonly enabled: unknown };
    if (legacy.steps !== undefined) {
      steps = decodeCiSteps(legacy.steps, "stages.settings.ci.steps", true, warnings);
    }
    ciEnabled = legacy.enabled;
  }
  if (ciEnabled !== undefined && typeof ciEnabled !== "boolean") {
    warnings.push("ci.enabled: expected true or false; ignored.");
    ciEnabled = undefined;
  }
  if (steps.length > 0 || ciEnabled === true) {
    stageSwitches[BOARD_SEED_STAGE_IDS.ci] = ciEnabled !== false;
  }
  if (ciEnabled === true && steps.length === 0) {
    warnings.push("ci.enabled: CI is on but has no steps, so cards skip it until one is added.");
  }
  return result(createStages);
}

const positiveNumber = (value: unknown, where: string, warnings: string[]): number | null => {
  if (value === undefined || value === null) return null;
  if (typeof value === "number" && Number.isFinite(value) && value > 0) return value;
  warnings.push(`${where}: expected a positive number; ignored.`);
  return null;
};

/** T3o: the file's `resources` block (T3O-86). A bad entry is dropped with a warning. */
function decodeResources(value: unknown, warnings: string[]): BoardProjectResources | undefined {
  if (!isRecord(value)) {
    warnings.push("resources: expected an object; ignored.");
    return undefined;
  }
  for (const key of Object.keys(value)) {
    if (!["baseline", "setupTimeoutMinutes", "readiness"].includes(key)) {
      warnings.push(`resources.${key}: unknown key; ignored.`);
    }
  }
  let baseline: BoardProjectResources["baseline"] = null;
  if (value.baseline !== undefined) {
    const raw = value.baseline;
    if (!isRecord(raw)) {
      warnings.push("resources.baseline: expected an object; ignored.");
    } else {
      const cpuCores = positiveNumber(raw.cpuCores, "resources.baseline.cpuCores", warnings);
      const ramGiB = positiveNumber(raw.ramGiB, "resources.baseline.ramGiB", warnings);
      const diskGB = positiveNumber(raw.diskGB, "resources.baseline.diskGB", warnings);
      if (cpuCores !== null && ramGiB !== null && diskGB !== null) {
        baseline = { cpuCores, ramGiB, diskGB, setAtUpgrade: false };
      } else {
        warnings.push("resources.baseline: needs cpuCores, ramGiB and diskGB; ignored.");
      }
    }
  }
  let readinessPath: string | null = null;
  let readinessTimeoutSeconds: number | null = null;
  if (value.readiness !== undefined) {
    const raw = value.readiness;
    if (!isRecord(raw)) {
      warnings.push("resources.readiness: expected an object; ignored.");
    } else {
      if (raw.path !== undefined) {
        readinessPath = typeof raw.path === "string" ? normalizeBoardReadinessPath(raw.path) : null;
        if (readinessPath === null) {
          warnings.push(
            "resources.readiness.path: must be a relative path inside the repository; ignored.",
          );
        }
      }
      readinessTimeoutSeconds = positiveNumber(
        raw.timeoutSeconds,
        "resources.readiness.timeoutSeconds",
        warnings,
      );
    }
  }
  return {
    baseline,
    setupTimeoutMinutes: positiveNumber(
      value.setupTimeoutMinutes,
      "resources.setupTimeoutMinutes",
      warnings,
    ),
    readinessPath,
    readinessTimeoutSeconds,
  };
}

/** Where a stage the file adds goes: after its `after` anchor, but never
    between CI and the merge stage (an anchor there is dropped with a
    warning, and the stage goes just before CI). */
function placeNewStage(
  board: BoardState,
  created: ReadonlyArray<BoardStageDefinition>,
  after: unknown,
  where: string,
  warnings: string[],
): string | null {
  const ordered = [...boardStagesInOrder(board), ...created].sort(compareBoardStages);
  const fallback = () => {
    const key = boardNewStageOrderKey({ stages: ordered });
    return key;
  };
  if (after === undefined) return fallback();
  if (typeof after !== "string") {
    warnings.push(`${where}.after: expected a stage id; placed before CI.`);
    return fallback();
  }
  const anchorIndex = ordered.findIndex((stage) => stage.stageId === after);
  if (anchorIndex < 0) {
    warnings.push(`${where}.after: "${after}" is not a stage; placed before CI.`);
    return fallback();
  }
  const ciIndex = ordered.findIndex((stage) => stage.stageId === BOARD_SEED_STAGE_IDS.ci);
  const anchor = ordered[anchorIndex]!;
  const anchorRole = effectiveBoardStageRole(anchor);
  if ((ciIndex >= 0 && anchorIndex >= ciIndex) || anchorRole === "merge" || anchorRole === "done") {
    warnings.push(`${where}.after: nothing can come after ${anchor.label} here; placed before CI.`);
    return fallback();
  }
  const build = ordered.findIndex((stage) => effectiveBoardStageRole(stage) === "build");
  if (anchorIndex === build - 1) {
    warnings.push(
      `${where}.after: ${anchor.label} is where cards wait to build, so nothing can follow it; placed before CI.`,
    );
    return fallback();
  }
  return boardOrderKeyBetween(anchor.orderKey, ordered[anchorIndex + 1]?.orderKey ?? null);
}

/**
 * A project's delta as a v2 `t3o.json` (export). Stages it switches
 * on that are off by default are written as `stages.add` entries, so the file
 * recreates them on another board.
 */
export function buildT3oProjectFile(input: {
  readonly board: BoardState;
  readonly config: Pick<BoardProjectStageConfig, "stageSwitches" | "overrides" | "ci"> & {
    readonly resources?: BoardProjectResources | undefined;
  };
}): Record<string, unknown> {
  const ordered = boardStagesInOrder(input.board);
  const remove: string[] = [];
  const enable: string[] = [];
  const add: Array<Record<string, unknown>> = [];
  const addedIds = new Set<string>();
  for (const [index, stage] of ordered.entries()) {
    if (stage.stageId === BOARD_SEED_STAGE_IDS.ci) continue;
    const on = input.config.stageSwitches[stage.stageId];
    if (on === undefined) continue;
    if (!on) {
      remove.push(stage.stageId);
      continue;
    }
    if (boardStageDefaultForProjects(stage)) {
      enable.push(stage.stageId);
      continue;
    }
    const before = ordered[index - 1];
    // A project-scoped stage's id carries its project as a prefix the file's id
    // pattern refuses; import looks the bare id up under the project.
    const prefix = stage.projectId === null ? null : `${stage.projectId}:`;
    add.push({
      id:
        prefix !== null && stage.stageId.startsWith(prefix)
          ? stage.stageId.slice(prefix.length)
          : stage.stageId,
      label: stage.label,
      ...(before === undefined ? {} : { after: before.stageId }),
    });
    addedIds.add(stage.stageId);
  }
  const settings: Record<string, unknown> = {};
  for (const stage of ordered) {
    const patch = input.config.overrides[stage.stageId];
    if (patch === undefined || Object.keys(patch).length === 0) continue;
    if (addedIds.has(stage.stageId)) {
      const entry = add.find((candidate) => candidate.id === stage.stageId)!;
      Object.assign(entry, patch);
    } else {
      settings[stage.stageId] = patch;
    }
  }
  const ciOn = input.config.stageSwitches[BOARD_SEED_STAGE_IDS.ci];
  const stages: Record<string, unknown> = {};
  if (enable.length > 0) stages.enable = enable;
  if (remove.length > 0) stages.remove = remove;
  if (add.length > 0) stages.add = add;
  if (Object.keys(settings).length > 0) stages.settings = settings;
  const file: Record<string, unknown> = { version: T3O_PROJECT_FILE_VERSION };
  if (Object.keys(stages).length > 0) file.stages = stages;
  const stopOnFailure = boardCiStopsOnFailure(input.config.ci);
  if (input.config.ci.steps.length > 0 || ciOn !== undefined || !stopOnFailure) {
    file.ci = {
      ...(ciOn === undefined ? {} : { enabled: ciOn }),
      ...(stopOnFailure ? {} : { stopOnFailure: false }),
      steps: input.config.ci.steps,
    };
  }
  const resources = input.config.resources;
  if (resources !== undefined) {
    const block: Record<string, unknown> = {};
    if (resources.baseline !== null) {
      block.baseline = {
        cpuCores: resources.baseline.cpuCores,
        ramGiB: resources.baseline.ramGiB,
        diskGB: resources.baseline.diskGB,
      };
    }
    if (resources.setupTimeoutMinutes !== null) {
      block.setupTimeoutMinutes = resources.setupTimeoutMinutes;
    }
    if (resources.readinessPath !== null || resources.readinessTimeoutSeconds !== null) {
      block.readiness = {
        ...(resources.readinessPath === null ? {} : { path: resources.readinessPath }),
        ...(resources.readinessTimeoutSeconds === null
          ? {}
          : { timeoutSeconds: resources.readinessTimeoutSeconds }),
      };
    }
    if (Object.keys(block).length > 0) file.resources = block;
  }
  return file;
}

/** Parse a `t3o.json` body to JSON, or say why it could not be; the warning
    has no ending so each caller adds what it does instead. */
export function parseT3oProjectFile(
  text: string,
):
  | { readonly raw: unknown; readonly warning: null }
  | { readonly raw: null; readonly warning: string } {
  try {
    return { raw: JSON.parse(text) as unknown, warning: null };
  } catch (cause) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    return {
      raw: null,
      warning: `${T3O_PROJECT_FILE_NAME} is not valid JSON (${detail})`,
    };
  }
}
