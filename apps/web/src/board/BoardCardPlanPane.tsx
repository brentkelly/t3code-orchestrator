/**
 * The card modal's Plan pane (t3o-08): the planning stage's output, rendered
 * as markdown in the working surface where the thread and brief also live.
 *
 * Lazy, like the thread pane — it pulls in `ChatMarkdown` (highlighting,
 * tables, the lot), so the board chunk never pays for it until a card with a
 * plan is opened onto this pane.
 */
import type { BoardPlanWithBody } from "@t3tools/contracts";
import { ChevronLeftIcon } from "lucide-react";

import ChatMarkdown from "../components/ChatMarkdown";
import { BoardSectionHeading as SectionHeading } from "./BoardCardFields";

export function BoardCardPlanPane({
  plans,
  cardKey,
  onBackToThread,
}: {
  readonly plans: ReadonlyArray<BoardPlanWithBody>;
  readonly cardKey: string;
  readonly onBackToThread: () => void;
}) {
  // A card's plans are one ordered set; a single plan is the common case, so
  // it reads as one document rather than a titled section of one.
  const single = plans.length === 1;
  return (
    <section className="flex min-h-0 min-w-0 flex-col border-r border-border bg-muted/55">
      <div className="flex h-11 shrink-0 items-center gap-2 border-b border-border pl-3.5 pr-3">
        <SectionHeading>Implementation plan</SectionHeading>
        <span className="inline-flex h-[18px] shrink-0 items-center rounded-md bg-muted-foreground/14 px-[7px] text-[11px] font-medium text-foreground">
          {cardKey}
        </span>
        <span className="flex-1" />
        <button
          className="inline-flex h-6 shrink-0 items-center gap-1 rounded-[7px] border border-input bg-popover pl-1.5 pr-2.5 text-[11.5px] font-medium text-muted-foreground shadow-xs hover:bg-accent hover:text-foreground"
          onClick={onBackToThread}
          type="button"
        >
          <ChevronLeftIcon className="size-3" />
          Back to thread
        </button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-4.5 pt-4 pb-6">
        {plans.map((plan) => (
          <div key={plan.planId} className="mb-6 last:mb-0">
            {single ? null : (
              <h3 className="mb-2 text-[13.5px] font-semibold text-foreground">{plan.title}</h3>
            )}
            <ChatMarkdown cwd={undefined} text={plan.body} />
          </div>
        ))}
      </div>
    </section>
  );
}
