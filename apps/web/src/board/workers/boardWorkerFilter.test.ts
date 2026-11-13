import { BOARD_LOCAL_WORKER_ID, EnvironmentId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  BOARD_UNPLACED_FILTER,
  boardCardMatchesWorkerFilter,
  boardWorkerFilterLabel,
  parseBoardWorkerFilter,
  serializeBoardWorkerFilter,
} from "./boardWorkerFilter";

const B1 = EnvironmentId.make("env-build-01");
const B2 = EnvironmentId.make("env-build-02");
const state = {
  workers: [
    { id: B1, label: "build-01", abbreviation: "B1" },
    { id: B2, label: "build-02", abbreviation: "B2" },
  ],
} as never;

describe("the worker filter (T3O-87)", () => {
  it("matches the placement target only, with Not placed yet for the rest", () => {
    const built = { workerId: B1, worktreeReady: true };
    const pinnedOnly = { workerId: B1 };
    const local = { worktreeReady: true };
    expect(boardCardMatchesWorkerFilter(built, new Set([B1]))).toBe(true);
    // Pinned but not placed: it isn't on B1 yet.
    expect(boardCardMatchesWorkerFilter(pinnedOnly, new Set([B1]))).toBe(false);
    expect(boardCardMatchesWorkerFilter(pinnedOnly, new Set([BOARD_UNPLACED_FILTER]))).toBe(true);
    expect(boardCardMatchesWorkerFilter(local, new Set([BOARD_LOCAL_WORKER_ID]))).toBe(true);
    // A multi-select keeps cards on any chosen worker; no selection keeps every card.
    expect(boardCardMatchesWorkerFilter(built, new Set([B2, B1]))).toBe(true);
    expect(boardCardMatchesWorkerFilter(pinnedOnly, new Set())).toBe(true);
  });

  it("round-trips through the URL by worker id, dropping a removed worker", () => {
    const selection = [B1, BOARD_UNPLACED_FILTER];
    const param = serializeBoardWorkerFilter(selection);
    expect(param).toBe(`${B1},unplaced`);
    expect(parseBoardWorkerFilter(param, state)).toEqual(selection);
    expect(parseBoardWorkerFilter(`${B1},env-gone,${B1}`, state)).toEqual([B1]);
    expect(serializeBoardWorkerFilter([])).toBeUndefined();
  });

  it("names up to two selections by abbreviation", () => {
    expect(boardWorkerFilterLabel([], state)).toBe("Worker");
    expect(boardWorkerFilterLabel([B1, BOARD_LOCAL_WORKER_ID], state)).toBe("B1, SRV");
    expect(boardWorkerFilterLabel([B1, B2, BOARD_UNPLACED_FILTER], state)).toBe("B1, B2 +1");
  });
});
