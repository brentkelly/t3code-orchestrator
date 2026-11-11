/**
 * Whether the thread sidebar's header has room for the mode tabs. The width is
 * measured, never calculated: sidebar width, insets, fullscreen and the
 * environment pill all change it.
 */
import { isTablessLocation, modeForHref } from "./boardUiStore";

/**
 * `BoardModeTabs`' rendered width with every label showing: measured at 233px
 * (`BoardModeTabs.browser.test.tsx` holds it), rounded up for font variance.
 */
export const MODE_TABS_WIDTH = 236;

/**
 * Room the slot needs on top of the control: keeps the tabs off the right edge
 * and absorbs a wide custom interface font.
 */
const MODE_TABS_SLOT_GUTTER = 24;

/** The measured slot width at or above which the sidebar takes the tabs. */
export const MODE_TABS_MIN_WIDTH = MODE_TABS_WIDTH + MODE_TABS_SLOT_GUTTER;

/**
 * True where the top bar carries the tabs today. Tabless pages get no sidebar
 * header tabs either.
 */
export function locationHasModeTabs(pathname: string): boolean {
  return modeForHref(pathname) === "threads" && !isTablessLocation(pathname);
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
  // header to host anything.
  if (isMobile) return false;
  if (!sidebarVisible) return false;
  if (!locationHasModeTabs(pathname)) return false;
  return availableWidth >= MODE_TABS_MIN_WIDTH;
}
