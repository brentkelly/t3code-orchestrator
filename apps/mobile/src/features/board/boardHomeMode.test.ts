import { describe, expect, it } from "vite-plus/test";

import {
  boardCapableEnvironmentIds,
  boardComposeAction,
  boardCreateHostKey,
  boardCreateRequestForHost,
  boardCreateRequestStaysArmed,
  boardEmptyStateCopy,
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

describe("boardEmptyStateCopy", () => {
  it("names a filtered non-board server", () => {
    expect(
      boardEmptyStateCopy({
        selectedEnvironmentId: "cloud",
        boardCapableIds: new Set(["t3o"]),
      }),
    ).toEqual({
      title: "No board on this server",
      detail: "The Home filter is a server without a board.",
    });
  });

  it("asks to pair when no specific non-board filter is selected", () => {
    expect(
      boardEmptyStateCopy({
        selectedEnvironmentId: null,
        boardCapableIds: new Set(["t3o"]),
      }),
    ).toEqual({
      title: "No board on this server",
      detail: "Pair a T3o server to see the Board.",
    });
  });
});

describe("boardComposeAction", () => {
  it("creates when Board is showing a board server", () => {
    expect(boardComposeAction({ homeMode: "board", boardEnvironmentId: "t3o" })).toBe("create");
  });

  it("alerts instead of arming create when Board has no environment", () => {
    expect(boardComposeAction({ homeMode: "board", boardEnvironmentId: null })).toBe("empty-board");
  });

  it("opens a new task in Threads mode", () => {
    expect(boardComposeAction({ homeMode: "threads", boardEnvironmentId: "t3o" })).toBe("new-task");
  });
});

describe("boardCreateRequestStaysArmed", () => {
  it("stays armed only while BoardHomeScreen is mounted", () => {
    expect(boardCreateRequestStaysArmed({ homeMode: "board", boardEnvironmentId: "t3o" })).toBe(
      true,
    );
  });

  it("disarms when the empty board unmounts the create sheet host", () => {
    expect(boardCreateRequestStaysArmed({ homeMode: "board", boardEnvironmentId: null })).toBe(
      false,
    );
  });

  it("disarms when leaving Board mode", () => {
    expect(boardCreateRequestStaysArmed({ homeMode: "threads", boardEnvironmentId: "t3o" })).toBe(
      false,
    );
  });
});

describe("boardCreateHostKey", () => {
  it("is the board environment while BoardHomeScreen is mounted", () => {
    expect(boardCreateHostKey({ homeMode: "board", boardEnvironmentId: "t3o" })).toBe("t3o");
  });

  it("is null on the empty board", () => {
    expect(boardCreateHostKey({ homeMode: "board", boardEnvironmentId: null })).toBeNull();
  });
});

describe("boardCreateRequestForHost", () => {
  it("keeps a press for the mounted board", () => {
    expect(boardCreateRequestForHost({ createForHost: "t3o", createHostKey: "t3o" })).toBe("t3o");
  });

  it("drops a press when the empty board unmounts the create sheet host", () => {
    expect(boardCreateRequestForHost({ createForHost: "t3o", createHostKey: null })).toBeNull();
  });

  it("drops a press when a later mount would otherwise open the sheet", () => {
    expect(boardCreateRequestForHost({ createForHost: "t3o", createHostKey: "other" })).toBeNull();
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
