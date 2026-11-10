/**
 * The step-failure banner states why a step stalled in the provider's own words.
 * A stall the board will end by itself (quota park, backoff) is amber and says it
 * is waiting; only one stopped until a human acts is red.
 */
import { TriangleAlertIcon } from "lucide-react";

import { cn } from "../lib/utils";
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
    </div>
  );
}
