/**
 * T3o board client UI state (t3o-05): the Threads/Board mode, each mode's
 * last location, and per-column collapse.
 *
 * Board-owned on purpose — `uiStateStore.ts` is upstream-owned and the 02a
 * seam grammar does not admit board fields there, so board UI toggles grow
 * this store instead. Same persistence shape as the app's other stores
 * (zustand `persist` + `createJSONStorage` over `resolveStorage`, its own
 * key) so it participates in client-settings restore rather than being raw
 * `localStorage`.
 */
import type { BoardStage } from "@t3tools/contracts";
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

import { resolveStorage } from "../lib/storage";

export const BOARD_UI_STATE_STORAGE_KEY = "t3code:board-ui:v1";

export type WorkspaceMode = "threads" | "board";

interface BoardUiState {
  /** The mode the client was last in. */
  mode: WorkspaceMode;
  /** Last location (href) seen in each mode, so toggling modes returns to
      where you were instead of that mode's root. */
  lastLocationByMode: Partial<Record<WorkspaceMode, string>>;
  /** Explicit collapse overrides; stages without an entry fall back to
      `isBoardColumnCollapsed`'s default (Backlog collapsed). */
  collapsedByStage: Partial<Record<BoardStage, boolean>>;
}

interface BoardUiStore extends BoardUiState {
  recordModeLocation: (mode: WorkspaceMode, href: string) => void;
  setColumnCollapsed: (stage: BoardStage, collapsed: boolean) => void;
}

/** Backlog starts collapsed to a rail: it is the one column that grows
    without bound and it is not where attention belongs. */
export function isBoardColumnCollapsed(
  collapsedByStage: Partial<Record<BoardStage, boolean>>,
  stage: BoardStage,
): boolean {
  return collapsedByStage[stage] ?? stage === "backlog";
}

export function migratePersistedBoardUiState(persistedState: unknown): BoardUiState {
  const fallback: BoardUiState = { mode: "threads", lastLocationByMode: {}, collapsedByStage: {} };
  if (!persistedState || typeof persistedState !== "object") {
    return fallback;
  }
  const candidate = persistedState as Partial<BoardUiState>;
  const lastLocationByMode: BoardUiState["lastLocationByMode"] = {};
  for (const mode of ["threads", "board"] as const) {
    const href = candidate.lastLocationByMode?.[mode];
    if (typeof href === "string" && href.startsWith("/")) {
      lastLocationByMode[mode] = href;
    }
  }
  const collapsedByStage: BoardUiState["collapsedByStage"] = {};
  if (candidate.collapsedByStage && typeof candidate.collapsedByStage === "object") {
    for (const [stage, collapsed] of Object.entries(candidate.collapsedByStage)) {
      if (typeof collapsed === "boolean") {
        collapsedByStage[stage as BoardStage] = collapsed;
      }
    }
  }
  return {
    mode: candidate.mode === "board" ? "board" : "threads",
    lastLocationByMode,
    collapsedByStage,
  };
}

export const useBoardUiStore = create<BoardUiStore>()(
  persist(
    (set) => ({
      mode: "threads",
      lastLocationByMode: {},
      collapsedByStage: {},
      recordModeLocation: (mode, href) =>
        set((state) =>
          state.mode === mode && state.lastLocationByMode[mode] === href
            ? state
            : { mode, lastLocationByMode: { ...state.lastLocationByMode, [mode]: href } },
        ),
      setColumnCollapsed: (stage, collapsed) =>
        set((state) =>
          isBoardColumnCollapsed(state.collapsedByStage, stage) === collapsed
            ? state
            : { collapsedByStage: { ...state.collapsedByStage, [stage]: collapsed } },
        ),
    }),
    {
      name: BOARD_UI_STATE_STORAGE_KEY,
      version: 1,
      storage: createJSONStorage(() =>
        resolveStorage(typeof window !== "undefined" ? window.localStorage : undefined),
      ),
      migrate: migratePersistedBoardUiState,
      // `migrate` only runs on a version bump; same-version persisted data
      // (hand-edited or corrupted localStorage) would otherwise be spread in
      // unchecked. Sanitise on every rehydrate.
      merge: (persistedState, currentState) => ({
        ...currentState,
        ...migratePersistedBoardUiState(persistedState),
      }),
      partialize: (state) => ({
        mode: state.mode,
        lastLocationByMode: state.lastLocationByMode,
        collapsedByStage: state.collapsedByStage,
      }),
    },
  ),
);
