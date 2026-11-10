// T3o: per-project config deltas (T3O-49) — normalization, comparison and
// the edits each settings command makes. Pure, so the server's config
// service, the decider and the web read one answer.
import {
  BOARD_STAGE_EXECUTION_PATCH_KEYS,
  boardCiStopsOnFailure,
  boardStageById,
  boardStageDefaultForProjects,
  boardStageExecutionKind,
  canonicalJson,
  isBoardStageSwitchable,
  resolveBoardStageExecution,
  type BoardCiStep,
  type BoardProjectStageDelta,
  type BoardSettings,
  type BoardStageDefinition,
  type BoardStageExecutionPatch,
  type BoardStageId,
  type BoardState,
} from "./board.ts";

const PROMPT_KEY = "prompt";

function sameValue(left: unknown, right: unknown): boolean {
  return canonicalJson(left) === canonicalJson(right);
}

/** A patch less every key whose value already equals the global member's.
    A prompt is kept even when it matches: overriding it pins the text. */
function normalizePatch(
  patch: BoardStageExecutionPatch,
  global: Record<string, unknown>,
  allowed: ReadonlySet<string>,
): BoardStageExecutionPatch {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined || !allowed.has(key)) continue;
    const base = global[key];
    if (typeof value === "object" && value !== null && !Array.isArray(value) && key !== "model") {
      const nested =
        typeof base === "object" && base !== null ? (base as Record<string, unknown>) : {};
      const inner: Record<string, unknown> = {};
      for (const [innerKey, innerValue] of Object.entries(value as Record<string, unknown>)) {
        if (innerValue === undefined) continue;
        if (
          typeof innerValue === "object" &&
          innerValue !== null &&
          !Array.isArray(innerValue) &&
          innerKey !== "model"
        ) {
          const deeper = (nested[innerKey] ?? {}) as Record<string, unknown>;
          const kept = Object.fromEntries(
            Object.entries(innerValue as Record<string, unknown>).filter(
              ([leaf, leafValue]) =>
                leafValue !== undefined &&
                (leaf === PROMPT_KEY || !sameValue(leafValue, deeper[leaf])),
            ),
          );
          if (Object.keys(kept).length > 0) inner[innerKey] = kept;
        } else if (innerKey === PROMPT_KEY || !sameValue(innerValue, nested[innerKey])) {
          inner[innerKey] = innerValue;
        }
      }
      if (Object.keys(inner).length > 0) out[key] = inner;
      continue;
    }
    if (key === PROMPT_KEY || !sameValue(value, base)) out[key] = value;
  }
  return out as BoardStageExecutionPatch;
}

/**
 * A delta with nothing that changes anything (T3O-49): switches equal to the
 * stage's default, switches on stages that can't be switched, overrides
 * equal to global (prompts excepted) and ids the board doesn't know are
 * dropped. `extraStages` are stages an import is about to create.
 */
export function normalizeBoardProjectDelta<D extends BoardProjectStageDelta>(input: {
  readonly board: Pick<BoardState, "stages">;
  readonly settings: BoardSettings;
  readonly delta: D;
  readonly extraStages?: ReadonlyArray<BoardStageDefinition>;
}): D {
  const extra = new Map((input.extraStages ?? []).map((stage) => [String(stage.stageId), stage]));
  const stageFor = (stageId: string) =>
    extra.get(stageId) ?? boardStageById(input.board, stageId as BoardStageId);
  const stageSwitches: Record<string, boolean> = {};
  for (const [stageId, on] of Object.entries(input.delta.stageSwitches)) {
    const stage = stageFor(stageId);
    if (stage === null || stage === undefined) continue;
    if (!isBoardStageSwitchable(input.board, stage)) continue;
    if (on === boardStageDefaultForProjects(stage)) continue;
    stageSwitches[stageId] = on;
  }
  const overrides: Record<string, BoardStageExecutionPatch> = {};
  for (const [stageId, patch] of Object.entries(input.delta.overrides)) {
    const stage = stageFor(stageId);
    if (stage === null || stage === undefined) continue;
    const kind = boardStageExecutionKind(stage.stageId);
    const global = resolveBoardStageExecution(input.settings, stage.stageId) as unknown as Record<
      string,
      unknown
    >;
    const normalized = normalizePatch(
      patch,
      global,
      new Set(BOARD_STAGE_EXECUTION_PATCH_KEYS[kind]),
    );
    if (Object.keys(normalized).length > 0) overrides[stageId] = normalized;
  }
  return { ...input.delta, stageSwitches, overrides };
}

const PERMISSION_KEYS = new Set([
  "runtimeMode",
  "autoExecute",
  "autoMerge",
  "humanInLoop",
  "humanInLoopWithPlan",
  "humanInLoopWithoutPlan",
]);

const withoutStepIds = (steps: ReadonlyArray<BoardCiStep>) =>
  steps.map(({ id: _id, ...rest }) => rest);

/** Whether two normalized deltas run the same pipeline. CI step ids are
    ignored: an import mints its own. */
export function boardProjectDeltasEqual(
  left: BoardProjectStageDelta,
  right: BoardProjectStageDelta,
): boolean {
  return (
    canonicalJson({
      stageSwitches: left.stageSwitches,
      overrides: left.overrides,
      steps: withoutStepIds(left.ci.steps),
      stopOnFailure: boardCiStopsOnFailure(left.ci),
    }) ===
    canonicalJson({
      stageSwitches: right.stageSwitches,
      overrides: right.overrides,
      steps: withoutStepIds(right.ci.steps),
      stopOnFailure: boardCiStopsOnFailure(right.ci),
    })
  );
}

/** Every command and prompt in `next` that `current` doesn't already hold,
    in full, plus every permission setting it adds, changes or removes, for
    the import confirmation. */
export function boardProjectDeltaNewTexts(
  current: BoardProjectStageDelta,
  next: BoardProjectStageDelta,
): ReadonlyArray<{
  readonly where: string;
  readonly kind: "command" | "prompt" | "setting";
  readonly text: string;
}> {
  const out: Array<{ where: string; kind: "command" | "prompt" | "setting"; text: string }> = [];
  const known = new Set<string>();
  for (const step of current.ci.steps) {
    if (step.kind === "script") known.add(`command:${step.command}`);
    if (step.kind === "agent") known.add(`prompt:${step.prompt}`);
  }
  const collectPrompts = (value: unknown, sink: Set<string> | null, where: string) => {
    if (typeof value !== "object" || value === null) return;
    for (const [key, inner] of Object.entries(value as Record<string, unknown>)) {
      if (key === PROMPT_KEY && typeof inner === "string") {
        if (sink !== null) sink.add(`prompt:${inner}`);
        else if (!known.has(`prompt:${inner}`)) out.push({ where, kind: "prompt", text: inner });
      } else if (key !== "model") {
        collectPrompts(inner, sink, `${where}.${key}`);
      }
    }
  };
  collectPrompts(current.overrides, known, "");
  for (const step of next.ci.steps) {
    if (step.kind === "script" && !known.has(`command:${step.command}`)) {
      out.push({ where: `CI step "${step.name}"`, kind: "command", text: step.command });
    }
    if (step.kind === "agent" && !known.has(`prompt:${step.prompt}`)) {
      out.push({ where: `CI step "${step.name}"`, kind: "prompt", text: step.prompt });
    }
  }
  for (const [stageId, patch] of Object.entries(next.overrides)) {
    collectPrompts(patch, null, stageId);
  }
  // Settings that change what an agent may do without a human, by path.
  const permissions = (overrides: BoardProjectStageDelta["overrides"]) => {
    const found = new Map<string, string>();
    const walk = (value: unknown, where: string) => {
      if (typeof value !== "object" || value === null) return;
      for (const [key, inner] of Object.entries(value as Record<string, unknown>)) {
        if (PERMISSION_KEYS.has(key) && typeof inner !== "object") {
          found.set(`${where}.${key}`, String(inner));
        } else if (key !== "model") {
          walk(inner, `${where}.${key}`);
        }
      }
    };
    for (const [stageId, patch] of Object.entries(overrides)) walk(patch, stageId);
    return found;
  };
  const before = permissions(current.overrides);
  const after = permissions(next.overrides);
  for (const [where, value] of after) {
    if (before.get(where) !== value) out.push({ where, kind: "setting", text: value });
  }
  // A dropped override falls back to the global default, which may be looser.
  for (const [where, value] of before) {
    if (!after.has(where)) out.push({ where, kind: "setting", text: `removed (was ${value})` });
  }
  return out;
}
