import type { ComponentProps } from "react";

import { PopoverPopup } from "~/components/ui/popover";

/** The board's popover insets, inside upstream's own viewport padding. */
const BOARD_POPOVER_INSETS = {
  "1": "p-1",
  "1.5": "p-1.5",
  "2.5": "p-2.5",
  "3": "p-3",
} as const;

/** Upstream's popover, padded the way the board's dense popovers are. */
export function BoardPopoverPopup({
  inset,
  children,
  ...props
}: ComponentProps<typeof PopoverPopup> & { readonly inset: keyof typeof BOARD_POPOVER_INSETS }) {
  return (
    <PopoverPopup {...props}>
      <div className={BOARD_POPOVER_INSETS[inset]}>{children}</div>
    </PopoverPopup>
  );
}
