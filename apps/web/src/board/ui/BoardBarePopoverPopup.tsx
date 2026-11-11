import { Popover as PopoverPrimitive } from "@base-ui/react/popover";

import { renderClosingPositioner } from "~/components/ui/closing-positioner";
import { cn } from "~/lib/utils";
import {
  UPSTREAM_POPOVER_POPUP,
  UPSTREAM_POPOVER_POSITIONER,
  UPSTREAM_POPOVER_POSITIONER_TRANSITION,
  UPSTREAM_POPOVER_VIEWPORT,
  UPSTREAM_POPOVER_VIEWPORT_OVERFLOW,
  UPSTREAM_POPOVER_VIEWPORT_PADDING_NONE,
} from "./upstreamClasses";

/*
 * A popover with no surface of its own, for content that brings its own (the app's model
 * picker). Built the way upstream's `components/ui/popover.tsx` builds PopoverPopup, minus
 * the glass. Its upstream classes live in upstreamClasses.ts, checked against upstream's source.
 */
export function BoardBarePopoverPopup({
  children,
  align = "center",
  side = "bottom",
  sideOffset = 4,
  ...props
}: PopoverPrimitive.Popup.Props & {
  readonly align?: PopoverPrimitive.Positioner.Props["align"];
  readonly side?: PopoverPrimitive.Positioner.Props["side"];
  readonly sideOffset?: PopoverPrimitive.Positioner.Props["sideOffset"];
}) {
  return (
    <PopoverPrimitive.Portal>
      <PopoverPrimitive.Positioner
        align={align}
        alignOffset={0}
        className={cn(
          UPSTREAM_POPOVER_POSITIONER,
          UPSTREAM_POPOVER_POSITIONER_TRANSITION,
          "z-[130]",
        )}
        data-slot="popover-positioner"
        render={renderClosingPositioner}
        side={side}
        sideOffset={sideOffset}
      >
        <PopoverPrimitive.Popup
          className={cn(
            UPSTREAM_POPOVER_POPUP,
            "dropdown-glass [-webkit-app-region:no-drag] dark:shadow-board-menu-dark",
            "border-0 bg-transparent p-0 shadow-none before:hidden [-webkit-backdrop-filter:none]! [--viewport-inline-padding:0] [backdrop-filter:none]!",
          )}
          data-slot="popover-popup"
          {...props}
        >
          <PopoverPrimitive.Viewport
            className={cn(
              UPSTREAM_POPOVER_VIEWPORT,
              UPSTREAM_POPOVER_VIEWPORT_PADDING_NONE,
              UPSTREAM_POPOVER_VIEWPORT_OVERFLOW,
            )}
            data-slot="popover-viewport"
          >
            {children}
          </PopoverPrimitive.Viewport>
        </PopoverPrimitive.Popup>
      </PopoverPrimitive.Positioner>
    </PopoverPrimitive.Portal>
  );
}
