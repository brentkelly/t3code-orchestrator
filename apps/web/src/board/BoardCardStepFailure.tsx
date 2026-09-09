/**
 * T3o: the card's step-failure banner (t3o-30, D3).
 *
 * A stalled step is the board saying "nobody is working on this and nobody will
 * until you act" — but until now it said that only as a badge, with no reason
 * and nothing to press. The worst case was a step whose provider never started:
 * the card rendered a spinner for a thread that had already died, the error
 * lived inside a thread the card would not point at, and the only exit was to
 * archive the card.
 *
 * So this states the reason in the provider's own words and offers the one
 * action that clears it. Restart is the SAME command the `+` menu's restart item
 * dispatches (`board.card.start-stage-thread`), which supersedes the stalled
 * step server-side — there is no second recovery path to keep in step with it.
 *
 * T3O-22 splits its tone by whether anything is coming. A stall the board will
 * end by itself — a quota park waiting for its provider's window, a backoff rung
 * waiting for its time — is amber and says it is waiting; only a stall that has
 * stopped until a human acts keeps the red "stopped" treatment. Red on a card
 * counting down to its own resume was the loudest thing on screen saying the
 * opposite of the card's own chip.
 */
import { RotateCcwIcon, TriangleAlertIcon } from "lucide-react";

import { cn } from "../lib/utils";
import { Button } from "../components/ui/button";
import { boardStageLabelMidSentence } from "./boardCardThreadMenu";

export function BoardCardStepFailure(props: {
  /** The stage the stalled step belongs to, for the sentence. */
  readonly stageLabel: string;
  /** The provider's error text, or null for a stall with no recorded reason —
      recovery exhausting its budget, which the sentence covers instead. */
  readonly error: string | null;
  /** Whether the BOARD will start this step again by itself (T3O-22) —
      `boardStallIsWaiting` off the same shell field the card face's chip reads,
      so the board and the open modal cannot disagree about whether anything is
      coming. */
  readonly waiting: boolean;
  /** Absent when the card cannot be restarted from here (no environment, or a
      run somehow still in flight), which leaves the banner purely informational
      rather than offering a button that would do nothing. */
  readonly onRestart: (() => void) | null;
  /** Spacing from the layout that owns it — the rail insets it, the stacked
      column lets its own gap do the work. */
  readonly className?: string;
}) {
  const tone = props.waiting
    ? {
        frame: "border-amber-500/30 bg-amber-500/10",
        icon: "text-amber-600 dark:text-amber-400",
        heading: "text-amber-700 dark:text-amber-300",
        body: "text-amber-700/90 dark:text-amber-300/90",
      }
    : {
        frame: "border-destructive/30 bg-destructive/10",
        icon: "text-destructive",
        heading: "text-destructive-foreground",
        body: "text-destructive-foreground/90",
      };
  return (
    <div
      className={cn(
        "flex flex-col gap-2 rounded-md border px-2.5 py-2",
        tone.frame,
        props.className,
      )}
    >
      <div className="flex items-start gap-2">
        <TriangleAlertIcon
          aria-hidden="true"
          className={cn("mt-px size-3.5 shrink-0", tone.icon)}
        />
        <div className="flex min-w-0 flex-col gap-1">
          <span className={cn("text-[12px] font-medium", tone.heading)}>
            {boardStageLabelMidSentence(props.stageLabel)}{" "}
            {props.waiting ? "is waiting to resume" : "stopped"}
          </span>
          {/* `whitespace-pre-wrap` because the summary is two paragraphs when the
              provider gave a root cause — the message and what actually failed
              underneath it. `break-words` because provider errors carry paths and
              commands with no spaces to wrap at. */}
          <span
            className={cn("whitespace-pre-wrap break-words text-[12px] leading-[1.5]", tone.body)}
          >
            {props.error ??
              (props.waiting
                ? "Nothing is running right now. The board will start it again by itself."
                : "Recovery gave up after repeated attempts with no progress. Nothing is running.")}
          </span>
        </div>
      </div>
      {props.onRestart === null ? null : (
        <div className="flex justify-end">
          <Button size="xs" variant="outline" onClick={props.onRestart}>
            <RotateCcwIcon aria-hidden="true" className="size-3.5" />
            Restart {boardStageLabelMidSentence(props.stageLabel)}
          </Button>
        </div>
      )}
    </div>
  );
}
