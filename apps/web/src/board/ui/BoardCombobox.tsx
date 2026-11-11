import { Combobox as ComboboxPrimitive } from "@base-ui/react/combobox";

import { cn } from "~/lib/utils";
import { BoardInput } from "./BoardInput";

/*
 * Combobox parts for the board's code-type pickers, built the way upstream's
 * `components/ui/combobox.tsx` builds its own. The class strings mirror upstream's; an
 * upstream sync that restyles its combobox should carry the change into these.
 */

/** A search row on a hairline at the top of a combobox popup, with no trigger or clear. */
export function BoardComboboxSearchInput({
  className,
  ...props
}: Omit<ComboboxPrimitive.Input.Props, "size">) {
  return (
    <div className="relative not-has-[>*.w-full]:w-fit w-full text-foreground has-disabled:opacity-64">
      <ComboboxPrimitive.Input
        className={cn(
          "has-[+[data-slot=combobox-trigger],+[data-slot=combobox-clear]]:*:data-[slot=combobox-input]:pe-6.5",
          "[&_input]:h-6.5",
          className,
        )}
        data-slot="combobox-input"
        render={<BoardInput look="combobox-search" nativeInput size="sm" unstyled />}
        {...props}
      />
    </div>
  );
}

const COMBOBOX_ITEM_CLASS =
  "flex min-h-8 in-data-[side=none]:min-w-[calc(var(--anchor-width)+1.25rem)] cursor-pointer items-center rounded-sm px-2 py-1 text-base outline-none not-data-disabled:hover:bg-foreground/9 data-disabled:pointer-events-none data-disabled:cursor-not-allowed data-selected:text-foreground data-highlighted:bg-foreground/9 data-highlighted:text-accent-foreground [&[data-highlighted][data-selected]]:bg-foreground/9 [&[data-highlighted][data-selected]]:text-accent-foreground data-disabled:opacity-64 sm:min-h-7 sm:text-sm [&_svg:not([class*='size-'])]:size-4.5 sm:[&_svg:not([class*='size-'])]:size-4 [&_svg]:pointer-events-none [&_svg]:shrink-0";

/** A combobox row in code type, its trailing marks pulled closer to the edge. */
export function BoardComboboxCodeItem({
  className,
  children,
  ...props
}: ComboboxPrimitive.Item.Props) {
  return (
    <ComboboxPrimitive.Item
      className={cn(
        COMBOBOX_ITEM_CLASS,
        "data-selected:bg-foreground/6",
        "pe-1.5 font-mono",
        className,
      )}
      data-slot="combobox-item"
      {...props}
    >
      <div
        className="flex min-w-0 flex-1 items-center gap-2 [&_svg:not([class*='text-'])]:text-muted-foreground"
        data-slot="combobox-item-content"
      >
        {children}
      </div>
    </ComboboxPrimitive.Item>
  );
}

/** A virtualised combobox list padded even while it is empty. */
export function BoardComboboxPaddedList({ className, ...props }: ComboboxPrimitive.List.Props) {
  return (
    <ComboboxPrimitive.List
      className={cn("size-full min-w-0 not-empty:px-1 not-empty:py-1", "p-1", className)}
      data-slot="combobox-list"
      {...props}
    />
  );
}
