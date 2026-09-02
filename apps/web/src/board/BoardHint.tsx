import type { ReactElement, ReactNode } from "react";

import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";

/**
 * A hover hint on one element — the board's replacement for the native `title`
 * attribute, which upstream lints against (`no-native-title-tooltip`) because
 * it renders unstyled and late. The child renders AS the trigger (its props
 * are merged into it), so nothing about the layout changes. A nullish or empty
 * label renders the child alone, which keeps the conditional call sites simple.
 */
export function BoardHint(props: {
  readonly label: ReactNode | null | undefined;
  readonly side?: "top" | "bottom" | "left" | "right";
  readonly children: ReactElement;
}) {
  if (props.label === null || props.label === undefined || props.label === "") {
    return props.children;
  }
  return (
    <Tooltip>
      <TooltipTrigger render={props.children} />
      <TooltipPopup side={props.side ?? "top"}>{props.label}</TooltipPopup>
    </Tooltip>
  );
}
