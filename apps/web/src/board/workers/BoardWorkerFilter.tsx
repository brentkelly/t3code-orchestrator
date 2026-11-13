/**
 * T3o: the board header's Worker button and its multi-select (T3O-87), and the strip saying how
 * many cards the filter shows. Offline workers sort to the bottom; "Not placed yet" is last.
 */
import { BOARD_LOCAL_WORKER_ID, type BoardWorkersState } from "@t3tools/contracts";
import { CheckIcon, ServerIcon } from "lucide-react";
import { useState } from "react";

import { Popover, PopoverTrigger } from "../../components/ui/popover";
import { cn } from "../../lib/utils";
import { BoardPopoverPopup } from "../ui/BoardPopoverPopup";
import { BOARD_UNPLACED_FILTER, boardWorkerFilterLabel } from "./boardWorkerFilter";
import { boardWorkerLabel } from "./cardWorker";

export function BoardWorkerFilterButton(props: {
  readonly state: BoardWorkersState;
  readonly selection: ReadonlyArray<string>;
  /** Cards per placement target, and under "unplaced". */
  readonly counts: ReadonlyMap<string, number>;
  readonly onChange: (selection: ReadonlyArray<string>) => void;
}) {
  const [open, setOpen] = useState(false);
  const rows = [
    { id: BOARD_LOCAL_WORKER_ID, online: true },
    ...props.state.workers.map((worker) => ({
      id: worker.id as string,
      online: worker.status.state === "online",
    })),
  ].toSorted((left, right) => Number(right.online) - Number(left.online));
  const toggle = (id: string) =>
    props.onChange(
      props.selection.includes(id)
        ? props.selection.filter((entry) => entry !== id)
        : [...props.selection, id],
    );
  const row = (id: string, label: string, detail: string) => (
    <button
      key={id}
      className="flex items-center gap-2 rounded-md px-2 py-1.5 text-left text-board-12-5 hover:bg-accent"
      onClick={() => toggle(id)}
      type="button"
    >
      <span className="flex size-3.5 shrink-0 items-center justify-center">
        {props.selection.includes(id) ? <CheckIcon className="size-3" /> : null}
      </span>
      <span className="min-w-0 flex-1 truncate">{label}</span>
      <span className="shrink-0 text-board-11 text-muted-foreground">{detail}</span>
    </button>
  );
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        aria-label="Filter by worker"
        render={
          <button
            className={cn(
              "inline-flex h-7 shrink-0 items-center gap-1 rounded-lg border border-input bg-popover px-2 text-board-12 shadow-xs/5 sm:h-6.5 dark:bg-input/32",
              props.selection.length > 0 && "border-ring",
            )}
            type="button"
          />
        }
      >
        <ServerIcon aria-hidden="true" className="size-3.5 shrink-0 text-muted-foreground" />
        <span className="max-w-32 truncate">
          {boardWorkerFilterLabel(props.selection, props.state)}
        </span>
      </PopoverTrigger>
      <BoardPopoverPopup align="end" className="w-64 flex-col" inset="1" side="bottom">
        {rows.map((entry) =>
          row(
            entry.id,
            boardWorkerLabel(entry.id as never, props.state),
            `${entry.online ? "" : "offline · "}${props.counts.get(entry.id) ?? 0}`,
          ),
        )}
        {row(
          BOARD_UNPLACED_FILTER,
          "Not placed yet",
          String(props.counts.get(BOARD_UNPLACED_FILTER) ?? 0),
        )}
      </BoardPopoverPopup>
    </Popover>
  );
}

/** "Showing 8 of 16 cards · SRV, B1 · Clear filter". */
export function BoardWorkerFilterStrip(props: {
  readonly shown: number;
  readonly total: number;
  readonly label: string;
  readonly onClear: () => void;
}) {
  return (
    <div className="flex shrink-0 items-center gap-1.5 px-3 pb-1 text-board-12 text-muted-foreground sm:px-5">
      <span>
        Showing {props.shown} of {props.total} cards · {props.label}
      </span>
      <span>·</span>
      <button className="underline underline-offset-2" onClick={props.onClear} type="button">
        Clear filter
      </button>
    </div>
  );
}
