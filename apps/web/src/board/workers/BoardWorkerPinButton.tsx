/**
 * T3o (prototype 5.6–5.8): the create dialog's worker pin, tucked into the
 * footer beside the schedule clock. A bare pin icon until pinned, then a
 * "Pinned to {worker}" chip with × to unpin. Pinning at creation is rare, so it
 * takes no row in the form.
 */
import { BOARD_LOCAL_WORKER_ID, type BoardWorkerId } from "@t3tools/contracts";
import { PinIcon, XIcon } from "lucide-react";
import { useState } from "react";

import { Popover, PopoverTrigger } from "../../components/ui/popover";
import { BoardPopoverPopup } from "../ui/BoardPopoverPopup";
import { BoardWorkerPinMenu } from "./BoardWorkerPicker";
import { BOARD_ANY_READY_WORKER_LABEL, boardWorkerLabel } from "./cardWorker";
import type { BoardWorkerChoices } from "./useBoardWorkerChoices";

export function BoardWorkerPinButton(props: {
  readonly field: BoardWorkerChoices;
  readonly pinnedWorkerId: BoardWorkerId | null;
  readonly onSelect: (workerId: BoardWorkerId | null) => void;
}) {
  const [open, setOpen] = useState(false);
  const { field, pinnedWorkerId } = props;
  const pick = (workerId: BoardWorkerId | null) => {
    setOpen(false);
    if (workerId !== pinnedWorkerId) props.onSelect(workerId);
  };
  const pinnedLabel =
    pinnedWorkerId === null ? null : boardWorkerLabel(pinnedWorkerId, field.workers);
  const tip = "Builds go to any ready worker. Pin to a worker…";

  return (
    <Popover open={open} onOpenChange={setOpen}>
      {pinnedLabel === null ? (
        <PopoverTrigger
          aria-label={tip}
          title={tip}
          render={
            <button
              className="inline-flex h-[26px] shrink-0 items-center rounded-md px-1.5 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground data-[popup-open]:bg-accent data-[popup-open]:text-foreground"
              type="button"
            />
          }
        >
          <PinIcon className="size-3 shrink-0" />
        </PopoverTrigger>
      ) : (
        <span className="inline-flex h-[26px] min-w-0 shrink items-center rounded-md border border-input bg-background text-board-11-5 font-medium text-foreground">
          <PopoverTrigger
            aria-label={`Pinned to ${pinnedLabel}. Change the pin`}
            render={
              <button
                className="inline-flex h-full min-w-0 items-center gap-1.5 rounded-l-md pr-1 pl-2 hover:bg-accent"
                type="button"
              />
            }
          >
            <PinIcon className="size-3 shrink-0 text-muted-foreground" />
            <span className="whitespace-nowrap">Pinned to</span>
            <span className="min-w-0 truncate font-mono">{pinnedLabel}</span>
          </PopoverTrigger>
          <button
            aria-label="Unpin"
            className="inline-flex size-5 shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-accent hover:text-foreground"
            onClick={() => props.onSelect(null)}
            type="button"
          >
            <XIcon className="size-3" />
          </button>
        </span>
      )}
      <BoardPopoverPopup align="start" className="w-72 flex-col" inset="1" side="top">
        <BoardWorkerPinMenu
          choices={field.choices}
          followLabel={BOARD_ANY_READY_WORKER_LABEL}
          note={`Pin builds to a worker. Planning always runs on ${boardWorkerLabel(BOARD_LOCAL_WORKER_ID, field.workers)}.`}
          onPick={pick}
          pinnedWorkerId={pinnedWorkerId}
        />
      </BoardPopoverPopup>
    </Popover>
  );
}
