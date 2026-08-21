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
 * Switch the workspace to `target` mode, returning to that mode's last-seen
 * location (or its root when there is none, or when the stored location does
 * not actually belong to the target mode).
 *
 * Two things this must get right, both learned from real bugs:
 *  - Navigate through `router.navigate`, never `router.history.push`: a raw
 *    history push does not re-run route matching in this TanStack version, so
 *    the tab click silently did nothing.
 *  - Only honour a stored location that belongs to `target`. A store poisoned
 *    with a thread href under `board` would otherwise send a Board click to
 *    that thread, and one poisoned with `/settings/...` under `threads` would
 *    send a Threads click into settings. `modeForHref` is the guard — it
 *    returns null for non-workspace routes like settings, so those never match
 *    a target. The store sanitises too, but this keeps navigation correct even
 *    before the store re-hydrates.
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
  const fallback = target === "board" ? "/board" : "/";
  const stored = lastLocationByMode[target];
  const href = stored !== undefined && modeForHref(stored) === target ? stored : fallback;
  void router.navigate({ href });
}

export function BoardModeTabs({
  mode,
  className,
}: {
  readonly mode: WorkspaceMode;
  readonly className?: string;
}) {
  const router = useRouter();
  const locationHref = useRouterState({ select: (state) => state.location.href });
  const recordModeLocation = useBoardUiStore((state) => state.recordModeLocation);
  const lastLocationByMode = useBoardUiStore((state) => state.lastLocationByMode);

  useEffect(() => {
    recordModeLocation(mode, locationHref);
  }, [locationHref, mode, recordModeLocation]);

  const switchTo = useCallback(
    (target: WorkspaceMode) => navigateToMode(router, mode, target, lastLocationByMode),
    [lastLocationByMode, mode, router],
  );

  return (
    <div
      aria-label="Workspace mode"
      className={cn(
        "flex shrink-0 items-center gap-[3px] rounded-[10px] bg-accent p-0.5",
        className,
      )}
      role="group"
    >
      <ModeTab active={mode === "threads"} label="Threads" onSelect={() => switchTo("threads")}>
        <MessageSquareIcon />
      </ModeTab>
      <ModeTab active={mode === "board"} label="Board" onSelect={() => switchTo("board")}>
        <Columns3Icon />
      </ModeTab>
    </div>
  );
}

function ModeTab({
  active,
  label,
  onSelect,
  children,
}: {
  readonly active: boolean;
  readonly label: string;
  readonly onSelect: () => void;
  readonly children: React.ReactNode;
}) {
  return (
    <button
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
      onClick={onSelect}
      type="button"
    >
      {children}
      <span className="max-sm:sr-only">{label}</span>
    </button>
  );
}
