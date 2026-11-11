import { Popover as PopoverPrimitive } from "@base-ui/react/popover";

import { renderClosingPositioner } from "~/components/ui/closing-positioner";

/*
 * A popover with no surface of its own, for content that brings its own (the app's model
 * picker). Built the way upstream's `components/ui/popover.tsx` builds PopoverPopup, minus
 * the glass; the class strings mirror upstream's, so a sync that restyles its popover should
 * carry the change into this.
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
        className="h-(--positioner-height) max-h-(--available-height) w-(--positioner-width) max-w-(--available-width) transition-transform data-instant:transition-none z-[130]"
        data-slot="popover-positioner"
        render={renderClosingPositioner}
        side={side}
        sideOffset={sideOffset}
      >
        <PopoverPrimitive.Popup
          className="relative flex h-(--popup-height,auto) w-(--popup-width,auto) origin-(--transform-origin) rounded-lg text-popover-foreground outline-none transition-[width,height,scale,opacity] data-ending-style:scale-98 data-starting-style:scale-98 data-ending-style:opacity-0 data-starting-style:opacity-0 dropdown-glass [-webkit-app-region:no-drag] dark:shadow-board-menu-dark border-0 bg-transparent p-0 shadow-none before:hidden [-webkit-backdrop-filter:none]! [--viewport-inline-padding:0] [backdrop-filter:none]!"
          data-slot="popover-popup"
          {...props}
        >
          <PopoverPrimitive.Viewport
            className="relative size-full max-h-(--available-height) overflow-clip px-(--viewport-inline-padding) data-instant:transition-none **:data-current:data-ending-style:opacity-0 **:data-current:data-starting-style:opacity-0 **:data-previous:data-ending-style:opacity-0 **:data-previous:data-starting-style:opacity-0 **:data-current:w-[calc(var(--popup-width)-2*var(--viewport-inline-padding)-2px)] **:data-previous:w-[calc(var(--popup-width)-2*var(--viewport-inline-padding)-2px)] **:data-current:opacity-100 **:data-previous:opacity-100 **:data-current:transition-opacity **:data-previous:transition-opacity rounded-board-inner-lg py-0 [--viewport-inline-padding:0px] not-data-transitioning:overflow-y-auto"
            data-slot="popover-viewport"
          >
            {children}
          </PopoverPrimitive.Viewport>
        </PopoverPrimitive.Popup>
      </PopoverPrimitive.Positioner>
    </PopoverPrimitive.Portal>
  );
}
