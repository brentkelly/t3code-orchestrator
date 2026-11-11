import { RadioGroup as RadioGroupPrimitive } from "@base-ui/react/radio-group";

import { cn } from "~/lib/utils";

/** Upstream's radio group with its options set close together, as the board's option rows are. */
export function BoardRadioGroup({ className, ...props }: RadioGroupPrimitive.Props) {
  return (
    <RadioGroupPrimitive
      className={cn("flex flex-col gap-0.5", className)}
      data-slot="radio-group"
      {...props}
    />
  );
}
