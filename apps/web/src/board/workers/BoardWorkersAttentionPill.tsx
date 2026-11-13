/**
 * The board header's worker indicator, shown only while a worker is offline
 * or needs an update, listing the cards each has paused. Amber: the cards
 * are held on something outside themselves.
 */
import type { BoardCardShell, BoardWorkersState } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { ServerOffIcon } from "lucide-react";
import { useState } from "react";

import { Button } from "../../components/ui/button";
import { Popover, PopoverTrigger } from "../../components/ui/popover";
import { boardWorkersAttention } from "./cardWorker";
import { BoardPopoverPopup } from "../ui/BoardPopoverPopup";

export function BoardWorkersAttentionPill(props: {
  readonly cards: ReadonlyArray<BoardCardShell>;
  readonly workers: BoardWorkersState;
  readonly onOpenCard: (cardId: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const navigate = useNavigate();
  const attention = boardWorkersAttention(props.cards, props.workers);
  if (attention === null) return null;

  return (
    <Popover onOpenChange={setOpen} open={open}>
      <PopoverTrigger
        aria-label={attention.label}

        type="button"
        render={
          <button
            className="inline-flex h-[26px] shrink-0 items-center gap-1.5 rounded-md bg-warning/12 px-2 text-board-12 font-medium text-warning-foreground transition-colors hover:bg-warning/20"
            type="button"
          />
        }
      >
        <ServerOffIcon className="size-3.5 shrink-0" />
        {attention.label}
      </PopoverTrigger>
      <BoardPopoverPopup align="end" className="w-[318px]" inset="3">
        <span className="text-board-12-5 font-semibold text-foreground">Workers</span>
        {attention.rows.map((row) => (
          <div className="mt-2 flex flex-col gap-1 border-t border-border pt-2" key={row.workerId}>
            <div className="flex items-center gap-2">
              <span className="text-board-12-5 font-medium text-foreground">{row.label}</span>
              <span className="flex-1" />
              <span className="text-board-11-5 text-warning-foreground">{row.status}</span>
            </div>
            <span className="text-board-11-5 text-muted-foreground">
              {row.pausedCards.length === 0
                ? "No cards are paused."
                : `${row.pausedCards.length} ${row.pausedCards.length === 1 ? "card" : "cards"} paused. They carry on ${row.resumesWhen}.`}
            </span>
            {row.pausedCards.map((card) => (
              <button
                className="flex min-w-0 items-center gap-2 rounded px-1 py-0.5 text-left text-board-12 hover:bg-muted"
                key={card.cardId}
                onClick={() => {
                  setOpen(false);
                  props.onOpenCard(card.cardId);
                }}
                type="button"
              >
                <span className="shrink-0 font-mono text-board-11 text-muted-foreground">
                  {card.key}
                </span>
                <span className="min-w-0 truncate">{card.title}</span>
              </button>
            ))}
          </div>
        ))}
        <div className="mt-2 flex border-t border-border pt-2">
          <Button
            onClick={() => {
              setOpen(false);
              void navigate({ to: "/settings/board/workers" });
            }}
            size="xs"
            variant="outline"
          >
            Open Workers settings
          </Button>
        </div>
      </BoardPopoverPopup>
    </Popover>
  );
}
