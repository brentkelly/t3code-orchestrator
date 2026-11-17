/**
 * T3o: where a t3o.json schedule runs (T3O-117) — the New card dialog's
 * worker pin menu, with Don't schedule / Not scheduled first and the board
 * server ("This server", tagged Board). Child B lists workers beside it.
 */
import type { EnvironmentId } from "@t3tools/contracts";
import { ChevronDownIcon, ServerIcon } from "lucide-react";
import { useState } from "react";

import { Popover, PopoverTrigger } from "../../components/ui/popover";
import { cn } from "../../lib/utils";
import { BoardPopoverPopup } from "../ui/BoardPopoverPopup";
import { BoardWorkerPinMenu } from "../workers/BoardWorkerPicker";
import type { BoardWorkerChoice } from "../workers/cardWorker";

export function BoardScheduleMachinePicker(props: {
  readonly value: EnvironmentId | null;
  readonly serverEnvironmentId: EnvironmentId;
  /** "Don't schedule" in the import dialog, "Not scheduled" on the Schedules tab. */
  readonly noneLabel: string;
  readonly noneSub: string;
  readonly note: string;
  readonly onSelect: (environmentId: EnvironmentId | null) => void;
  readonly disabled?: boolean;
  /** Amber border: the chosen machine can't run it now. */
  readonly warning?: boolean;
  readonly className?: string;
}) {
  const [open, setOpen] = useState(false);
  const choices: ReadonlyArray<BoardWorkerChoice> = [
    {
      workerId: props.serverEnvironmentId,
      label: "This server",
      detail: "Board",
      selectable: true,
      tooltip: null,
      canSetUp: false,
      cloning: false,
    },
  ];
  const label =
    props.value === null
      ? null
      : props.value === props.serverEnvironmentId
        ? "This server"
        : props.value;
  const pick = (workerId: string | null) => {
    setOpen(false);
    const next = workerId as EnvironmentId | null;
    if (next !== props.value) props.onSelect(next);
  };
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        aria-label={label === null ? props.noneLabel : `Runs on ${label}. Change machine`}
        disabled={props.disabled}
        render={
          <button
            className={cn(
              "inline-flex h-7 min-w-0 items-center gap-1.5 rounded-md border px-2 text-left text-board-12-5 disabled:cursor-default disabled:opacity-60",
              label === null
                ? "border-dashed border-input text-muted-foreground hover:bg-accent"
                : "border-input bg-background text-foreground hover:bg-accent",
              props.warning === true && "border-warning-foreground/60",
              props.className,
            )}
            type="button"
          />
        }
      >
        {label === null ? null : <ServerIcon className="size-3 shrink-0 text-muted-foreground" />}
        <span className="min-w-0 flex-1 truncate">{label ?? props.noneLabel}</span>
        <ChevronDownIcon className="size-3 shrink-0 text-muted-foreground" />
      </PopoverTrigger>
      <BoardPopoverPopup align="start" className="w-72 max-w-[calc(100vw-2rem)] flex-col" inset="1">
        <BoardWorkerPinMenu
          choices={choices}
          followLabel={props.noneLabel}
          followSub={props.noneSub}
          note={props.note}
          onPick={pick}
          pinnedWorkerId={props.value}
          sectionLabel="Run on"
        />
      </BoardPopoverPopup>
    </Popover>
  );
}
