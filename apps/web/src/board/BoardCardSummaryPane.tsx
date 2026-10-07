/**
 * The card modal's Summary pane (T3O-5): a read-only recap of how the work
 * went. Merge / Another review round / View PR stay on the rail; this pane
 * only links into View PR, the Review pane (outstanding titles), and a
 * split-parent child (same as the Plans panel).
 */
import { ChevronLeftIcon, GitPullRequestIcon } from "lucide-react";

import { cn } from "../lib/utils";
import { BoardSectionHeading as SectionHeading } from "./BoardCardFields";
import type { BoardCardWorkSummary, BoardCardWorkSummaryTone } from "./boardCardWorkSummary";

const TONE_CLASS: Record<BoardCardWorkSummaryTone, string> = {
  success: "bg-success/14 text-success-foreground",
  info: "bg-info/12 text-info-foreground",
  attention: "bg-attention/12 text-attention-foreground",
  warning: "bg-warning/8 text-warning-foreground",
  muted: "bg-muted text-muted-foreground",
};

function Block({
  label,
  children,
}: {
  readonly label: string;
  readonly children: React.ReactNode;
}) {
  return (
    <div className="flex shrink-0 flex-col gap-2 rounded-xl border border-border bg-card px-3.5 py-3">
      <SectionHeading>{label}</SectionHeading>
      {children}
    </div>
  );
}

function EmptyCopy({ children }: { readonly children: string }) {
  return <p className="text-[12.5px] text-muted-foreground">{children}</p>;
}

export function BoardCardSummaryPane({
  summary,
  threadLocked,
  onBackToThread,
  onOpenPullRequest,
  onSelectReview,
  onOpenChild,
}: {
  readonly summary: BoardCardWorkSummary;
  readonly threadLocked: boolean;
  readonly onBackToThread: () => void;
  readonly onOpenPullRequest: (url: string) => void;
  readonly onSelectReview: () => void;
  readonly onOpenChild?: ((childCardId: string) => void) | undefined;
}) {
  const { verdict, review, build, pullRequest } = summary;
  return (
    <section className="flex min-h-0 min-w-0 flex-col border-r border-border bg-muted/55">
      <div className="flex h-11 shrink-0 items-center gap-2 border-b border-border pl-3.5 pr-3">
        <SectionHeading>Summary</SectionHeading>
        <span className="flex-1" />
        {threadLocked ? null : (
          <button
            className="inline-flex h-6 shrink-0 items-center gap-1 rounded-[7px] border border-input bg-popover pl-1.5 pr-2.5 text-[11.5px] font-medium text-muted-foreground shadow-xs hover:bg-accent hover:text-foreground"
            onClick={onBackToThread}
            type="button"
          >
            <ChevronLeftIcon className="size-3" />
            Back to thread
          </button>
        )}
      </div>
      <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-4 pb-5 pt-3.5">
        <Block label="Verdict">
          <span
            className={cn(
              "inline-flex h-[22px] w-fit shrink-0 items-center rounded-[7px] px-2 text-[11.5px] font-medium",
              TONE_CLASS[verdict.tone],
            )}
          >
            {verdict.label}
          </span>
        </Block>

        <Block label="Review recap">
          {review.empty ? (
            <EmptyCopy>No review summary</EmptyCopy>
          ) : (
            <div className="flex flex-col gap-2">
              <p className="text-[12.5px] text-foreground">
                Round {review.currentRound} of {review.maxRounds}
              </p>
              <p className="text-[11.5px] text-muted-foreground">
                {review.severities.critical} / {review.severities.improvement} /{" "}
                {review.severities.nitpick}
                {" · "}
                {review.counts.raised} raised · {review.counts.fixed} fixed ·{" "}
                {review.counts.rejected} rejected
                {review.counts.open > 0 ? ` · ${review.counts.open} open` : ""}
                {review.counts.disputed > 0 ? ` · ${review.counts.disputed} disputed` : ""}
              </p>
              {review.outstanding.length === 0 ? null : (
                <ul className="flex flex-col gap-1">
                  {review.outstanding.map((finding) => (
                    <li key={finding.id}>
                      <button
                        className="w-full truncate rounded-md px-1.5 py-1 text-left text-[12.5px] text-foreground hover:bg-accent"
                        onClick={onSelectReview}
                        type="button"
                      >
                        {finding.title}
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
        </Block>

        <Block label="Build recap">
          {build.empty ? (
            <EmptyCopy>No build summary</EmptyCopy>
          ) : (
            <div className="flex flex-col gap-2">
              {build.children !== null && build.children.total > 0 ? (
                <div className="flex flex-col gap-1.5">
                  <p className="text-[12.5px] text-foreground">
                    {build.children.done} of {build.children.total}{" "}
                    {build.children.total === 1 ? "plan" : "plans"} done
                  </p>
                  <ul className="flex flex-col gap-1">
                    {build.children.rows.map((row) => {
                      const openable = row.cardId !== null && onOpenChild !== undefined;
                      return (
                        <li key={row.key}>
                          <button
                            className={cn(
                              "flex w-full items-center justify-between gap-2 rounded-md px-1.5 py-1 text-left text-[12.5px]",
                              openable
                                ? "text-foreground hover:bg-accent"
                                : "cursor-default text-foreground",
                            )}
                            disabled={!openable}
                            onClick={
                              openable ? () => onOpenChild?.(row.cardId as string) : undefined
                            }
                            type="button"
                          >
                            <span className="font-medium">{row.key}</span>
                            <span className="text-[11.5px] text-muted-foreground">
                              {row.stageLabel}
                            </span>
                          </button>
                        </li>
                      );
                    })}
                  </ul>
                </div>
              ) : null}
              {build.summary !== null ? (
                <p className="text-[12.5px]/[1.5] text-pretty text-foreground">{build.summary}</p>
              ) : null}
            </div>
          )}
        </Block>

        <Block label="PR identity">
          {pullRequest.empty || pullRequest.number === null || pullRequest.url === null ? (
            <EmptyCopy>No PR</EmptyCopy>
          ) : (
            <button
              className="flex w-full flex-col gap-1 rounded-md px-1.5 py-1 text-left hover:bg-accent"
              onClick={() => onOpenPullRequest(pullRequest.url as string)}
              type="button"
            >
              <span className="flex items-center gap-1.5 text-[12.5px] font-medium text-foreground">
                <GitPullRequestIcon className="size-3.5 shrink-0" />#{pullRequest.number}
                {pullRequest.title !== null ? (
                  <span className="truncate font-normal">{pullRequest.title}</span>
                ) : null}
              </span>
              <span className="font-mono text-[11px] text-muted-foreground">
                {pullRequest.baseRef} ← {pullRequest.headBranch}
              </span>
            </button>
          )}
        </Block>
      </div>
    </section>
  );
}
