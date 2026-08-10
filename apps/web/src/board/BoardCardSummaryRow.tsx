/**
 * T3o stage-specific summary row (t3o-06). Renders the `BoardCardSummaryItem`s
 * `boardCardSummary` derives from a `BoardCardShell` — plan pips, review round
 * pips, the severity triple (with the tooltip that makes three bare numbers
 * mean something), the issue tally, PR and attachment counts.
 *
 * Static presentation only: no animations (upstream AGENTS.md — repainting
 * loops peg the GPU on high-refresh displays). The row renders nothing when
 * `items` is empty, so a stage with no data adds no height to the card.
 */
import { GitPullRequestIcon, PaperclipIcon } from "lucide-react";

import { cn } from "../lib/utils";
import type { BoardCardSummaryItem } from "./boardCardSummary";

/** Bounded round pips: one dot per round, filled up to `current`. Capped so a
    pathological round count cannot blow out the card width. */
const MAX_ROUND_PIPS = 6;

function RoundPips({ current, max }: { readonly current: number; readonly max: number }) {
  const shown = Math.min(max, MAX_ROUND_PIPS);
  return (
    <span
      className="inline-flex items-center gap-0.5"
      title={`Round ${current} of ${max}`}
      aria-label={`Round ${current} of ${max}`}
    >
      <span className="text-[10.5px] font-medium text-muted-foreground">
        Round {current} of {max}
      </span>
      <span className="ml-0.5 inline-flex items-center gap-0.5">
        {Array.from({ length: shown }, (_, index) => (
          <span
            key={index}
            className={cn(
              "size-1.5 rounded-full",
              index < current ? "bg-foreground/70" : "bg-muted-foreground/30",
            )}
          />
        ))}
      </span>
    </span>
  );
}

function PlanPips({ done, total }: { readonly done: number; readonly total: number }) {
  const shown = Math.min(total, MAX_ROUND_PIPS);
  return (
    <span
      className="inline-flex items-center gap-0.5"
      title={`${done} of ${total} plans done`}
      aria-label={`${done} of ${total} plans done`}
    >
      <span className="inline-flex items-center gap-0.5">
        {Array.from({ length: shown }, (_, index) => (
          <span
            key={index}
            className={cn(
              "size-1.5 rounded-full",
              index < done ? "bg-emerald-500" : "bg-muted-foreground/30",
            )}
          />
        ))}
      </span>
      <span className="ml-0.5 text-[10.5px] font-medium text-muted-foreground">
        {done}/{total} plans
      </span>
    </span>
  );
}

function SeverityTriple({
  critical,
  improvement,
  nitpick,
}: {
  readonly critical: number;
  readonly improvement: number;
  readonly nitpick: number;
}) {
  // Three bare numbers are meaningless to anyone who has not read the spec —
  // the tooltip spells them out (t3o-06 verification).
  return (
    <span
      className="inline-flex items-center gap-1 rounded bg-muted px-1.5 text-[10.5px] font-medium tabular-nums"
      title={`${critical} critical · ${improvement} improvements · ${nitpick} nitpicks`}
    >
      <span className="text-red-600 dark:text-red-400">{critical}</span>
      <span className="text-muted-foreground">/</span>
      <span className="text-amber-600 dark:text-amber-400">{improvement}</span>
      <span className="text-muted-foreground">/</span>
      <span className="text-sky-600 dark:text-sky-400">{nitpick}</span>
    </span>
  );
}

function IssueTally({
  fixed,
  rejected,
  open,
  disputed,
}: {
  readonly fixed: number;
  readonly rejected: number;
  readonly open: number;
  readonly disputed: number;
}) {
  return (
    <span
      className="text-[10.5px] font-medium text-muted-foreground"
      title={`${fixed} fixed · ${rejected} rejected · ${open} open · ${disputed} disputed`}
    >
      {fixed} fixed · {rejected} rejected · {open} open · {disputed} disputed
    </span>
  );
}

function SummaryItem({ item }: { readonly item: BoardCardSummaryItem }) {
  switch (item.kind) {
    case "attachments":
      return (
        <span className="inline-flex items-center gap-0.5 text-[10.5px] font-medium text-muted-foreground">
          <PaperclipIcon className="size-3" />
          {item.count}
        </span>
      );
    case "plans":
      return <PlanPips done={item.done} total={item.total} />;
    case "pr":
      return (
        <span className="inline-flex items-center gap-0.5 text-[10.5px] font-medium text-muted-foreground">
          <GitPullRequestIcon className="size-3" />#{item.number}
        </span>
      );
    case "round":
      return <RoundPips current={item.current} max={item.max} />;
    case "step":
      return (
        <span className="inline-flex items-center rounded bg-muted px-1.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
          {item.label}
        </span>
      );
    case "severity":
      return (
        <SeverityTriple
          critical={item.critical}
          improvement={item.improvement}
          nitpick={item.nitpick}
        />
      );
    case "issues":
      return (
        <IssueTally
          fixed={item.fixed}
          rejected={item.rejected}
          open={item.open}
          disputed={item.disputed}
        />
      );
  }
}

export function BoardCardSummaryRow({
  items,
}: {
  readonly items: ReadonlyArray<BoardCardSummaryItem>;
}) {
  if (items.length === 0) return null;
  return (
    <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
      {items.map((item) => (
        <SummaryItem item={item} key={item.kind} />
      ))}
    </div>
  );
}
