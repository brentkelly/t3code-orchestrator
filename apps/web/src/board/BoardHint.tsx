import type { ReactElement, ReactNode } from "react";

import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";

/**
 * A hover hint replacing the native `title` (upstream lints it). The child renders
 * as the trigger; a nullish or empty label renders the child alone.
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
