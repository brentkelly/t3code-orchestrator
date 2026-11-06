import {
  BOARD_LOCAL_WORKER_ID,
  EnvironmentId,
  PositiveInt,
  ProviderInstanceId,
  type BoardConcurrencySettings,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  boardLimitPatch,
  boardLocalConcurrencyDiverges,
  boardWorkerCapSummary,
  boardWorkerInstanceCapPatch,
  boardWorkerLimitPatch,
  boardWorkerLimitsWarning,
} from "./workerConcurrency";

const LINUX = EnvironmentId.make("env-linux-box");

/** A settings file written before workers: one limit, local's caps. */
const legacy: BoardConcurrencySettings = {
  perInstance: { [ProviderInstanceId.make("claude-max")]: PositiveInt.make(3) },
  globalMaxConcurrent: PositiveInt.make(4),
  workers: {},
};

describe("per-worker concurrency (T3O-65, prototype 3)", () => {
  it("writes local's inherited limit down the first time the board limit changes", () => {
    expect(boardLimitPatch(legacy, 8)).toEqual({
      globalMaxConcurrent: 8,
      workers: { [BOARD_LOCAL_WORKER_ID]: { maxConcurrent: 4 } },
    });
    // Once local has its own, only the board limit moves.
    expect(
      boardLimitPatch(
        { ...legacy, workers: { local: { maxConcurrent: PositiveInt.make(2), perInstance: {} } } },
        8,
      ),
    ).toEqual({ globalMaxConcurrent: 8 });
  });

  it("writes a worker's limit and caps as retained nulls when cleared", () => {
    expect(boardWorkerLimitPatch(LINUX, null)).toEqual({
      workers: { [LINUX]: { maxConcurrent: null } },
    });
    expect(boardWorkerInstanceCapPatch(LINUX, "codex-team", 2)).toEqual({
      workers: { [LINUX]: { perInstance: { "codex-team": 2 } } },
    });
  });

  it("warns when worker limits add up to more than the board limit", () => {
    const settings: BoardConcurrencySettings = {
      ...legacy,
      globalMaxConcurrent: PositiveInt.make(8),
      workers: {
        local: { maxConcurrent: PositiveInt.make(4), perInstance: {} },
        [LINUX]: { maxConcurrent: PositiveInt.make(9), perInstance: {} },
      },
    };
    expect(boardWorkerLimitsWarning(settings, [BOARD_LOCAL_WORKER_ID, LINUX])).toBe(
      "Worker limits add up to 13; the board limit of 8 still applies",
    );
    // A worker with no limit of its own is bound only by the board: no sum to compare.
    expect(
      boardWorkerLimitsWarning(
        {
          ...settings,
          workers: { ...settings.workers, [LINUX]: { maxConcurrent: null, perInstance: {} } },
        },
        [BOARD_LOCAL_WORKER_ID, LINUX],
      ),
    ).toBeNull();
  });

  it("summarises a collapsed worker's caps, local's migrated ones included", () => {
    expect(boardWorkerCapSummary(legacy, BOARD_LOCAL_WORKER_ID, ["claude-max", "codex-team"])).toBe(
      "claude-max 3 · codex-team no cap",
    );
  });
});

describe("a local override left behind once every worker is removed", () => {
  it("is not one when it agrees with the single-machine fields", () => {
    expect(boardLocalConcurrencyDiverges(legacy)).toBe(false);
    // The first board-limit edit wrote local's limit down at the same value.
    expect(
      boardLocalConcurrencyDiverges({
        ...legacy,
        workers: { local: { maxConcurrent: PositiveInt.make(4), perInstance: {} } },
      }),
    ).toBe(false);
  });

  it("is one when local's limit or a cap binds differently", () => {
    expect(
      boardLocalConcurrencyDiverges({
        ...legacy,
        workers: { local: { maxConcurrent: PositiveInt.make(2), perInstance: {} } },
      }),
    ).toBe(true);
    expect(
      boardLocalConcurrencyDiverges({
        ...legacy,
        workers: {
          local: { perInstance: { [ProviderInstanceId.make("claude-max")]: PositiveInt.make(1) } },
        },
      }),
    ).toBe(true);
  });
});
