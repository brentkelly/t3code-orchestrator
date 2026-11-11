import { RadioGroup as RadioGroupPrimitive } from "@base-ui/react/radio-group";

import { cn } from "~/lib/utils";
import { UPSTREAM_RADIO_GROUP } from "./upstreamClasses";

/** Upstream's radio group with its options set close together, as the board's option rows are. */
export function BoardRadioGroup({ className, ...props }: RadioGroupPrimitive.Props) {
  return (
    <RadioGroupPrimitive
      className={cn(UPSTREAM_RADIO_GROUP, "gap-0.5", className)}
      data-slot="radio-group"
      {...props}
    />
  );
}
