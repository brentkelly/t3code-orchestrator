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
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

import { resolveStorage } from "../lib/storage";

export const BOARD_UI_STATE_STORAGE_KEY = "t3code:board-ui:v1";

export type WorkspaceMode = "threads" | "board";

/**
 * Full-surface routes that are not a workspace location at all: settings
 * (which replaces the whole workspace, tabs included) and the auth flow.
 *
 * They must never be filed as a mode's last location. `/settings/general`
 * recorded under `threads` stranded the workspace: clicking Threads reopened
 * settings, and Back out of settings landed on the board, leaving no way to
 * reach a thread.
 */
const NON_WORKSPACE_ROOTS = ["/settings", "/pair", "/connect"];

/** The path part of an in-app href, without `?search` or `#hash`. */
function pathnameOf(href: string): string {
  const boundary = href.search(/[?#]/);
  return boundary === -1 ? href : href.slice(0, boundary);
}

/**
 * Which workspace mode an href belongs to, or `null` when it belongs to
 * neither. The board surface lives under `/board` (optionally with
 * `?project`/`?card`); threads, drafts and the root are threads-surface
 * locations; settings and the auth flow are not workspace locations.
 *
 * This is the single source of truth for classifying a location, used both to
 * guard `recordModeLocation` against cross-mode writes and to sanitise
 * persisted state. Keeping it in one place stops the two from drifting.
 */
export function modeForHref(href: string): WorkspaceMode | null {
  const pathname = pathnameOf(href);
  if (NON_WORKSPACE_ROOTS.some((root) => pathname === root || pathname.startsWith(`${root}/`))) {
    return null;
  }
  return pathname === "/board" || pathname.startsWith("/board/") ? "board" : "threads";
}

interface BoardUiState {
  /** The mode the client was last in. */
  mode: WorkspaceMode;
  /** Last location (href) seen in each mode, so toggling modes returns to
      where you were instead of that mode's root. */
  lastLocationByMode: Partial<Record<WorkspaceMode, string>>;
  /** Explicit collapse overrides, keyed per scope (t3o-15, t3o-25): a bare
      stage id on the root board, `boardScopeCollapseKey`'s `sub/…` composite
      inside a sub-board — so a collapsed root Backlog does not collapse
      inside every sub-board. Keys without an entry fall back to
      `isBoardColumnCollapsed`'s default (the root board's first column
      collapsed). */
  collapsedByStage: Partial<Record<string, boolean>>;
}

interface BoardUiStore extends BoardUiState {
  recordModeLocation: (mode: WorkspaceMode, href: string) => void;
  setColumnCollapsed: (stageKey: string, collapsed: boolean) => void;
}

/** The first column starts collapsed to a rail (D13): it is the one column that
    grows without bound (the intake/backlog) and it is not where attention
    belongs. `isFirstStage` comes from the read-model stage order — and is
    passed false for every sub-board column (t3o-25), where the first rendered
    column is the materialisation floor the children queue in, not an intake. */
export function isBoardColumnCollapsed(
  collapsedByStage: Partial<Record<string, boolean>>,
  stageKey: string,
  isFirstStage: boolean,
): boolean {
  return collapsedByStage[stageKey] ?? isFirstStage;
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
    // second check repairs stores poisoned by the pre-guard bugs: a
    // board→thread transition recording a thread href under `board` (which
    // sent every Board click back to that thread), and a workspace→settings
    // transition recording `/settings/...` under `threads` (which sent every
    // Threads click into settings).
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
          // Without this guard the still-mounted tab records the incoming href
          // under its own mode: a board→thread transition filed a thread href
          // under `board`, and a threads→settings transition filed
          // `/settings/...` under `threads`. Only file a location under the
          // mode it actually belongs to, and never file a non-workspace
          // location (`modeForHref` returns null) under either.
          if (modeForHref(href) !== mode) return state;
          return state.mode === mode && state.lastLocationByMode[mode] === href
            ? state
            : { mode, lastLocationByMode: { ...state.lastLocationByMode, [mode]: href } };
        }),
      setColumnCollapsed: (stageKey, collapsed) =>
        set((state) =>
          // Skip only when the EXPLICIT stored value already matches — the
          // read-model default (first-column collapsed) lives in
          // `isBoardColumnCollapsed`, which needs the stage list this store
          // does not hold.
          state.collapsedByStage[stageKey] === collapsed
            ? state
            : { collapsedByStage: { ...state.collapsedByStage, [stageKey]: collapsed } },
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
