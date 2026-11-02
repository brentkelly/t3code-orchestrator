/**
 * The card's merge strategy override (T3O-80), opened from the card modal's
 * kebab menu or its header pill. Like `BoardCardModelsPopover` it renders no
 * trigger of its own: it has two doors, so the caller owns `open` and anchors
 * it. Picking an option applies at once; the default option sends null.
 */
import type { ReactNode } from "react";

import type { BoardMergeStrategy } from "@t3tools/contracts";

import { Popover, PopoverPopup } from "../components/ui/popover";
import { Radio, RadioGroup } from "../components/ui/radio-group";
import type { BoardCardMergeStrategyOption } from "./boardCardMergeStrategy";

const DEFAULT_VALUE = "default";

export function BoardCardMergeStrategyPopover({
  open,
  onOpenChange,
  anchor,
  options,
  value,
  onChange,
}: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly anchor: ReactNode;
  readonly options: ReadonlyArray<BoardCardMergeStrategyOption>;
  /** The card's own value; null when it follows the default. */
  readonly value: BoardMergeStrategy | null;
  readonly onChange: (next: BoardMergeStrategy | null) => void;
}) {
  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      {anchor}
      <PopoverPopup align="end" className="w-[328px] p-3">
        <span className="text-[12.5px] font-semibold text-foreground">Merge strategy</span>
        <p className="mt-1 text-[11.5px] leading-[1.5] text-muted-foreground">
          Applies to this card only.
        </p>
        <RadioGroup
          aria-label="Merge strategy for this card"
          className="mt-2.5 gap-0.5"
          onValueChange={(next) => {
            const picked = options.find((option) => (option.value ?? DEFAULT_VALUE) === next);
            if (picked !== undefined && picked.value !== value) onChange(picked.value);
          }}
          value={value ?? DEFAULT_VALUE}
        >
          {options.map((option) => {
            const optionValue = option.value ?? DEFAULT_VALUE;
            return (
              <label
                className="flex cursor-pointer items-start gap-2.5 rounded-lg px-2 py-[7px] hover:bg-accent has-data-checked:bg-accent"
                key={optionValue}
              >
                <Radio className="mt-px" value={optionValue} />
                <span className="flex min-w-0 flex-col gap-0.5">
                  <span className="text-[12px] font-medium text-foreground">{option.label}</span>
                  <span className="text-[11px] leading-[1.45] text-muted-foreground">
                    {option.note}
                  </span>
                </span>
              </label>
            );
          })}
        </RadioGroup>
      </PopoverPopup>
    </Popover>
  );
}
