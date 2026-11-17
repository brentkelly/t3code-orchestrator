/**
 * T3o (prototype 4.1–4.3): card detail's Worker field. Any ready worker, or a pin;
 * each row gives the worker's load or why it can't be picked, and Set up when
 * it lacks a checkout. The create dialog uses `BoardWorkerPinButton` instead.
 */
import type { BoardWorkerId } from "@t3tools/contracts";
import { CheckIcon, ChevronDownIcon } from "lucide-react";
import { useState } from "react";

import { Popover, PopoverTrigger } from "../../components/ui/popover";
import { cn } from "../../lib/utils";
import { BoardHint } from "../BoardHint";
import type { BoardWorkerChoice } from "./cardWorker";
import { BoardPopoverPopup } from "../ui/BoardPopoverPopup";

export function BoardWorkerPicker(props: {
  readonly choices: ReadonlyArray<BoardWorkerChoice>;
  /** The pin, or null when any ready worker may take the card. */
  readonly pinnedWorkerId: BoardWorkerId | null;
  /** "Any ready worker". */
  readonly followLabel: string;
  /** The closed field's text and whether it reads as pinned. */
  readonly value: { readonly label: string; readonly pinned: boolean };
  readonly onSelect: (workerId: BoardWorkerId | null) => void;
  readonly onSetUp: (workerId: BoardWorkerId) => void;
  /** Where the popover opens; the side panel opens it upward. */
  readonly side?: "top" | "bottom";
  readonly className?: string;
}) {
  const [open, setOpen] = useState(false);
  const pick = (workerId: BoardWorkerId | null) => {
    setOpen(false);
    if (workerId !== props.pinnedWorkerId) props.onSelect(workerId);
  };
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        aria-label="Worker"
        render={
          <button
            className={cn(
              "inline-flex h-7 min-w-0 items-center gap-1.5 rounded-md border border-input bg-background px-2 text-left text-board-12-5 text-foreground hover:bg-accent",
              props.className,
            )}
            type="button"
          />
        }
      >
        <span className="min-w-0 flex-1 truncate">{props.value.label}</span>
        {props.value.pinned ? (
          <span className="shrink-0 text-board-11 text-muted-foreground">Pinned</span>
        ) : null}
        <ChevronDownIcon className="size-3 shrink-0 text-muted-foreground" />
      </PopoverTrigger>
      <BoardPopoverPopup
        align="start"
        className="w-72 flex-col"
        inset="1"
        side={props.side ?? "bottom"}
      >
        <BoardWorkerPinMenu
          choices={props.choices}
          followLabel={props.followLabel}
          onPick={pick}
          onSetUp={props.onSetUp}
          pinnedWorkerId={props.pinnedWorkerId}
        />
      </BoardPopoverPopup>
    </Popover>
  );
}

/**
 * The picker's rows: "Any ready worker", then Pin builds to each worker. Shared
 * by the Worker field and the create dialog's footer pin (prototype 5.7), which
 * leaves out Set up and heads the rows with `note`.
 */
export function BoardWorkerPinMenu(props: {
  readonly choices: ReadonlyArray<BoardWorkerChoice>;
  readonly pinnedWorkerId: BoardWorkerId | null;
  readonly followLabel: string;
  readonly onPick: (workerId: BoardWorkerId | null) => void;
  readonly onSetUp?: (workerId: BoardWorkerId) => void;
  readonly note?: string;
  /** The first row's sub-line, and the heading over the worker rows (T3O-117). */
  readonly followSub?: string;
  readonly sectionLabel?: string;
}) {
  return (
    <>
      {props.note === undefined ? null : (
        <p className="px-2 pt-1.5 pb-1 text-board-11 leading-board-1-45 text-muted-foreground">
          {props.note}
        </p>
      )}
      <button
        className="flex flex-col items-start rounded-md px-2 py-1.5 text-left hover:bg-accent"
        onClick={() => props.onPick(null)}
        type="button"
      >
        <span className="flex w-full items-center gap-1.5 text-board-12-5">
          <span className="min-w-0 flex-1 truncate">{props.followLabel}</span>
          {props.pinnedWorkerId === null ? (
            <CheckIcon className="size-3 shrink-0 text-muted-foreground" />
          ) : null}
        </span>
        <span className="text-board-11 text-muted-foreground">
          {props.followSub ?? "The board picks the best ready worker when the build starts"}
        </span>
      </button>
      <p className="px-2 pt-2 pb-1 text-board-11 font-medium text-muted-foreground">
        {props.sectionLabel ?? "Pin builds to"}
      </p>
      {props.choices.map((choice) => {
        const row = (
          <div
            className={cn(
              "flex h-7 items-center gap-1.5 rounded-md px-2 text-board-12-5",
              choice.selectable ? "cursor-pointer hover:bg-accent" : "text-muted-foreground",
            )}
            key={choice.workerId}
          >
            <button
              className="flex min-w-0 flex-1 items-center gap-1.5 text-left disabled:cursor-default"
              disabled={!choice.selectable}
              onClick={() => props.onPick(choice.workerId)}
              type="button"
            >
              <span className="min-w-0 flex-1 truncate">{choice.label}</span>
              {props.pinnedWorkerId === choice.workerId ? (
                <CheckIcon className="size-3 shrink-0 text-muted-foreground" />
              ) : null}
              <span className="shrink-0 text-board-11 text-muted-foreground">{choice.detail}</span>
            </button>
            {choice.canSetUp && props.onSetUp !== undefined ? (
              <button
                className="shrink-0 rounded px-1 text-board-11 font-medium text-foreground hover:bg-accent"
                onClick={() => props.onSetUp?.(choice.workerId)}
                type="button"
              >
                Set up on worker
              </button>
            ) : null}
          </div>
        );
        return choice.tooltip === null || choice.selectable ? (
          row
        ) : (
          <BoardHint key={choice.workerId} label={choice.tooltip} side="left">
            {row}
          </BoardHint>
        );
      })}
    </>
  );
}
