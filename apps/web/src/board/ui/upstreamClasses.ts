/*
 * Class strings board/ui copies from upstream's components/ui primitives, written with board
 * tokens in place of upstream's arbitrary values. upstreamClasses.test.ts checks each against
 * upstream's source, so an upstream sync that restyles a primitive fails there.
 */

/** components/ui/input.tsx */
export const UPSTREAM_INPUT_CONTROL =
  "relative inline-flex w-full rounded-lg border border-input bg-background not-dark:bg-clip-padding text-base text-foreground shadow-xs/5 ring-ring/24 transition-shadow before:pointer-events-none before:absolute before:inset-0 before:rounded-board-inner-lg not-has-disabled:not-has-focus-visible:not-has-aria-invalid:before:shadow-board-control-top has-focus-visible:has-aria-invalid:border-destructive/64 has-focus-visible:has-aria-invalid:ring-destructive/16 has-aria-invalid:border-destructive/36 has-focus-visible:border-ring has-autofill:bg-foreground/4 has-disabled:opacity-64 has-[:disabled,:focus-visible,[aria-invalid]]:shadow-none has-focus-visible:ring-3 has-focus-visible:ring-inset sm:text-sm dark:bg-input/32 dark:has-autofill:bg-foreground/8 dark:has-aria-invalid:ring-destructive/24 dark:not-has-disabled:not-has-focus-visible:not-has-aria-invalid:before:shadow-board-control-top-dark";
export const UPSTREAM_INPUT_CONTROL_COMPACT = "rounded-md before:rounded-board-inner-md";
export const UPSTREAM_INPUT =
  "h-8.5 w-full min-w-0 rounded-[inherit] px-2.75 leading-8.5 outline-none placeholder:text-placeholder sm:h-7.5 sm:leading-7.5 transition-[background-color] duration-5000000000 ease-in-out";
export const UPSTREAM_INPUT_COMPACT = "h-7 px-2.25 text-xs leading-7 sm:h-7 sm:leading-7";
export const UPSTREAM_INPUT_SM = "h-7.5 px-2.25 leading-7.5 sm:h-6.5 sm:leading-6.5";
export const UPSTREAM_INPUT_SEARCH =
  "[&::-webkit-search-cancel-button]:appearance-none [&::-webkit-search-decoration]:appearance-none [&::-webkit-search-results-button]:appearance-none [&::-webkit-search-results-decoration]:appearance-none";

/** components/ui/textarea.tsx */
export const UPSTREAM_TEXTAREA_CONTROL =
  "relative inline-flex w-full rounded-lg border border-input bg-background not-dark:bg-clip-padding text-base text-foreground shadow-xs/5 ring-ring/24 transition-shadow before:pointer-events-none before:absolute before:inset-0 before:rounded-board-inner-lg has-focus-visible:has-aria-invalid:border-destructive/64 has-focus-visible:has-aria-invalid:ring-destructive/16 has-aria-invalid:border-destructive/36 has-focus-visible:border-ring has-disabled:opacity-64 has-[:disabled,:focus-visible,[aria-invalid]]:shadow-none has-focus-visible:ring-3 has-focus-visible:ring-inset not-has-disabled:has-not-focus-visible:not-has-aria-invalid:before:shadow-board-control-top sm:text-sm dark:bg-input/32 dark:has-aria-invalid:ring-destructive/24 dark:not-has-disabled:has-not-focus-visible:not-has-aria-invalid:before:shadow-board-control-top-dark";
export const UPSTREAM_TEXTAREA =
  "field-sizing-content max-h-64 w-full rounded-[inherit] px-2.75 py-1.25 outline-none wrap-anywhere";
export const UPSTREAM_TEXTAREA_MIN_HEIGHT = "min-h-17.5 max-sm:min-h-20.5";

/** components/ui/dialog.tsx */
export const UPSTREAM_DIALOG_VIEWPORT =
  "fixed inset-0 z-50 grid grid-rows-[1fr_auto_1fr] justify-items-center p-4";
export const UPSTREAM_DIALOG_VIEWPORT_MOBILE_SHEET =
  "max-sm:grid-rows-[1fr_auto] max-sm:p-0 max-sm:pt-12";
export const UPSTREAM_DIALOG_POPUP = "row-start-2 text-popover-foreground";
export const UPSTREAM_DIALOG_POPUP_DEFAULT = "max-h-full max-w-lg";
export const UPSTREAM_DIALOG_TITLE = "wrap-anywhere font-semibold text-xl leading-snug";
export const UPSTREAM_DIALOG_FOOTER =
  "flex flex-col-reverse gap-2 px-6 sm:flex-row sm:justify-end sm:rounded-b-board-inner-2xl";
export const UPSTREAM_DIALOG_FOOTER_DEFAULT = "border-t bg-muted/72 py-4";

/** components/ui/combobox.tsx */
export const UPSTREAM_COMBOBOX_INPUT_WRAPPER =
  "relative not-has-[>*.w-full]:w-fit w-full text-foreground has-disabled:opacity-64";
export const UPSTREAM_COMBOBOX_INPUT_SM =
  "has-[+[data-slot=combobox-trigger],+[data-slot=combobox-clear]]:*:data-[slot=combobox-input]:pe-6.5";
export const UPSTREAM_COMBOBOX_ITEM =
  "flex min-h-8 in-data-[side=none]:min-w-[calc(var(--anchor-width)+1.25rem)] cursor-pointer items-center rounded-sm px-2 py-1 text-base outline-none not-data-disabled:hover:bg-foreground/9 data-disabled:pointer-events-none data-disabled:cursor-not-allowed data-selected:text-foreground data-highlighted:bg-foreground/9 data-highlighted:text-accent-foreground [&[data-highlighted][data-selected]]:bg-foreground/9 [&[data-highlighted][data-selected]]:text-accent-foreground data-disabled:opacity-64 sm:min-h-7 sm:text-sm [&_svg:not([class*='size-'])]:size-4.5 sm:[&_svg:not([class*='size-'])]:size-4 [&_svg]:pointer-events-none [&_svg]:shrink-0";
export const UPSTREAM_COMBOBOX_ITEM_SELECTED_FILL = "data-selected:bg-foreground/6";
export const UPSTREAM_COMBOBOX_ITEM_CONTENT =
  "flex min-w-0 flex-1 items-center gap-2 [&_svg:not([class*='text-'])]:text-muted-foreground";
export const UPSTREAM_COMBOBOX_LIST = "size-full min-w-0 not-empty:px-1 not-empty:py-1";

/** components/ui/kbd.tsx */
export const UPSTREAM_KBD =
  "pointer-events-none inline-flex h-5 min-w-5 select-none items-center justify-center gap-1 rounded px-1 font-medium font-sans text-muted-foreground text-xs [&_svg:not([class*='size-'])]:size-3";

/** components/ui/popover.tsx */
export const UPSTREAM_POPOVER_POSITIONER =
  "h-(--positioner-height) max-h-(--available-height) w-(--positioner-width) max-w-(--available-width)";
export const UPSTREAM_POPOVER_POSITIONER_TRANSITION =
  "transition-transform data-instant:transition-none";
/** The popup's base classes, less the `before:` frame and calendar rounding a bare popup hides. */
export const UPSTREAM_POPOVER_POPUP =
  "relative flex h-(--popup-height,auto) w-(--popup-width,auto) origin-(--transform-origin) rounded-lg text-popover-foreground outline-none transition-[width,height,scale,opacity] data-ending-style:scale-98 data-starting-style:scale-98 data-ending-style:opacity-0 data-starting-style:opacity-0";
/** The viewport's base classes, less the calendar padding. */
export const UPSTREAM_POPOVER_VIEWPORT =
  "relative size-full max-h-(--available-height) overflow-clip px-(--viewport-inline-padding) data-instant:transition-none **:data-current:data-ending-style:opacity-0 **:data-current:data-starting-style:opacity-0 **:data-previous:data-ending-style:opacity-0 **:data-previous:data-starting-style:opacity-0 **:data-current:w-[calc(var(--popup-width)-2*var(--viewport-inline-padding)-2px)] **:data-previous:w-[calc(var(--popup-width)-2*var(--viewport-inline-padding)-2px)] **:data-current:opacity-100 **:data-previous:opacity-100 **:data-current:transition-opacity **:data-previous:transition-opacity";
export const UPSTREAM_POPOVER_VIEWPORT_PADDING_NONE =
  "rounded-board-inner-lg py-0 [--viewport-inline-padding:0px]";
export const UPSTREAM_POPOVER_VIEWPORT_OVERFLOW = "not-data-transitioning:overflow-y-auto";
