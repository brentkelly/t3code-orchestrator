import { Combobox as ComboboxPrimitive } from "@base-ui/react/combobox";

import { cn } from "~/lib/utils";
import { BoardInput } from "./BoardInput";
import {
  UPSTREAM_COMBOBOX_INPUT_SM,
  UPSTREAM_COMBOBOX_INPUT_WRAPPER,
  UPSTREAM_COMBOBOX_ITEM,
  UPSTREAM_COMBOBOX_ITEM_CONTENT,
  UPSTREAM_COMBOBOX_ITEM_SELECTED_FILL,
  UPSTREAM_COMBOBOX_LIST,
} from "./upstreamClasses";

/*
 * Combobox parts for the board's code-type pickers, built the way upstream's
 * `components/ui/combobox.tsx` builds its own. Their upstream classes live in
 * upstreamClasses.ts, checked against upstream's source.
 */

/** A search row on a hairline at the top of a combobox popup, with no trigger or clear. */
export function BoardComboboxSearchInput({
  className,
  ...props
}: Omit<ComboboxPrimitive.Input.Props, "size">) {
  return (
    <div className={UPSTREAM_COMBOBOX_INPUT_WRAPPER}>
      <ComboboxPrimitive.Input
        className={cn(UPSTREAM_COMBOBOX_INPUT_SM, "[&_input]:h-6.5", className)}
        data-slot="combobox-input"
        render={<BoardInput look="combobox-search" nativeInput size="sm" unstyled />}
        {...props}
      />
    </div>
  );
}

/** A combobox row in code type, its trailing marks pulled closer to the edge. */
export function BoardComboboxCodeItem({
  className,
  children,
  ...props
}: ComboboxPrimitive.Item.Props) {
  return (
    <ComboboxPrimitive.Item
      className={cn(
        UPSTREAM_COMBOBOX_ITEM,
        UPSTREAM_COMBOBOX_ITEM_SELECTED_FILL,
        "pe-1.5 font-mono",
        className,
      )}
      data-slot="combobox-item"
      {...props}
    >
      <div className={UPSTREAM_COMBOBOX_ITEM_CONTENT} data-slot="combobox-item-content">
        {children}
      </div>
    </ComboboxPrimitive.Item>
  );
}

/** A virtualised combobox list padded even while it is empty. */
export function BoardComboboxPaddedList({ className, ...props }: ComboboxPrimitive.List.Props) {
  return (
    <ComboboxPrimitive.List
      className={cn(UPSTREAM_COMBOBOX_LIST, "p-1", className)}
      data-slot="combobox-list"
      {...props}
    />
  );
}
