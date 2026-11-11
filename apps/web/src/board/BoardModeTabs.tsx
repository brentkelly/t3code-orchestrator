/**
 * The Board/List/Threads segmented control. The board UI store remembers each
 * mode's last location so toggling returns to where you were.
 */
import { useRouter, useRouterState } from "@tanstack/react-router";
import { Columns3Icon, ListTreeIcon, MessageSquareIcon } from "lucide-react";
import { useEffect } from "react";

import { cn } from "../lib/utils";
import { isModeTabDestination, useBoardUiStore, type WorkspaceMode } from "./boardUiStore";

/**
 * A mode's last-seen location, or its root. Only a stored location that belongs
 * to `mode` is honoured (`isModeTabDestination`), so a poisoned or not-yet
 * re-hydrated store cannot send a tab into a thread or settings.
 */
function locationForMode(
  mode: WorkspaceMode,
  lastLocationByMode: Partial<Record<WorkspaceMode, string>>,
): string {
  const fallback = mode === "board" ? "/board" : mode === "list" ? "/list" : "/";
  const stored = lastLocationByMode[mode];
  return stored !== undefined && isModeTabDestination(mode, stored) ? stored : fallback;
}

/**
 * The tab anchor's `href`, so middle-click, copy-link and the status bar work.
 * `history.createHref` makes it real under the desktop app's hash history.
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
 * A modified or non-primary click is the browser's (new tab, window, download)
 * and is left alone; any other click switches mode through the router, as
 * TanStack's `<Link>` does.
 */
export function handleModeTabClick(event: ModeTabClick, onSelect: () => void): void {
  if (event.button !== 0 || event.defaultPrevented) return;
  if (event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return;
  event.preventDefault();
  onSelect();
}

/**
 * Navigates through `router.navigate`, never `router.history.push`: a raw push
 * does not re-run route matching, so the click silently did nothing.
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
  /** Which of the control's two homes this mount is. The top-bar
      copy stands down while the thread sidebar's header is holding the tabs;
      the sidebar copy is the one doing the holding. */
  readonly placement?: "topbar" | "sidebar";
}) {
  const router = useRouter();
  const locationHref = useRouterState({ select: (state) => state.location.href });
  const recordModeLocation = useBoardUiStore((state) => state.recordModeLocation);
  const lastLocationByMode = useBoardUiStore((state) => state.lastLocationByMode);
  const sidebarHostsModeTabs = useBoardUiStore((state) => state.sidebarHostsModeTabs);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- records the router's committed location per mode so switching back returns to it
  useEffect(() => {
    recordModeLocation(mode, locationHref);
  }, [locationHref, mode, recordModeLocation]);

  const switchTo = (target: WorkspaceMode) =>
    navigateToMode(router, mode, target, lastLocationByMode);
  const hrefFor = (target: WorkspaceMode) =>
    modeTabHref(router.history, target, lastLocationByMode);

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
        "flex shrink-0 items-center gap-0.75 rounded-board-10 bg-accent p-0.5",
        className,
      )}
      role="group"
    >
      {/* Board leads: the board is the app's primary mode, and the
          tab order is the clearest place to say so. */}
      <ModeTab
        active={mode === "board"}
        href={hrefFor("board")}
        label="Board"
        onSelect={() => switchTo("board")}
      >
        <Columns3Icon />
      </ModeTab>
      {/* T3o: the whole card tree as an outline. */}
      <ModeTab
        active={mode === "list"}
        href={hrefFor("list")}
        label="List"
        onSelect={() => switchTo("list")}
      >
        <ListTreeIcon />
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
        "inline-flex h-[26px] cursor-pointer items-center gap-1.5 rounded-lg px-2.5 font-medium text-board-12-5 transition-colors [&_svg]:size-3.5 [&_svg]:shrink-0",
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
