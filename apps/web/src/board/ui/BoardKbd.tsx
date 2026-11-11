import type { ComponentProps } from "react";

import { cn } from "~/lib/utils";
import { UPSTREAM_KBD } from "./upstreamClasses";

/** A shortcut hint set inside a primary button, in the button's own foreground. Mirrors
    upstream's Kbd, whose look it replaces. */
export function BoardKbd({ className, ...props }: ComponentProps<"kbd">) {
  return (
    <kbd
      className={cn(
        UPSTREAM_KBD,
        "h-4 min-w-0 rounded-sm bg-primary-foreground/20 px-1 font-mono text-board-10 text-primary-foreground",
        className,
      )}
      data-slot="kbd"
      {...props}
    />
  );
}
