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
import { CircleAlertIcon, LockIcon } from "lucide-react";
import type { DragEvent } from "react";

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
        // `transition-colors` alone could not animate the lift — box-shadow is
        // not a colour property, so the hover shadow snapped in. Transition
        // both, and use the prototype's lifted shadow.
        // `dark:bg-[#1c1c20]` lifts the card above the column beneath it. The
        // stock `--card` in dark is ~3% off the page background, which landed
        // BELOW the column's fill and left cards darker than the board.
        "flex cursor-pointer flex-col gap-1.5 rounded-[10px] border border-border bg-card px-[11px] py-2.5 shadow-xs/5 transition-[color,background-color,border-color,box-shadow] duration-[120ms] ease-[ease] dark:bg-[#1c1c20] hover:border-foreground/18 hover:shadow-[0_4px_14px_-8px_rgb(0_0_0/0.35)]",
        // Selection darkens the card's own border rather than adding a ring:
        // `ring-2 ring-ring` painted the accent blue outside the card and read
        // as a focus ring on click. Blue on a board card means "needs input",
        // and selection is already unmistakable — the detail pane opens.
        selected && "border-foreground/40",
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
      {/* Labels sit on their own row beneath the key, so a multi-label card
          reads as a stack of tags and never crowds the status badges. */}
      {card.labelIds.length > 0 ? (
        <div className="flex flex-wrap items-center gap-1.5">
          <BoardLabelChips labelIds={card.labelIds} labelsById={labelsById} />
        </div>
      ) : null}
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

/**
 * A board card wired for native HTML5 drag-and-drop (the prototype's model).
 * dnd-kit's sortable transforms fought `@legendapp/list`'s absolute
 * positioning — cards vanished mid-drag and no gap opened — so ordering uses
 * the platform drag with a rotated ghost clone (built by the page) and a
 * measured placeholder gap. `dragging` dims the source in place while its
 * clone is what the cursor carries.
 */
export function DraggableBoardCard({
  card,
  labelsById,
  queueSlot,
  selected,
  dragging,
  onSelect,
  onDragStart,
  onDragEnd,
  accentName,
}: {
  readonly card: BoardCardShell;
  readonly labelsById: ReadonlyMap<BoardLabelId, BoardLabel>;
  readonly queueSlot: BoardCardQueueSlot | undefined;
  readonly selected: boolean;
  readonly dragging: boolean;
  readonly onSelect: (card: BoardCardShell) => void;
  readonly onDragStart: (card: BoardCardShell, event: DragEvent<HTMLDivElement>) => void;
  readonly onDragEnd: () => void;
  readonly accentName?: string | null | undefined;
}) {
  return (
    <div
      draggable
      className={cn("cursor-grab", dragging && "opacity-40")}
      onClick={() => onSelect(card)}
      onDragStart={(event) => onDragStart(card, event)}
      onDragEnd={onDragEnd}
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
