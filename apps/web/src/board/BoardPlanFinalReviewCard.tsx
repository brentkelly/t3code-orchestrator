/**
 * The final-review footer, shared by the Plans panel and the sub-board. It
 * states and never acts: the reactor already advances and regresses the parent.
 */
import { PullRequestGlyph } from "../components/pullRequest/pullRequestIcons";

import { cn } from "../lib/utils";

export function BoardPlanFinalReviewCard({
  branch,
  note,
  className,
}: {
  /** The parent's integration branch, or null before the reactor has cut it —
      in which case the heading says so rather than naming a branch that does
      not exist yet. */
  readonly branch: string | null;
  readonly note: string;
  readonly className?: string | undefined;
}) {
  return (
    <div
      className={cn(
        "flex shrink-0 items-center gap-3 rounded-xl border border-input border-dashed bg-foreground/3 px-3.5 py-3",
        className,
      )}
    >
      <span className="inline-flex size-[26px] shrink-0 items-center justify-center rounded-lg border border-border bg-card text-muted-foreground">
        <PullRequestGlyph.merged className="size-3.5" />
      </span>
      <div className="min-w-0">
        <div className="text-[12.5px] font-semibold text-foreground">
          Final review
          {branch === null ? (
            <span className="font-normal text-muted-foreground"> · integration branch pending</span>
          ) : (
            <>
              {" · "}
              <span className="font-mono font-medium">{branch}</span>
            </>
          )}
        </div>
        <div className="text-[11.5px]/[1.5] text-pretty text-muted-foreground">{note}</div>
      </div>
    </div>
  );
}
