import { Field as FieldPrimitive } from "@base-ui/react/field";
import { Input as InputPrimitive } from "@base-ui/react/input";
import { mergeProps } from "@base-ui/react/merge-props";
import type * as React from "react";

import { cn } from "~/lib/utils";

/*
 * Board text fields, built the way upstream's `components/ui/input.tsx` and `textarea.tsx`
 * build theirs so they read as the same control, with the board's typography owned here.
 * The class strings mirror upstream's; an upstream sync that restyles its fields should carry
 * the change into these.
 */

const CONTROL_CLASS =
  "relative inline-flex w-full rounded-lg border border-input bg-background not-dark:bg-clip-padding text-base text-foreground shadow-xs/5 ring-ring/24 transition-shadow before:pointer-events-none before:absolute before:inset-0 before:rounded-board-inner-lg not-has-disabled:not-has-focus-visible:not-has-aria-invalid:before:shadow-board-control-top has-focus-visible:has-aria-invalid:border-destructive/64 has-focus-visible:has-aria-invalid:ring-destructive/16 has-aria-invalid:border-destructive/36 has-focus-visible:border-ring has-autofill:bg-foreground/4 has-disabled:opacity-64 has-[:disabled,:focus-visible,[aria-invalid]]:shadow-none has-focus-visible:ring-3 has-focus-visible:ring-inset sm:text-sm dark:bg-input/32 dark:has-autofill:bg-foreground/8 dark:has-aria-invalid:ring-destructive/24 dark:not-has-disabled:not-has-focus-visible:not-has-aria-invalid:before:shadow-board-control-top-dark";

const INPUT_CLASS =
  "h-8.5 w-full min-w-0 rounded-[inherit] px-2.75 leading-8.5 outline-none placeholder:text-placeholder sm:h-7.5 sm:leading-7.5 transition-[background-color] duration-5000000000 ease-in-out";
const INPUT_SIZE_CLASS = {
  default: "",
  compact: "h-7 px-2.25 text-xs leading-7 sm:h-7 sm:leading-7",
  sm: "h-7.5 px-2.25 leading-7.5 sm:h-6.5 sm:leading-6.5",
} as const;
const SEARCH_INPUT_CLASS =
  "[&::-webkit-search-cancel-button]:appearance-none [&::-webkit-search-decoration]:appearance-none [&::-webkit-search-results-button]:appearance-none [&::-webkit-search-results-decoration]:appearance-none";

/** The board's field looks, applied to the control the way upstream applies a className. */
const BOARD_INPUT_LOOKS = {
  /** The New card dialog's title field. */
  title: "text-board-13-5",
  /** A project's card-key prefix in Board settings. */
  "key-prefix": "font-mono text-board-13 uppercase",
  /** The search field at the top of the label picker. */
  "label-search": "rounded-lg text-board-12-5",
  /** The search field at the top of a board picker popover. */
  "picker-search": "text-sm",
  /** The board's filter box, borderless inside the top bar's own frame. */
  filter: "[&_input]:px-0 [&_input]:leading-6",
  /** A combobox's search row: the field sits on a hairline, not in a box. */
  "combobox-search":
    "has-disabled:opacity-100 rounded-none bg-transparent text-sm [&_input]:ps-5 [&_input]:font-sans [&_input]:leading-6.5",
} as const;

export type BoardInputLook = keyof typeof BOARD_INPUT_LOOKS;

type BoardInputProps = Omit<
  InputPrimitive.Props & React.RefAttributes<HTMLInputElement>,
  "size"
> & {
  readonly look: BoardInputLook;
  readonly size?: keyof typeof INPUT_SIZE_CLASS;
  readonly unstyled?: boolean;
  readonly nativeInput?: boolean;
};

export function BoardInput({
  className,
  look,
  size = "default",
  unstyled = false,
  nativeInput = false,
  ...props
}: BoardInputProps) {
  const inputClassName = cn(
    INPUT_CLASS,
    INPUT_SIZE_CLASS[size],
    props.type === "search" && SEARCH_INPUT_CLASS,
  );
  let inputElement: React.ReactElement;
  if (nativeInput) {
    const { style, onValueChange: _onValueChange, ...nativeInputProps } = props;
    inputElement = (
      <input
        className={inputClassName}
        data-slot="input"
        style={typeof style === "function" ? undefined : style}
        {...(nativeInputProps as React.ComponentProps<"input">)}
      />
    );
  } else {
    inputElement = <InputPrimitive className={inputClassName} data-slot="input" {...props} />;
  }
  return (
    <span
      className={
        cn(
          !unstyled && CONTROL_CLASS,
          !unstyled && size === "compact" && "rounded-md before:rounded-board-inner-md",
          BOARD_INPUT_LOOKS[look],
          className,
        ) || undefined
      }
      data-size={size}
      data-slot="input-control"
    >
      {inputElement}
    </span>
  );
}

const TEXTAREA_CONTROL_CLASS =
  "relative inline-flex w-full rounded-lg border border-input bg-background not-dark:bg-clip-padding text-base text-foreground shadow-xs/5 ring-ring/24 transition-shadow before:pointer-events-none before:absolute before:inset-0 before:rounded-board-inner-lg has-focus-visible:has-aria-invalid:border-destructive/64 has-focus-visible:has-aria-invalid:ring-destructive/16 has-aria-invalid:border-destructive/36 has-focus-visible:border-ring has-disabled:opacity-64 has-[:disabled,:focus-visible,[aria-invalid]]:shadow-none has-focus-visible:ring-3 has-focus-visible:ring-inset not-has-disabled:has-not-focus-visible:not-has-aria-invalid:before:shadow-board-control-top sm:text-sm dark:bg-input/32 dark:has-aria-invalid:ring-destructive/24 dark:not-has-disabled:has-not-focus-visible:not-has-aria-invalid:before:shadow-board-control-top-dark";

const BOARD_TEXTAREA_LOOKS = {
  /** A card brief being written: the board's reading size, borderless in its own frame. */
  brief: "text-board-13-5 leading-board-1-6",
  /** A pipeline stage's prompt, edited on the card-coloured page. */
  prompt:
    "[&_textarea]:bg-card [&_textarea]:px-3.5 [&_textarea]:py-3 [&_textarea]:text-board-13 [&_textarea]:leading-relaxed [&_textarea]:text-foreground",
  /** A project's prompt override, in code type. */
  code: "font-mono text-xs",
} as const;

export function BoardTextarea({
  className,
  look,
  unstyled = false,
  rows,
  ...props
}: React.ComponentProps<"textarea"> & {
  readonly look: keyof typeof BOARD_TEXTAREA_LOOKS;
  readonly unstyled?: boolean;
}) {
  return (
    <span
      className={
        cn(!unstyled && TEXTAREA_CONTROL_CLASS, BOARD_TEXTAREA_LOOKS[look], className) || undefined
      }
      data-size="default"
      data-slot="textarea-control"
    >
      <FieldPrimitive.Control
        render={(defaultProps) => (
          <textarea
            className={cn(
              "field-sizing-content max-h-64 w-full rounded-[inherit] px-2.75 py-1.25 outline-none wrap-anywhere",
              rows === undefined && "min-h-17.5 max-sm:min-h-20.5",
            )}
            style={
              rows === undefined
                ? undefined
                : { minHeight: `calc(${rows}lh + 2 * (var(--spacing) * 1.5 - 1px))` }
            }
            data-slot="textarea"
            rows={rows}
            {...mergeProps(defaultProps, props)}
          />
        )}
      />
    </span>
  );
}
