/**
 * Pure transforms for the Board settings panel (t3o-07). Kept out of the
 * component so the map/array mutations that back the whole-map patches — where
 * a wrong merge silently corrupts a recipe or strands a project override — are
 * unit-tested directly.
 */
import {
  DEFAULT_BOARD_BUILD_STEP,
  DEFAULT_BOARD_STEP_MAX_ATTEMPTS,
  DEFAULT_BOARD_STEP_TIMEOUT_MS,
  type BoardProjectSettings,
  type BoardStep,
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

/** A blank new step for a stage, with a unique-within-stage id. */
export function makeNewBoardStep(existing: ReadonlyArray<BoardStep>): BoardStep {
  const used = new Set(existing.map((step) => step.id));
  let index = existing.length + 1;
  let id = `step-${index}`;
  while (used.has(id)) {
    index += 1;
    id = `step-${index}`;
  }
  return {
    id,
    label: `Step ${index}`,
    promptTemplate: "",
    providerInstanceId: DEFAULT_BOARD_BUILD_STEP.providerInstanceId,
    model: DEFAULT_BOARD_BUILD_STEP.model,
    timeoutMs: DEFAULT_BOARD_STEP_TIMEOUT_MS,
    maxAttempts: DEFAULT_BOARD_STEP_MAX_ATTEMPTS,
  };
}

export function setBoardStepField(
  steps: ReadonlyArray<BoardStep>,
  index: number,
  patch: Partial<BoardStep>,
): Array<BoardStep> {
  return steps.map((step, i) => (i === index ? { ...step, ...patch } : step));
}

export function removeBoardStep(steps: ReadonlyArray<BoardStep>, index: number): Array<BoardStep> {
  return steps.filter((_, i) => i !== index);
}

export function appendBoardStep(
  steps: ReadonlyArray<BoardStep>,
  step: BoardStep,
): Array<BoardStep> {
  return [...steps, step];
}

/**
 * Apply a project-settings change and return the next whole `projects` map. An
 * entry that ends up with no override at all (default prefix and default
 * accent) is dropped, so the map only ever holds meaningful overrides — and
 * because a `deepMerge` patch can never *delete* a key, the panel always sends
 * this full map, not a single entry.
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
  const next: BoardProjectSettings = { ...current, ...patch };
  const result: Record<string, BoardProjectSettings> = { ...projects };
  if (next.keyPrefix === null && next.accentColor === null) {
    delete result[projectId];
  } else {
    result[projectId] = next;
  }
  return result;
}

/** Trim a text prefix to a stored value: empty becomes null (use the default). */
export function normalizeKeyPrefixInput(value: string): string | null {
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/** Set the concurrency ceiling for one instance, dropping it when cleared. */
export function setBoardInstanceConcurrency(
  perInstance: Readonly<Record<string, number>>,
  instanceId: ProviderInstanceId,
  value: number | null,
): Record<string, number> {
  const result: Record<string, number> = { ...perInstance };
  if (value === null || value <= 0) {
    delete result[instanceId];
  } else {
    result[instanceId] = value;
  }
  return result;
}
