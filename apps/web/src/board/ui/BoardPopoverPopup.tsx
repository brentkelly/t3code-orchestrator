import type { ComponentProps } from "react";

import { PopoverPopup } from "~/components/ui/popover";
import { cn } from "~/lib/utils";

/** The board's popover insets, on the popup itself so they sit outside the scrolling viewport. */
const BOARD_POPOVER_INSETS = {
  "1": "p-1",
  "1.5": "p-1.5",
  "2.5": "p-2.5",
  "3": "p-3",
} as const;

type BoardPopoverInset = keyof typeof BOARD_POPOVER_INSETS;

/** Takes the popup's merged className and adds the board inset after it. */
function BoardPopoverSurface({
  className,
  inset,
  ...props
}: ComponentProps<"div"> & { readonly inset: BoardPopoverInset }) {
  return <div className={cn(className, BOARD_POPOVER_INSETS[inset])} {...props} />;
}

/** Upstream's popover, padded the way the board's dense popovers are. */
export function BoardPopoverPopup({
  inset,
  ...props
}: Omit<ComponentProps<typeof PopoverPopup>, "render"> & { readonly inset: BoardPopoverInset }) {
  return <PopoverPopup {...props} render={<BoardPopoverSurface inset={inset} />} />;
}
