/**
 * T3o: the card's paused-step banner (T3O-23).
 *
 * A human pressed Stop on this card's step. Nothing is running, nothing is
 * waiting on an answer, and the board will not touch it again until somebody
 * says so — which is exactly the state the card face's neutral `Paused` chip
 * asserts, and this is where the human acts on it.
 *
 * Deliberately NOT the destructive `BoardCardStepFailure` treatment: a paused
 * step has not failed, has not stalled, and has spent no recovery budget.
 * Neutral surface, per `docs/t3o/status-colours.md` — no colour without a claim.
 *
 * The copy names the consequence of pressing Resume: the step re-enters the
 * queue and waits for an agent slot, so the `Queued` pill that follows
 * reads as expected rather than as the button having failed.
 */
import { PauseIcon, PlayIcon } from "lucide-react";

import { cn } from "../lib/utils";
import { Button } from "../components/ui/button";
import { boardStageLabelMidSentence } from "./boardCardThreadMenu";

export function BoardCardStepPaused(props: {
  /** The stage the paused step belongs to, for the sentence. */
  readonly stageLabel: string;
  /** Absent when the card cannot be resumed from here (no environment), which
      leaves the banner purely informational rather than offering a button that
      would do nothing. */
  readonly onResume: (() => void) | null;
  /** True while the resume command is in flight, so the button cannot be
      double-pressed into two requeues. */
  readonly resuming?: boolean;
  /** Spacing from the layout that owns it — the rail insets it, the stacked
      column lets its own gap do the work. */
  readonly className?: string;
}) {
  return (
    <div
      className={cn(
        "flex flex-col gap-2 rounded-md border border-border bg-muted px-2.5 py-2",
        props.className,
      )}
    >
      <div className="flex items-start gap-2">
        <PauseIcon aria-hidden="true" className="mt-px size-3.5 shrink-0 text-muted-foreground" />
        <div className="flex min-w-0 flex-col gap-1">
          <span className="text-[12px] font-medium text-foreground">
            {boardStageLabelMidSentence(props.stageLabel)} is paused
          </span>
          <span className="break-words text-[12px] leading-[1.5] text-muted-foreground">
            You stopped this, so nothing is running and the board is leaving it alone. Resuming puts
            it back in the queue — it carries on in the same thread as soon as an agent slot is
            free.
          </span>
        </div>
      </div>
      {props.onResume === null ? null : (
        <div className="flex justify-end">
          <Button
            size="xs"
            variant="outline"
            disabled={props.resuming === true}
            onClick={props.onResume}
          >
            <PlayIcon aria-hidden="true" className="size-3.5" />
            Resume
          </Button>
        </div>
      )}
    </div>
  );
}
