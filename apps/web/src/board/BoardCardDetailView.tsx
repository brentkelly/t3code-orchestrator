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
  BOARD_STAGES,
  activeBoardCardThreadId,
  boardStageIndex,
  type BoardCardDetail,
  type BoardCardId,
  type BoardCardThreadState,
  type BoardLabel,
  type BoardLabelId,
  type BoardStage,
  type EnvironmentId,
  type ThreadId,
} from "@t3tools/contracts";
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
import { BoardLabelChips } from "./BoardLabelChips";
import { BoardLabelField } from "./BoardLabelField";
import { BoardSearchAddPicker, type BoardPickerOption } from "./BoardSearchAddPicker";
import { BOARD_STAGE_LABELS } from "./boardStages";
import { boardStagePrimaryAction } from "./boardStageActions";

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
 * From Planning onward the card has work running against it, so the modal
 * opens onto the thread instead of the brief — the prototype's
 * `stageIndex(status) >= 2`.
 */
export function boardCardHasThreadPane(stage: BoardStage): boolean {
  return boardStageIndex(stage) >= boardStageIndex("planning");
}

export interface BoardDetailDependency {
  readonly cardId: BoardCardId;
  readonly key: string;
  readonly title: string | null;
  readonly stage: BoardStage;
  /** False when the dependency id resolves to no live card (deleted, or
      another environment) — rendered as an unknown reference, never hidden. */
  readonly known: boolean;
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
  readonly labelsById: ReadonlyMap<BoardLabelId, BoardLabel>;
  /** Project title, or null when the project is not on disk (archived card). */
  readonly projectName: string | null;
  /** Branch of the card's active thread; null when nothing is running for it
      yet — the card itself owns no branch. */
  readonly branch: string | null;
  readonly dependencies: ReadonlyArray<BoardDetailDependency>;
  readonly dependencyOptions: ReadonlyArray<BoardPickerOption>;
  readonly threadLinks: ReadonlyArray<BoardDetailThreadLink>;
  readonly adoptableThreads: ReadonlyArray<BoardPickerOption>;
  /** Inline feedback for the last rejected command (e.g. a dependency cycle). */
  readonly feedback: string | null;
  readonly onClose: () => void;
  readonly onSetLabels: (labelIds: ReadonlyArray<BoardLabelId>) => void;
  readonly onCreateLabel: (name: string) => void;
  readonly onRecolourLabel: (labelId: BoardLabelId, colour: string) => void;
  readonly onDeleteLabel: (labelId: BoardLabelId) => void;
  readonly onUndeleteLabel: (labelId: BoardLabelId) => void;
  readonly onSaveBrief: (brief: string | null) => void;
  readonly onAddDependency: (cardId: BoardCardId) => void;
  readonly onRemoveDependency: (cardId: BoardCardId) => void;
  readonly onMoveStage: (toStage: BoardStage) => void;
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

/** The prototype's section label: 11px, uppercase, widely tracked. */
function SectionHeading({
  children,
  className,
}: {
  readonly children: React.ReactNode;
  readonly className?: string;
}) {
  return (
    <h3
      className={cn(
        "text-[11px] font-semibold uppercase tracking-[0.07em] text-muted-foreground",
        className,
      )}
    >
      {children}
    </h3>
  );
}

const THREAD_STATE_LABEL: Record<BoardCardThreadState, string> = {
  working: "Working",
  waiting: "Waiting",
  stopped: "Stopped",
  none: "Idle",
};

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
    <>
      <div className="mb-[7px] flex items-center gap-1.5">
        <SectionHeading>Dependencies</SectionHeading>
        <BoardSearchAddPicker
          label="Add"
          onPick={(id) => props.onAddDependency(id as BoardCardId)}
          options={props.dependencyOptions}
          placeholder="Search cards…"
        />
      </div>
      {props.dependencies.length === 0 ? (
        <p className="text-[13px] text-muted-foreground">No dependencies.</p>
      ) : (
        <ul className="flex flex-col gap-1.5">
          {props.dependencies.map((dependency) => (
            <li
              className="flex items-center gap-[9px] rounded-lg border border-border bg-muted px-2.5 py-[7px]"
              key={dependency.cardId}
            >
              <span className="size-1.5 shrink-0 rounded-full bg-muted-foreground/45" />
              <span className="shrink-0 text-[11px] font-medium text-muted-foreground">
                {dependency.key}
              </span>
              <span className="min-w-0 flex-1 truncate text-[13px] text-foreground">
                {dependency.title ?? "Unknown task"}
              </span>
              <span
                className={cn(
                  "shrink-0 text-[11px]",
                  dependency.known && dependency.stage === "done"
                    ? "text-success-foreground"
                    : "text-muted-foreground",
                )}
              >
                {dependency.known ? BOARD_STAGE_LABELS[dependency.stage] : "unknown card"}
              </span>
              <Button
                onClick={() => props.onRemoveDependency(dependency.cardId)}
                size="icon-xs"
                title="Remove dependency"
                variant="ghost"
              >
                <XIcon />
              </Button>
            </li>
          ))}
        </ul>
      )}
    </>
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
  onMoveStage,
}: {
  readonly stage: BoardStage;
  readonly onMoveStage: (toStage: BoardStage) => void;
}) {
  return (
    <div className="flex flex-col gap-px">
      {BOARD_STAGES.map((candidate) => {
        const current = candidate === stage;
        return (
          <button
            aria-current={current ? "true" : undefined}
            className={cn(
              "flex h-[26px] items-center gap-2 rounded-[7px] px-2 text-[12.5px]",
              current
                ? "bg-accent font-medium text-foreground"
                : "text-muted-foreground hover:bg-accent/50",
            )}
            key={candidate}
            onClick={() => {
              if (!current) onMoveStage(candidate);
            }}
            type="button"
          >
            <span className="size-1.5 shrink-0 rounded-full bg-muted-foreground/45" />
            <span className="flex-1 text-left">{BOARD_STAGE_LABELS[candidate]}</span>
            {current ? <CheckIcon className="size-3.5 shrink-0" /> : null}
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
  const primaryAction = boardStagePrimaryAction(card.stage);
  const forward = primaryAction !== null && !archived ? primaryAction : null;
  if (forward === null && !card.blocked) return null;
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

/** The header's Thread/Brief switch — only the wide form has one, because
    only it has somewhere else for the brief to live. */
function PaneTabs({
  pane,
  onSelect,
}: {
  readonly pane: "thread" | "brief";
  readonly onSelect: (pane: "thread" | "brief") => void;
}) {
  const tab = (value: "thread" | "brief") =>
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
  const wide = boardCardHasThreadPane(card.stage);
  // A dependency is met only when its card is done; an unknown id counts as
  // unmet (nothing can prove it finished) — the contracts' definition.
  const unmet = props.dependencies.filter(
    (dependency) => !dependency.known || dependency.stage !== "done",
  );

  const [pane, setPane] = useState<"thread" | "brief">("thread");
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
          {BOARD_STAGE_LABELS[card.stage]}
        </span>
        {archived ? (
          <span className="inline-flex h-[18px] shrink-0 items-center rounded-md bg-muted px-[7px] text-[11px] font-medium text-muted-foreground">
            Archived
          </span>
        ) : null}
        <span className="flex-1" />
        {wide ? <PaneTabs onSelect={setPane} pane={pane} /> : null}
        <Menu>
          <MenuTrigger
            aria-label="More actions"
            className="inline-flex size-7 shrink-0 items-center justify-center rounded-lg text-muted-foreground hover:bg-accent hover:text-foreground data-popup-open:bg-accent data-popup-open:text-foreground"
            title="More actions"
          >
            <EllipsisVerticalIcon className="size-[15px]" />
          </MenuTrigger>
          <MenuPopup align="end" className="min-w-42">
            <MenuItem onClick={props.onArchiveToggle}>
              {archived ? <ArchiveRestoreIcon /> : <ArchiveIcon />}
              {archived ? "Restore card" : "Archive card"}
            </MenuItem>
          </MenuPopup>
        </Menu>
        <button
          className="inline-flex size-7 shrink-0 items-center justify-center rounded-lg text-muted-foreground hover:bg-accent hover:text-foreground"
          onClick={props.onClose}
          title="Close"
          type="button"
        >
          <XIcon className="size-[15px]" />
        </button>
      </div>

      <h2
        className="mx-2.5 mt-2 shrink-0 px-1.5 text-[21px]/[1.25] font-semibold tracking-[-0.015em] text-pretty text-foreground"
        id={CARD_TITLE_ID}
      >
        {card.title}
      </h2>

      {wide ? (
        <div className="mt-3 grid min-h-0 flex-1 grid-cols-[minmax(0,1fr)_336px] border-t border-border">
          {pane === "brief" ? (
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
          ) : (
            <Suspense fallback={<div className="min-h-0 border-r border-border bg-muted/55" />}>
              <BoardCardThreadPane
                adoptableThreads={props.adoptableThreads}
                cardKey={card.key}
                environmentId={props.environmentId}
                maximised={props.maximised}
                onLinkThread={props.onLinkThread}
                onSelectThread={setSelectedThreadId}
                onToggleMaximised={props.onToggleMaximised}
                onUnlinkThread={props.onUnlinkThread}
                selectedThreadId={selectedThread}
                threadLinks={props.threadLinks}
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
            {/*
              Activity (t3o-08) renders here once the card's event history
              reaches the client. Absent, not empty (no-speculative-inventory).
            */}
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
              <StageLadder onMoveStage={props.onMoveStage} stage={card.stage} />
            </div>
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

              {/*
                Activity (t3o-08) renders here once the card's event history
                reaches the client. Absent, not empty.
              */}
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
                <StageLadder onMoveStage={props.onMoveStage} stage={card.stage} />
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
  const wide = boardCardHasThreadPane(props.detail.card.stage);
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
