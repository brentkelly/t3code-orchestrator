import type { ComponentProps } from "react";

import { Button } from "~/components/ui/button";
import { cn } from "~/lib/utils";

/** The board's own button looks, each layered on one of upstream's variants and sizes. */
const BOARD_BUTTON_LOOKS = {
  /** A small inline action beside a field: Reset, Edit. */
  "inline-action": "h-6 gap-1 px-2 text-xs text-muted-foreground",
  /** Remove a pipeline stage. */
  "danger-outline": "gap-1.5 text-destructive-foreground hover:bg-destructive/10",
  /** Discard a card draft: reads neutral until hovered. */
  discard: "hover:border-destructive hover:text-destructive-foreground",
  muted: "text-muted-foreground",
  /** A project's Show-on-board toggle while the project is hidden. */
  "muted-pressed": "text-muted-foreground border border-border",
  /** The model row's picker trigger. */
  "model-picker": "max-w-56 justify-between gap-1.5",
  /** The model row's settings menu, as an icon. */
  "model-menu-icon": "shrink-0 px-2 text-muted-foreground/70 hover:text-foreground/80",
  /** The model row's settings menu, sized like the model picker (Button `xs`) beside it. */
  "model-menu-label":
    "h-7 min-w-0 max-w-56 shrink-0 gap-1 px-1.75 text-sm text-foreground/90 hover:text-foreground sm:h-6 sm:text-xs",
  /** A base-branch picker trigger. */
  "branch-picker": "min-w-0 max-w-full justify-start font-mono",
  /** A base-branch picker set into the card modal's meta row, sized to its text. */
  "branch-picker-inline":
    "min-w-0 max-w-full justify-start font-mono h-5 px-1 text-board-11-5 text-foreground",
} as const;

type BoardButtonLook = keyof typeof BOARD_BUTTON_LOOKS;

/** Settles the board look over Button's variant classes, then the caller's className over
    both, the order Button itself gives a className. */
function BoardButtonElement({
  className,
  look,
  callerClassName,
  ...props
}: ComponentProps<"button"> & {
  readonly look: BoardButtonLook;
  readonly callerClassName: string | undefined;
}) {
  return (
    <button
      className={cn(className, BOARD_BUTTON_LOOKS[look], callerClassName)}
      type="button"
      {...props}
    />
  );
}

/** Upstream's Button wearing one of the board's looks. */
export function BoardButton({
  look,
  className,
  ...props
}: Omit<ComponentProps<typeof Button>, "render" | "className"> & {
  readonly look: BoardButtonLook;
  readonly className?: string;
}) {
  return (
    <Button {...props} render={<BoardButtonElement callerClassName={className} look={look} />} />
  );
}
