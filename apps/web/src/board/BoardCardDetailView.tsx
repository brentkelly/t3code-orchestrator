/**
 * T3o card detail — pure view (t3o-06). Everything the modal renders is a
 * prop; the connected `BoardCardDetail` wires the atoms and command dispatch.
 *
 * The card opens as a CENTRED MODAL, not a side pane, and it has the
 * prototype's two forms (`.plans/prototype/T3 Code Kanban v4.dc.html`):
 *
 * - **Backlog and Sprint** — a 760px sheet. The work has not started, so the
 *   card is what you read: brief, dependencies and threads on the left, the
 *   stage action, labels, the stage ladder and provenance in a 244px rail.
 * - **Planning onward** — a 1220px working surface. The card's thread runs in
 *   the modal (`BoardCardThreadPane`), with everything else stacked into a
 *   336px rail beside it and the brief one tab away. This is the prototype's
 *   `hasThreadPane` split, at its exact stage boundary.
 *
 * `BoardCardDetailPanel` is the sheet's contents, split out so the markup
 * stays testable with `renderToStaticMarkup` (the dialog itself portals, and
 * portals render nothing on the server). The D7 line is unchanged: the modal
 * renders from `board.subscribeCard` detail, the column view never does.
 *
 * The modal renders fully for an archived card whose worktree is long gone —
 * nothing here reads the repo (`projectName === null` is a first-class state,
 * not a crash). Sections with no data source yet (Plan body, Review ledger,
 * Activity) are deliberately ABSENT, not empty skeletons (no-speculative-
 * inventory); their owning specs are named in comments.
 */
import {
  BoardAdjudicatePayload,
  BoardReviewPayload,
  BoardTriagePayload,
  activeBoardCardThreadId,
  boardCardArchiveNeedsConfirmation,
  boardStageIndex,
  boardStagesInOrder,
  boardStageWithRole,
  isBoardReviewBlockingSeverity,
  liveBoardCardDependents,
  parseReviewStepId,
  type BoardAdjudicatePayload as BoardAdjudicatePayloadType,
  type BoardCardDetail,
  type BoardCardId,
  type BoardCardThreadShell,
  type BoardCardThreadState,
  type BoardLabel,
  type BoardLabelId,
  type BoardReviewFinding,
  type BoardReviewPayload as BoardReviewPayloadType,
  type BoardStageDefinition,
  type BoardStageId,
  type BoardState,
  type BoardStepCompletion,
  type BoardTriagePayload as BoardTriagePayloadType,
  type EnvironmentId,
  type ThreadId,
} from "@t3tools/contracts";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { Link } from "@tanstack/react-router";
import {
  ArchiveIcon,
  ArchiveRestoreIcon,
  ArrowRightIcon,
  CheckIcon,
  ChevronLeftIcon,
  CircleAlertIcon,
  EllipsisVerticalIcon,
  ExternalLinkIcon,
  FileIcon,
  FileTextIcon,
  LockIcon,
  MessageSquareIcon,
  XIcon,
} from "lucide-react";
import { Suspense, lazy, useState } from "react";

import { Button } from "../components/ui/button";
import { Dialog, DialogPopup } from "../components/ui/dialog";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "../components/ui/menu";
import { Textarea } from "../components/ui/textarea";
import { cn } from "../lib/utils";
import { formatRelativeTimeLabel } from "../timestampFormat";
import { BoardArchiveConfirmDialog } from "./BoardArchiveConfirmDialog";
import { BoardLabelChips } from "./BoardLabelChips";
import { BoardLabelField } from "./BoardLabelField";
import {
  BoardDependencySection,
  BoardSectionHeading as SectionHeading,
  type BoardDependencyEntry,
} from "./BoardCardFields";
import { BoardSearchAddPicker, type BoardPickerOption } from "./BoardSearchAddPicker";
import type { BoardThreadStageRestart } from "./BoardCardThreadAddMenu";
import { BoardCardActivityRail, type BoardActivityAgentLookup } from "./BoardCardActivityRail";
import { boardStageLabel } from "./boardStages";
import { boardStagePrimaryAction, isBoardStageManuallySelectable } from "./boardStageActions";

/** A `BoardState` view over a bare stage list, so the read-model stage helpers
    apply inside this pure view. */
function stageStateOf(stages: ReadonlyArray<BoardStageDefinition>): BoardState {
  return { cards: [], stages, nextCardNumberByProject: {} };
}

/** One id, so the dialog can label itself from the title the panel renders
    (the panel is mounted outside the dialog context by its tests). */
const CARD_TITLE_ID = "board-card-detail-title";

/**
 * The thread pane mounts the whole chat, so it loads only when a card that
 * has one is opened — the board's own chunk stays small, and the board never
 * pays for the chat it is not showing.
 */
const BoardCardThreadPane = lazy(() =>
  import("./BoardCardThreadPane").then((module) => ({ default: module.BoardCardThreadPane })),
);

/**
 * The plan pane pulls in the markdown renderer, so like the thread pane it
 * loads only when a card is actually shown on it — the board chunk stays lean.
 */
const BoardCardPlanPane = lazy(() =>
  import("./BoardCardPlanPane").then((module) => ({ default: module.BoardCardPlanPane })),
);

/**
 * From Planning onward the card has work running against it, so the modal
 * opens onto the thread instead of the brief — the prototype's
 * `stageIndex(status) >= 2`.
 */
export function boardCardHasThreadPane(
  stages: ReadonlyArray<BoardStageDefinition>,
  stage: BoardStageId,
): boolean {
  // From the third stage onward the card has work running against it, so the
  // modal opens onto the thread instead of the brief — the prototype's
  // `stageIndex(status) >= 2`, now over the user-defined stage order (D13).
  return boardStageIndex(stageStateOf(stages), stage) >= 2;
}

/** Named for the modal that first rendered it; the shape is shared with the
    create dialog, so it lives in `BoardCardFields`. */
export type BoardDetailDependency = BoardDependencyEntry;

/** The rail in the working-surface layout's right rail. Absent when the card
    has no activity — not an empty skeleton (no-speculative-inventory). */
function ActivitySection({
  detail,
  stages,
  agents,
}: {
  readonly detail: BoardCardDetail;
  readonly stages: ReadonlyArray<BoardStageDefinition>;
  readonly agents: BoardActivityAgentLookup | undefined;
}) {
  if (detail.activity.length === 0) return null;
  return (
    <div className="flex flex-col gap-2 border-t border-border p-3.5">
      <SectionHeading>Activity</SectionHeading>
      <BoardCardActivityRail agents={agents} entries={detail.activity} stages={stages} />
    </div>
  );
}

export interface BoardDetailThreadLink {
  readonly threadId: ThreadId;
  readonly role: string;
  readonly tombstoned: boolean;
  readonly title: string | null;
  readonly threadState: BoardCardThreadState;
  readonly awaitingInput: boolean;
}

export interface BoardCardDetailViewProps {
  readonly environmentId: EnvironmentId;
  readonly detail: BoardCardDetail;
  readonly catalogue: ReadonlyArray<BoardLabel>;
  /** The read-model stage list (D13): column labels, the stage ladder, and the
      per-card human-in-the-loop toggle's Build-role detection all read it. */
  readonly stages: ReadonlyArray<BoardStageDefinition>;
  /** The computed human-in-the-loop stance for this card on the Build stage
      (D6) — `null` when the card is not on the build role (no toggle shown).
      `value` is the effective boolean; `explicit` is whether the card has an
      explicit override (vs the computed default). */
  readonly humanInLoop: { readonly value: boolean; readonly explicit: boolean } | null;
  readonly onSetHumanInLoop: (value: boolean) => void;
  readonly labelsById: ReadonlyMap<BoardLabelId, BoardLabel>;
  /** Project title, or null when the project is not on disk (archived card). */
  readonly projectName: string | null;
  /** Branch of the card's active thread; null when nothing is running for it
      yet — the card itself owns no branch. */
  readonly branch: string | null;
  readonly dependencies: ReadonlyArray<BoardDetailDependency>;
  readonly dependencyOptions: ReadonlyArray<BoardPickerOption>;
  readonly threadLinks: ReadonlyArray<BoardDetailThreadLink>;
  /** Provider display names and accents for the Activity rail's agent actors
      (t3o-18, D11), resolved at render time so a renamed instance relabels its
      own history. */
  readonly agents?: BoardActivityAgentLookup | undefined;
  /** Each live-linked thread's cached todo list (t3o-18, D3), keyed by thread —
      the modal's per-tab counts and its sticky todos strip. */
  readonly threadTodos?: ReadonlyMap<ThreadId, BoardCardThreadShell> | undefined;
  readonly adoptableThreads: ReadonlyArray<BoardPickerOption>;
  /** The thread pane `+` menu's restart affordance (t3o-14): present only when
      the card's current stage auto-executes, `null` otherwise. */
  readonly stageRestart: BoardThreadStageRestart | null;
  /** Dispatch `board.card.start-stage-thread` for the card's current stage. */
  readonly onRestartStage: () => void;
  /** Create a blank server thread, link it, and resolve to its id (or `null` on
      failure) so the pane can open it. */
  readonly onCreateBlankThread: () => Promise<ThreadId | null>;
  /** Inline feedback for the last rejected command (e.g. a dependency cycle). */
  readonly feedback: string | null;
  readonly onClose: () => void;
  readonly onSetLabels: (labelIds: ReadonlyArray<BoardLabelId>) => void;
  readonly onCreateLabel: (name: string) => void;
  readonly onRecolourLabel: (labelId: BoardLabelId, colour: string) => void;
  readonly onDeleteLabel: (labelId: BoardLabelId) => void;
  readonly onUndeleteLabel: (labelId: BoardLabelId) => void;
  readonly onSaveTitle: (title: string) => void;
  readonly onSaveBrief: (brief: string | null) => void;
  readonly onAddDependency: (cardId: BoardCardId) => void;
  readonly onRemoveDependency: (cardId: BoardCardId) => void;
  readonly onMoveStage: (toStage: BoardStageId) => void;
  readonly onArchiveToggle: () => void;
  readonly onLinkThread: (threadId: ThreadId, role: string) => void;
  readonly onUnlinkThread: (threadId: ThreadId) => void;
}

export interface BoardCardDetailPanelProps extends BoardCardDetailViewProps {
  /** Fullscreen is the dialog's business, so the frame owns the flag and the
      pane's control just toggles it. */
  readonly maximised: boolean;
  readonly onToggleMaximised: () => void;
}

const THREAD_STATE_LABEL: Record<BoardCardThreadState, string> = {
  working: "Working",
  waiting: "Waiting",
  stopped: "Stopped",
  none: "Idle",
};

/**
 * The card's title, click-to-edit in place — the prototype's affordance, the
 * same one `BriefBody` has. The heading keeps `CARD_TITLE_ID` in both states so
 * the dialog stays labelled while the title is being typed.
 *
 * A blank title is a cancel, not a clear: `board.card.update` takes a non-empty
 * title, and a card with no title is nothing anyone can find again.
 */
function TitleBody({
  title,
  onSave,
}: {
  readonly title: string;
  readonly onSave: (title: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(title);
  const commit = () => {
    const trimmed = draft.replace(/\s+/g, " ").trim();
    if (trimmed.length > 0 && trimmed !== title) onSave(trimmed);
    setEditing(false);
  };
  const frame =
    "mx-2.5 mt-2 shrink-0 rounded-[7px] px-1.5 text-[21px]/[1.25] font-semibold tracking-[-0.015em] text-pretty text-foreground";
  if (editing) {
    return (
      <h2
        className={cn(frame, "flex bg-muted shadow-[0_0_0_1px_var(--primary)]")}
        id={CARD_TITLE_ID}
      >
        {/* A textarea, not an input: long titles wrap here exactly as they do
            at rest, so committing never reflows the sheet. */}
        <textarea
          autoFocus
          className="field-sizing-content w-full resize-none bg-transparent text-inherit outline-none"
          onBlur={commit}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              setDraft(title);
              setEditing(false);
            }
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              commit();
            }
          }}
          rows={1}
          value={draft}
        />
      </h2>
    );
  }
  return (
    <h2 className={cn(frame, "cursor-text hover:bg-accent")} id={CARD_TITLE_ID}>
      <button
        className="block w-full cursor-text text-left"
        onClick={() => {
          setDraft(title);
          setEditing(true);
        }}
        title="Click to edit"
        type="button"
      >
        {title}
      </button>
    </h2>
  );
}

function BriefBody({
  brief,
  onSave,
}: {
  readonly brief: string | null;
  readonly onSave: (brief: string | null) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(brief ?? "");
  const commit = () => {
    const trimmed = draft.trim();
    const next = trimmed.length === 0 ? null : trimmed;
    if (next !== (brief ?? null)) onSave(next);
    setEditing(false);
  };
  if (editing) {
    return (
      <Textarea
        autoFocus
        className="min-h-24 text-[13.5px]/[1.6]"
        onBlur={commit}
        onChange={(event) => setDraft(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            setDraft(brief ?? "");
            setEditing(false);
          }
          if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) commit();
        }}
        placeholder="Describe the work… (⌘⏎ to save, Esc to cancel)"
        value={draft}
      />
    );
  }
  // Click-to-edit in place, the prototype's affordance: the brief reads as
  // prose until you touch it, with the hover tint as the only hint.
  return (
    <button
      className="-mx-[7px] -my-1 rounded-lg px-[7px] py-1 text-left text-[13.5px]/[1.6] hover:bg-accent"
      onClick={() => {
        setDraft(brief ?? "");
        setEditing(true);
      }}
      title="Click to edit"
      type="button"
    >
      {brief === null ? (
        <span className="text-muted-foreground">Add a brief…</span>
      ) : (
        <span className="whitespace-pre-wrap text-pretty text-foreground">{brief}</span>
      )}
    </button>
  );
}

function DependenciesSection(props: BoardCardDetailViewProps) {
  return (
    <BoardDependencySection
      dependencies={props.dependencies}
      onAdd={props.onAddDependency}
      onRemove={props.onRemoveDependency}
      options={props.dependencyOptions}
      stages={props.stages}
    />
  );
}

/** The linked-thread list — the narrow form's stand-in for the thread pane,
    which is where adoption happens before the work starts. */
function ThreadsSection(props: BoardCardDetailViewProps) {
  const activeThreadId = activeBoardCardThreadId(props.detail.card.threadLinks);
  return (
    <>
      <div className="mb-[7px] flex items-center gap-1.5">
        <SectionHeading>Threads</SectionHeading>
        <BoardSearchAddPicker
          label="Adopt"
          onPick={(id) => props.onLinkThread(id as ThreadId, "linked")}
          options={props.adoptableThreads}
          placeholder="Search threads…"
        />
      </div>
      {props.threadLinks.length === 0 ? (
        <p className="text-[13px] text-muted-foreground">No linked threads.</p>
      ) : (
        <ul className="flex flex-col gap-1.5">
          {props.threadLinks.map((link) => (
            <li
              className="flex items-center gap-[9px] rounded-lg border border-border bg-muted px-2.5 py-[7px]"
              key={link.threadId}
            >
              <div className="flex min-w-0 flex-1 flex-col">
                <div className="flex items-center gap-1.5">
                  <span
                    className={cn(
                      "min-w-0 truncate text-[13px] text-foreground",
                      link.tombstoned && "text-muted-foreground line-through",
                    )}
                  >
                    {link.title ?? "Deleted thread"}
                  </span>
                  {link.awaitingInput ? (
                    <CircleAlertIcon className="size-3 shrink-0 text-info-foreground" />
                  ) : null}
                </div>
                <span className="text-[10.5px] text-muted-foreground">
                  {link.role}
                  {link.tombstoned ? " · deleted" : ` · ${THREAD_STATE_LABEL[link.threadState]}`}
                  {link.threadId === activeThreadId && !link.tombstoned ? " · active" : ""}
                </span>
              </div>
              {link.tombstoned ? null : (
                <Link
                  className="shrink-0 rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
                  params={{ environmentId: props.environmentId, threadId: link.threadId }}
                  title="Open thread"
                  to="/$environmentId/$threadId"
                >
                  <ExternalLinkIcon className="size-3.5" />
                </Link>
              )}
              {link.tombstoned ? null : (
                <Button
                  onClick={() => props.onUnlinkThread(link.threadId)}
                  size="icon-xs"
                  title="Unlink thread"
                  variant="ghost"
                >
                  <XIcon />
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}
    </>
  );
}

/** Every stage, as a ladder — the current one ticked. Replaces a dropdown:
    the pipeline is the board's spine, so it reads better as a visible list
    than as a collapsed select. */
function StageLadder({
  stage,
  stages,
  onMoveStage,
}: {
  readonly stage: BoardStageId;
  readonly stages: ReadonlyArray<BoardStageDefinition>;
  readonly onMoveStage: (toStage: BoardStageId) => void;
}) {
  return (
    <div className="flex flex-col gap-px">
      {boardStagesInOrder(stageStateOf(stages)).map((candidate) => {
        const current = candidate.stageId === stage;
        const rung = (
          <>
            <span className="size-1.5 shrink-0 rounded-full bg-muted-foreground/45" />
            <span className="flex-1 text-left">{candidate.label}</span>
            {current ? <CheckIcon className="size-3.5 shrink-0" /> : null}
          </>
        );
        const className = cn(
          "flex h-[26px] items-center gap-2 rounded-[7px] px-2 text-[12.5px]",
          current ? "bg-accent font-medium text-foreground" : "text-muted-foreground",
        );
        // The build role onward is granted by the pipeline, not chosen — those
        // rungs render as plain rows so the ladder still reads whole.
        if (current || !isBoardStageManuallySelectable(stages, candidate.stageId)) {
          return (
            <div
              aria-current={current ? "true" : undefined}
              className={className}
              key={candidate.stageId}
            >
              {rung}
            </div>
          );
        }
        return (
          <button
            className={cn(className, "hover:bg-accent/50")}
            key={candidate.stageId}
            onClick={() => onMoveStage(candidate.stageId)}
            type="button"
          >
            {rung}
          </button>
        );
      })}
    </div>
  );
}

/** The card's labels as pills over one autocomplete — `BoardLabelField`. */
function LabelSection({
  selected,
  catalogue,
  onSetLabels,
  onCreateLabel,
  onRecolourLabel,
  onDeleteLabel,
  onUndeleteLabel,
}: {
  readonly selected: ReadonlyArray<BoardLabelId>;
  readonly catalogue: ReadonlyArray<BoardLabel>;
  readonly onSetLabels: (labelIds: ReadonlyArray<BoardLabelId>) => void;
  readonly onCreateLabel: (name: string) => void;
  readonly onRecolourLabel: (labelId: BoardLabelId, colour: string) => void;
  readonly onDeleteLabel: (labelId: BoardLabelId) => void;
  readonly onUndeleteLabel: (labelId: BoardLabelId) => void;
}) {
  return (
    <>
      <SectionHeading>Label</SectionHeading>
      <BoardLabelField
        catalogue={catalogue}
        onCreate={onCreateLabel}
        onDelete={onDeleteLabel}
        onRecolour={onRecolourLabel}
        onToggle={(labelId) =>
          onSetLabels(
            selected.includes(labelId)
              ? selected.filter((id) => id !== labelId)
              : [...selected, labelId],
          )
        }
        onUndelete={onUndeleteLabel}
        selectedLabelIds={selected}
      />
    </>
  );
}

/** Stage action, blocked reason and archive — the things you *do* to a card,
    kept together at the top of the rail. */
function ActionsSection({
  props,
  unmet,
}: {
  readonly props: BoardCardDetailViewProps;
  readonly unmet: ReadonlyArray<BoardDetailDependency>;
}) {
  const { card } = props.detail;
  const archived = card.archivedAt !== null;
  const primaryAction = boardStagePrimaryAction(props.stages, card.stage);
  const forward = primaryAction !== null && !archived ? primaryAction : null;
  // The per-card human-in-the-loop toggle shows only on the Build role (D6);
  // `props.humanInLoop` is non-null exactly then.
  const humanInLoop = archived ? null : props.humanInLoop;
  if (forward === null && !card.blocked && humanInLoop === null) return null;
  return (
    <div className="flex flex-col gap-2 p-3.5">
      {forward !== null ? (
        <button
          className={cn(
            "inline-flex h-[34px] items-center justify-center gap-[7px] rounded-lg border px-3 text-[13px] font-medium shadow-xs",
            forward.emphasised
              ? "border-primary bg-primary text-primary-foreground hover:bg-primary/90"
              : "border-input bg-popover text-foreground hover:bg-accent",
            // The dependency gate is not overridable (D18) — the button says
            // so rather than bouncing off the decider.
            card.blocked && "cursor-not-allowed opacity-50",
          )}
          disabled={card.blocked}
          onClick={() => props.onMoveStage(forward.toStage)}
          title={card.blocked ? "Blocked by unmet dependencies" : undefined}
          type="button"
        >
          <ArrowRightIcon className="size-3.5" />
          {forward.label}
        </button>
      ) : null}
      {card.blocked ? (
        <div className="flex gap-[7px] rounded-lg border border-warning/35 bg-warning/8 px-2.5 py-2.5 text-[11.5px]/[1.45] text-warning-foreground">
          <LockIcon className="mt-px size-3.5 shrink-0" />
          <span>
            {unmet.length === 0
              ? "Blocked by unmet dependencies"
              : `Blocked by ${unmet.map((dependency) => dependency.key).join(", ")}`}
          </span>
        </div>
      ) : null}
      {humanInLoop !== null ? (
        <label className="flex items-center justify-between gap-2 rounded-lg border border-input bg-popover px-2.5 py-2 text-[12.5px]">
          <span className="flex flex-col">
            <span className="font-medium text-foreground">Human in the loop</span>
            <span className="text-[11px] text-muted-foreground">
              {humanInLoop.explicit
                ? humanInLoop.value
                  ? "You drive the build in conversation."
                  : "The build runs unattended."
                : humanInLoop.value
                  ? "Default: conversation (no plan yet)."
                  : "Default: unattended (a plan exists)."}
            </span>
          </span>
          <input
            aria-label="Human in the loop"
            checked={humanInLoop.value}
            className="size-4 shrink-0"
            onChange={(event) => props.onSetHumanInLoop(event.target.checked)}
            type="checkbox"
          />
        </label>
      ) : null}
    </div>
  );
}

// ── Review findings (t3o-16, D9) ───────────────────────────────────────
// With no PR to anchor them to (D6), the review loop's findings live on the
// card. The panel reads the SAME opaque completion payloads the agents write —
// review findings, triage dispositions, adjudication verdicts — grouped by
// round. It parses payloads, never branches on the stage's role, so it is not
// a third dispatch on `review` (AC10): a card with no review completions
// renders nothing at all (absent, not empty).

const decodeReviewPayload = Schema.decodeUnknownOption(BoardReviewPayload);
const decodeTriagePayload = Schema.decodeUnknownOption(BoardTriagePayload);
const decodeAdjudicatePayload = Schema.decodeUnknownOption(BoardAdjudicatePayload);

function parsePayloadJson(payload: string | null): unknown {
  if (payload === null) return undefined;
  try {
    return JSON.parse(payload);
  } catch {
    return undefined;
  }
}

interface ReviewRound {
  readonly round: number;
  readonly review: BoardReviewPayloadType | null;
  readonly reviewMalformed: boolean;
  readonly triage: BoardTriagePayloadType | null;
  readonly adjudicate: BoardAdjudicatePayloadType | null;
}

/** Group a card's completions into review rounds (D8/D9). Pure over the
    completion list, so the same round-scoped step ids the executor mints drive
    the render. */
function groupReviewRounds(completions: ReadonlyArray<BoardStepCompletion>): ReviewRound[] {
  const byRound = new Map<
    number,
    { review?: BoardStepCompletion; triage?: BoardStepCompletion; adjudicate?: BoardStepCompletion }
  >();
  for (const completion of completions) {
    const parsed = parseReviewStepId(completion.stepId);
    if (parsed === null) continue;
    const entry = byRound.get(parsed.round) ?? {};
    entry[parsed.phase] = completion;
    byRound.set(parsed.round, entry);
  }
  return [...byRound.entries()]
    .sort(([a], [b]) => a - b)
    .map(([round, entry]) => {
      const reviewJson = entry.review ? parsePayloadJson(entry.review.payload) : undefined;
      const review = entry.review ? decodeReviewPayload(reviewJson) : Option.none();
      const triage = entry.triage
        ? decodeTriagePayload(parsePayloadJson(entry.triage.payload))
        : Option.none();
      const adjudicate = entry.adjudicate
        ? decodeAdjudicatePayload(parsePayloadJson(entry.adjudicate.payload))
        : Option.none();
      return {
        round,
        review: Option.getOrNull(review),
        // A recorded review phase whose payload will not parse is a broken
        // reviewer, surfaced as such rather than silently dropped.
        reviewMalformed: entry.review !== undefined && Option.isNone(review),
        triage: Option.getOrNull(triage),
        adjudicate: Option.getOrNull(adjudicate),
      };
    });
}

const SEVERITY_STYLES: Record<BoardReviewFinding["severity"], string> = {
  critical: "border-destructive/40 bg-destructive/10 text-destructive-foreground",
  improvement: "border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-300",
  nitpick: "border-border/60 bg-muted text-muted-foreground",
};

function ReviewFindingsSection({
  completions,
}: {
  readonly completions: ReadonlyArray<BoardStepCompletion>;
}) {
  const rounds = groupReviewRounds(completions);
  if (rounds.length === 0) return null;
  return (
    <div className="flex flex-col gap-3 border-t border-border p-3.5">
      <SectionHeading>Code review</SectionHeading>
      {rounds.map((round) => {
        const findings = round.review?.findings ?? [];
        const blocking = findings.filter((f) => isBoardReviewBlockingSeverity(f.severity));
        const dispositionsByFinding = new Map(
          (round.triage?.dispositions ?? []).map((d) => [d.findingId, d]),
        );
        const verdictsByFinding = new Map(
          (round.adjudicate?.verdicts ?? []).map((v) => [v.findingId, v]),
        );
        return (
          <div key={round.round} className="flex flex-col gap-2">
            <div className="flex items-center gap-2">
              <span className="text-[12px] font-semibold text-foreground">Round {round.round}</span>
              <span className="text-[11px] text-muted-foreground">
                {round.reviewMalformed
                  ? "reviewer payload unreadable"
                  : round.review === null
                    ? "in progress"
                    : blocking.length === 0
                      ? "no blocking findings"
                      : `${blocking.length} blocking`}
              </span>
            </div>
            {findings.length === 0 ? null : (
              <ul className="flex flex-col gap-1.5">
                {findings.map((finding) => {
                  const disposition = dispositionsByFinding.get(finding.id);
                  const verdict = verdictsByFinding.get(finding.id);
                  return (
                    <li
                      key={finding.id}
                      className="rounded-md border border-border/50 px-2 py-1.5 text-[12px]"
                    >
                      <div className="flex flex-wrap items-center gap-1.5">
                        <span
                          className={cn(
                            "rounded-full border px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide",
                            SEVERITY_STYLES[finding.severity],
                          )}
                        >
                          {finding.severity}
                        </span>
                        <span className="font-medium text-foreground">{finding.title}</span>
                        {finding.file !== null ? (
                          <span className="text-[11px] text-muted-foreground">
                            {finding.file}
                            {finding.line !== null ? `:${finding.line}` : ""}
                          </span>
                        ) : null}
                      </div>
                      {finding.detail.trim().length > 0 ? (
                        <p className="mt-1 text-[11.5px] leading-[1.4] text-muted-foreground">
                          {finding.detail}
                        </p>
                      ) : null}
                      {disposition !== undefined || verdict !== undefined ? (
                        <div className="mt-1 flex flex-wrap items-center gap-1.5 text-[11px]">
                          {disposition !== undefined ? (
                            <span className="rounded border border-border/60 px-1.5 py-0.5 text-muted-foreground">
                              triage: {disposition.action}
                              {disposition.note.trim().length > 0 ? ` — ${disposition.note}` : ""}
                            </span>
                          ) : null}
                          {verdict !== undefined ? (
                            <span className="rounded border border-border/60 px-1.5 py-0.5 text-muted-foreground">
                              {verdict.verdict}
                              {verdict.note.trim().length > 0 ? ` — ${verdict.note}` : ""}
                            </span>
                          ) : null}
                        </div>
                      ) : null}
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        );
      })}
    </div>
  );
}

function InfoSection({ props }: { readonly props: BoardCardDetailViewProps }) {
  return (
    <div className="border-t border-border p-3.5 text-[11.5px]/[1.7] text-muted-foreground">
      <div>
        Project ·{" "}
        <span className="text-foreground">{props.projectName ?? "Project not on disk"}</span>
      </div>
      {props.branch === null ? null : (
        <div>
          Branch · <span className="text-foreground">{props.branch}</span>
        </div>
      )}
      <div>Created · {formatRelativeTimeLabel(props.detail.card.createdAt)}</div>
    </div>
  );
}

type BoardCardPane = "thread" | "plan" | "brief";

/** The header's Thread/Plan/Brief switch — only the wide form has one, because
    only it has somewhere else for the brief to live. The Plan pill appears only
    once the card has a plan; before planning writes one there is nothing to
    show, so the switch is a plain Thread/Brief pair. */
function PaneTabs({
  pane,
  hasPlan,
  onSelect,
}: {
  readonly pane: BoardCardPane;
  readonly hasPlan: boolean;
  readonly onSelect: (pane: BoardCardPane) => void;
}) {
  const tab = (value: BoardCardPane) =>
    cn(
      "inline-flex h-6 shrink-0 items-center gap-1.5 rounded-[7px] px-2.5 text-[11.5px]",
      pane === value
        ? "bg-card font-medium text-foreground shadow-[0_0_0_1px_var(--border)]"
        : "text-muted-foreground hover:text-foreground",
    );
  return (
    <div className="flex shrink-0 items-center gap-0.5 rounded-[9px] bg-accent p-0.5">
      <button className={tab("thread")} onClick={() => onSelect("thread")} type="button">
        <MessageSquareIcon className="size-3" />
        Thread
      </button>
      {hasPlan ? (
        <button className={tab("plan")} onClick={() => onSelect("plan")} type="button">
          <FileIcon className="size-3" />
          Plan
        </button>
      ) : null}
      <button className={tab("brief")} onClick={() => onSelect("brief")} type="button">
        <FileTextIcon className="size-3" />
        Brief
      </button>
    </div>
  );
}

export function BoardCardDetailPanel(props: BoardCardDetailPanelProps) {
  const { card } = props.detail;
  const archived = card.archivedAt !== null;
  const wide = boardCardHasThreadPane(props.stages, card.stage);
  // The contracts' definition of unmet, mirrored: an unknown id counts as
  // unmet (nothing can prove it finished), an archived dependency does not
  // count at all (t3o-13, D1), and everything else must be done.
  const unmet = props.dependencies.filter(
    (dependency) => !dependency.known || (!dependency.archived && dependency.stage !== "done"),
  );

  // Archiving a not-done card that live cards depend on asks first (D3); every
  // other archive, and every restore, is a single click.
  const liveDependents = liveBoardCardDependents(props.detail.dependents);
  const archiveNeedsConfirmation = boardCardArchiveNeedsConfirmation({
    stage: card.stage,
    dependents: props.detail.dependents,
  });
  const [archiveConfirmOpen, setArchiveConfirmOpen] = useState(false);

  const [pane, setPane] = useState<BoardCardPane>("thread");
  // The plan is a first-class entity, so its pill only exists once one is
  // written; if the card loses its plans while the pane is open, fall back to
  // the thread rather than render an empty surface.
  const hasPlan = props.detail.plans.length > 0;
  const activePane: BoardCardPane = pane === "plan" && !hasPlan ? "thread" : pane;
  // Which tab the thread pane is on. Absent means "the card's active thread",
  // so a newly adopted thread opens without the panel tracking it.
  const [selectedThreadId, setSelectedThreadId] = useState<ThreadId | null>(null);
  const selectedThread =
    props.threadLinks.find((link) => link.threadId === selectedThreadId)?.threadId ??
    activeBoardCardThreadId(card.threadLinks);

  return (
    <>
      {/* Identity row: key, the card's labels, its stage. */}
      <div className="flex shrink-0 items-center gap-[9px] px-4 pt-4">
        <span className="shrink-0 text-[11.5px] font-medium text-muted-foreground">{card.key}</span>
        <BoardLabelChips labelIds={card.labels} labelsById={props.labelsById} />
        <span className="inline-flex h-[18px] shrink-0 items-center rounded-md bg-muted-foreground/14 px-[7px] text-[11px] font-medium text-foreground">
          {boardStageLabel(props.stages, card.stage)}
        </span>
        {archived ? (
          <span className="inline-flex h-[18px] shrink-0 items-center rounded-md bg-muted px-[7px] text-[11px] font-medium text-muted-foreground">
            Archived
          </span>
        ) : null}
        <span className="flex-1" />
        {wide ? <PaneTabs hasPlan={hasPlan} onSelect={setPane} pane={activePane} /> : null}
        <Menu>
          <MenuTrigger
            aria-label="More actions"
            className="inline-flex size-7 shrink-0 items-center justify-center rounded-lg text-muted-foreground hover:bg-accent hover:text-foreground data-popup-open:bg-accent data-popup-open:text-foreground"
            title="More actions"
          >
            <EllipsisVerticalIcon className="size-[15px]" />
          </MenuTrigger>
          <MenuPopup align="end" className="min-w-42">
            <MenuItem
              onClick={() => {
                if (!archived && archiveNeedsConfirmation) {
                  setArchiveConfirmOpen(true);
                  return;
                }
                props.onArchiveToggle();
              }}
            >
              {archived ? <ArchiveRestoreIcon /> : <ArchiveIcon />}
              {archived ? "Restore card" : "Archive card"}
            </MenuItem>
          </MenuPopup>
        </Menu>
        <BoardArchiveConfirmDialog
          cardKey={card.key}
          dependents={liveDependents}
          onConfirm={props.onArchiveToggle}
          onOpenChange={setArchiveConfirmOpen}
          open={archiveConfirmOpen}
        />
        <button
          className="inline-flex size-7 shrink-0 items-center justify-center rounded-lg text-muted-foreground hover:bg-accent hover:text-foreground"
          onClick={props.onClose}
          title="Close"
          type="button"
        >
          <XIcon className="size-[15px]" />
        </button>
      </div>

      <TitleBody onSave={props.onSaveTitle} title={card.title} />

      {wide ? (
        <div className="mt-3 grid min-h-0 flex-1 grid-cols-[minmax(0,1fr)_336px] border-t border-border">
          {activePane === "brief" ? (
            <section className="flex min-h-0 min-w-0 flex-col border-r border-border bg-muted/55">
              <div className="flex h-11 shrink-0 items-center gap-2 border-b border-border pl-3.5 pr-3">
                <SectionHeading>Brief</SectionHeading>
                <span className="flex-1" />
                <button
                  className="inline-flex h-6 shrink-0 items-center gap-1 rounded-[7px] border border-input bg-popover pl-1.5 pr-2.5 text-[11.5px] font-medium text-muted-foreground shadow-xs hover:bg-accent hover:text-foreground"
                  onClick={() => setPane("thread")}
                  type="button"
                >
                  <ChevronLeftIcon className="size-3" />
                  Back to thread
                </button>
              </div>
              <div className="min-h-0 flex-1 overflow-y-auto px-4.5 pt-4 pb-6">
                <BriefBody brief={props.detail.brief} onSave={props.onSaveBrief} />
              </div>
            </section>
          ) : activePane === "plan" ? (
            <Suspense fallback={<div className="min-h-0 border-r border-border bg-muted/55" />}>
              <BoardCardPlanPane
                cardKey={card.key}
                onBackToThread={() => setPane("thread")}
                plans={props.detail.plans}
              />
            </Suspense>
          ) : (
            <Suspense fallback={<div className="min-h-0 border-r border-border bg-muted/55" />}>
              <BoardCardThreadPane
                adoptableThreads={props.adoptableThreads}
                cardKey={card.key}
                environmentId={props.environmentId}
                maximised={props.maximised}
                onCreateBlankThread={props.onCreateBlankThread}
                onLinkThread={props.onLinkThread}
                onRestartStage={props.onRestartStage}
                onSelectThread={setSelectedThreadId}
                onToggleMaximised={props.onToggleMaximised}
                onUnlinkThread={props.onUnlinkThread}
                selectedThreadId={selectedThread}
                stageRestart={props.stageRestart}
                threadLinks={props.threadLinks}
                threadTodos={props.threadTodos}
              />
            </Suspense>
          )}

          {/* The rail: everything about the card that is not the conversation. */}
          <div className="flex min-h-0 flex-col overflow-y-auto [&>*:first-child]:border-t-0">
            <ActionsSection props={props} unmet={unmet} />
            {props.feedback !== null ? (
              <p className="mx-3.5 mb-3.5 rounded-md bg-destructive/10 px-2 py-1.5 text-[12px] text-destructive-foreground">
                {props.feedback}
              </p>
            ) : null}
            <div className="border-t border-border p-3.5">
              <DependenciesSection {...props} />
            </div>
            <ActivitySection agents={props.agents} detail={props.detail} stages={props.stages} />
            <div className="flex flex-col gap-2 border-t border-border p-3.5">
              <LabelSection
                catalogue={props.catalogue}
                onCreateLabel={props.onCreateLabel}
                onDeleteLabel={props.onDeleteLabel}
                onRecolourLabel={props.onRecolourLabel}
                onSetLabels={props.onSetLabels}
                onUndeleteLabel={props.onUndeleteLabel}
                selected={card.labels}
              />
            </div>
            <div className="flex flex-col gap-2 border-t border-border p-3.5">
              <SectionHeading>Stage</SectionHeading>
              <StageLadder
                onMoveStage={props.onMoveStage}
                stage={card.stage}
                stages={props.stages}
              />
            </div>
            <ReviewFindingsSection completions={props.detail.stepCompletions} />
            <InfoSection props={props} />
          </div>
        </div>
      ) : (
        <div className="mt-3 flex min-h-0 flex-[0_1_auto] flex-col overflow-y-auto border-t border-border">
          <div className="flex items-stretch">
            {/* ── Left: what the card is ─────────────────────────────── */}
            <div className="flex min-w-0 flex-1 flex-col gap-[18px] px-5 pt-4 pb-5">
              {props.feedback !== null ? (
                <p className="rounded-md bg-destructive/10 px-2 py-1.5 text-[12px] text-destructive-foreground">
                  {props.feedback}
                </p>
              ) : null}

              <div className="min-w-0">
                <SectionHeading className="mb-[7px]">Brief</SectionHeading>
                <BriefBody brief={props.detail.brief} onSave={props.onSaveBrief} />
              </div>

              <div className="min-w-0">
                <DependenciesSection {...props} />
              </div>

              {/* The mockup's pre-Planning card has no Threads section —
                  adoption belongs to the thread pane. A card that already
                  carries links still shows them, so state is never hidden. */}
              {props.threadLinks.length === 0 ? null : (
                <div className="min-w-0">
                  <ThreadsSection {...props} />
                </div>
              )}

              {props.detail.activity.length === 0 ? null : (
                <div className="min-w-0">
                  <SectionHeading className="mb-[7px]">Activity</SectionHeading>
                  <BoardCardActivityRail
                    agents={props.agents}
                    entries={props.detail.activity}
                    stages={props.stages}
                  />
                </div>
              )}
            </div>

            {/* ── Right: what you can do with it ──────────────────────── */}
            <div className="flex w-[244px] shrink-0 flex-col border-l border-border [&>*:first-child]:border-t-0">
              <ActionsSection props={props} unmet={unmet} />
              <div className="flex flex-col gap-2 border-t border-border p-3.5">
                <LabelSection
                  catalogue={props.catalogue}
                  onCreateLabel={props.onCreateLabel}
                  onDeleteLabel={props.onDeleteLabel}
                  onRecolourLabel={props.onRecolourLabel}
                  onSetLabels={props.onSetLabels}
                  onUndeleteLabel={props.onUndeleteLabel}
                  selected={card.labels}
                />
              </div>
              <div className="flex flex-col gap-2 border-t border-border p-3.5">
                <SectionHeading>Stage</SectionHeading>
                <StageLadder
                  onMoveStage={props.onMoveStage}
                  stage={card.stage}
                  stages={props.stages}
                />
              </div>
              <InfoSection props={props} />
            </div>
          </div>
        </div>
      )}
    </>
  );
}

export function BoardCardDetailView(props: BoardCardDetailViewProps) {
  const [maximised, setMaximised] = useState(false);
  const wide = boardCardHasThreadPane(props.stages, props.detail.card.stage);
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) props.onClose();
      }}
    >
      <BoardCardDetailPopup cardId={props.detail.card.id} maximised={wide && maximised} wide={wide}>
        <BoardCardDetailPanel
          {...props}
          maximised={maximised}
          onToggleMaximised={() => setMaximised((current) => !current)}
        />
      </BoardCardDetailPopup>
    </Dialog>
  );
}

/** The sheet itself: the prototype's card modal — 760px while the card is
    still a plan, 1220px once a thread runs in it, edge-to-edge in fullscreen.
    Shared with the loading state so the frame never jumps once the detail
    arrives. */
export function BoardCardDetailPopup({
  cardId,
  wide = false,
  maximised = false,
  children,
}: {
  readonly cardId: BoardCardId | null;
  readonly wide?: boolean;
  readonly maximised?: boolean;
  readonly children: React.ReactNode;
}) {
  return (
    <DialogPopup
      aria-labelledby={CARD_TITLE_ID}
      className={cn(
        "overflow-hidden p-0",
        maximised
          ? "fixed inset-0 h-screen max-h-none w-screen max-w-none rounded-none border-0"
          : wide
            ? "h-[86vh] max-h-[86vh] w-[min(1220px,100%)] max-w-[1220px]"
            : "max-h-[86vh] w-[min(760px,100%)] max-w-[760px]",
      )}
      showCloseButton={false}
      {...(cardId === null ? {} : { "data-board-card-detail": cardId })}
    >
      {children}
    </DialogPopup>
  );
}
