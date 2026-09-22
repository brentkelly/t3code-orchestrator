/**
 * T3o Threads/Board segmented control (t3o-05), rendered before the
 * breadcrumb in the workspace top bar. The threads surface mounts it through
 * the one D1 shell-tab seam in `ChatView`; the board surface's top bar is
 * board-owned and mounts it directly.
 *
 * The mounting surface declares which mode its location belongs to; the
 * board UI store remembers each mode's last location so toggling returns to
 * where you were, not to that mode's root.
 */
import { useRouter, useRouterState } from "@tanstack/react-router";
import { Columns3Icon, MessageSquareIcon } from "lucide-react";
import { useCallback, useEffect } from "react";

import { cn } from "../lib/utils";
import { modeForHref, useBoardUiStore, type WorkspaceMode } from "./boardUiStore";

/**
 * Where a mode tab points: that mode's last-seen location, or its root when
 * there is none or when the stored location does not actually belong to it.
 *
 * Only honour a stored location that belongs to `mode`. A store poisoned with
 * a thread href under `board` would otherwise send a Board click to that
 * thread, and one poisoned with `/settings/...` under `threads` would send a
 * Threads click into settings. `modeForHref` is the guard — it returns null
 * for non-workspace routes like settings, so those never match a mode. The
 * store sanitises too, but this keeps navigation correct even before the
 * store re-hydrates.
 */
function locationForMode(
  mode: WorkspaceMode,
  lastLocationByMode: Partial<Record<WorkspaceMode, string>>,
): string {
  const fallback = mode === "board" ? "/board" : "/";
  const stored = lastLocationByMode[mode];
  return stored !== undefined && modeForHref(stored) === mode ? stored : fallback;
}

/**
 * The `href` to put on a mode tab's anchor, so the tabs behave like the links
 * they are: middle-click and ctrl/cmd-click open the other mode in a new tab,
 * right-click offers copy-link, and the status bar shows where the tab goes.
 *
 * `history.createHref` is what makes that address real rather than decorative:
 * the desktop app runs on hash history, where the location above has to be
 * written `#/board` to mean anything to the browser.
 */
export function modeTabHref(
  history: { readonly createHref: (href: string) => string },
  mode: WorkspaceMode,
  lastLocationByMode: Partial<Record<WorkspaceMode, string>>,
): string {
  return history.createHref(locationForMode(mode, lastLocationByMode));
}

interface ModeTabClick {
  readonly button: number;
  readonly metaKey: boolean;
  readonly ctrlKey: boolean;
  readonly altKey: boolean;
  readonly shiftKey: boolean;
  readonly defaultPrevented: boolean;
  readonly preventDefault: () => void;
}

/**
 * A click on a mode tab: ours, or the browser's.
 *
 * A modified or non-primary click is the browser's, and is left strictly
 * alone — that is how open-in-new-tab (ctrl/cmd or middle), open-in-new-window
 * (shift) and download (alt) are expressed, and swallowing them is the whole
 * complaint that made these tabs anchors. Every other click is ours, so an
 * ordinary one switches mode through the router instead of reloading the app.
 *
 * Mirrors what TanStack's own `<Link>` does with a click.
 */
export function handleModeTabClick(event: ModeTabClick, onSelect: () => void): void {
  if (event.button !== 0 || event.defaultPrevented) return;
  if (event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return;
  event.preventDefault();
  onSelect();
}

/**
 * Switch the workspace to `target` mode, returning to that mode's last-seen
 * location.
 *
 * Navigate through `router.navigate`, never `router.history.push`: a raw
 * history push does not re-run route matching in this TanStack version, so the
 * tab click silently did nothing.
 *
 * Extracted from the component so it can be regression tested against a real
 * router without a DOM. See BoardModeTabs.test.ts.
 */
export function navigateToMode(
  router: { readonly navigate: (options: { readonly href: string }) => unknown },
  current: WorkspaceMode,
  target: WorkspaceMode,
  lastLocationByMode: Partial<Record<WorkspaceMode, string>>,
): void {
  if (target === current) return;
  void router.navigate({ href: locationForMode(target, lastLocationByMode) });
}

export function BoardModeTabs({
  mode,
  className,
  placement = "topbar",
}: {
  readonly mode: WorkspaceMode;
  readonly className?: string;
  /** Which of the control's two homes this mount is (T3O-34, D7). The top-bar
      copy stands down while the thread sidebar's header is holding the tabs;
      the sidebar copy is the one doing the holding. */
  readonly placement?: "topbar" | "sidebar";
}) {
  const router = useRouter();
  const locationHref = useRouterState({ select: (state) => state.location.href });
  const recordModeLocation = useBoardUiStore((state) => state.recordModeLocation);
  const lastLocationByMode = useBoardUiStore((state) => state.lastLocationByMode);
  const sidebarHostsModeTabs = useBoardUiStore((state) => state.sidebarHostsModeTabs);

  useEffect(() => {
    recordModeLocation(mode, locationHref);
  }, [locationHref, mode, recordModeLocation]);

  const switchTo = useCallback(
    (target: WorkspaceMode) => navigateToMode(router, mode, target, lastLocationByMode),
    [lastLocationByMode, mode, router],
  );
  const hrefFor = useCallback(
    (target: WorkspaceMode) => modeTabHref(router.history, target, lastLocationByMode),
    [lastLocationByMode, router],
  );

  // After the hooks, never before: the hidden copy must keep recording the
  // last threads location, or the moment the sidebar takes over there is
  // nobody left writing it. Duplicate records are already a no-op in the
  // store, so both copies running the effect costs nothing.
  if (placement === "topbar" && mode === "threads" && sidebarHostsModeTabs) {
    return null;
  }

  return (
    <div
      aria-label="Workspace mode"
      className={cn(
        "flex shrink-0 items-center gap-[3px] rounded-[10px] bg-accent p-0.5",
        className,
      )}
      role="group"
    >
      {/* Board leads (T3O-34): the board is the app's primary mode, and the
          tab order is the clearest place to say so. */}
      <ModeTab
        active={mode === "board"}
        href={hrefFor("board")}
        label="Board"
        onSelect={() => switchTo("board")}
      >
        <Columns3Icon />
      </ModeTab>
      <ModeTab
        active={mode === "threads"}
        href={hrefFor("threads")}
        label="Threads"
        onSelect={() => switchTo("threads")}
      >
        <MessageSquareIcon />
      </ModeTab>
    </div>
  );
}

/**
 * One tab, and a real link. The anchor carries the mode's address so the
 * browser's own link affordances work on it; the click handler takes the plain
 * left click back so switching modes routes in place rather than reloading the
 * whole app.
 */
function ModeTab({
  active,
  href,
  label,
  onSelect,
  children,
}: {
  readonly active: boolean;
  readonly href: string;
  readonly label: string;
  readonly onSelect: () => void;
  readonly children: React.ReactNode;
}) {
  return (
    <a
      aria-current={active ? "page" : undefined}
      className={cn(
        // Explicit 8px: `rounded-lg` maps to --radius (10px) in this theme,
        // which matched the 10px track behind the tabs instead of nesting
        // inside it.
        "inline-flex h-[26px] cursor-pointer items-center gap-1.5 rounded-[8px] px-2.5 font-medium text-[12.5px] transition-colors [&_svg]:size-3.5 [&_svg]:shrink-0",
        active
          ? "bg-card text-foreground shadow-xs"
          : "bg-transparent text-muted-foreground hover:text-foreground",
      )}
      href={href}
      onClick={(event) => handleModeTabClick(event, onSelect)}
    >
      {children}
      <span className="max-sm:sr-only">{label}</span>
    </a>
  );
}
