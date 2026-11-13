import type { BoardGroupChildState } from "./boardGroups";

/** A group's pips in the fixed status vocabulary: green done, violet needs
    you, amber blocked or held by an offline worker, solid blue an agent on it, hatched blue queued for a
    slot, grey not started. Static: no pip animates. */
export const BOARD_GROUP_PIP_CLASS: Record<BoardGroupChildState, string> = {
  done: "bg-success",
  waiting: "bg-attention",
  blocked: "bg-warning",
  held: "bg-warning",
  running: "bg-info",
  queued:
    "bg-[image:repeating-linear-gradient(45deg,var(--info)_0_1.5px,color-mix(in_srgb,var(--info)_18%,transparent)_1.5px_4px)]",
  idle: "bg-foreground/13",
};
