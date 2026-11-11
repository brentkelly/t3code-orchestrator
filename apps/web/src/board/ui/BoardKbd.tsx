import type { ComponentProps } from "react";

import { cn } from "~/lib/utils";

/** A shortcut hint set inside a primary button, in the button's own foreground. Mirrors
    upstream's Kbd, whose look it replaces. */
export function BoardKbd({ className, ...props }: ComponentProps<"kbd">) {
  return (
    <kbd
      className={cn(
        "pointer-events-none inline-flex h-5 min-w-5 select-none items-center justify-center gap-1 rounded px-1 font-medium font-sans text-muted-foreground text-xs [&_svg:not([class*='size-'])]:size-3",
        "h-4 min-w-0 rounded-sm bg-primary-foreground/20 px-1 font-mono text-board-10 text-primary-foreground",
        className,
      )}
      data-slot="kbd"
      {...props}
    />
  );
}
