/**
 * The group's header inside its own sub-board. Counts come from live shells;
 * the PR and plans need the card's detail subscription, opened only while
 * drilled in.
 */
import type {
  BoardCardAttention,
  BoardCardId,
  BoardCardShell,
  BoardState,
  EnvironmentId,
  ProjectIconColor,
} from "@t3tools/contracts";
import { useAtomValue } from "@effect/atom-react";
import { GitBranchIcon, Link2Icon } from "lucide-react";
import { PullRequestGlyph } from "../components/pullRequest/pullRequestIcons";

import { cn } from "../lib/utils";
import { boardHeaderButtonClass } from "./boardHeaderButton";
import { boardEnvironment } from "../state/board";
import { projectAccent } from "./projectAccent";
import { BoardHint } from "./BoardHint";
import { BoardGroupAutomationPopover } from "./BoardCardAutomation";
import { BoardGroupUsageButton } from "./usage/BoardUsagePopovers";
import {
  boardGroupAutoBuildLabel,
  boardGroupStats,
  boardGroupTargetLabel,
  boardShellGroup,
} from "./boardGroups";

export function BoardSubBoardHeader({
  environmentId,
  parentCardId,
  parentShell,
  accentName,
  onOpenParentCard,
  chartOpen,
  onToggleChart,
  shells,
  stages,
  attentionFor,
  boardWideAutoMerge,
  stageLabelOf,
  onOpenCardUsage,
}: {
  readonly environmentId: EnvironmentId;
  readonly parentCardId: BoardCardId;
  /** The parent's decorated live shell; null until the snapshot arrives (or
      once the parent leaves the board, when the redirect is imminent). */
  readonly parentShell: BoardCardShell | null;
  readonly accentName: ProjectIconColor | null;
  /** The parent's own sheet lives on the ROOT board — clicking the
      title goes there with the sheet open. */
  readonly onOpenParentCard: () => void;
  /** The dependency chart's toggle: the button lives here, in the
      header row, and the chart itself renders below in
      `BoardSubBoardPlanStrip` — so the state is the page's, not ours. */
  readonly chartOpen: boolean;
  readonly onToggleChart: () => void;
  /** Every shell and the stage list, for the group's counts and target. */
  readonly shells: ReadonlyArray<BoardCardShell>;
  readonly stages: BoardState;
  readonly attentionFor: (card: BoardCardShell) => BoardCardAttention | null;
  /** Settings → Board → Pipeline merges every card. */
  readonly boardWideAutoMerge: boolean;
  /** T3o: for the group's spend popover (T3O-77). */
  readonly stageLabelOf: (card: BoardCardShell) => string;
  readonly onOpenCardUsage: (cardId: string) => void;
}) {
  const detail = useAtomValue(
    boardEnvironment.cardDetailValueAtom({ environmentId, cardId: parentCardId }),
  );
  if (parentShell === null) return null;
  const accent = projectAccent(parentShell.projectId, accentName);
  const pullRequest = detail?.card.pullRequest ?? null;
  const group = boardShellGroup(shells, parentShell);
  const stats = boardGroupStats({ shells, stages, attentionFor }, String(parentShell.cardId));
  const target = boardGroupTargetLabel(shells, parentShell);
  const autoBuild = group === null ? "" : boardGroupAutoBuildLabel(group);
  return (
    <div className="flex min-w-0 items-center gap-2.5">
      <span
        className={cn(
          "inline-flex h-4 shrink-0 items-center rounded px-1.5 text-board-10 font-semibold tracking-wide",
          accent.pill,
        )}
      >
        {parentShell.key}
      </span>
      <BoardHint label={`Open ${parentShell.key} on the board`}>
        <button
          className="min-w-0 truncate text-left text-board-13 font-semibold text-foreground hover:underline"
          onClick={onOpenParentCard}
          type="button"
        >
          {parentShell.title}
        </button>
      </BoardHint>
      <span className="shrink-0 text-board-12 text-muted-foreground tabular-nums">
        {stats.done}/{stats.active.length} done
        {stats.deferred > 0 ? ` · ${stats.deferred} deferred` : ""}
      </span>
      <BoardHint
        label={
          group?.target === "own"
            ? `Integration branch: every card here builds on ${target}`
            : `Cards here merge into ${target}`
        }
      >
        <span className="inline-flex min-w-0 shrink items-center gap-1 rounded bg-muted px-1.5 py-0.5 text-board-11 font-medium text-muted-foreground">
          <GitBranchIcon className="size-3 shrink-0" />
          <span className="truncate">→ {target}</span>
        </span>
      </BoardHint>
      {autoBuild.length === 0 ? null : (
        <span className="shrink-0 text-board-11-5 text-muted-foreground">{autoBuild}</span>
      )}
      {pullRequest !== null && pullRequest.state === "open" ? (
        <BoardHint
          label={`${parentShell.key}'s integration pull request is open: ${pullRequest.url}`}
        >
          <span className="inline-flex shrink-0 items-center gap-1 rounded bg-info/12 px-1.5 py-0.5 text-board-11 font-medium text-info-foreground">
            <PullRequestGlyph.pullRequest className="size-3" />
            PR #{pullRequest.number}
          </span>
        </BoardHint>
      ) : null}
      {/* The group's spend at any stage, so in-progress spend is one click away. */}
      <BoardGroupUsageButton
        group={parentShell}
        onOpenCard={onOpenCardUsage}
        shells={shells}
        stageLabelOf={stageLabelOf}
        variant="header"
      />
      <span className="flex-1" />
      {/* The chart is drawn from the group's PLANS, so the toggle
          only exists once there are some. */}
      {(detail?.plans.length ?? 0) > 0 ? (
        <button className={boardHeaderButtonClass(chartOpen)} onClick={onToggleChart} type="button">
          <Link2Icon />
          {chartOpen ? "Hide chart" : "Dependency chart"}
        </button>
      ) : null}
      {group === null ? null : (
        <BoardGroupAutomationPopover
          boardWideAutoMerge={boardWideAutoMerge}
          environmentId={environmentId}
          group={parentShell}
          shells={shells}
          stages={stages}
        />
      )}
    </div>
  );
}
