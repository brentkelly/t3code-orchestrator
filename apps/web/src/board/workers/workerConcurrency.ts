/**
 * T3o (T3O-65, D11; prototype screen 3): the per-worker Concurrency settings
 * as pure functions — the patches the steppers write, the over-the-board-limit
 * warning, and a collapsed worker's one-line summary.
 *
 * Patches go through the stock `deepMerge`, which key-unions maps and cannot
 * delete a key: a cleared limit or cap is a retained `null`, never a missing
 * entry.
 */
import {
  BOARD_LOCAL_WORKER_ID,
  resolveBoardWorkerConcurrency,
  type BoardConcurrencySettings,
  type BoardConcurrencySettingsPatch,
  type BoardWorkerId,
} from "@t3tools/contracts";

/** From this many workers on, each block collapses to its summary line. */
export const BOARD_CONCURRENCY_COLLAPSE_AT = 6;

/**
 * The board limit. Until `local` has a worker limit of its own it inherits the
 * board limit (the single-machine migration), so the first change here on a
 * board with workers writes `local`'s current limit down — the two stop moving
 * together the moment they are shown as two numbers.
 */
export function boardLimitPatch(
  concurrency: BoardConcurrencySettings,
  value: number,
): BoardConcurrencySettingsPatch {
  const local = concurrency.workers[BOARD_LOCAL_WORKER_ID];
  return local?.maxConcurrent === undefined
    ? {
        globalMaxConcurrent: value,
        workers: { [BOARD_LOCAL_WORKER_ID]: { maxConcurrent: concurrency.globalMaxConcurrent } },
      }
    : { globalMaxConcurrent: value };
}

/** A worker's own limit; null removes it (only the board limit applies). */
export function boardWorkerLimitPatch(
  workerId: BoardWorkerId,
  value: number | null,
): BoardConcurrencySettingsPatch {
  return { workers: { [workerId]: { maxConcurrent: value } } };
}

/** A provider instance's cap on one worker; null removes it. */
export function boardWorkerInstanceCapPatch(
  workerId: BoardWorkerId,
  instanceId: string,
  value: number | null,
): BoardConcurrencySettingsPatch {
  return { workers: { [workerId]: { perInstance: { [instanceId]: value } } } };
}

/** "Worker limits add up to 13; the board limit of 8 still applies", or null. */
export function boardWorkerLimitsWarning(
  concurrency: BoardConcurrencySettings,
  workerIds: ReadonlyArray<BoardWorkerId>,
): string | null {
  let sum = 0;
  for (const workerId of workerIds) {
    const limit = resolveBoardWorkerConcurrency(concurrency, workerId).maxConcurrent;
    if (limit === null) return null;
    sum += limit;
  }
  return sum > concurrency.globalMaxConcurrent
    ? `Worker limits add up to ${sum}; the board limit of ${concurrency.globalMaxConcurrent} still applies`
    : null;
}

/** A collapsed block's line: "claude-max 3 · claude-api 2 · codex-team no cap". */
export function boardWorkerCapSummary(
  concurrency: BoardConcurrencySettings,
  workerId: BoardWorkerId,
  instanceIds: ReadonlyArray<string>,
): string {
  const caps = resolveBoardWorkerConcurrency(concurrency, workerId).perInstance;
  return instanceIds
    .map((instanceId) => `${instanceId} ${caps[instanceId] ?? "no cap"}`)
    .join(" · ");
}
