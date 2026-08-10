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
import { LayoutDashboardIcon, MessageSquareIcon } from "lucide-react";
import { useCallback, useEffect } from "react";

import { Button } from "../components/ui/button";
import { cn } from "../lib/utils";
import { useBoardUiStore, type WorkspaceMode } from "./boardUiStore";

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
    (target: WorkspaceMode) => {
      if (target === mode) return;
      const fallback = target === "board" ? "/board" : "/";
      router.history.push(lastLocationByMode[target] ?? fallback);
    },
    [lastLocationByMode, mode, router],
  );

  return (
    <div
      aria-label="Workspace mode"
      className={cn(
        "flex shrink-0 items-center gap-0.5 rounded-[calc(var(--control-radius)+2px)] bg-muted/70 p-0.5",
        className,
      )}
      role="group"
    >
      <ModeTab active={mode === "threads"} label="Threads" onSelect={() => switchTo("threads")}>
        <MessageSquareIcon />
      </ModeTab>
      <ModeTab active={mode === "board"} label="Board" onSelect={() => switchTo("board")}>
        <LayoutDashboardIcon />
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
    <Button
      aria-current={active ? "page" : undefined}
      className={active ? undefined : "text-muted-foreground"}
      onClick={onSelect}
      size="xs"
      variant={active ? "outline" : "ghost"}
    >
      {children}
      <span className="max-sm:sr-only">{label}</span>
    </Button>
  );
}
