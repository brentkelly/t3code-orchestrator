/**
 * T3o board column card (t3o-05): the minimal shell — key pill, label chips,
 * state badges, title. The rich summary content (plans, review rounds,
 * attachments) is t3o-06's.
 *
 * State indicators are static state changes, never continuously repainting
 * animations (upstream AGENTS.md: loops peg the GPU on high-refresh
 * displays) — a running thread is a solid dot, not a spinner.
 */
import type { BoardCardShell, BoardLabel, BoardLabelId } from "@t3tools/contracts";
import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { CircleAlertIcon, LockIcon } from "lucide-react";

import { cn } from "../lib/utils";
import { boardCardSummary } from "./boardCardSummary";
import { BoardLabelChips } from "./BoardLabelChips";
import { BoardCardSummaryRow } from "./BoardCardSummaryRow";
import { projectAccent } from "./projectAccent";

export interface BoardCardQueueSlot {
  readonly position: number;
  readonly startsNext: boolean;
}

export function BoardCardContent({
  card,
  labelsById,
  queueSlot,
  selected,
  accentName,
}: {
  readonly card: BoardCardShell;
  readonly labelsById: ReadonlyMap<BoardLabelId, BoardLabel>;
  readonly queueSlot: BoardCardQueueSlot | undefined;
  readonly selected: boolean;
  /** Configured project accent (t3o-07); falls back to the hash colour. */
  readonly accentName?: string | null | undefined;
}) {
  const accent = projectAccent(card.projectId, accentName);
  const summary = boardCardSummary(card);
  return (
    <article
      className={cn(
        "flex cursor-pointer flex-col gap-1.5 rounded-lg border border-border bg-card p-3 shadow-xs/5 transition-colors hover:border-foreground/18",
        selected && "ring-2 ring-ring",
        // Done recedes: finished work is muted and lower-contrast (D15 stage).
        summary.muted && "bg-card/60 opacity-70",
      )}
      data-board-card={card.cardId}
      data-board-card-stage={card.stage}
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
        <BoardLabelChips labelIds={card.labelIds} labelsById={labelsById} />
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
      <div
        className={cn(
          "text-[13px]/[1.35] font-medium text-pretty",
          summary.muted ? "text-muted-foreground" : "text-foreground",
        )}
      >
        {card.title}
      </div>
      <BoardCardSummaryRow items={summary.items} />
    </article>
  );
}

export function SortableBoardCard({
  card,
  labelsById,
  queueSlot,
  selected,
  onSelect,
  accentName,
}: {
  readonly card: BoardCardShell;
  readonly labelsById: ReadonlyMap<BoardLabelId, BoardLabel>;
  readonly queueSlot: BoardCardQueueSlot | undefined;
  readonly selected: boolean;
  readonly onSelect: (card: BoardCardShell) => void;
  readonly accentName?: string | null | undefined;
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
      <BoardCardContent
        card={card}
        labelsById={labelsById}
        queueSlot={queueSlot}
        selected={selected}
        accentName={accentName}
      />
    </div>
  );
}
