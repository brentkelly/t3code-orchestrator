/**
 * T3o board corner menu (T3O-34, D4/D5/D6).
 *
 * The board is mounted without the thread sidebar, so the three destinations
 * that sidebar's footer carries — Settings, Pull Requests, Usage — have
 * nowhere else to live. They come back as a small glass pill in the board's
 * bottom-left corner.
 *
 * The items are not reimplemented here: this mounts upstream's own
 * `SidebarUtilityMenu`, the same component the sidebar footer mounts. Parity
 * with the threads surface then stays automatic — including the desktop
 * update pill at the end of that menu, and a fourth item if upstream ever adds
 * one — at a cost of zero upstream edits. It works off the sidebar because
 * `AppSidebarLayout` still mounts `SidebarProvider` on the board; only the
 * `Sidebar` itself is skipped.
 *
 * Deliberately not included: the provider update pill and the arm64/Intel
 * architecture warning. Both sit outside that menu in the footer and are built
 * as full-width cards, which a corner pill is the wrong shape for.
 */
import { ChevronLeftIcon, ChevronRightIcon } from "lucide-react";

import { SidebarUtilityMenu } from "../components/sidebar/SidebarChrome";
import { cn } from "../lib/utils";
import { useBoardUiStore } from "./boardUiStore";

/**
 * Height the board's column scroller reserves at its bottom edge so no card can
 * come to rest under the pill (D5): the corner's 14px inset plus the pill's
 * 40px, plus 6px so a card stops short of it rather than against it. The
 * reserve does not change when the menu collapses — quieting the corner should
 * not reflow every column under the user's cursor.
 */
export const BOARD_UTILITY_MENU_RESERVED_SPACE = "pb-[60px]";

const CORNER = "fixed bottom-3.5 left-3.5 z-40 flex items-center rounded-xl border p-[3px]";
const GLASS = cn(
  "border-border/70 bg-popover/62 backdrop-blur-(--glass-blur) backdrop-saturate-(--glass-saturation)",
  "shadow-[0_16px_40px_-18px_rgb(0_0_0/55%)] dark:shadow-[0_18px_44px_-18px_rgb(0_0_0/80%)]",
);

const TOGGLE =
  "inline-flex h-[30px] shrink-0 cursor-pointer items-center justify-center rounded-[9px] text-muted-foreground transition-colors duration-100 hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none [&_svg]:size-4";

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
