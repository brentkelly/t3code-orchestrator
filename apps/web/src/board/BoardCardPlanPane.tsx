/**
 * The card modal's Plan pane (t3o-08): the planning stage's output, rendered
 * as markdown in the working surface where the thread and brief also live.
 *
 * The approve gate lives here too (t3o-23, D1): a multi-plan card offers
 * **Approve split**, which materialises each plan as a child card. The pane is
 * where the human is already reading the plans, so the confirm step is an
 * inline summary of what will materialise — titles, dependency edges, the
 * landing stage — not a separate dialog re-listing what is on screen.
 *
 * Lazy, like the thread pane — it pulls in `ChatMarkdown` (highlighting,
 * tables, the lot), so the board chunk never pays for it until a card with a
 * plan is opened onto this pane.
 */
import type {
  BoardCardChildRef,
  BoardPlanWithBody,
  BoardStageDefinition,
} from "@t3tools/contracts";
import { ChevronLeftIcon, LayersIcon } from "lucide-react";
import { useState } from "react";

import ChatMarkdown from "../components/ChatMarkdown";
import { BoardSectionHeading as SectionHeading } from "./BoardCardFields";
import { boardStageLabel } from "./boardStages";
import { BoardHint } from "./BoardHint";

export function BoardCardPlanPane({
  plans,
  cardKey,
  onBackToThread,
  childCards = [],
  stages = [],
  canApproveSplit = false,
  approveTargetLabel = null,
  onApproveSplit,
  onOpenChild,
}: {
  readonly plans: ReadonlyArray<BoardPlanWithBody>;
  readonly cardKey: string;
  readonly onBackToThread: () => void;
  /** Materialised child cards (t3o-23), paired to plans by `sourcePlanId`. */
  readonly childCards?: ReadonlyArray<BoardCardChildRef>;
  readonly stages?: ReadonlyArray<BoardStageDefinition>;
  /** Whether the approve gate renders (D1: two or more plans, no children
      yet, top-level card at or before the build stage). */
  readonly canApproveSplit?: boolean;
  /** The floor stage's label, for the confirm copy ("land in Ready"). */
  readonly approveTargetLabel?: string | null;
  readonly onApproveSplit?: (() => void) | undefined;
  /** Open one child inside this card's sub-board (t3o-25, AC4); absent keeps
      the chips informational. */
  readonly onOpenChild?: ((childCardId: string) => void) | undefined;
}) {
  const [confirming, setConfirming] = useState(false);
  const childByPlan = new Map(
    childCards
      .filter((child) => child.sourcePlanId !== null)
      .map((child) => [child.sourcePlanId, child]),
  );
  const titleByPlanId = new Map(plans.map((plan) => [plan.planId, plan.title]));
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
        {canApproveSplit && onApproveSplit !== undefined && !confirming ? (
          <button
            className="inline-flex h-6 shrink-0 items-center gap-1 rounded-[7px] border border-input bg-popover px-2.5 text-[11.5px] font-medium text-foreground shadow-xs hover:bg-accent"
            onClick={() => setConfirming(true)}
            type="button"
          >
            <LayersIcon className="size-3" />
            Approve split
          </button>
        ) : null}
        <button
          className="inline-flex h-6 shrink-0 items-center gap-1 rounded-[7px] border border-input bg-popover pl-1.5 pr-2.5 text-[11.5px] font-medium text-muted-foreground shadow-xs hover:bg-accent hover:text-foreground"
          onClick={onBackToThread}
          type="button"
        >
          <ChevronLeftIcon className="size-3" />
          Back to thread
        </button>
      </div>
      {confirming && canApproveSplit && onApproveSplit !== undefined ? (
        <div className="shrink-0 border-b border-border bg-popover px-4.5 py-3">
          <p className="text-[12.5px] font-medium text-foreground">
            Materialise {plans.length} plan cards
            {approveTargetLabel === null ? "" : ` into ${approveTargetLabel}`}?
          </p>
          <ul className="mt-1.5 space-y-0.5 text-[12px] text-muted-foreground">
            {plans.map((plan) => (
              <li key={plan.planId}>
                {plan.title}
                {plan.dependsOn.length > 0
                  ? ` — after ${plan.dependsOn
                      .map((dependency) => titleByPlanId.get(dependency) ?? String(dependency))
                      .join(", ")}`
                  : ""}
              </li>
            ))}
          </ul>
          <p className="mt-1.5 text-[11.5px] text-muted-foreground">
            This card moves to the build column and advances when the last plan card is done. Each
            plan card&apos;s build still starts with you.
          </p>
          <div className="mt-2 flex gap-2">
            <button
              className="inline-flex h-6 items-center rounded-[7px] bg-primary px-2.5 text-[11.5px] font-medium text-primary-foreground hover:bg-primary/90"
              onClick={() => {
                setConfirming(false);
                onApproveSplit();
              }}
              type="button"
            >
              Approve and materialise
            </button>
            <button
              className="inline-flex h-6 items-center rounded-[7px] border border-input bg-popover px-2.5 text-[11.5px] font-medium text-muted-foreground hover:bg-accent"
              onClick={() => setConfirming(false)}
              type="button"
            >
              Cancel
            </button>
          </div>
        </div>
      ) : null}
      <div className="min-h-0 flex-1 overflow-y-auto px-4.5 pt-4 pb-6">
        {plans.map((plan) => {
          const child = childByPlan.get(plan.planId);
          return (
            <div key={plan.planId} className="mb-6 last:mb-0">
              {single && child === undefined ? null : (
                <h3 className="mb-2 flex items-center gap-2 text-[13.5px] font-semibold text-foreground">
                  {plan.title}
                  {child === undefined ? null : (
                    // The materialised child (t3o-23): its key and where it
                    // stands. Struck through when archived, so the pairing
                    // survives without pretending the card is live. A button
                    // when navigation is wired (t3o-25): it opens the child
                    // inside this card's sub-board.
                    <BoardHint
                      label={`${child.key} — ${child.title}${onOpenChild === undefined ? "" : " (open in the sub-board)"}`}
                    >
                      <button
                        className={
                          "inline-flex h-[18px] shrink-0 items-center gap-1 rounded-md bg-muted-foreground/14 px-[7px] text-[11px] font-medium text-foreground disabled:pointer-events-none" +
                          (child.archivedAt === null ? "" : " line-through opacity-60") +
                          (onOpenChild === undefined ? "" : " hover:bg-muted-foreground/25")
                        }
                        disabled={onOpenChild === undefined}
                        onClick={
                          onOpenChild === undefined ? undefined : () => onOpenChild(child.cardId)
                        }
                        type="button"
                      >
                        <LayersIcon className="size-2.5" />
                        {child.key}
                        <span className="font-normal text-muted-foreground">
                          {boardStageLabel(stages, child.stage)}
                        </span>
                      </button>
                    </BoardHint>
                  )}
                </h3>
              )}
              <ChatMarkdown cwd={undefined} text={plan.body} />
            </div>
          );
        })}
      </div>
    </section>
  );
}
