/**
 * T3o card Activity rail (t3o-18, D10/D11/D12).
 *
 * The rail is a DETERMINISTIC PROJECTION of the board's own event log, not
 * anything an agent narrated: the board already emits the exact moments worth
 * showing — created, moved, plans proposed, plan written, step completed, input
 * requested, archived, unarchived, worktree failed — so the projector writes a
 * structured row for that curated subset and this component renders the
 * sentence.
 *
 * **The server never writes English.** Every row is a kind + a small typed
 * payload + an actor, so the log stays queryable and relabelable and "who
 * approved it" is a column rather than a phrase buried in prose. That split is
 * what makes this file the only place the wording lives.
 *
 * Nine kinds and no more (D12). The full step lifecycle would put ~20 rows on a
 * card that ran three steps — the same unreadability that motivated deleting the
 * agent-written progress notes in the first place.
 */
import type {
  BoardCardActivityEntry,
  BoardStageDefinition,
  BoardStepOutcome,
  ProviderInstanceId,
} from "@t3tools/contracts";
import {
  ArchiveIcon,
  ArchiveRestoreIcon,
  CheckCircle2Icon,
  CheckIcon,
  CircleAlertIcon,
  CircleSlashIcon,
  FileTextIcon,
  CloudOffIcon,
  GitMergeIcon,
  GitPullRequestIcon,
  LayersIcon,
  ListTreeIcon,
  FolderSyncIcon,
  MoveRightIcon,
  PlusCircleIcon,
  ScissorsIcon,
  TriangleAlertIcon,
  XIcon,
} from "lucide-react";
import { Fragment, useMemo, useState, type ReactNode } from "react";

import { cn } from "../lib/utils";
import { formatRelativeTimeLabel } from "../timestampFormat";
import {
  boardActivityGroupView,
  groupBoardActivity,
  toggleBoardActivityGroup,
} from "./boardActivityGroups";
import { boardStageLabel } from "./boardStages";
import { BoardHint } from "./BoardHint";

/** How the rail resolves an agent's display name and accent (D11): from the
    thread's `ProviderInstanceId`, which is exactly where "Claude Opus 4.8" and
    its accent already come from. Resolved at RENDER time, not frozen on the row,
    so renaming or recolouring a provider instance relabels its whole history. */
export interface BoardActivityAgentLookup {
  readonly displayName: (instanceId: ProviderInstanceId) => string;
  readonly accentColor: (instanceId: ProviderInstanceId) => string | undefined;
}

function ActorName({
  entry,
  agents,
}: {
  readonly entry: BoardCardActivityEntry;
  readonly agents: BoardActivityAgentLookup | undefined;
}) {
  const actor = entry.actor;
  if (actor.kind === "human") {
    return <span className="font-medium text-foreground">{actor.name ?? "You"}</span>;
  }
  if (actor.kind === "agent" && actor.providerInstanceId !== null) {
    const accent = agents?.accentColor(actor.providerInstanceId);
    return (
      <span
        className="font-medium text-foreground"
        style={accent === undefined ? undefined : { color: accent }}
      >
        {agents?.displayName(actor.providerInstanceId) ?? String(actor.providerInstanceId)}
      </span>
    );
  }
  // The supervisor reactor and every other internally-dispatched command.
  return <span className="font-medium text-muted-foreground">System</span>;
}

function ActivityIcon({ kind }: { readonly kind: BoardCardActivityEntry["kind"] }) {
  const className = "size-3 shrink-0";
  switch (kind) {
    case "card-created":
      return <PlusCircleIcon className={className} />;
    case "card-moved":
      return <MoveRightIcon className={className} />;
    case "card-project-changed":
      return <FolderSyncIcon className={className} />;
    case "plans-proposed":
      return <ListTreeIcon className={className} />;
    case "plan-written":
      return <FileTextIcon className={className} />;
    case "plans-approved":
      return <LayersIcon className={className} />;
    case "card-step-completed":
      return <CheckCircle2Icon className={className} />;
    case "card-input-requested":
      return <CircleAlertIcon className={cn(className, "text-attention-foreground")} />;
    case "card-archived":
      return <ArchiveIcon className={className} />;
    case "card-unarchived":
      return <ArchiveRestoreIcon className={className} />;
    case "card-worktree-failed":
      return <TriangleAlertIcon className={cn(className, "text-destructive-foreground")} />;
    case "card-pull-request-linked":
    case "card-pull-request-state-changed":
      return <GitPullRequestIcon className={className} />;
    case "card-pull-request-merged":
      return <GitMergeIcon className={className} />;
    case "card-branch-deleted":
      return <ScissorsIcon className={className} />;
    case "card-merge-refused":
      return <TriangleAlertIcon className={cn(className, "text-destructive-foreground")} />;
    case "card-branch-push-skipped":
      return <CloudOffIcon className={className} />;
    // A stale base is a merge that cannot proceed, so it wears the blocked
    // amber rather than the blue that now means "running".
    case "card-base-stale":
      return <GitPullRequestIcon className={cn(className, "text-warning-foreground")} />;
  }
}

/** The terminal outcome of a completed step, shown as a glyph rather than a
    word: a grey tick for a clean pass, a red cross for a failure, and a muted
    slash for a blocked run. `title` keeps the original word available on hover
    and to assistive tech. */
function StepOutcomeIcon({ outcome }: { readonly outcome: BoardStepOutcome }) {
  const className = "inline-block size-3 shrink-0 align-text-bottom";
  switch (outcome) {
    case "succeeded":
      return (
        <CheckIcon aria-label="succeeded" className={cn(className, "text-muted-foreground")} />
      );
    case "failed":
      return <XIcon aria-label="failed" className={cn(className, "text-destructive-foreground")} />;
    case "blocked":
      return (
        <CircleSlashIcon
          aria-label="blocked"
          className={cn(className, "text-warning-foreground")}
        />
      );
  }
}

/** The sentence for one row, built from its typed payload. A payload field that
    is absent simply drops out of the sentence — a row from an older schema reads
    as a shorter, still-true sentence rather than as `undefined`. */
function activitySentence(
  entry: BoardCardActivityEntry,
  stages: ReadonlyArray<BoardStageDefinition>,
  /** Project titles by id, for the T3O-33 row. A project the client cannot name
      (deleted, or another environment's) falls back to the reissued key alone,
      which is still a true sentence. */
  projectNames: ReadonlyMap<string, string> | undefined,
): ReactNode {
  const payload = entry.payload;
  switch (entry.kind) {
    case "card-created":
      return payload.toStage === undefined ? (
        <>created the card</>
      ) : (
        <>created the card in {boardStageLabel(stages, payload.toStage)}</>
      );
    case "card-moved":
      return payload.toStage === undefined ? (
        <>moved the card</>
      ) : (
        <>moved to {boardStageLabel(stages, payload.toStage)}</>
      );
    // The retired key is what this row is really about — it is printed on
    // branches, PR titles and everything anyone wrote down — so it is named
    // even when the project cannot be.
    case "card-project-changed": {
      const target =
        payload.toProjectId === undefined ? undefined : projectNames?.get(payload.toProjectId);
      const reissued =
        payload.toKey === undefined ? null : (
          <>
            {" "}
            as <span className="font-mono">{payload.toKey}</span>
          </>
        );
      return (
        <>
          moved the card{target === undefined ? null : <> to {target}</>}
          {reissued}
          {payload.fromKey === undefined ? null : (
            <>
              {" "}
              (was <span className="font-mono">{payload.fromKey}</span>)
            </>
          )}
        </>
      );
    }
    case "plans-proposed":
      return payload.planCount === undefined ? (
        <>proposed plans</>
      ) : (
        <>
          proposed {payload.planCount} {payload.planCount === 1 ? "plan" : "plans"}
        </>
      );
    case "plan-written":
      return payload.planTitle === undefined ? (
        <>drafted the plan</>
      ) : (
        <>drafted the plan “{payload.planTitle}”</>
      );
    case "plans-approved":
      return payload.planCount === undefined ? (
        <>approved the split</>
      ) : (
        <>
          approved the split into {payload.planCount}{" "}
          {payload.planCount === 1 ? "plan card" : "plan cards"}
        </>
      );
    case "card-step-completed":
      return (
        <>
          finished {payload.stepId ?? "the step"}
          {payload.outcome === undefined ? null : (
            <>
              {" "}
              <StepOutcomeIcon outcome={payload.outcome} />
            </>
          )}
        </>
      );
    case "card-input-requested":
      return payload.stepLabel === undefined ? (
        <>asked for input</>
      ) : (
        <>asked for input on {payload.stepLabel}</>
      );
    case "card-archived":
      return <>archived the card</>;
    case "card-unarchived":
      return <>restored the card</>;
    case "card-worktree-failed":
      return payload.detail === undefined ? (
        <>could not prepare the worktree</>
      ) : (
        <>could not prepare the worktree: {payload.detail}</>
      );
    case "card-pull-request-linked":
      return payload.prNumber === undefined ? (
        <>linked a pull request</>
      ) : (
        <>linked pull request #{payload.prNumber}</>
      );
    case "card-pull-request-state-changed":
      return payload.prNumber === undefined ? (
        <>the pull request changed state</>
      ) : (
        <>
          pull request #{payload.prNumber} is {payload.prState ?? "changed"}
        </>
      );
    case "card-pull-request-merged":
      return payload.prNumber === undefined ? (
        <>merged the pull request</>
      ) : (
        <>merged pull request #{payload.prNumber}</>
      );
    case "card-branch-deleted":
      return payload.detail === undefined ? <>deleted the branch</> : <>{payload.detail}</>;
    case "card-merge-refused":
      return payload.detail === undefined ? (
        <>could not merge the pull request</>
      ) : (
        <>{payload.detail}</>
      );
    case "card-branch-push-skipped":
      return payload.detail === undefined ? (
        <>created the integration branch but could not push it</>
      ) : (
        <>{payload.detail}</>
      );
    case "card-base-stale":
      return payload.detail === undefined ? (
        <>held the merge while the base branch is rebased and re-reviewed</>
      ) : (
        <>{payload.detail}</>
      );
  }
}

/** The toggle that ends a collapsed run. It makes no claim about work, so by
    the "no colour without a claim" rule it stays neutral rather than borrowing
    the violet the row's own icon wears. */
function ActivityRunToggle({
  expanded,
  label,
  onToggle,
}: {
  readonly expanded: boolean;
  readonly label: string;
  readonly onToggle: () => void;
}) {
  return (
    <button
      aria-expanded={expanded}
      className="ml-1 cursor-pointer rounded-sm font-medium text-muted-foreground/80 underline-offset-2 hover:text-foreground hover:underline"
      onClick={onToggle}
      type="button"
    >
      {label}
    </button>
  );
}

function ActivityRow({
  entry,
  stages,
  agents,
  projectNames,
  toggle,
}: {
  readonly entry: BoardCardActivityEntry;
  readonly stages: ReadonlyArray<BoardStageDefinition>;
  readonly agents: BoardActivityAgentLookup | undefined;
  readonly projectNames: ReadonlyMap<string, string> | undefined;
  readonly toggle: ReactNode;
}) {
  return (
    <li className="flex items-start gap-1.5 text-[12px]/[1.5] text-muted-foreground">
      <span className="mt-[3px]">
        <ActivityIcon kind={entry.kind} />
      </span>
      <span className="min-w-0 flex-1 text-pretty">
        <ActorName agents={agents} entry={entry} /> {activitySentence(entry, stages, projectNames)}
        {toggle}
      </span>
      <BoardHint label={entry.createdAt}>
        <span className="mt-[1px] shrink-0 text-[10.5px] tabular-nums text-muted-foreground/70">
          {formatRelativeTimeLabel(entry.createdAt)}
        </span>
      </BoardHint>
    </li>
  );
}

/**
 * The rail. Newest LAST, matching the chronological order the projector writes
 * and the way a card's story reads top to bottom.
 *
 * A run of identical consecutive rows renders as its newest member plus a
 * "+N more" toggle (T3O-35) — a planning session that asked thirty questions
 * used to spend thirty rows saying so. The toggle sits at the same row whether
 * open or shut, so expanding a run never moves the control the user just
 * pressed.
 *
 * Renders nothing when the card has no activity — absent, not an empty skeleton
 * (no-speculative-inventory), exactly as the two placeholders this replaces
 * promised.
 */
export function BoardCardActivityRail({
  entries,
  stages,
  agents,
  projectNames,
}: {
  readonly entries: ReadonlyArray<BoardCardActivityEntry>;
  readonly stages: ReadonlyArray<BoardStageDefinition>;
  readonly agents?: BoardActivityAgentLookup | undefined;
  /** Project titles by id (T3O-33), for the one row that names a project. */
  readonly projectNames?: ReadonlyMap<string, string> | undefined;
}) {
  const groups = useMemo(() => groupBoardActivity(entries), [entries]);
  const [expandedKeys, setExpandedKeys] = useState<ReadonlySet<string>>(() => new Set());

  if (entries.length === 0) return null;
  return (
    <ol className="flex flex-col gap-1.5">
      {groups.map((group) => {
        const expanded = expandedKeys.has(group.key);
        const { rows, toggleLabel } = boardActivityGroupView(group, expanded);
        const toggle =
          toggleLabel === null ? null : (
            <ActivityRunToggle
              expanded={expanded}
              label={toggleLabel}
              onToggle={() => {
                setExpandedKeys((current) => toggleBoardActivityGroup(current, group.key));
              }}
            />
          );
        return (
          <Fragment key={group.key}>
            {rows.map((entry, index) => (
              <ActivityRow
                agents={agents}
                entry={entry}
                key={entry.activityId}
                projectNames={projectNames}
                stages={stages}
                toggle={index === rows.length - 1 ? toggle : null}
              />
            ))}
          </Fragment>
        );
      })}
    </ol>
  );
}
