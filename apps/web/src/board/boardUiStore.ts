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
import type { BoardStageId } from "@t3tools/contracts";
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

import { resolveStorage } from "../lib/storage";

export const BOARD_UI_STATE_STORAGE_KEY = "t3code:board-ui:v1";

export type WorkspaceMode = "threads" | "board";

/**
 * Which workspace mode an href belongs to. The board surface lives under
 * `/board` (optionally with `?project`/`?card`); every other location —
 * threads, drafts, the root — is a threads-surface location.
 *
 * This is the single source of truth for classifying a location, used both to
 * guard `recordModeLocation` against cross-mode writes and to sanitise
 * persisted state. Keeping it in one place stops the two from drifting.
 */
export function modeForHref(href: string): WorkspaceMode {
  return href === "/board" || href.startsWith("/board?") || href.startsWith("/board/")
    ? "board"
    : "threads";
}

interface BoardUiState {
  /** The mode the client was last in. */
  mode: WorkspaceMode;
  /** Last location (href) seen in each mode, so toggling modes returns to
      where you were instead of that mode's root. */
  lastLocationByMode: Partial<Record<WorkspaceMode, string>>;
  /** Explicit collapse overrides, keyed by stage id (t3o-15); stages without an
      entry fall back to `isBoardColumnCollapsed`'s default (the first column
      collapsed). */
  collapsedByStage: Partial<Record<string, boolean>>;
}

interface BoardUiStore extends BoardUiState {
  recordModeLocation: (mode: WorkspaceMode, href: string) => void;
  setColumnCollapsed: (stage: BoardStageId, collapsed: boolean) => void;
}

/** The first column starts collapsed to a rail (D13): it is the one column that
    grows without bound (the intake/backlog) and it is not where attention
    belongs. `isFirstStage` comes from the read-model stage order. */
export function isBoardColumnCollapsed(
  collapsedByStage: Partial<Record<string, boolean>>,
  stageId: BoardStageId,
  isFirstStage: boolean,
): boolean {
  return collapsedByStage[stageId] ?? isFirstStage;
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
    // Must be an in-app path AND belong to the mode it is filed under. The
    // second check repairs stores poisoned by the pre-guard bug where a
    // board→thread transition recorded a thread href under `board`, which
    // then sent every Board click back to that thread.
    if (typeof href === "string" && href.startsWith("/") && modeForHref(href) === mode) {
      lastLocationByMode[mode] = href;
    }
  }
  const collapsedByStage: BoardUiState["collapsedByStage"] = {};
  if (candidate.collapsedByStage && typeof candidate.collapsedByStage === "object") {
    for (const [stage, collapsed] of Object.entries(candidate.collapsedByStage)) {
      if (typeof collapsed === "boolean") {
        collapsedByStage[stage] = collapsed;
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
        set((state) => {
          // The mounting surface fixes `mode`, but the router location updates
          // the instant a navigation starts — before the old surface unmounts.
          // Without this guard the still-mounted Board tab records the incoming
          // thread href under `board` during a board→thread transition, and
          // every later Board click jumps back to that thread. Only file a
          // location under the mode it actually belongs to.
          if (modeForHref(href) !== mode) return state;
          return state.mode === mode && state.lastLocationByMode[mode] === href
            ? state
            : { mode, lastLocationByMode: { ...state.lastLocationByMode, [mode]: href } };
        }),
      setColumnCollapsed: (stage, collapsed) =>
        set((state) =>
          // Skip only when the EXPLICIT stored value already matches — the
          // read-model default (first-column collapsed) lives in
          // `isBoardColumnCollapsed`, which needs the stage list this store
          // does not hold.
          state.collapsedByStage[stage] === collapsed
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
