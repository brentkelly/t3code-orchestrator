/**
 * T3o mode-tabs placement (T3O-34, D8/D9): does the thread sidebar's header
 * have room to hold the Threads/Board tabs, or do they stay in the top bar?
 *
 * The available width is *measured*, never calculated. What is left in that
 * header depends on the sidebar's dragged width, the sidebar toggle's inset,
 * the macOS traffic-light inset, whether the window is fullscreen and whether
 * the environment-identification pill is switched on. A formula would be
 * silently wrong on some of those combinations, and wrong here means two
 * pieces of chrome overlapping in the app's most visible row.
 */
import { modeForHref } from "./boardUiStore";

/**
 * The width `BoardModeTabs` needs to render both labelled tabs without
 * squeezing. Two buttons of `h-[26px]` with a 14px icon, a 6px gap and 10px of
 * padding either side, inside a 2px track with a 3px gap — about 178px — plus
 * a margin so the tabs never sit hard against the wordmark.
 */
export const MODE_TABS_MIN_WIDTH = 196;

/**
 * Workspace routes that render a top bar with no mode tabs today. Usage, pull
 * requests and project settings are footer destinations, not a mode — giving
 * their sidebar header tabs would invent an entry point rather than move one
 * (D9). `modeForHref` already rules out settings, pairing, connect and the
 * board itself.
 */
const TABLESS_ROOTS = ["/usage", "/pull-requests", "/projects"];

/** True at the locations whose top bar carries the tabs today. */
export function locationHasModeTabs(pathname: string): boolean {
  if (modeForHref(pathname) !== "threads") return false;
  return !TABLESS_ROOTS.some((root) => pathname === root || pathname.startsWith(`${root}/`));
}

export function shouldSidebarHostModeTabs({
  availableWidth,
  isMobile,
  sidebarVisible,
  pathname,
}: {
  /** Measured width of the header's flexible slot, in CSS pixels. */
  readonly availableWidth: number;
  readonly isMobile: boolean;
  readonly sidebarVisible: boolean;
  readonly pathname: string;
}): boolean {
  // Below `md` the sidebar is a sheet and the brand is hidden, so there is no
  // header to host anything (D9).
  if (isMobile) return false;
  if (!sidebarVisible) return false;
  if (!locationHasModeTabs(pathname)) return false;
  return availableWidth >= MODE_TABS_MIN_WIDTH;
}
