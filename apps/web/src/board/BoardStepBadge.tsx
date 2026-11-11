/**
 * The numbered step badge shared by CI and Code review, and the
 * shimmer a running step's name wears. Colours per `docs/t3o/status-colours.md`:
 * a done step's tick is green, a running step solid blue, a failure amber (blue
 * while a fix agent works on it), a cancelled step a grey dash.
 */
import { CheckIcon, MinusIcon, XIcon } from "lucide-react";

import { ActivityShimmerOverlay } from "../components/chat/TimelineRowParts";
import { observeVisibleAnimation } from "../lib/visibleAnimation";
import { cn } from "../lib/utils";
import type { BoardStepBadgeState } from "./boardCi";

const STATE_LABEL: Record<BoardStepBadgeState, string> = {
  pending: "Pending",
  running: "Running",
  passed: "Done",
  failed: "Failed",
  fixing: "Failed, being fixed",
  cancelled: "Cancelled",
};

export function BoardStepBadge({
  index,
  state,
}: {
  readonly index: number;
  readonly state: BoardStepBadgeState;
}) {
  const mark =
    state === "passed"
      ? { className: "bg-success", icon: <CheckIcon className="size-[7px]" strokeWidth={4} /> }
      : state === "failed"
        ? { className: "bg-warning", icon: <XIcon className="size-[7px]" strokeWidth={4} /> }
        : state === "fixing"
          ? { className: "bg-info", icon: <XIcon className="size-[7px]" strokeWidth={4} /> }
          : state === "cancelled"
            ? {
                className: "bg-muted-foreground",
                icon: <MinusIcon className="size-[7px]" strokeWidth={4} />,
              }
            : null;
  return (
    <span
      aria-label={`Step ${index}: ${STATE_LABEL[state]}`}
      role="img"
      className="relative inline-flex shrink-0"
      data-step-state={state}
    >
      <span
        className={cn(
          "inline-flex size-5 items-center justify-center rounded-full text-[10px] font-semibold",
          state === "running"
            ? "bg-info text-white"
            : state === "pending"
              ? "text-muted-foreground/70 shadow-[inset_0_0_0_1px_var(--border)]"
              : "bg-foreground/8 text-foreground",
        )}
      >
        {index}
      </span>
      {mark === null ? null : (
        <span
          className={cn(
            "absolute -bottom-[3px] -left-[3px] inline-flex size-[11px] items-center justify-center rounded-full text-white shadow-[0_0_0_1.5px_var(--card)]",
            mark.className,
          )}
        >
          {mark.icon}
        </span>
      )}
    </span>
  );
}

/** A running step's name with the shared activity shimmer. The shimmer runs
    only while on screen, and not at all under reduced motion or forced
    colours (`live-activity-focus` in index.css). */
export function BoardShimmerText({
  text,
  active,
  className,
}: {
  readonly text: string;
  readonly active: boolean;
  readonly className?: string | undefined;
}) {
  return (
    <span
      ref={active ? observeVisibleAnimation : undefined}
      className={cn("relative min-w-0 overflow-hidden", className)}
    >
      {text}
      {active ? <ActivityShimmerOverlay>{text}</ActivityShimmerOverlay> : null}
    </span>
  );
}
