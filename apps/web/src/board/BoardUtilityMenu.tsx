/**
 * The board's corner menu: Settings, Pull Requests and Usage, which the absent
 * sidebar's footer would carry. Mounts upstream's own `SidebarUtilityMenu`
 * (`SidebarProvider` is still mounted) so parity needs no upstream edits.
 */
import { ChevronLeftIcon, ChevronRightIcon } from "lucide-react";

import { SidebarUtilityMenu } from "../components/sidebar/SidebarChrome";
import { cn } from "../lib/utils";
import { useBoardUiStore } from "./boardUiStore";

/**
 * Space the column scroller reserves so no card rests under the pill: 14px inset
 * + 40px pill + 6px. Unchanged when the menu collapses, so columns never reflow
 * under the cursor.
 */
export const BOARD_UTILITY_MENU_RESERVED_SPACE = "pb-15";

const CORNER = "fixed bottom-3.5 left-3.5 z-40 flex items-center rounded-xl border p-0.75";
const GLASS = cn(
  "border-border/70 bg-popover/62 backdrop-blur-(--glass-blur) backdrop-saturate-(--glass-saturation)",
  "shadow-board-menu dark:shadow-board-menu-dark",
);

const TOGGLE =
  "inline-flex h-[30px] shrink-0 cursor-pointer items-center justify-center rounded-board-9 text-muted-foreground transition-colors duration-100 hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset focus-visible:outline-none [&_svg]:size-4";

export function BoardUtilityMenu() {
  const collapsed = useBoardUiStore((state) => state.utilityMenuCollapsed);
  const setCollapsed = useBoardUiStore((state) => state.setUtilityMenuCollapsed);

  if (collapsed) {
    return (
      <div className={cn(CORNER, GLASS)}>
        <button
          aria-expanded={false}
          aria-label="Show menu"
          className={cn(TOGGLE, "w-[30px]")}
          onClick={() => setCollapsed(false)}
          type="button"
        >
          <ChevronRightIcon />
        </button>
      </div>
    );
  }

  return (
    <div className={cn(CORNER, GLASS, "gap-0.5")}>
      {/* `SidebarMenu` is `w-full`; inside a shrink-to-fit corner pill it has
          to size to its items instead. A wrapper class, not an upstream edit. */}
      <div className="flex items-center [&_[data-sidebar=menu]]:w-auto [&_[data-sidebar=menu]]:gap-0.5">
        <SidebarUtilityMenu />
      </div>
      <span aria-hidden="true" className="mx-0.5 h-4 w-px shrink-0 bg-border/80" />
      <button
        aria-expanded
        aria-label="Hide menu"
        className={cn(TOGGLE, "w-[22px]")}
        onClick={() => setCollapsed(true)}
        type="button"
      >
        <ChevronLeftIcon />
      </button>
    </div>
  );
}
