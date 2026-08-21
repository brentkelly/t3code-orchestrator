/**
 * Pure transforms for the Board settings panel (t3o-07). Kept out of the
 * component so the map/array mutations that back the whole-map patches — where
 * a wrong merge silently corrupts a recipe or strands a project override — are
 * unit-tested directly.
 */
import {
  resolveBoardStageExecution,
  type BoardProjectSettings,
  type BoardSettings,
  type BoardStageExecution,
  type BoardStageId,
  type ProviderInstanceId,
} from "@t3tools/contracts";

export const BOARD_STEP_TIMEOUT_MIN_MINUTES = 1;
export const BOARD_STEP_MAX_ATTEMPTS_MAX = 10;

export function msToMinutes(ms: number): number {
  return Math.max(BOARD_STEP_TIMEOUT_MIN_MINUTES, Math.round(ms / 60_000));
}

export function minutesToMs(minutes: number): number {
  return Math.max(BOARD_STEP_TIMEOUT_MIN_MINUTES, Math.round(minutes)) * 60_000;
}

/**
 * Parse a numeric text input to a positive integer, or return `fallback` when
 * it is blank or invalid. Used for timeouts, attempt caps, and concurrency
 * ceilings, all of which are `PositiveInt` on the wire.
 */
export function parsePositiveIntInput(value: string, fallback: number): number {
  const parsed = Number.parseInt(value.trim(), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

/**
 * Apply a stage-execution change and return the next `pipeline` map (t3o-15).
 * The map is keyed by stage id, so a rename never orphans it (D4).
 *
 * A stage absent from the map starts from what `resolveBoardStageExecution`
 * RESOLVES it to, not the empty all-defaults config — that is the config the
 * user is editing on screen, and it is also the only base that keeps a review
 * stage a review member. Starting from the all-defaults simple config instead
 * turned "Code review: rounds 6" into a `kind: "simple"` entry whose `rounds`
 * and `phases` the patch encoder then dropped on the floor, silently retiring
 * the review loop. Absent entries are the NORMAL case: settings.json prunes
 * every entry that still equals its compiled-in default.
 */
export function setBoardStageExecution(
  board: BoardSettings,
  stageId: BoardStageId,
  patch: Partial<BoardStageExecution>,
): Record<string, BoardStageExecution> {
  const current = resolveBoardStageExecution(board, stageId);
  // `current` is a discriminated-union member and `patch` a partial of the same
  // member (the caller never crosses `kind`), so the field-wise merge stays
  // within one member; the cast re-narrows what a spread over a union widens.
  const next = { ...current, ...patch } as BoardStageExecution;
  return { ...board.pipeline, [stageId]: next };
}

/**
 * Apply a project-settings change and return the next `projects` map. An entry
 * that reverts to all-defaults is KEPT with null fields rather than deleted:
 * settings patches merge through the stock `deepMerge`, which key-unions maps
 * and cannot delete a key, so omitting the entry would silently retain the old
 * override. A `{ keyPrefix: null, accentColor: null }` entry resolves to the
 * defaults (see `resolveBoardKeyPrefix` / `resolveBoardProjectAccent`), so a
 * null entry and an absent key look identical — and clearing actually persists.
 */
export function setBoardProjectSetting(
  projects: Readonly<Record<string, BoardProjectSettings>>,
  projectId: string,
  patch: Partial<BoardProjectSettings>,
): Record<string, BoardProjectSettings> {
  const current: BoardProjectSettings = projects[projectId] ?? {
    keyPrefix: null,
    accentColor: null,
  };
  return { ...projects, [projectId]: { ...current, ...patch } };
}

/** Trim a text prefix to a stored value: empty becomes null (use the default). */
export function normalizeKeyPrefixInput(value: string): string | null {
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * Set the concurrency ceiling for one instance. Clearing it stores `null`
 * (meaning "use the global limit"), never a deleted key — `deepMerge` cannot
 * delete keys, so a null entry is how a cleared cap persists.
 */
export function setBoardInstanceConcurrency(
  perInstance: Readonly<Record<string, number | null>>,
  instanceId: ProviderInstanceId,
  value: number | null,
): Record<string, number | null> {
  return { ...perInstance, [instanceId]: value !== null && value > 0 ? value : null };
}
