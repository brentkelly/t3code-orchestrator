/**
 * T3o modal todos strip (t3o-18, D5/D9) — the selected thread's full todo list,
 * sticky above its conversation.
 *
 * Unlike the CARD strip, this always shows what is stored: retention is a storage
 * rule and visibility is a render rule (D5), and inside the modal you are looking
 * AT the thread, so a finished `5/5` list is the answer to "did it get there",
 * not stale noise.
 *
 * Collapse state is React state keyed by thread id, lost on reload (D9). A
 * collapse preference has near-zero value across reloads, and persisted board UI
 * state has already caused a navigation bug in this codebase — where stale
 * `localStorage` routed Board clicks to a thread. Not worth re-entering that
 * surface for a chevron.
 *
 * Auto-expand: expanded while the thread is awaiting input, collapsed otherwise.
 * A MANUAL collapse sticks for that thread until the awaiting-input state clears
 * and returns.
 */
import type { BoardCardThreadShell, ThreadId } from "@t3tools/contracts";
import {
  BOARD_THREAD_TODO_STATUS_DONE,
  BOARD_THREAD_TODO_STATUS_IN_PROGRESS,
} from "@t3tools/contracts";
import { ChevronDownIcon, ChevronRightIcon } from "lucide-react";
import { useEffect, useState } from "react";

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
  useEffect(() => {
    setManual((current) =>
      current === null || (current.threadId === threadId && current.awaitingInput === awaitingInput)
        ? current
        : null,
    );
  }, [threadId, awaitingInput]);
  const expanded = manual?.expanded ?? awaitingInput;

  const total = todo?.todoTotal ?? 0;
  if (todo === undefined || total === 0) return null;
  const done = todo.todoDone ?? 0;
  const statuses = todo.todoStatuses ?? "";

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
        <span className="shrink-0 text-[11px] font-medium tabular-nums text-foreground">
          {done}/{total} todos
        </span>
        {todo.todoCurrent === undefined || expanded ? null : (
          <span className="min-w-0 flex-1 truncate text-[11px] text-muted-foreground">
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
                "flex items-center gap-1.5 text-[11.5px]",
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
                    ? "bg-emerald-500"
                    : statuses[index] === BOARD_THREAD_TODO_STATUS_IN_PROGRESS
                      ? "bg-info"
                      : "bg-muted-foreground/30",
                )}
              />
              {/* Only the in-progress item's TEXT rides the wire (D3: the strip
                  is a summary, not a copy of the list), so the rest render as
                  their status alone — the pip row above is the shape, and this
                  list is where the current item is named. */}
              <span className="min-w-0 flex-1 truncate">
                {statuses[index] === BOARD_THREAD_TODO_STATUS_IN_PROGRESS
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
