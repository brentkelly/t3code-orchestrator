/**
 * Board client UI state: the Threads/Board mode, each mode's last location, and
 * per-column collapse. Board-owned because `uiStateStore.ts` is upstream's; same
 * persistence shape as the app's other stores so client-settings restore covers it.
 */
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

import { resolveStorage } from "../lib/storage";

const BOARD_UI_STATE_STORAGE_KEY = "t3code:board-ui:v1";

export type WorkspaceMode = "threads" | "board" | "list";

const WORKSPACE_MODES: ReadonlyArray<WorkspaceMode> = ["threads", "board", "list"];

/**
 * Routes that are not a workspace location. Filing one as a mode's last location
 * strands the workspace: the mode's tab then reopens settings, onboarding or a
 * project link instead of the workspace.
 */
const NON_WORKSPACE_ROOTS = ["/settings", "/pair", "/connect", "/welcome", "/projects", "/usage"];

/** The path part of an in-app href, without `?search` or `#hash`. */
function pathnameOf(href: string): string {
  const boundary = href.search(/[?#]/);
  return boundary === -1 ? href : href.slice(0, boundary);
}

/**
 * Which workspace mode an href belongs to, or `null` for neither. The single
 * classifier for both `recordModeLocation`'s guard and persisted-state
 * sanitising, so the two cannot drift.
 */
export function modeForHref(href: string): WorkspaceMode | null {
  const pathname = pathnameOf(href);
  if (NON_WORKSPACE_ROOTS.some((root) => pathname === root || pathname.startsWith(`${root}/`))) {
    return null;
  }
  if (pathname === "/list" || pathname.startsWith("/list/")) return "list";
  return pathname === "/board" || pathname.startsWith("/board/") ? "board" : "threads";
}

/** The board-owned, full-bleed surfaces: the board and the List view. */
export function isBoardSurfacePath(pathname: string): boolean {
  const mode = modeForHref(pathname);
  return mode === "board" || mode === "list";
}

/**
 * Workspace routes with a top bar but no mode tabs. The thread view's tabs are
 * still mounted when the router moves here, so without this they would file it
 * as the threads location.
 */
const TABLESS_ROOTS = ["/pull-requests"];

/** True at a workspace location whose top bar carries no mode tabs. */
export function isTablessLocation(href: string): boolean {
  const pathname = pathnameOf(href);
  return TABLESS_ROOTS.some((root) => pathname === root || pathname.startsWith(`${root}/`));
}

/**
 * Whether `href` may be remembered as `mode`'s last location, and so be where
 * that mode's tab leads: it must belong to `mode` and carry the tabs itself.
 * Guards the store's writes, its rehydrate sanitiser and the tab's link alike.
 */
export function isModeTabDestination(mode: WorkspaceMode, href: string): boolean {
  return modeForHref(href) === mode && !isTablessLocation(href);
}

/** One board action the command palette lists. */
export interface BoardPaletteAction {
  readonly id: string;
  readonly title: string;
  readonly description: string;
  readonly run: () => void;
}

interface BoardUiState {
  /** The mode the client was last in. */
  mode: WorkspaceMode;
  /** Last location (href) seen in each mode, so toggling modes returns to
      where you were instead of that mode's root. */
  lastLocationByMode: Partial<Record<WorkspaceMode, string>>;
  /** Explicit collapse overrides, keyed per scope (`boardScopeCollapseKey`), so a
      collapsed root column does not collapse inside every sub-board. Missing keys
      fall back to `isBoardColumnCollapsed`'s default. */
  collapsedByStage: Partial<Record<string, boolean>>;
  /** The board's floating corner menu, collapsed to a single chevron.
      Persisted: a user who quieted that corner expects it to
      stay quiet across reloads. */
  utilityMenuCollapsed: boolean;
}

interface BoardUiStore extends BoardUiState {
  /** Whether the thread sidebar's header is currently holding the mode tabs.
      Transient — it is a measurement of this client's live
      layout, not a preference, so it is deliberately outside `partialize`. */
  sidebarHostsModeTabs: boolean;
  /** The card whose sheet is fullscreen. Lives here, not in the sheet, so a step
      (which remounts the sheet) can hand it on; naming the card keeps fullscreen
      from leaking into a card opened any other way. Not persisted. */
  detailMaximisedCardId: string | null;
  /** The card a spend popover asked to open on its Summary pane (T3O-77). Not
      persisted; consumed when that card's detail mounts. */
  detailSummaryCardId: string | null;
  setDetailSummaryCardId: (cardId: string | null) => void;
  /** Each board's filter text, keyed by `boardScopeQueryKey`: the
      root board and every sub-board keep their own. Transient — typing state,
      not a preference. */
  queryByBoard: Partial<Record<string, string>>;
  setBoardQuery: (boardKey: string, query: string) => void;
  /** What the mounted board offers the command palette: drill into
      the selected group, go up a level. Transient, and empty off the board,
      so the palette never subscribes to the board itself. */
  paletteActions: ReadonlyArray<BoardPaletteAction>;
  setPaletteActions: (actions: ReadonlyArray<BoardPaletteAction>) => void;
  recordModeLocation: (mode: WorkspaceMode, href: string) => void;
  setColumnCollapsed: (stageKey: string, collapsed: boolean) => void;
  setUtilityMenuCollapsed: (collapsed: boolean) => void;
  setSidebarHostsModeTabs: (hosting: boolean) => void;
  setDetailMaximisedCardId: (cardId: string | null) => void;
}

/** The first column (the unbounded intake) starts collapsed to a rail.
    `isFirstStage` is false for every sub-board column. */
export function isBoardColumnCollapsed(
  collapsedByStage: Partial<Record<string, boolean>>,
  stageKey: string,
  isFirstStage: boolean,
): boolean {
  return collapsedByStage[stageKey] ?? isFirstStage;
}

export function migratePersistedBoardUiState(persistedState: unknown): BoardUiState {
  const fallback: BoardUiState = {
    mode: "threads",
    lastLocationByMode: {},
    collapsedByStage: {},
    utilityMenuCollapsed: false,
  };
  if (!persistedState || typeof persistedState !== "object") {
    return fallback;
  }
  const candidate = persistedState as Partial<BoardUiState>;
  const lastLocationByMode: BoardUiState["lastLocationByMode"] = {};
  for (const mode of WORKSPACE_MODES) {
    const href = candidate.lastLocationByMode?.[mode];
    // Must be an in-app path AND belong to the mode it is filed under; the second
    // check also repairs stores poisoned by cross-mode writes.
    if (typeof href === "string" && href.startsWith("/") && isModeTabDestination(mode, href)) {
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
    mode:
      typeof candidate.mode === "string" && WORKSPACE_MODES.includes(candidate.mode)
        ? candidate.mode
        : "threads",
    lastLocationByMode,
    collapsedByStage,
    // An older persisted blob has no such field; the menu opens.
    utilityMenuCollapsed: candidate.utilityMenuCollapsed === true,
  };
}

export const useBoardUiStore = create<BoardUiStore>()(
  persist(
    (set) => ({
      mode: "threads",
      lastLocationByMode: {},
      collapsedByStage: {},
      utilityMenuCollapsed: false,
      sidebarHostsModeTabs: false,
      detailMaximisedCardId: null,
      detailSummaryCardId: null,
      setDetailSummaryCardId: (cardId) =>
        set((state) =>
          state.detailSummaryCardId === cardId ? state : { detailSummaryCardId: cardId },
        ),
      queryByBoard: {},
      paletteActions: [],
      setPaletteActions: (actions) =>
        set((state) =>
          state.paletteActions.length === 0 && actions.length === 0
            ? state
            : { paletteActions: actions },
        ),
      setBoardQuery: (boardKey, query) =>
        set((state) =>
          (state.queryByBoard[boardKey] ?? "") === query
            ? state
            : { queryByBoard: { ...state.queryByBoard, [boardKey]: query } },
        ),
      recordModeLocation: (mode, href) =>
        set((state) => {
          // The router location updates before the old surface unmounts, so the
          // still-mounted tab sees the incoming href. File only a location that belongs
          // to this mode and that its tab could lead to.
          if (!isModeTabDestination(mode, href)) return state;
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
      setUtilityMenuCollapsed: (collapsed) =>
        set((state) =>
          state.utilityMenuCollapsed === collapsed ? state : { utilityMenuCollapsed: collapsed },
        ),
      setSidebarHostsModeTabs: (hosting) =>
        set((state) =>
          state.sidebarHostsModeTabs === hosting ? state : { sidebarHostsModeTabs: hosting },
        ),
      setDetailMaximisedCardId: (cardId) =>
        set((state) =>
          state.detailMaximisedCardId === cardId ? state : { detailMaximisedCardId: cardId },
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
        utilityMenuCollapsed: state.utilityMenuCollapsed,
      }),
    },
  ),
);
