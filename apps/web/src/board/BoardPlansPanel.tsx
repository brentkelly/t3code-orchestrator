/**
 * The Plans panel (t3o-29): what a split parent's modal shows once its
 * children exist.
 *
 * The pane it replaces rendered the plan markdown — which, after approval, is
 * a second copy of four Brief panes (`decider.ts` makes each plan body the
 * child's brief at materialisation). A parent whose whole job is to supervise
 * four cards was therefore showing prose the human read at approval and
 * nothing at all about what the four cards were doing. This shows the split:
 * one row per plan, in dependency order, each carrying its child's live stage,
 * what is holding it up, and its PR.
 *
 * No "Back to thread" button, unlike the markdown pane: a split parent's own
 * thread is locked until review (t3o-28, D4), so the control would be dead
 * wherever this panel renders.
 *
 * Pure presentation over `deriveBoardPlanRows` — see `boardPlanRows.ts` for
 * why none of this needed a wire change.
 */
import { ChevronRightIcon, CircleAlertIcon, Columns3Icon, Link2Icon, LockIcon } from "lucide-react";
import { useState } from "react";

import { cn } from "../lib/utils";
import { BoardSectionHeading as SectionHeading } from "./BoardCardFields";
import { BoardPlanGraph } from "./BoardPlanGraph";
import {
  boardPlanFinalReview,
  type BoardPlanRow,
  type BoardPlanRowTone,
  type BoardPlanRows,
} from "./boardPlanRows";
import { BoardPlanFinalReviewCard } from "./BoardPlanFinalReviewCard";
import { BoardHint } from "./BoardHint";

const TONE_DOT: Record<BoardPlanRowTone, string> = {
  done: "bg-success",
  blocked: "bg-warning",
  active: "bg-info",
  idle: "bg-muted-foreground/30",
  gone: "bg-muted-foreground/20",
};

export function BoardPlansPanel({
  planRows,
  integrationBranch,
  onOpenChild,
  onOpenSubBoard,
}: {
  readonly planRows: BoardPlanRows;
  /** The parent's integration branch, for the footer; null before the reactor
      has cut it. */
  readonly integrationBranch: string | null;
  /** Open one child inside this parent's sub-board. Absent leaves the rows
      informational. */
  readonly onOpenChild?: ((childCardId: string) => void) | undefined;
  /** Open the sub-board itself, no sheet — the header's Board button. */
  readonly onOpenSubBoard?: (() => void) | undefined;
}) {
  // Ephemeral by design (D6): the modal remounts per card, so there is no
  // state to strand and no persisted key scheme to maintain.
  const [chartOpen, setChartOpen] = useState(false);
  const final = boardPlanFinalReview({
    branch: integrationBranch,
    liveTotal: planRows.liveTotal,
    liveDone: planRows.liveDone,
  });
  return (
    <section className="flex min-h-0 min-w-0 flex-col border-r border-border bg-muted/55">
      <div className="flex h-11 shrink-0 items-center gap-2.5 border-b border-border pl-3.5 pr-3">
        <SectionHeading>Plans</SectionHeading>
        <span className="text-[11.5px] text-muted-foreground">in dependency order</span>
        <span className="flex-1" />
        <button
          className={cn(
            "inline-flex h-6 shrink-0 items-center gap-1.5 rounded-[7px] border px-2.5 text-[11.5px] font-medium whitespace-nowrap shadow-xs",
            chartOpen
              ? "border-input bg-accent text-foreground"
              : "border-border bg-popover text-muted-foreground hover:bg-accent hover:text-foreground",
          )}
          onClick={() => setChartOpen((open) => !open)}
          type="button"
        >
          <Link2Icon className="size-3" />
          {chartOpen ? "Hide chart" : "Dependency chart"}
        </button>
        {onOpenSubBoard === undefined ? null : (
          <BoardHint label="Open these plans as a board">
            <button
              className="inline-flex h-6 shrink-0 items-center gap-1.5 rounded-[7px] border border-input bg-popover px-2.5 text-[11.5px] font-medium whitespace-nowrap text-foreground shadow-xs hover:bg-accent"
              onClick={onOpenSubBoard}
              type="button"
            >
              <Columns3Icon className="size-3" />
              Board
            </button>
          </BoardHint>
        )}
      </div>
      <div className="flex min-h-0 flex-1 flex-col gap-3.5 overflow-y-auto px-4 pt-3.5 pb-5">
        {chartOpen ? <BoardPlanGraph onOpenChild={onOpenChild} rows={planRows.rows} /> : null}
        <div className="flex flex-col gap-[7px]">
          {planRows.rows.map((row) => (
            <PlanRow key={row.planId} onOpenChild={onOpenChild} row={row} />
          ))}
        </div>
        <BoardPlanFinalReviewCard branch={final.branch} note={final.note} />
      </div>
    </section>
  );
}

function PlanRow({
  row,
  onOpenChild,
}: {
  readonly row: BoardPlanRow;
  readonly onOpenChild: ((childCardId: string) => void) | undefined;
}) {
  const cardId = row.live?.cardId ?? null;
  const openable = cardId !== null && onOpenChild !== undefined;
  // "after #1, #2  ·  PR #303" — the plan's place in the order, then its
  // card's pull request if it has one.
  const meta = [
    row.dependsOnNumbers.length === 0
      ? "no dependencies"
      : `after ${row.dependsOnNumbers.map((n) => `#${n}`).join(", ")}`,
    row.live?.prNumber === undefined ? null : `PR #${row.live.prNumber}`,
    row.state === "archived" ? "archived" : row.state === "missing" ? "no card" : null,
  ].filter((part): part is string => part !== null);
  return (
    <BoardHint label={openable ? `Open ${row.key ?? row.title} in the sub-board` : row.title}>
      <button
        className={cn(
          "flex w-full items-center gap-[11px] rounded-[10px] border px-3 py-2.5 text-left shadow-xs",
          row.live?.awaitingInput === true ? "border-attention/50" : "border-border",
          row.done ? "bg-foreground/3" : "bg-card",
          row.state !== "live" && "opacity-70",
          openable ? "hover:border-foreground/20" : "cursor-default",
        )}
        disabled={!openable}
        onClick={openable ? () => onOpenChild(cardId) : undefined}
        type="button"
      >
        <span className={cn("size-[7px] shrink-0 rounded-full", TONE_DOT[row.tone])} />
        <span className="shrink-0 text-[11px] font-semibold text-muted-foreground">#{row.n}</span>
        <span className="flex min-w-0 flex-1 flex-col gap-[3px]">
          <span
            className={cn(
              "truncate text-[13px] font-medium text-foreground",
              row.state === "archived" && "line-through",
            )}
          >
            {row.title}
          </span>
          <span className="truncate text-[10.5px] text-muted-foreground">{meta.join("  ·  ")}</span>
          {row.blockers.length > 0 && !row.done ? (
            <span className="inline-flex items-center gap-1 text-[10.5px] font-medium text-warning-foreground">
              <LockIcon className="size-2.5 shrink-0" />
              Waiting on{" "}
              {row.blockers.map((blocker) => `#${blocker.n} · ${blocker.stageLabel}`).join(", ")}
            </span>
          ) : null}
        </span>
        {row.done ? null : row.live?.stalled === true ? (
          <span className="inline-flex shrink-0 items-center gap-1 text-[10.5px] font-medium text-warning-foreground">
            <CircleAlertIcon className="size-3" />
            Stalled
          </span>
        ) : row.live?.awaitingInput === true ? (
          <span className="inline-flex shrink-0 items-center gap-1 text-[10.5px] font-medium text-attention-foreground">
            <CircleAlertIcon className="size-3" />
            Input needed
          </span>
        ) : row.live?.queued === true ? (
          <span className="shrink-0 text-[10.5px] font-medium text-muted-foreground">Queued</span>
        ) : row.live?.working === true ? (
          <BoardHint label="Working">
            <span
              aria-label="Working"
              role="img"
              className="size-[11px] shrink-0 animate-spin rounded-full border-[1.8px] border-[color-mix(in_srgb,var(--info)_25%,transparent)] border-t-info-foreground"
            />
          </BoardHint>
        ) : null}
        <span
          className={cn(
            "inline-flex h-5 shrink-0 items-center rounded-md border border-border px-2 text-[11px] font-medium text-muted-foreground",
            row.done ? "bg-success/12" : "bg-muted",
          )}
        >
          {row.stageLabel ?? "No card"}
        </span>
        <ChevronRightIcon
          className={cn("size-3.5 shrink-0 text-muted-foreground", !openable && "opacity-0")}
        />
      </button>
    </BoardHint>
  );
}
