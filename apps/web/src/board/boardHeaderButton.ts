import { cn } from "../lib/utils";

/** The small bordered buttons in a board panel header (dependency chart, Automation). */
export function boardHeaderButtonClass(active: boolean): string {
  return cn(
    "inline-flex h-6 shrink-0 cursor-pointer items-center gap-1.5 rounded-board-7 border px-2.5 text-board-11-5 font-medium whitespace-nowrap shadow-xs [&_svg]:size-3",
    active
      ? "border-input bg-accent text-foreground"
      : "border-border bg-popover text-muted-foreground hover:bg-accent hover:text-foreground data-popup-open:border-input data-popup-open:bg-accent data-popup-open:text-foreground",
  );
}
