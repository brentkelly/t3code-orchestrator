/**
 * Card priority pieces: the icon, the option list (side panel and header popover) and the
 * segmented control (new card dialog). Copy lives in `boardCardPriority.ts`.
 */
import type { BoardCardPriority } from "@t3tools/contracts";
import { Toggle as TogglePrimitive } from "@base-ui/react/toggle";
import { ToggleGroup as ToggleGroupPrimitive } from "@base-ui/react/toggle-group";
import { CheckIcon, ChevronDownIcon } from "lucide-react";
import { useState } from "react";

import { Popover, PopoverTrigger } from "../components/ui/popover";
import { cn } from "../lib/utils";
import {
  BOARD_CARD_PRIORITIES,
  BOARD_CARD_PRIORITY_NAME,
  BOARD_CARD_PRIORITY_RULE,
} from "./boardCardPriority";
import { BoardPopoverPopup } from "./ui/BoardPopoverPopup";

const FILLED_BARS: Record<Exclude<BoardCardPriority, "urgent">, number> = {
  low: 1,
  normal: 2,
  high: 3,
};

/** Three rising bars, filled by level; Urgent is a red square with a "!". */
export function BoardCardPriorityIcon({
  priority,
  className,
}: {
  readonly priority: BoardCardPriority;
  readonly className?: string;
}) {
  const name = BOARD_CARD_PRIORITY_NAME[priority];
  if (priority === "urgent") {
    return (
      <span
        aria-label={`${name} priority`}
        className={cn(
          "inline-flex size-3.5 shrink-0 items-center justify-center rounded-sm bg-priority-urgent text-board-10 leading-none font-bold text-white",
          className,
        )}
        role="img"
      >
        !
      </span>
    );
  }
  const filled = FILLED_BARS[priority];
  return (
    <span
      aria-label={`${name} priority`}
      className={cn("inline-flex h-3 w-3.5 shrink-0 items-end gap-0.5", className)}
      role="img"
    >
      {[5, 8, 12].map((height, index) => (
        <i
          className={cn(
            "block w-0.75 rounded-xs",
            index >= filled
              ? "bg-foreground/18"
              : priority === "low"
                ? "bg-muted-foreground"
                : "bg-foreground",
          )}
          key={height}
          style={{ height }}
        />
      ))}
    </span>
  );
}

/** Each level with its rule and a tick on the selected one. Picking saves at once. */
function BoardCardPriorityOptions({
  value,
  onChange,
  showRules = true,
}: {
  readonly value: BoardCardPriority;
  readonly onChange: (next: BoardCardPriority) => void;
  readonly showRules?: boolean;
}) {
  return (
    <div aria-label="Priority" className="flex flex-col gap-0.5" role="radiogroup">
      {BOARD_CARD_PRIORITIES.map((priority) => {
        const selected = priority === value;
        return (
          <button
            aria-checked={selected}
            className={cn(
              "grid cursor-pointer grid-cols-[18px_minmax(0,1fr)_14px] items-start gap-x-2.25 gap-y-0.5 rounded-lg px-2 py-2 text-left hover:bg-accent",
              selected && "bg-accent",
            )}
            key={priority}
            onClick={() => {
              if (!selected) onChange(priority);
            }}
            role="radio"
            type="button"
          >
            <span className="pt-0.5">
              <BoardCardPriorityIcon priority={priority} />
            </span>
            <span className="text-board-12-5 font-medium text-foreground">
              {BOARD_CARD_PRIORITY_NAME[priority]}
            </span>
            <span>{selected ? <CheckIcon className="size-3.5 text-foreground" /> : null}</span>
            {showRules ? (
              <span className="col-start-2 text-board-11-5 leading-board-1-45 text-pretty text-muted-foreground">
                {BOARD_CARD_PRIORITY_RULE[priority]}
              </span>
            ) : null}
          </button>
        );
      })}
    </div>
  );
}

/**
 * Low → Urgent, left to right, so it reads like a slider. A board-owned look (outlined track,
 * filled selection), so it sits on the base-ui primitives rather than restyling `ToggleGroup`.
 */
export function BoardCardPrioritySegmented({
  value,
  onChange,
  className,
}: {
  readonly value: BoardCardPriority;
  readonly onChange: (next: BoardCardPriority) => void;
  readonly className?: string;
}) {
  return (
    <ToggleGroupPrimitive
      aria-label="Priority"
      className={cn("flex w-fit gap-1 rounded-board-9 border border-border p-0.75", className)}
      onValueChange={(next) => {
        const picked = BOARD_CARD_PRIORITIES.find((priority) => priority === next[0]);
        if (picked !== undefined) onChange(picked);
      }}
      value={[value]}
    >
      {BOARD_CARD_PRIORITIES.map((priority) => (
        <TogglePrimitive
          className="inline-flex h-7.5 flex-1 cursor-pointer items-center justify-center gap-1.5 rounded-board-7 px-3.5 text-board-12-5 font-medium whitespace-nowrap text-muted-foreground outline-none transition-colors hover:bg-accent/60 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset data-pressed:bg-accent data-pressed:text-foreground"
          key={priority}
          value={priority}
        >
          <BoardCardPriorityIcon priority={priority} />
          {BOARD_CARD_PRIORITY_NAME[priority]}
        </TogglePrimitive>
      ))}
    </ToggleGroupPrimitive>
  );
}

/**
 * The side panel's Priority row: label left, current level right, opening in place like
 * Automation and Stage. Picking a level saves straight away and collapses the row.
 */
export function BoardCardPrioritySection({
  value,
  onChange,
  startedNote,
  blocksHint,
}: {
  readonly value: BoardCardPriority;
  readonly onChange: (next: BoardCardPriority) => void;
  /** Shown above the options when the card already outranks waiting work. */
  readonly startedNote: string | null;
  /** "Blocks an Urgent card", under the row while it is collapsed too. */
  readonly blocksHint: string | null;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div className="flex flex-col gap-2">
      <button
        aria-expanded={open}
        className="flex w-full min-w-0 items-center gap-1.5 text-left"
        onClick={() => setOpen((current) => !current)}
        type="button"
      >
        <span className="shrink-0 text-board-11 font-semibold uppercase tracking-board-7 text-muted-foreground">
          Priority
        </span>
        <span className="flex-1" />
        <span className="flex min-w-0 items-center gap-1.5 truncate text-board-11 font-medium text-foreground">
          <BoardCardPriorityIcon priority={value} />
          {BOARD_CARD_PRIORITY_NAME[value]}
        </span>
        <ChevronDownIcon
          aria-hidden
          className={cn(
            "size-3 shrink-0 text-muted-foreground transition-transform duration-120",
            open && "rotate-180",
          )}
        />
      </button>
      {blocksHint === null ? null : (
        <span className="text-board-11-5 text-muted-foreground">{blocksHint}</span>
      )}
      {open ? (
        <>
          {startedNote === null ? null : (
            <p className="rounded-lg border border-border bg-muted px-2.5 py-2.25 text-board-11-5 leading-normal text-pretty text-muted-foreground">
              {startedNote}
            </p>
          )}
          <BoardCardPriorityOptions
            onChange={(next) => {
              onChange(next);
              setOpen(false);
            }}
            value={value}
          />
        </>
      ) : null}
    </div>
  );
}

/** The header chip, only when the card is not Normal; clicking it opens the option list. */
export function BoardCardPriorityChip({
  value,
  onChange,
}: {
  readonly value: BoardCardPriority;
  readonly onChange: (next: BoardCardPriority) => void;
}) {
  const [open, setOpen] = useState(false);
  if (value === "normal") return null;
  return (
    <Popover onOpenChange={setOpen} open={open}>
      <PopoverTrigger
        aria-label={`${BOARD_CARD_PRIORITY_NAME[value]} priority: change`}
        render={
          <button
            className={cn(
              "inline-flex h-[18px] shrink-0 items-center gap-1 rounded-md px-1.75 text-board-11 font-medium",
              value === "urgent"
                ? "bg-priority-urgent/12 text-priority-urgent-foreground hover:bg-priority-urgent/18"
                : "bg-muted-foreground/14 text-foreground hover:bg-muted-foreground/20",
            )}
            type="button"
          />
        }
      >
        <BoardCardPriorityIcon className="size-3" priority={value} />
        {BOARD_CARD_PRIORITY_NAME[value]}
      </PopoverTrigger>
      <BoardPopoverPopup align="start" className="w-[300px]" inset="1.5">
        <BoardCardPriorityOptions
          onChange={(next) => {
            onChange(next);
            setOpen(false);
          }}
          value={value}
        />
      </BoardPopoverPopup>
    </Popover>
  );
}
