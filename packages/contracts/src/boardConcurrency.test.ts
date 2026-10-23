import { describe, expect, it } from "@effect/vitest";
import * as Schema from "effect/Schema";

import {
  BoardSettings,
  clampBoardInstanceCap,
  resolveBoardWorkerConcurrency,
  type BoardConcurrencySettings,
} from "./board.ts";

const decodeBoardSettings = Schema.decodeUnknownSync(BoardSettings);

describe("per-worker concurrency settings (T3O-65, D11)", () => {
  it("decodes a settings file written before workers, unchanged", () => {
    const settings = decodeBoardSettings({
      concurrency: { globalMaxConcurrent: 4, perInstance: { "claude-max": 3 } },
    });
    expect(settings.concurrency).toEqual({
      globalMaxConcurrent: 4,
      perInstance: { "claude-max": 3 },
      workers: {},
    });
  });

  it("migrates today's limit and caps to this server, and nothing to another worker", () => {
    const legacy = decodeBoardSettings({
      concurrency: { globalMaxConcurrent: 4, perInstance: { "claude-max": 3 } },
    }).concurrency;
    expect(resolveBoardWorkerConcurrency(legacy, "local")).toEqual({
      maxConcurrent: 4,
      perInstance: { "claude-max": 3 },
    });
    expect(resolveBoardWorkerConcurrency(legacy, "env-linux" as never)).toEqual({
      maxConcurrent: null,
      perInstance: {},
    });
  });

  it("lets local's own entry override what it inherited", () => {
    const concurrency = decodeBoardSettings({
      concurrency: {
        globalMaxConcurrent: 8,
        perInstance: { "claude-max": 3 },
        workers: { local: { maxConcurrent: null, perInstance: { "claude-max": null, codex: 2 } } },
      },
    }).concurrency satisfies BoardConcurrencySettings;
    expect(resolveBoardWorkerConcurrency(concurrency, "local")).toEqual({
      maxConcurrent: null,
      perInstance: { "claude-max": null, codex: 2 },
    });
  });

  it("clamps a provider cap to its worker limit", () => {
    expect(clampBoardInstanceCap(5, 2)).toBe(2);
    expect(clampBoardInstanceCap(1, 2)).toBe(1);
    expect(clampBoardInstanceCap(null, 2)).toBeNull();
    expect(clampBoardInstanceCap(5, null)).toBe(5);
  });
});
