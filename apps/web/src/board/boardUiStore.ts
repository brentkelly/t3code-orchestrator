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
 * Routes that are not a workspace location at all: settings (which replaces
 * the whole workspace, tabs included), the auth flow, onboarding (`/welcome`),
 * `/projects/<key>` (a redirect into `/settings/projects`) and the full-page
 * usage view.
 *
 * They must never be filed as a mode's last location. `/settings/general`
 * recorded under `threads` stranded the workspace: clicking Threads reopened
 * settings, and Back out of settings landed on the board, leaving no way to
 * reach a thread. `/projects/<key>` did the same by the back door (T3O-50):
 * the router location changes before the thread view's tabs unmount, so
 * they filed the link under `threads`, and every Threads click then followed
 * it into project settings. `/welcome` is the same shape: the first-run gate
 * replaces a thread view's location with it, and Threads would then reopen
 * the onboarding wizard.
 */
const NON_WORKSPACE_ROOTS = ["/settings", "/pair", "/connect", "/welcome", "/projects", "/usage"];

/** The path part of an in-app href, without `?search` or `#hash`. */
function pathnameOf(href: string): string {
  const boundary = href.search(/[?#]/);
  return boundary === -1 ? href : href.slice(0, boundary);
}

/**
 * Which workspace mode an href belongs to, or `null` when it belongs to
 * neither. The board surface lives under `/board` (optionally with
 * `?project`/`?card`); threads, drafts and the root are threads-surface
 * locations; everything in `NON_WORKSPACE_ROOTS` (settings, the auth flow,
 * onboarding, project links, usage) is not a workspace location.
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

/**
 * Workspace routes that render a top bar with no mode tabs. Pull requests is a
 * footer destination, not a mode: it is a threads-surface page, but it is not
 * somewhere the Threads tab should lead. The thread view's tabs are still
 * mounted when the router moves there, so without this they filed it as the
 * threads location and the next Threads click opened the PR list (T3O-50).
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
  /** The board's floating corner menu, collapsed to a single chevron
      (T3O-34, D6). Persisted: a user who quieted that corner expects it to
      stay quiet across reloads. */
  utilityMenuCollapsed: boolean;
}

interface BoardUiStore extends BoardUiState {
  /** Whether the thread sidebar's header is currently holding the mode tabs
      (T3O-34, D8). Transient — it is a measurement of this client's live
      layout, not a preference, so it is deliberately outside `partialize`. */
  sidebarHostsModeTabs: boolean;
  /** The card whose sheet is currently in fullscreen, or null (T3O-37, D5).
      Transient, and deliberately outside `partialize` for the same reason as
      the field above: it belongs to the sheet that is open right now, not to
      the client. It lives here rather than in the sheet only so that stepping
      to the next card — which remounts the sheet on purpose, to reset
      everything else — does not throw the reader out of fullscreen; a step
      hands the flag to the card it steps to. Naming the card rather than
      holding a bare boolean is what keeps fullscreen from leaking into a card
      the user never maximised: every OTHER way a card opens (a deep link, a
      sub-board drill, clicking a different card) leaves this id behind, and a
      sheet is fullscreen only while it matches. The board clears it on close. */
  detailMaximisedCardId: string | null;
  recordModeLocation: (mode: WorkspaceMode, href: string) => void;
  setColumnCollapsed: (stageKey: string, collapsed: boolean) => void;
  setUtilityMenuCollapsed: (collapsed: boolean) => void;
  setSidebarHostsModeTabs: (hosting: boolean) => void;
  setDetailMaximisedCardId: (cardId: string | null) => void;
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
  for (const mode of ["threads", "board"] as const) {
    const href = candidate.lastLocationByMode?.[mode];
    // Must be an in-app path AND belong to the mode it is filed under. The
    // second check repairs stores poisoned by the pre-guard bugs: a
    // board→thread transition recording a thread href under `board` (which
    // sent every Board click back to that thread), and a workspace→settings
    // transition recording `/settings/...` under `threads` (which sent every
    // Threads click into settings).
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
    mode: candidate.mode === "board" ? "board" : "threads",
    lastLocationByMode,
    collapsedByStage,
    // A blob persisted before T3O-34 has no such field; the menu opens.
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
      recordModeLocation: (mode, href) =>
        set((state) => {
          // The mounting surface fixes `mode`, but the router location updates
          // the instant a navigation starts — before the old surface unmounts.
          // Without this guard the still-mounted tab records the incoming href
          // under its own mode: a board→thread transition filed a thread href
          // under `board`, and a threads→settings transition filed
          // `/settings/...` under `threads`. Only file a location under the
          // mode it actually belongs to, and never file a non-workspace
          // location (`modeForHref` returns null) under either, nor a tabless
          // page the tab could not have been clicked from.
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
