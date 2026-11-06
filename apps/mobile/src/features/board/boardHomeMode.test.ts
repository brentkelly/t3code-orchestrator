import { describe, expect, it } from "vite-plus/test";

import {
  boardCapableEnvironmentIds,
  boardShouldShowEnvironmentLabel,
  pickBoardEnvironmentId,
  resolveHomeMode,
  sanitizeHomeMode,
} from "./boardHomeMode";

describe("sanitizeHomeMode", () => {
  it("keeps threads and board", () => {
    expect(sanitizeHomeMode("threads")).toBe("threads");
    expect(sanitizeHomeMode("board")).toBe("board");
  });

  it("drops anything else", () => {
    expect(sanitizeHomeMode("kanban")).toBeUndefined();
    expect(sanitizeHomeMode(null)).toBeUndefined();
    expect(sanitizeHomeMode(1)).toBeUndefined();
  });
});

describe("resolveHomeMode", () => {
  it("falls back to threads when the server has no board", () => {
    expect(resolveHomeMode({ saved: "board", boardAvailable: false })).toBe("threads");
  });

  it("restores the saved board mode when the server advertises the board", () => {
    expect(resolveHomeMode({ saved: "board", boardAvailable: true })).toBe("board");
  });

  it("defaults to threads when nothing is saved", () => {
    expect(resolveHomeMode({ saved: undefined, boardAvailable: true })).toBe("threads");
  });
});

describe("boardCapableEnvironmentIds", () => {
  it("keeps only environments that advertise capabilities.board", () => {
    expect(
      boardCapableEnvironmentIds([
        { environmentId: "a", environment: { capabilities: { board: true } } },
        { environmentId: "b", environment: { capabilities: {} } },
        { environmentId: "c" },
        { environmentId: "d", environment: { capabilities: { board: false } } },
      ]),
    ).toEqual(new Set(["a"]));
  });
});

describe("pickBoardEnvironmentId", () => {
  const environments = [{ environmentId: "a" }, { environmentId: "b" }, { environmentId: "c" }];

  it("keeps a selected board-capable environment", () => {
    expect(
      pickBoardEnvironmentId({
        selectedEnvironmentId: "b",
        environments,
        boardCapableIds: new Set(["a", "b"]),
      }),
    ).toBe("b");
  });

  it("falls back to the first capable environment when the filter is all servers", () => {
    expect(
      pickBoardEnvironmentId({
        selectedEnvironmentId: null,
        environments,
        boardCapableIds: new Set(["b", "c"]),
      }),
    ).toBe("b");
  });

  it("does not substitute another server when the filter is a non-board environment", () => {
    expect(
      pickBoardEnvironmentId({
        selectedEnvironmentId: "a",
        environments,
        boardCapableIds: new Set(["c"]),
      }),
    ).toBeNull();
  });

  it("returns null when no environment advertises a board", () => {
    expect(
      pickBoardEnvironmentId({
        selectedEnvironmentId: "a",
        environments,
        boardCapableIds: new Set(),
      }),
    ).toBeNull();
  });
});

describe("boardShouldShowEnvironmentLabel", () => {
  it("hides the host name when the Home filter is that same server", () => {
    expect(
      boardShouldShowEnvironmentLabel({
        boardEnvironmentId: "t3o",
        selectedEnvironmentId: "t3o",
      }),
    ).toBe(false);
  });

  it("shows the host name when the Home filter is all servers", () => {
    expect(
      boardShouldShowEnvironmentLabel({
        boardEnvironmentId: "t3o",
        selectedEnvironmentId: null,
      }),
    ).toBe(true);
  });
});
