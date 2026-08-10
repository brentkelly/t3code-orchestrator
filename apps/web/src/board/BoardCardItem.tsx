/**
 * T3o board column card (t3o-05): the minimal shell — key pill, type chip,
 * state badges, title. The rich summary content (plans, review rounds,
 * attachments) is t3o-06's.
 *
 * State indicators are static state changes, never continuously repainting
 * animations (upstream AGENTS.md: loops peg the GPU on high-refresh
 * displays) — a running thread is a solid dot, not a spinner.
 */
import type { BoardCardShell } from "@t3tools/contracts";
import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { CircleAlertIcon, LockIcon } from "lucide-react";

import { cn } from "../lib/utils";
import { projectAccent } from "./projectAccent";

const TYPE_CHIP_CLASSES: Record<BoardCardShell["type"], string> = {
  feature: "bg-violet-500/12 text-violet-700 dark:text-violet-300",
  bug: "bg-red-500/12 text-red-700 dark:text-red-300",
  chore: "bg-amber-500/12 text-amber-700 dark:text-amber-300",
};

export interface BoardCardQueueSlot {
  readonly position: number;
  readonly startsNext: boolean;
}

export function BoardCardContent({
  card,
  queueSlot,
  selected,
}: {
  readonly card: BoardCardShell;
  readonly queueSlot: BoardCardQueueSlot | undefined;
  readonly selected: boolean;
}) {
  const accent = projectAccent(card.projectId);
  return (
    <article
      className={cn(
        "flex cursor-pointer flex-col gap-1.5 rounded-lg border border-border bg-card p-3 shadow-xs/5 transition-colors hover:border-foreground/18",
        selected && "ring-2 ring-ring",
      )}
      data-board-card={card.cardId}
    >
      <div className="flex items-center gap-1.5">
        <span
          className={cn(
            "inline-flex h-4 shrink-0 items-center rounded px-1.5 text-[10px] font-semibold tracking-wide",
            accent.pill,
          )}
        >
          {card.key}
        </span>
        <span
          className={cn(
            "inline-flex h-4 shrink-0 items-center rounded px-1.5 text-[10px] font-medium uppercase tracking-wide",
            TYPE_CHIP_CLASSES[card.type],
          )}
        >
          {card.type}
        </span>
        {card.threadState === "working" ? (
          <span className="size-2 shrink-0 rounded-full bg-emerald-500" title="Thread running" />
        ) : null}
        {card.awaitingInput ? (
          <span className="inline-flex shrink-0 items-center gap-0.5 text-[10.5px] font-medium text-info-foreground">
            <CircleAlertIcon className="size-3" />
            Input needed
          </span>
        ) : null}
        <span className="flex-1" />
        {queueSlot !== undefined ? (
          <span
            className="inline-flex shrink-0 items-center rounded bg-muted px-1.5 text-[10px] font-medium text-muted-foreground"
            title={
              queueSlot.startsNext
                ? "Queued — starts next"
                : `Queued — position ${queueSlot.position}`
            }
          >
            {queueSlot.startsNext ? "Next" : `Queued #${queueSlot.position}`}
          </span>
        ) : null}
        {card.blocked ? (
          <span
            className="inline-flex shrink-0 items-center gap-0.5 text-[10.5px] font-medium text-warning-foreground"
            title={`Blocked by ${card.dependencyCount} ${card.dependencyCount === 1 ? "dependency" : "dependencies"}`}
          >
            <LockIcon className="size-3" />
            Blocked
          </span>
        ) : null}
      </div>
      <div className="text-[13px]/[1.35] font-medium text-pretty text-foreground">{card.title}</div>
    </article>
  );
}

export function SortableBoardCard({
  card,
  queueSlot,
  selected,
  onSelect,
}: {
  readonly card: BoardCardShell;
  readonly queueSlot: BoardCardQueueSlot | undefined;
  readonly selected: boolean;
  readonly onSelect: (card: BoardCardShell) => void;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: card.cardId,
    data: { type: "card", stage: card.stage },
  });
  return (
    <div
      ref={setNodeRef}
      className={cn("pb-2", isDragging && "opacity-40")}
      style={{ transform: CSS.Translate.toString(transform), transition }}
      onClick={() => onSelect(card)}
      {...attributes}
      {...listeners}
    >
      <BoardCardContent card={card} queueSlot={queueSlot} selected={selected} />
    </div>
  );
}
