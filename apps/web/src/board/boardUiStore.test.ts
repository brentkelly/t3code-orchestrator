/**
 * T3o board UI store (t3o-05): collapse defaults and persisted-state
 * sanitisation.
 */
import { BOARD_SEED_STAGE_IDS } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  isBoardColumnCollapsed,
  migratePersistedBoardUiState,
  modeForHref,
  useBoardUiStore,
} from "./boardUiStore";

/** Reset only the data fields; the action closures are preserved (merge). */
function resetStore() {
  useBoardUiStore.setState({ mode: "threads", lastLocationByMode: {}, collapsedByStage: {} });
}

describe("isBoardColumnCollapsed", () => {
  it("collapses the first column by default and nothing else", () => {
    // The default is now the read-model first stage (t3o-15), not a hard-coded
    // "backlog": the first stage collapses, every later one stays open.
    expect(isBoardColumnCollapsed({}, BOARD_SEED_STAGE_IDS.backlog, true)).toBe(true);
    expect(isBoardColumnCollapsed({}, BOARD_SEED_STAGE_IDS.sprint, false)).toBe(false);
    expect(isBoardColumnCollapsed({}, BOARD_SEED_STAGE_IDS.building, false)).toBe(false);
  });

  it("lets an explicit override beat the default", () => {
    expect(isBoardColumnCollapsed({ backlog: false }, BOARD_SEED_STAGE_IDS.backlog, true)).toBe(
      false,
    );
    expect(isBoardColumnCollapsed({ done: true }, BOARD_SEED_STAGE_IDS.done, false)).toBe(true);
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

  it("repairs a store poisoned with a thread href filed under board", () => {
    // This is the persisted shape that made every Board click open a thread:
    // a thread URL had been recorded under `board`.
    const migrated = migratePersistedBoardUiState({
      mode: "threads",
      lastLocationByMode: {
        threads: "/env-1/thread-1",
        board: "/env-1/thread-1",
      },
      collapsedByStage: {},
    });
    // The bogus board entry is dropped, so navigation falls back to /board.
    expect(migrated.lastLocationByMode.board).toBeUndefined();
    expect(migrated.lastLocationByMode.threads).toBe("/env-1/thread-1");
  });

  it("drops a board href mistakenly filed under threads", () => {
    const migrated = migratePersistedBoardUiState({
      lastLocationByMode: { threads: "/board?project=p1" },
    });
    expect(migrated.lastLocationByMode.threads).toBeUndefined();
  });
});

describe("modeForHref", () => {
  it("classifies board locations", () => {
    expect(modeForHref("/board")).toBe("board");
    expect(modeForHref("/board?project=web")).toBe("board");
    expect(modeForHref("/board/anything")).toBe("board");
  });

  it("classifies everything else as threads", () => {
    expect(modeForHref("/")).toBe("threads");
    expect(modeForHref("/env-1/thread-1")).toBe("threads");
    expect(modeForHref("/draft/d1")).toBe("threads");
    // A path that merely starts with the letters "board" is not the board route.
    expect(modeForHref("/boardroom")).toBe("threads");
  });
});

describe("recordModeLocation", () => {
  it("records a location under its own mode", () => {
    resetStore();
    useBoardUiStore.getState().recordModeLocation("board", "/board?project=web");
    expect(useBoardUiStore.getState().lastLocationByMode.board).toBe("/board?project=web");
  });

  it("refuses to file a thread href under board (the poisoning that caused the bug)", () => {
    resetStore();
    // Reproduces the board→thread transition: the still-mounted board tab sees
    // the incoming thread href while its mode prop is still "board".
    useBoardUiStore.getState().recordModeLocation("board", "/env-1/thread-1");
    expect(useBoardUiStore.getState().lastLocationByMode.board).toBeUndefined();
  });
});
