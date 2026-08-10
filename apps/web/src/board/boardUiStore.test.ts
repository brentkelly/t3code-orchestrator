/**
 * T3o board UI store (t3o-05): collapse defaults and persisted-state
 * sanitisation.
 */
import { describe, expect, it } from "vite-plus/test";

import { isBoardColumnCollapsed, migratePersistedBoardUiState } from "./boardUiStore";

describe("isBoardColumnCollapsed", () => {
  it("collapses Backlog by default and nothing else", () => {
    expect(isBoardColumnCollapsed({}, "backlog")).toBe(true);
    expect(isBoardColumnCollapsed({}, "sprint")).toBe(false);
    expect(isBoardColumnCollapsed({}, "building")).toBe(false);
  });

  it("lets an explicit override beat the default", () => {
    expect(isBoardColumnCollapsed({ backlog: false }, "backlog")).toBe(false);
    expect(isBoardColumnCollapsed({ done: true }, "done")).toBe(true);
  });
});

describe("migratePersistedBoardUiState", () => {
  it("falls back to defaults for garbage", () => {
    expect(migratePersistedBoardUiState(null)).toEqual({
      mode: "threads",
      lastLocationByMode: {},
      collapsedByStage: {},
    });
    expect(migratePersistedBoardUiState("nope")).toEqual({
      mode: "threads",
      lastLocationByMode: {},
      collapsedByStage: {},
    });
  });

  it("keeps valid fields and drops malformed ones", () => {
    const migrated = migratePersistedBoardUiState({
      mode: "board",
      lastLocationByMode: { board: "/board?project=p1", threads: "https://evil.example" },
      collapsedByStage: { backlog: false, sprint: "yes" },
    });
    expect(migrated.mode).toBe("board");
    expect(migrated.lastLocationByMode).toEqual({ board: "/board?project=p1" });
    expect(migrated.collapsedByStage).toEqual({ backlog: false });
  });
});
