/**
 * The selected thread's full todo list, sticky above its conversation. Collapse is
 * React state, not persisted. Expanded while awaiting input; a manual collapse
 * sticks until the awaiting-input state changes.
 */
import type { BoardCardThreadShell, ThreadId } from "@t3tools/contracts";
import {
  BOARD_THREAD_TODO_STATUS_DONE,
  BOARD_THREAD_TODO_STATUS_IN_PROGRESS,
} from "@t3tools/contracts";
import { ChevronDownIcon, ChevronRightIcon } from "lucide-react";
import { useState } from "react";

import { cn } from "../lib/utils";
import { BoardTodoPips } from "./BoardCardSummaryRow";

export function BoardCardThreadTodosStrip({
  threadId,
  todo,
  awaitingInput,
}: {
  readonly threadId: ThreadId;
  readonly todo: BoardCardThreadShell | undefined;
  readonly awaitingInput: boolean;
}) {
  const [manual, setManual] = useState<{
    readonly threadId: ThreadId;
    readonly awaitingInput: boolean;
    readonly expanded: boolean;
  } | null>(null);
  // Switching thread, or the awaiting-input state changing, drops the manual
  // override — which is exactly "a manual collapse sticks until the
  // awaiting-input state clears and returns".
  if (manual !== null && (manual.threadId !== threadId || manual.awaitingInput !== awaitingInput)) {
    setManual(null);
  }
  const expanded = manual?.expanded ?? awaitingInput;

  const total = todo?.todoTotal ?? 0;
  if (todo === undefined || total === 0) return null;
  const done = todo.todoDone ?? 0;
  const statuses = todo.todoStatuses ?? "";
  // Only the FIRST in-progress item's text rides the wire (`boardThreadTodoSummary`
  // captures `currentText` from the first `inProgress` item); a rare second
  // in-progress item is not that text, so it renders generically rather than
  // duplicating the first one's name.
  const currentIndex = statuses.indexOf(BOARD_THREAD_TODO_STATUS_IN_PROGRESS);

  return (
    <div className="shrink-0 border-b border-border bg-card/60 px-3 py-2">
      <button
        className="flex w-full min-w-0 items-center gap-1.5 text-left"
        onClick={() => setManual({ threadId, awaitingInput, expanded: !expanded })}
        type="button"
      >
        {expanded ? (
          <ChevronDownIcon className="size-3 shrink-0 text-muted-foreground" />
        ) : (
          <ChevronRightIcon className="size-3 shrink-0 text-muted-foreground" />
        )}
        <span className="shrink-0 text-board-11 font-medium tabular-nums text-foreground">
          {done}/{total} todos
        </span>
        {todo.todoCurrent === undefined || expanded ? null : (
          <span className="min-w-0 flex-1 truncate text-board-11 text-muted-foreground">
            {todo.todoCurrent}
          </span>
        )}
        <span className="min-w-8 flex-1" />
        <span className="w-24 shrink-0">
          <BoardTodoPips done={done} statuses={statuses} total={total} />
        </span>
      </button>
      {!expanded ? null : (
        <ol className="mt-1.5 flex flex-col gap-0.5">
          {/* Indexed, like the pip row: only the in-progress item's text rides
              the wire, so position is the only identity an item has here. */}
          {Array.from({ length: statuses.length }, (_, index) => (
            <li
              className={cn(
                "flex items-center gap-1.5 text-board-11-5",
                statuses[index] === BOARD_THREAD_TODO_STATUS_DONE
                  ? "text-muted-foreground line-through"
                  : statuses[index] === BOARD_THREAD_TODO_STATUS_IN_PROGRESS
                    ? "text-foreground"
                    : "text-muted-foreground",
              )}
              key={index}
            >
              <span
                className={cn(
                  "size-1.5 shrink-0 rounded-full",
                  statuses[index] === BOARD_THREAD_TODO_STATUS_DONE
                    ? "bg-success"
                    : statuses[index] === BOARD_THREAD_TODO_STATUS_IN_PROGRESS
                      ? "bg-info"
                      : "bg-muted-foreground/30",
                )}
              />
              {/* Only the current item's text is on the wire; the rest render by position. */}
              <span className="min-w-0 flex-1 truncate">
                {index === currentIndex
                  ? (todo.todoCurrent ?? `Item ${index + 1}`)
                  : `Item ${index + 1}`}
              </span>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}
