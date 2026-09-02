/**
 * Sub-board parent header (t3o-25, D2): inside its own sub-board the parent
 * is a HEADER, not a card. A card invites dragging — which the decider
 * refuses for a split parent anyway — so the header states the frozen-stage
 * rule instead of letting the refusal teach it.
 *
 * The key, title and pips come from the parent's live shell (already
 * decorated with the derived `planTotal`/`planDone`). The integration branch
 * and the pull request ride the per-card detail, so the header opens the same
 * `board.subscribeCard` the modal does — one parent per drill-in, so the
 * board at rest still opens none.
 */
import type { BoardCardId, BoardCardShell, EnvironmentId } from "@t3tools/contracts";
import { useAtomValue } from "@effect/atom-react";
import { GitBranchIcon, GitPullRequestIcon, Link2Icon } from "lucide-react";

import { cn } from "../lib/utils";
import { boardEnvironment } from "../state/board";
import { PlanPips } from "./BoardCardSummaryRow";
import { projectAccent } from "./projectAccent";
import { BoardHint } from "./BoardHint";

export function BoardSubBoardHeader({
  environmentId,
  parentCardId,
  parentShell,
  accentName,
  onOpenParentCard,
  chartOpen,
  onToggleChart,
}: {
  readonly environmentId: EnvironmentId;
  readonly parentCardId: BoardCardId;
  /** The parent's decorated live shell; null until the snapshot arrives (or
      once the parent leaves the board, when the D3 redirect is imminent). */
  readonly parentShell: BoardCardShell | null;
  readonly accentName: string | null;
  /** The parent's own sheet lives on the ROOT board (D2) — clicking the
      title goes there with the sheet open. */
  readonly onOpenParentCard: () => void;
  /** The dependency chart's toggle (t3o-29): the button lives here, in the
      header row, and the chart itself renders below in
      `BoardSubBoardPlanStrip` — so the state is the page's, not ours. */
  readonly chartOpen: boolean;
  readonly onToggleChart: () => void;
}) {
  const detail = useAtomValue(
    boardEnvironment.cardDetailValueAtom({ environmentId, cardId: parentCardId }),
  );
  if (parentShell === null) return null;
  const accent = projectAccent(parentShell.projectId, accentName);
  const branch = detail?.card.worktree?.branch ?? null;
  const pullRequest = detail?.card.pullRequest ?? null;
  const total = parentShell.planTotal ?? 0;
  const done = parentShell.planDone ?? 0;
  return (
    <div className="flex min-w-0 items-center gap-2.5">
      <span
        className={cn(
          "inline-flex h-4 shrink-0 items-center rounded px-1.5 text-[10px] font-semibold tracking-wide",
          accent.pill,
        )}
      >
        {parentShell.key}
      </span>
      <BoardHint label={`Open ${parentShell.key} on the board`}>
        <button
          className="min-w-0 truncate text-left text-[13px] font-semibold text-foreground hover:underline"
          onClick={onOpenParentCard}
          type="button"
        >
          {parentShell.title}
        </button>
      </BoardHint>
      {total > 0 ? <PlanPips done={done} total={total} /> : null}
      {branch !== null ? (
        <BoardHint label={`Integration branch — every card here builds on ${branch}`}>
          <span className="inline-flex min-w-0 shrink items-center gap-1 rounded bg-muted px-1.5 py-0.5 text-[11px] font-medium text-muted-foreground">
            <GitBranchIcon className="size-3 shrink-0" />
            <span className="truncate">{branch}</span>
          </span>
        </BoardHint>
      ) : null}
      {pullRequest !== null && pullRequest.state === "open" ? (
        <BoardHint
          label={`${parentShell.key}'s integration pull request is open — ${pullRequest.url}`}
        >
          <span className="inline-flex shrink-0 items-center gap-1 rounded bg-info/12 px-1.5 py-0.5 text-[11px] font-medium text-info-foreground">
            <GitPullRequestIcon className="size-3" />
            PR #{pullRequest.number}
          </span>
        </BoardHint>
      ) : null}
      {total > 0 && done < total ? (
        <span className="hidden shrink-0 text-[11.5px] text-muted-foreground lg:inline">
          Holds its stage until every card here is done.
        </span>
      ) : null}
      {/* The chart is drawn from the parent's PLANS (t3o-29, D3), so the
          toggle only exists once there are some — a split whose plans are
          gone has no shape left to draw. */}
      {(detail?.plans.length ?? 0) > 0 ? (
        <>
          <span className="flex-1" />
          <button
            className={cn(
              "inline-flex h-6 shrink-0 items-center gap-1.5 rounded-[7px] border px-2.5 text-[11.5px] font-medium whitespace-nowrap shadow-xs",
              chartOpen
                ? "border-input bg-accent text-foreground"
                : "border-border bg-popover text-muted-foreground hover:bg-accent hover:text-foreground",
            )}
            onClick={onToggleChart}
            type="button"
          >
            <Link2Icon className="size-3" />
            {chartOpen ? "Hide chart" : "Dependency chart"}
          </button>
        </>
      ) : null}
    </div>
  );
}
