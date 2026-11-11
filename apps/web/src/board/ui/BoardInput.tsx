import { Field as FieldPrimitive } from "@base-ui/react/field";
import { Input as InputPrimitive } from "@base-ui/react/input";
import { mergeProps } from "@base-ui/react/merge-props";
import type * as React from "react";

import { cn } from "~/lib/utils";
import {
  UPSTREAM_INPUT,
  UPSTREAM_INPUT_COMPACT,
  UPSTREAM_INPUT_CONTROL,
  UPSTREAM_INPUT_CONTROL_COMPACT,
  UPSTREAM_INPUT_SEARCH,
  UPSTREAM_INPUT_SM,
  UPSTREAM_TEXTAREA,
  UPSTREAM_TEXTAREA_CONTROL,
  UPSTREAM_TEXTAREA_MIN_HEIGHT,
} from "./upstreamClasses";

/*
 * Board text fields, built the way upstream's `components/ui/input.tsx` and `textarea.tsx`
 * build theirs so they read as the same control, with the board's typography owned here.
 * Their upstream classes live in upstreamClasses.ts, checked against upstream's source.
 */

const INPUT_SIZE_CLASS = {
  default: "",
  compact: UPSTREAM_INPUT_COMPACT,
  sm: UPSTREAM_INPUT_SM,
} as const;

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
    UPSTREAM_INPUT,
    INPUT_SIZE_CLASS[size],
    props.type === "search" && UPSTREAM_INPUT_SEARCH,
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
          !unstyled && UPSTREAM_INPUT_CONTROL,
          !unstyled && size === "compact" && UPSTREAM_INPUT_CONTROL_COMPACT,
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
        cn(!unstyled && UPSTREAM_TEXTAREA_CONTROL, BOARD_TEXTAREA_LOOKS[look], className) ||
        undefined
      }
      data-size="default"
      data-slot="textarea-control"
    >
      <FieldPrimitive.Control
        render={(defaultProps) => (
          <textarea
            className={cn(UPSTREAM_TEXTAREA, rows === undefined && UPSTREAM_TEXTAREA_MIN_HEIGHT)}
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
