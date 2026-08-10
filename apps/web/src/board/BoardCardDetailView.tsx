/**
 * T3o card detail pane — pure view (t3o-06). Everything the pane renders is a
 * prop; the connected `BoardCardDetail` wires the atoms and command dispatch.
 * Splitting the view out keeps it testable with `renderToStaticMarkup` and
 * keeps the D7 line honest: the pane renders from `board.subscribeCard`
 * detail, the column view never does.
 *
 * The pane renders fully for an archived card whose worktree is long gone —
 * nothing here reads the repo (`projectName === null` is a first-class state,
 * not a crash). Sections with no data source yet (Plan body, Review ledger,
 * Activity) are deliberately ABSENT, not empty skeletons (no-speculative-
 * inventory); their owning specs are named in comments.
 */
import {
  BOARD_STAGES,
  activeBoardCardThreadId,
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
  CircleAlertIcon,
  ExternalLinkIcon,
  LockIcon,
  TagIcon,
  XIcon,
} from "lucide-react";
import { useState } from "react";

import { Button } from "../components/ui/button";
import { Popover, PopoverPopup, PopoverTrigger } from "../components/ui/popover";
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "../components/ui/select";
import { Textarea } from "../components/ui/textarea";
import { cn } from "../lib/utils";
import { BoardLabelChips } from "./BoardLabelChips";
import { BoardLabelPicker } from "./BoardLabelPicker";
import { BoardSearchAddPicker, type BoardPickerOption } from "./BoardSearchAddPicker";
import { BOARD_STAGE_LABELS } from "./boardStages";
import { boardStagePrimaryAction } from "./boardStageActions";
import { projectAccent } from "./projectAccent";

export interface BoardDetailDependency {
  readonly cardId: BoardCardId;
  readonly key: string;
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
  readonly accentName: string | null;
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

function SectionHeading({ children }: { readonly children: React.ReactNode }) {
  return (
    <h3 className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
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

function BriefSection({
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
        className="min-h-24 text-sm"
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
  return (
    <button
      className="w-full rounded-md border border-transparent px-2 py-1.5 text-left text-[13px]/[1.45] hover:border-border hover:bg-accent/40"
      onClick={() => {
        setDraft(brief ?? "");
        setEditing(true);
      }}
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

export function BoardCardDetailView(props: BoardCardDetailViewProps) {
  const { card } = props.detail;
  const accent = projectAccent(card.projectId, props.accentName);
  const archived = card.archivedAt !== null;
  const primaryAction = boardStagePrimaryAction(card.stage);
  const activeThreadId = activeBoardCardThreadId(card.threadLinks);

  return (
    <aside
      className="flex h-full w-[22rem] shrink-0 flex-col border-l border-border bg-background"
      data-board-card-detail={card.id}
    >
      {/* Header */}
      <div className="flex items-start gap-2 border-b border-border px-3 py-2.5">
        <div className="flex min-w-0 flex-1 flex-col gap-1.5">
          <div className="flex items-center gap-1.5">
            <span
              className={cn(
                "inline-flex h-4 shrink-0 items-center rounded px-1.5 text-[10px] font-semibold tracking-wide",
                accent.pill,
              )}
            >
              {card.key}
            </span>
            <span className="truncate text-[11.5px] text-muted-foreground">
              {props.projectName ?? "Project not on disk"}
            </span>
            {archived ? (
              <span className="inline-flex items-center rounded bg-muted px-1.5 text-[10px] font-medium text-muted-foreground">
                Archived
              </span>
            ) : null}
          </div>
          <div className="text-[15px]/[1.3] font-semibold text-pretty text-foreground">
            {card.title}
          </div>
        </div>
        <Button onClick={props.onClose} size="icon-xs" title="Close" variant="ghost">
          <XIcon />
        </Button>
      </div>

      <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-3 py-3">
        {/* Stage + primary action */}
        <div className="flex flex-wrap items-center gap-2">
          <Select
            items={BOARD_STAGES.map((stage) => ({
              value: stage as string,
              label: BOARD_STAGE_LABELS[stage],
            }))}
            modal={false}
            onValueChange={(value: string | null) => {
              if (value !== null && value !== card.stage) props.onMoveStage(value as BoardStage);
            }}
            value={card.stage}
          >
            <SelectTrigger aria-label="Stage" size="xs" variant="default">
              <SelectValue />
            </SelectTrigger>
            <SelectPopup>
              {BOARD_STAGES.map((stage) => (
                <SelectItem key={stage} value={stage}>
                  {BOARD_STAGE_LABELS[stage]}
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
          {primaryAction !== null && !archived ? (
            <Button onClick={() => props.onMoveStage(primaryAction.toStage)} size="xs">
              {primaryAction.label}
            </Button>
          ) : null}
          <span className="flex-1" />
          <Button
            onClick={props.onArchiveToggle}
            size="xs"
            title={archived ? "Restore card" : "Archive card"}
            variant="ghost"
          >
            {archived ? <ArchiveRestoreIcon /> : <ArchiveIcon />}
            {archived ? "Restore" : "Archive"}
          </Button>
        </div>

        {props.feedback !== null ? (
          <p className="rounded-md bg-destructive/10 px-2 py-1.5 text-[12px] text-destructive-foreground">
            {props.feedback}
          </p>
        ) : null}

        {/* Labels */}
        <div className="flex flex-col gap-1.5">
          <div className="flex items-center gap-1.5">
            <SectionHeading>Labels</SectionHeading>
            <span className="flex-1" />
            <Popover>
              <PopoverTrigger
                render={<Button size="icon-xs" title="Edit labels" variant="ghost" />}
              >
                <TagIcon />
              </PopoverTrigger>
              <PopoverPopup className="p-0">
                <BoardLabelPicker
                  catalogue={props.catalogue}
                  onCreate={props.onCreateLabel}
                  onDelete={props.onDeleteLabel}
                  onRecolour={props.onRecolourLabel}
                  onToggle={(labelId) => {
                    const has = card.labels.includes(labelId);
                    props.onSetLabels(
                      has ? card.labels.filter((id) => id !== labelId) : [...card.labels, labelId],
                    );
                  }}
                  onUndelete={props.onUndeleteLabel}
                  selectedLabelIds={card.labels}
                />
              </PopoverPopup>
            </Popover>
          </div>
          <div className="flex flex-wrap items-center gap-1">
            {card.labels.length === 0 ? (
              <span className="text-[12.5px] text-muted-foreground">No labels</span>
            ) : (
              <BoardLabelChips labelIds={card.labels} labelsById={props.labelsById} />
            )}
          </div>
        </div>

        {/* Brief */}
        <div className="flex flex-col gap-1.5">
          <SectionHeading>Brief</SectionHeading>
          <BriefSection brief={props.detail.brief} onSave={props.onSaveBrief} />
        </div>

        {/* Dependencies */}
        <div className="flex flex-col gap-1.5">
          <div className="flex items-center gap-1.5">
            <SectionHeading>Dependencies</SectionHeading>
            <span className="flex-1" />
            <BoardSearchAddPicker
              label="Add"
              onPick={(id) => props.onAddDependency(id as BoardCardId)}
              options={props.dependencyOptions}
              placeholder="Search cards…"
            />
          </div>
          {props.dependencies.length === 0 ? (
            <span className="text-[12.5px] text-muted-foreground">No dependencies</span>
          ) : (
            <ul className="flex flex-col gap-1">
              {props.dependencies.map((dependency) => (
                <li
                  className="flex items-center gap-2 rounded-md border border-border px-2 py-1"
                  key={dependency.cardId}
                >
                  <LockIcon className="size-3 shrink-0 text-muted-foreground" />
                  <span className="shrink-0 text-[12px] font-medium">{dependency.key}</span>
                  <span className="min-w-0 flex-1 truncate text-[11.5px] text-muted-foreground">
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
        </div>

        {/* Threads */}
        <div className="flex flex-col gap-1.5">
          <div className="flex items-center gap-1.5">
            <SectionHeading>Threads</SectionHeading>
            <span className="flex-1" />
            <BoardSearchAddPicker
              label="Adopt"
              onPick={(id) => props.onLinkThread(id as ThreadId, "linked")}
              options={props.adoptableThreads}
              placeholder="Search threads…"
            />
          </div>
          {props.threadLinks.length === 0 ? (
            <span className="text-[12.5px] text-muted-foreground">No linked threads</span>
          ) : (
            <ul className="flex flex-col gap-1">
              {props.threadLinks.map((link) => (
                <li
                  className="flex items-center gap-2 rounded-md border border-border px-2 py-1"
                  key={link.threadId}
                >
                  <div className="flex min-w-0 flex-1 flex-col">
                    <div className="flex items-center gap-1.5">
                      <span
                        className={cn(
                          "min-w-0 truncate text-[12.5px] font-medium",
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
                      {link.tombstoned
                        ? " · deleted"
                        : ` · ${THREAD_STATE_LABEL[link.threadState]}`}
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
        </div>

        {/*
          Plan (post-MVP sub-boards, D12), Review ledger (post-MVP review
          pipeline) and Activity (t3o-08) render here once their data lands on
          BoardCardDetail. Absent, not empty (no-speculative-inventory).
        */}
      </div>
    </aside>
  );
}
