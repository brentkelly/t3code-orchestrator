import { Dialog as DialogPrimitive } from "@base-ui/react/dialog";

import { DialogBackdrop, DialogPortal, renderRetainedPopup } from "~/components/ui/dialog";
import { DIALOG_MOBILE_SHEET_CLASS, DIALOG_POPUP_CLASS } from "~/components/ui/dialog-styles";
import { cn } from "~/lib/utils";
import type { ComponentProps } from "react";
import {
  UPSTREAM_DIALOG_FOOTER,
  UPSTREAM_DIALOG_FOOTER_DEFAULT,
  UPSTREAM_DIALOG_POPUP,
  UPSTREAM_DIALOG_POPUP_DEFAULT,
  UPSTREAM_DIALOG_TITLE,
  UPSTREAM_DIALOG_VIEWPORT,
  UPSTREAM_DIALOG_VIEWPORT_MOBILE_SHEET,
} from "./upstreamClasses";

/*
 * Board dialog parts built the way upstream's `components/ui/dialog.tsx` builds its own, with
 * the board's looks owned here. Their upstream classes live in upstreamClasses.ts, checked
 * against upstream's source.
 */

const BOARD_SHEET_MAXIMISED_CLASS =
  "fixed inset-0 h-screen max-h-none w-screen max-w-none rounded-none border-0";

/** The card modal's sheet: upstream's dialog popup, which can also fill the window edge to edge. */
export function BoardSheetPopup({
  className,
  maximised = false,
  ...props
}: DialogPrimitive.Popup.Props & { readonly maximised?: boolean }) {
  return (
    <DialogPortal>
      <DialogBackdrop />
      <DialogPrimitive.Viewport
        className={cn(UPSTREAM_DIALOG_VIEWPORT, UPSTREAM_DIALOG_VIEWPORT_MOBILE_SHEET)}
        data-slot="dialog-viewport"
      >
        <DialogPrimitive.Popup
          className={cn(
            DIALOG_POPUP_CLASS,
            UPSTREAM_DIALOG_POPUP,
            UPSTREAM_DIALOG_POPUP_DEFAULT,
            DIALOG_MOBILE_SHEET_CLASS,
            maximised && BOARD_SHEET_MAXIMISED_CLASS,
            className,
          )}
          data-slot="dialog-popup"
          render={renderRetainedPopup}
          {...props}
        />
      </DialogPrimitive.Viewport>
    </DialogPortal>
  );
}

const BOARD_DIALOG_TITLE_LOOKS = {
  /** The New card dialog's heading. */
  create: "text-board-17/tight tracking-board-n1",
  /** A CI log's step name in the log dialog's header. */
  log: "truncate text-board-13 font-semibold",
  /** A heading led by a status icon. */
  "with-icon": "flex items-center gap-2",
} as const;

export function BoardDialogTitle({
  className,
  look,
  ...props
}: DialogPrimitive.Title.Props & { readonly look: keyof typeof BOARD_DIALOG_TITLE_LOOKS }) {
  return (
    <DialogPrimitive.Title
      className={cn(UPSTREAM_DIALOG_TITLE, BOARD_DIALOG_TITLE_LOOKS[look], className)}
      data-slot="dialog-title"
      {...props}
    />
  );
}

/** Upstream's dialog footer at the board's narrower inset, matching its dialog bodies. */
export function BoardDialogFooter({ className, ...props }: ComponentProps<"div">) {
  return (
    <div
      className={cn(UPSTREAM_DIALOG_FOOTER, UPSTREAM_DIALOG_FOOTER_DEFAULT, "px-5", className)}
      data-slot="dialog-footer"
      {...props}
    />
  );
}
