/**
 * T3o (T3O-65, prototype 4.1–4.3): the Worker field's picker — "Follow default
 * — {worker}", or Pin to a worker. Each row says the worker's load, or why it
 * can't be picked, and a worker with no checkout of the project offers Set up
 * on worker inline. Shared by the create dialog and the card's details column.
 */
import type { BoardWorkerId } from "@t3tools/contracts";
import { CheckIcon, ChevronDownIcon } from "lucide-react";
import { useState } from "react";

import { Popover, PopoverPopup, PopoverTrigger } from "../../components/ui/popover";
import { cn } from "../../lib/utils";
import { BoardHint } from "../BoardHint";
import type { BoardWorkerChoice } from "./cardWorker";

export function BoardWorkerPicker(props: {
  readonly choices: ReadonlyArray<BoardWorkerChoice>;
  /** The pin, or null when the card follows the default. */
  readonly pinnedWorkerId: BoardWorkerId | null;
  /** "Follow default — This server". */
  readonly followLabel: string;
  /** The closed field's text and whether it reads as pinned. */
  readonly value: { readonly label: string; readonly pinned: boolean };
  readonly onSelect: (workerId: BoardWorkerId | null) => void;
  readonly onSetUp: (workerId: BoardWorkerId) => void;
  /** Where the popover opens: down in the create dialog, up in the side panel. */
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
        className={cn(
          "inline-flex h-7 min-w-0 items-center gap-1.5 rounded-md border border-input bg-background px-2 text-left text-[12.5px] text-foreground hover:bg-accent",
          props.className,
        )}
        render={<button type="button" />}
      >
        <span className="min-w-0 flex-1 truncate">{props.value.label}</span>
        {props.value.pinned ? (
          <span className="shrink-0 text-[11px] text-muted-foreground">Pinned</span>
        ) : null}
        <ChevronDownIcon className="size-3 shrink-0 text-muted-foreground" />
      </PopoverTrigger>
      <PopoverPopup align="start" className="w-72 flex-col p-1" side={props.side ?? "bottom"}>
        <button
          className="flex flex-col items-start rounded-md px-2 py-1.5 text-left hover:bg-accent"
          onClick={() => pick(null)}
          type="button"
        >
          <span className="flex w-full items-center gap-1.5 text-[12.5px]">
            <span className="min-w-0 flex-1 truncate">{props.followLabel}</span>
            {props.pinnedWorkerId === null ? (
              <CheckIcon className="size-3 shrink-0 text-muted-foreground" />
            ) : null}
          </span>
          <span className="text-[11px] text-muted-foreground">
            Moves with the default until the card has a worktree
          </span>
        </button>
        <p className="px-2 pt-2 pb-1 text-[11px] font-medium text-muted-foreground">Pin to</p>
        {props.choices.map((choice) => {
          const row = (
            <div
              className={cn(
                "flex h-7 items-center gap-1.5 rounded-md px-2 text-[12.5px]",
                choice.selectable ? "cursor-pointer hover:bg-accent" : "text-muted-foreground",
              )}
              key={choice.workerId}
            >
              <button
                className="flex min-w-0 flex-1 items-center gap-1.5 text-left disabled:cursor-default"
                disabled={!choice.selectable}
                onClick={() => pick(choice.workerId)}
                type="button"
              >
                <span className="min-w-0 flex-1 truncate">{choice.label}</span>
                {props.pinnedWorkerId === choice.workerId ? (
                  <CheckIcon className="size-3 shrink-0 text-muted-foreground" />
                ) : null}
                <span className="shrink-0 text-[11px] text-muted-foreground">{choice.detail}</span>
              </button>
              {choice.canSetUp ? (
                <button
                  className="shrink-0 rounded px-1 text-[11px] font-medium text-foreground hover:bg-accent"
                  onClick={() => props.onSetUp(choice.workerId)}
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
      </PopoverPopup>
    </Popover>
  );
}
