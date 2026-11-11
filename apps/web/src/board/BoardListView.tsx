/**
 * The card tree as an indented outline. Every move (toolbar, keyboard, drag) goes
 * through `runMove`, which applies `planBoardListMove` and sends one `board.card.move-cards`.
 */
import {
  BoardCardId,
  boardProjectFirstStageId,
  boardStageWithRole,
  isBoardCardWorking,
  isBoardDeferredStage,
  type BoardCardAttention,
  type BoardCardShell,
  type BoardStageId,
  type BoardState,
  type EnvironmentId,
  type ProjectIconColor,
  type ProjectId,
} from "@t3tools/contracts";
import { isAtomCommandInterrupted } from "@t3tools/client-runtime/state/runtime";
import {
  ArchiveIcon,
  ChevronDownIcon,
  Columns3Icon,
  EyeIcon,
  FolderInputIcon,
  IndentDecreaseIcon,
  IndentIncreaseIcon,
  LayersIcon,
  PlusIcon,
  XIcon,
} from "lucide-react";
import {
  memo,
  useEffect,
  useId,
  useRef,
  useState,
  type DragEvent,
  type KeyboardEvent,
  type MouseEvent,
  type ReactNode,
} from "react";

import { Button } from "../components/ui/button";
import {
  Menu,
  MenuCheckboxItem,
  MenuItem,
  MenuPopup,
  MenuSeparator,
  MenuTrigger,
} from "../components/ui/menu";
import { isEditableFocused } from "../lib/editableFocus";
import { observeResize } from "../lib/observeResize";
import { useStableCallback } from "../hooks/useStableCallback";
import { cn, randomUUID } from "../lib/utils";
import { boardEnvironment } from "../state/board";
import { useAtomCommand } from "../state/use-atom-command";
import { BoardDialogShell } from "./BoardDialogShell";
import { BoardArchiveGroupDialog, BoardStartedParentDialog } from "./BoardGroupDialogs";
import { BoardHint } from "./BoardHint";
import { describeBoardCommandFailure } from "./boardCommandFeedback";
import {
  boardGroupStats,
  boardGroupTargetLabel,
  boardShellGroup,
  type BoardGroupChildState,
  type BoardGroupStats,
  type BoardGroupStatsInput,
} from "./boardGroups";
import {
  boardListDragBlocked,
  boardListDropRequest,
  boardListDropZone,
  boardListIndent,
  boardListMoveTargets,
  boardListOutdent,
  boardListRange,
  boardListRowWindow,
  boardListRows,
  boardListSelection,
  boardListStageCounts,
  boardListVisibleSelection,
  buildBoardListTree,
  planBoardListMove,
  type BoardListDropZone,
  type BoardListMoveRequest,
  type BoardListStep,
} from "./boardList";
import { BOARD_DEFERRED_STAGE } from "./boardScope";
import { boardStageLabel } from "./boardStages";
import { boardToast } from "./boardToast";
import { projectAccent } from "./projectAccent";

type Shells = ReadonlyArray<BoardCardShell>;

const BOARD_LIST_ROW_HEIGHT = 35;
const INDENT_PX = 22;
/** Below this many rows every row renders; above it, only the window. */
const VIRTUALISE_FROM = 150;
const OVERSCAN = 12;
const GRID_COLUMNS = "grid-cols-[minmax(0,1fr)_124px_168px_130px_150px]";

const PIP_CLASS: Record<BoardGroupChildState, string> = {
  done: "bg-success",
  waiting: "bg-attention",
  blocked: "bg-warning",
  running: "bg-info/65",
  idle: "bg-foreground/13",
};

const toggled = (current: ReadonlySet<string>, id: string): ReadonlySet<string> => {
  const next = new Set(current);
  if (!next.delete(id)) next.add(id);
  return next;
};

const failed = (result: { readonly _tag: string }) =>
  result._tag === "Failure" && !isAtomCommandInterrupted(result as never);

export interface BoardListViewProps {
  readonly environmentId: EnvironmentId;
  /** Every live card the client shows (hidden projects already dropped). */
  readonly shells: Shells;
  /**
   * Every live card, hidden projects included. The move planner reads these,
   * as the server does: a group with a child in a hidden project isn't empty.
   */
  readonly allShells: Shells;
  readonly stages: BoardState;
  readonly inScope: (card: BoardCardShell) => boolean;
  /** The project scope picker, shown at the head of the header row. */
  readonly scopeControl: ReactNode;
  /** Where New group creates when nothing is selected. */
  readonly projects: ReadonlyArray<{ readonly id: ProjectId; readonly title: string }>;
  readonly attentionFor: (card: BoardCardShell) => BoardCardAttention | null;
  readonly accentNameFor: (projectId: ProjectId) => ProjectIconColor | null;
  readonly keyPrefixFor: (projectId: ProjectId) => string;
  readonly query: string;
  readonly onOpenCard: (cardId: string) => void;
  readonly onOpenBoard: (cardId: string) => void;
}

interface DropTarget {
  readonly id: string;
  readonly zone: BoardListDropZone;
}

// Its own hook so a selection change, which the model reads, never rebuilds the rows.
function useBoardListRows(props: BoardListViewProps) {
  const { shells, stages, inScope, query } = props;
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(() => new Set());
  const [stageFilter, setStageFilter] = useState<ReadonlySet<string>>(() => new Set());
  const tree = buildBoardListTree({ shells, stages, inScope });
  const filter = { query, stages: stageFilter };
  const rows = boardListRows({ tree, collapsed, filter });
  const visibleIds = rows.map((row) => String(row.card.cardId));
  return { collapsed, setCollapsed, stageFilter, setStageFilter, tree, rows, visibleIds };
}

// The derivations live in their own hook: a value the compiler sees later passed to
// a call after one of the view's hooks loses its cache, and hook results are frozen.
function useBoardListModel(props: BoardListViewProps) {
  const { shells, allShells, stages, attentionFor, query } = props;
  const { collapsed, setCollapsed, stageFilter, setStageFilter, tree, rows, visibleIds } =
    useBoardListRows(props);
  const [rawSelected, setSelected] = useState<ReadonlySet<string>>(() => new Set());
  const [dragIds, setDragIds] = useState<ReadonlyArray<string> | null>(null);
  // Every action reads only the selected rows still on screen: a filter or a
  // collapse must not leave Tab, Move to… or a drag acting on hidden cards.
  const selected = boardListVisibleSelection(rawSelected, visibleIds);
  const selection = boardListSelection(tree, selected);
  const selectionIds = selection.map((card) => String(card.cardId));
  const filtering = query.trim().length > 0 || stageFilter.size > 0;
  const indent = boardListIndent(tree, selected, filtering ? new Set(visibleIds) : undefined);
  const outdent = boardListOutdent(tree, selected, allShells);
  const dragBlocked = dragIds === null ? null : boardListDragBlocked(shells, dragIds);
  // `boardGroupStats` caches per input object, so this must keep its identity.
  const statsInput: BoardGroupStatsInput = { shells, stages, attentionFor };
  return {
    setSelected,
    collapsed,
    setCollapsed,
    stageFilter,
    setStageFilter,
    dragIds,
    setDragIds,
    tree,
    rows,
    visibleIds,
    selected,
    selection,
    selectionIds,
    indent,
    outdent,
    dragBlocked,
    statsInput,
  };
}

export function BoardListView(props: BoardListViewProps) {
  const { environmentId, shells, allShells, stages, attentionFor } = props;
  const moveCards = useAtomCommand(boardEnvironment.moveCards);
  const archiveCard = useAtomCommand(boardEnvironment.archiveCard);
  const unarchiveCard = useAtomCommand(boardEnvironment.unarchiveCard);

  // Session-scoped view state: none of it is worth a reload (D9).
  const [anchorId, setAnchorId] = useState<string | null>(null);
  const [over, setOver] = useState<DropTarget | null>(null);
  const [startedDialog, setStartedDialog] = useState<{
    readonly startedId: string;
    readonly movingIds: ReadonlyArray<string>;
  } | null>(null);
  const [newGroup, setNewGroup] = useState<{ readonly ids: ReadonlyArray<string> } | null>(null);
  const [archiveGroupId, setArchiveGroupId] = useState<string | null>(null);

  const {
    setSelected,
    setCollapsed,
    stageFilter,
    setStageFilter,
    dragIds,
    setDragIds,
    tree,
    rows,
    visibleIds,
    selected,
    selection,
    selectionIds,
    indent,
    outdent,
    dragBlocked,
    statsInput,
  } = useBoardListModel(props);
  const stageDefinitions = stages.stages ?? [];

  // ── The one move path ────────────────────────────────────────────────
  const runMove = (request: BoardListMoveRequest) => {
    const plan = planBoardListMove({ shells: allShells, stages, request });
    if (plan.kind === "noop") return;
    if (plan.kind === "refused") {
      boardToast({ tone: "error", title: plan.reason });
      return;
    }
    if (plan.kind === "started") {
      setStartedDialog({
        startedId: String(plan.started.cardId),
        movingIds: plan.moving.map((card) => String(card.cardId)),
      });
      return;
    }
    const parentId = plan.input.parentCardId;
    if (parentId !== null) {
      setCollapsed((current) => {
        if (!current.has(parentId)) return current;
        const next = new Set(current);
        next.delete(parentId);
        return next;
      });
    }
    void moveCards({ environmentId, input: plan.input }).then((result) => {
      if (failed(result)) {
        boardToast({
          tone: "error",
          title: "Could not move the cards",
          description: describeBoardCommandFailure(result),
        });
        return;
      }
      const byStage = new Map<BoardStageId, Array<(typeof plan.reverting)[number]>>();
      for (const entry of plan.reverting) {
        byStage.set(entry.stageId, [...(byStage.get(entry.stageId) ?? []), entry]);
      }
      for (const [stageId, entries] of byStage) {
        const keys = entries.map((entry) => entry.card.key).join(", ");
        const stage = isBoardDeferredStage(stageId)
          ? BOARD_DEFERRED_STAGE.label
          : boardStageLabel(stageDefinitions, stageId);
        boardToast({
          title: `${keys} ${entries.length === 1 ? "has" : "have"} no children left and ${
            entries.length === 1 ? "is an ordinary card" : "are ordinary cards"
          } again, back in ${stage}.`,
        });
      }
    });
  };

  const runStep = (step: BoardListStep) => {
    if (step.kind === "refused") {
      boardToast({ title: step.reason });
      return;
    }
    runMove(step.request);
  };

  const clearSelection = () => {
    setSelected((current) => (current.size === 0 ? current : new Set()));
  };

  // ── Row handlers, stable so a memoised row re-renders only on its own data ──
  const onRowClick = useStableCallback((id: string, event: MouseEvent) => {
    if (event.shiftKey && anchorId !== null) {
      setSelected(new Set(boardListRange(visibleIds, anchorId, id)));
      return;
    }
    if (event.metaKey || event.ctrlKey) {
      setSelected(toggled(selected, id));
      setAnchorId(id);
      return;
    }
    // The second click of a double-click must not deselect the row it opens.
    const again = event.detail === 1;
    setSelected(again && selected.size === 1 && selected.has(id) ? new Set() : new Set([id]));
    setAnchorId(id);
  });
  const onRowCheck = useStableCallback((id: string) => {
    setSelected(toggled(selected, id));
    setAnchorId(id);
  });
  const onRowToggle = (id: string) => {
    setCollapsed((current) => {
      const next = new Set(current);
      if (!next.delete(id)) next.add(id);
      return next;
    });
  };
  const { onOpenCard, onOpenBoard } = props;
  const onRowDragStart = useStableCallback((id: string, event: DragEvent) => {
    const ids = selected.has(id) ? selectionIds : [id];
    event.dataTransfer.effectAllowed = "move";
    try {
      event.dataTransfer.setData("text/plain", id);
    } catch {
      // Some browsers refuse data on synthetic drags; the ids live in state.
    }
    setDragIds(ids);
    setOver(null);
  });
  const onRowDragEnd = () => {
    setDragIds(null);
    setOver(null);
  };
  const onRowDragOver = useStableCallback((id: string, event: DragEvent<HTMLElement>) => {
    if (dragIds === null) return;
    if (dragBlocked?.has(id) === true) {
      if (over !== null) setOver(null);
      return;
    }
    event.preventDefault();
    const rect = event.currentTarget.getBoundingClientRect();
    const zone = boardListDropZone(event.clientY - rect.top, rect.height);
    if (over?.id !== id || over.zone !== zone) setOver({ id, zone });
  });
  const onRowDrop = useStableCallback((id: string, event: DragEvent<HTMLElement>) => {
    event.preventDefault();
    setDragIds(null);
    setOver(null);
    if (dragIds === null || dragBlocked?.has(id) === true) return;
    const target = tree.byId.get(id);
    if (target === undefined) return;
    const rect = event.currentTarget.getBoundingClientRect();
    const zone = boardListDropZone(event.clientY - rect.top, rect.height);
    runMove(boardListDropRequest(dragIds, target, zone));
  });

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.defaultPrevented || isEditableFocused(event.target)) return;
    if (event.key === "Escape" && selected.size > 0) {
      event.preventDefault();
      clearSelection();
      return;
    }
    if (event.key !== "Tab" || selected.size === 0) return;
    if (event.altKey || event.metaKey || event.ctrlKey) return;
    event.preventDefault();
    runStep(event.shiftKey ? outdent : indent);
  };

  // ── Toolbar actions ──────────────────────────────────────────────────
  const openGroupInto = () => {
    const first = selection[0];
    if (first === undefined) {
      setNewGroup({ ids: [] });
      return;
    }
    const sameParent = selection.every((card) => card.parentCardId === first.parentCardId);
    const sameProject = selection.every((card) => card.projectId === first.projectId);
    if (!sameParent || !sameProject) {
      boardToast({ tone: "error", title: "Group cards that share a parent and a project." });
      return;
    }
    setNewGroup({ ids: selectionIds });
  };

  const archiveSelected = () => {
    const card = selection[0];
    if (card === undefined || selection.length !== 1) return;
    if (boardShellGroup(allShells, card) !== null) {
      setArchiveGroupId(String(card.cardId));
      return;
    }
    void archiveCard({ environmentId, input: { cardId: card.cardId } }).then((result) => {
      if (failed(result)) {
        boardToast({
          tone: "error",
          title: `Could not archive ${card.key}`,
          description: describeBoardCommandFailure(result),
        });
        return;
      }
      clearSelection();
      boardToast({
        title: `Archived ${card.key}.`,
        action: {
          label: "Undo",
          run: () => void unarchiveCard({ environmentId, input: { cardId: card.cardId } }),
        },
      });
    });
  };

  const counts = boardListStageCounts(tree);
  const moveTargets =
    selected.size === 0
      ? []
      : boardListMoveTargets(tree, selected).map((target) => ({
          ...target,
          isGroup: target.card !== null && boardShellGroup(shells, target.card) !== null,
        }));
  const groupCount = [...tree.inScope].filter((id) => {
    const card = tree.byId.get(id);
    return card !== undefined && boardShellGroup(shells, card) !== null;
  }).length;
  const stageOptions = [...stageDefinitions, BOARD_DEFERRED_STAGE];

  // ── Rows ────────────────────────────────────────────────────────────
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const [viewport, setViewport] = useState({
    scrollTop: 0,
    height: VIRTUALISE_FROM * BOARD_LIST_ROW_HEIGHT,
  });
  const virtualised = rows.length > VIRTUALISE_FROM;
  const measure = () => {
    const element = scrollRef.current;
    if (element === null) return;
    const { scrollTop, clientHeight: height } = element;
    setViewport((current) =>
      current.scrollTop === scrollTop && current.height === height
        ? current
        : { scrollTop, height },
    );
  };
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- observes the scroller's size to window the virtualised rows
  useEffect(() => {
    if (!virtualised) return;
    measure();
    const element = scrollRef.current;
    if (element === null) return;
    return observeResize(element, measure);
  }, [measure, virtualised]);
  const { start, end } = virtualised
    ? boardListRowWindow({
        scrollTop: viewport.scrollTop,
        viewportHeight: viewport.height,
        rowCount: rows.length,
        rowHeight: BOARD_LIST_ROW_HEIGHT,
        overscan: OVERSCAN,
      })
    : { start: 0, end: rows.length };
  const doneStageId = boardStageWithRole(stages, "done")?.stageId ?? null;

  const hasSelection = selection.length > 0;
  const indentHintId = useId();
  const outdentHintId = useId();

  const startedCard = startedDialog === null ? undefined : tree.byId.get(startedDialog.startedId);
  const newGroupCards = newGroup === null ? [] : boardListSelection(tree, new Set(newGroup.ids));
  const archiveGroup = archiveGroupId === null ? undefined : tree.byId.get(archiveGroupId);

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <div
        aria-label="List toolbar"
        className="flex min-h-10 shrink-0 flex-wrap items-center gap-2 px-3 py-1.5 sm:px-5"
        role="toolbar"
      >
        {hasSelection ? (
          <>
            <span className="text-[12.5px] font-medium text-foreground">
              {selection.length} selected
            </span>
            <StepButton
              hintId={indentHintId}
              icon={<IndentIncreaseIcon />}
              label="Indent"
              onRun={() => runStep(indent)}
              shortcut="Tab"
              step={indent}
            />
            <StepButton
              hintId={outdentHintId}
              icon={<IndentDecreaseIcon />}
              label="Outdent"
              onRun={() => runStep(outdent)}
              shortcut="⇧Tab"
              step={outdent}
            />
            <Menu>
              <MenuTrigger
                render={
                  <Button size="xs" variant="outline">
                    <FolderInputIcon />
                    Move to…
                  </Button>
                }
              />
              <MenuPopup align="start" className="max-h-80 min-w-64 overflow-y-auto">
                {moveTargets.map(({ card, depth, isGroup }) => (
                  <MenuItem
                    key={card === null ? "top" : card.cardId}
                    onClick={() =>
                      runMove({
                        ids: selectionIds,
                        parentId: card === null ? null : String(card.cardId),
                      })
                    }
                  >
                    <span aria-hidden className="shrink-0" style={{ width: depth * 14 }} />
                    {card === null ? (
                      <span className="font-medium">Top level</span>
                    ) : (
                      <>
                        <KeyPill accentNameFor={props.accentNameFor} card={card} />
                        <span className={cn("min-w-0 truncate", isGroup && "font-medium")}>
                          {card.title}
                        </span>
                      </>
                    )}
                  </MenuItem>
                ))}
              </MenuPopup>
            </Menu>
            <Button onClick={openGroupInto} size="xs" variant="outline">
              <LayersIcon />
              Group into new…
            </Button>
            {selection.length === 1 ? (
              <Button onClick={archiveSelected} size="xs" variant="outline">
                <ArchiveIcon />
                Archive
              </Button>
            ) : null}
            <Button onClick={clearSelection} size="xs" variant="ghost">
              <XIcon />
              Clear
            </Button>
          </>
        ) : (
          <>
            {props.scopeControl}
            <span className="text-[12px] text-muted-foreground">
              {tree.inScope.size} cards · {groupCount} groups
            </span>
            <Menu>
              <MenuTrigger
                render={
                  <Button size="xs" variant={stageFilter.size > 0 ? "secondary" : "outline"}>
                    {stageFilter.size === 0
                      ? "All stages"
                      : stageFilter.size === 1
                        ? boardStageLabel(stageOptions, [...stageFilter][0] as BoardStageId)
                        : `${stageFilter.size} stages`}
                    <ChevronDownIcon />
                  </Button>
                }
              />
              <MenuPopup align="start" className="min-w-52">
                {stageOptions.map((stage) => (
                  <MenuCheckboxItem
                    checked={stageFilter.has(stage.stageId)}
                    closeOnClick={false}
                    key={stage.stageId}
                    onCheckedChange={(checked) =>
                      setStageFilter((current) => {
                        const next = new Set(current);
                        if (checked) next.add(stage.stageId);
                        else next.delete(stage.stageId);
                        return next;
                      })
                    }
                  >
                    <span className="flex w-full items-center justify-between gap-3">
                      {stage.label}
                      <span className="text-[11px] text-muted-foreground tabular-nums">
                        {counts.get(stage.stageId) ?? 0}
                      </span>
                    </span>
                  </MenuCheckboxItem>
                ))}
                <MenuSeparator />
                <MenuItem
                  disabled={stageFilter.size === 0}
                  onClick={() => setStageFilter(new Set())}
                >
                  Show all stages
                </MenuItem>
              </MenuPopup>
            </Menu>
            <span className="flex-1 md:hidden" />
            <span className="hidden min-w-0 flex-1 basis-0 items-center justify-end-safe gap-1 overflow-hidden text-[11.5px] whitespace-nowrap text-muted-foreground md:flex">
              <ListKbd>⇧Click</ListKbd> for a range. <ListKbd>Tab</ListKbd> indents,
              <ListKbd>⇧Tab</ListKbd> outdents; drag to move.
            </span>
            <Button onClick={() => setNewGroup({ ids: [] })} size="xs" variant="outline">
              <PlusIcon />
              New group
            </Button>
          </>
        )}
      </div>
      <div
        className={cn(
          "grid shrink-0 items-center gap-x-3 border-b border-foreground/7 px-[calc(--spacing(3)+10px)] pb-1.5 text-[11px] font-medium text-muted-foreground sm:px-[calc(--spacing(5)+10px)]",
          GRID_COLUMNS,
        )}
      >
        <span>Name</span>
        <span>Stage</span>
        <span>Status</span>
        <span>Progress</span>
        <span>Merges into</span>
      </div>
      <div
        className="min-h-0 flex-1 overflow-auto px-3 pb-16 outline-none sm:px-5"
        onScroll={virtualised ? measure : undefined}
        ref={scrollRef}
      >
        {/* The list holds focus for Tab / Shift+Tab and Escape; text fields
            elsewhere keep their own Tab. */}
        <div
          aria-label="Cards"
          aria-multiselectable
          className="outline-none"
          onKeyDown={onKeyDown}
          role="tree"
          tabIndex={0}
        >
          {rows.length === 0 ? (
            <p className="px-2.5 py-6 text-[12.5px] text-muted-foreground">
              {props.query.trim().length > 0 || stageFilter.size > 0
                ? "No cards match the filter."
                : "No cards here yet."}
            </p>
          ) : null}
          {start > 0 ? <div style={{ height: start * BOARD_LIST_ROW_HEIGHT }} /> : null}
          {rows.slice(start, end).map((row) => {
            const id = String(row.card.cardId);
            const attention = row.isGroup ? null : attentionFor(row.card);
            return (
              <BoardListRowView
                accentNameFor={props.accentNameFor}
                blocked={!row.isGroup && (row.card.blocked || attention?.tone === "warning")}
                card={row.card}
                childCount={row.childCount}
                context={row.context}
                depth={row.depth}
                dragging={dragIds !== null}
                dropBlocked={dragBlocked?.has(id) === true}
                dropZone={over?.id === id ? over.zone : null}
                done={row.card.stage === doneStageId}
                expanded={row.expanded}
                isGroup={row.isGroup}
                key={id}
                onCheck={onRowCheck}
                onClick={onRowClick}
                onDragEnd={onRowDragEnd}
                onDragOver={onRowDragOver}
                onDragStart={onRowDragStart}
                onDrill={onOpenBoard}
                onDrop={onRowDrop}
                onOpen={onOpenCard}
                onToggle={onRowToggle}
                running={!row.isGroup && isBoardCardWorking(row.card)}
                selected={selected.has(id)}
                stageLabel={
                  isBoardDeferredStage(row.card.stage)
                    ? BOARD_DEFERRED_STAGE.label
                    : boardStageLabel(stageDefinitions, row.card.stage)
                }
                stats={row.isGroup ? boardGroupStats(statsInput, id) : null}
                target={row.isGroup ? boardGroupTargetLabel(shells, row.card) : null}
                targetOwn={row.isGroup && boardShellGroup(shells, row.card)?.target === "own"}
                waiting={attention?.tone === "attention"}
              />
            );
          })}
          {end < rows.length ? (
            <div style={{ height: (rows.length - end) * BOARD_LIST_ROW_HEIGHT }} />
          ) : null}
        </div>
      </div>
      {startedDialog !== null && startedCard !== undefined ? (
        <BoardStartedParentDialog
          environmentId={environmentId}
          keyPrefix={props.keyPrefixFor(startedCard.projectId)}
          moving={startedDialog.movingIds.flatMap((id) => {
            const card = tree.byId.get(id);
            return card === undefined ? [] : [card];
          })}
          onClose={() => setStartedDialog(null)}
          stages={stages}
          started={startedCard}
        />
      ) : null}
      {newGroup !== null ? (
        <BoardListNewGroupDialog
          cards={newGroupCards}
          environmentId={environmentId}
          keyPrefixFor={props.keyPrefixFor}
          onClose={() => setNewGroup(null)}
          onCreated={(cardId) => {
            setSelected(new Set([cardId]));
            setAnchorId(cardId);
          }}
          projects={props.projects}
          shells={allShells}
          stages={stages}
        />
      ) : null}
      {archiveGroup !== undefined ? (
        <BoardArchiveGroupDialog
          group={archiveGroup}
          onClose={() => setArchiveGroupId(null)}
          onConfirm={(confirmCardKey) => {
            void archiveCard({
              environmentId,
              input: { cardId: archiveGroup.cardId, confirmCardKey },
            }).then((result) => {
              if (failed(result)) {
                boardToast({
                  tone: "error",
                  title: `Could not archive ${archiveGroup.key}`,
                  description: describeBoardCommandFailure(result),
                });
                return;
              }
              clearSelection();
              boardToast({ title: `Archived ${archiveGroup.key} and everything in it.` });
            });
          }}
          shells={allShells}
          stages={stages}
        />
      ) : null}
    </div>
  );
}

/** Indent or Outdent: aria-disabled, not disabled, so the hint naming why
    still shows on hover and a click says the reason. */
function StepButton({
  step,
  label,
  shortcut,
  icon,
  hintId,
  onRun,
}: {
  readonly step: BoardListStep;
  readonly label: string;
  readonly shortcut: string;
  readonly icon: ReactNode;
  readonly hintId: string;
  readonly onRun: () => void;
}) {
  const hint = step.kind === "ok" ? `${step.label} (${shortcut})` : step.reason;
  return (
    <BoardHint label={hint}>
      <Button
        aria-describedby={hintId}
        aria-disabled={step.kind === "refused" ? true : undefined}
        onClick={onRun}
        size="xs"
        variant="outline"
      >
        {icon}
        {label}
        <span className="sr-only" id={hintId}>
          {hint}
        </span>
      </Button>
    </BoardHint>
  );
}

function ListKbd({ children }: { readonly children: ReactNode }) {
  return (
    <kbd className="rounded-[4px] border border-border bg-muted px-[5px] py-px font-mono text-[10.5px] font-medium text-foreground">
      {children}
    </kbd>
  );
}

function KeyPill({
  card,
  accentNameFor,
}: {
  readonly card: BoardCardShell;
  readonly accentNameFor: (projectId: ProjectId) => ProjectIconColor | null;
}) {
  return (
    <span
      className={cn(
        "inline-flex h-4 shrink-0 items-center rounded px-1.5 text-[10px] font-semibold tracking-wide",
        projectAccent(card.projectId, accentNameFor(card.projectId)).pill,
      )}
    >
      {card.key}
    </span>
  );
}

function StatusFlag({
  tone,
  children,
}: {
  readonly tone: "attention" | "info" | "warning";
  readonly children: ReactNode;
}) {
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center gap-[5px] text-[11.5px] font-medium whitespace-nowrap",
        tone === "attention" && "text-attention-foreground",
        tone === "info" && "text-info-foreground",
        tone === "warning" && "text-warning-foreground",
      )}
      data-tone={tone}
    >
      <span
        aria-hidden
        className={cn(
          "size-1.5 shrink-0 rounded-full",
          tone === "attention" && "bg-attention",
          tone === "info" && "bg-info",
          tone === "warning" && "bg-warning",
        )}
      />
      {children}
    </span>
  );
}

interface BoardListRowViewProps {
  readonly card: BoardCardShell;
  readonly depth: number;
  readonly isGroup: boolean;
  readonly expanded: boolean;
  readonly childCount: number;
  readonly context: boolean;
  readonly selected: boolean;
  readonly dragging: boolean;
  readonly dropBlocked: boolean;
  readonly dropZone: BoardListDropZone | null;
  readonly stageLabel: string;
  readonly done: boolean;
  readonly waiting: boolean;
  readonly running: boolean;
  readonly blocked: boolean;
  readonly stats: BoardGroupStats | null;
  readonly target: string | null;
  readonly targetOwn: boolean;
  readonly accentNameFor: (projectId: ProjectId) => ProjectIconColor | null;
  readonly onClick: (id: string, event: MouseEvent) => void;
  readonly onCheck: (id: string) => void;
  readonly onToggle: (id: string) => void;
  readonly onOpen: (id: string) => void;
  readonly onDrill: (id: string) => void;
  readonly onDragStart: (id: string, event: DragEvent) => void;
  readonly onDragEnd: () => void;
  readonly onDragOver: (id: string, event: DragEvent<HTMLElement>) => void;
  readonly onDrop: (id: string, event: DragEvent<HTMLElement>) => void;
}

/** One outline row. Memoised by card id: a row re-renders only when its own
    shell, selection, drop state or status changes. */
const BoardListRowView = memo(function BoardListRowView(props: BoardListRowViewProps) {
  const { card, stats } = props;
  const id = String(card.cardId);
  const deferred = isBoardDeferredStage(card.stage);
  const flags: Array<{ readonly tone: "attention" | "info" | "warning"; readonly text: string }> =
    [];
  if (stats !== null) {
    if (stats.waiting > 0) {
      flags.push({
        tone: "attention",
        text: `${stats.waiting} need${stats.waiting === 1 ? "s" : ""} you`,
      });
    }
    if (stats.blocked > 0) flags.push({ tone: "warning", text: `${stats.blocked} blocked` });
    if (stats.running > 0 && flags.length < 2) {
      flags.push({ tone: "info", text: `${stats.running} running` });
    }
  } else {
    if (props.waiting) flags.push({ tone: "attention", text: "Needs you" });
    else if (props.running) flags.push({ tone: "info", text: "Running" });
    if (props.blocked) flags.push({ tone: "warning", text: "Blocked" });
  }
  const done = props.done;
  return (
    <div
      aria-expanded={props.isGroup ? props.expanded : undefined}
      aria-level={props.depth + 1}
      aria-selected={props.selected}
      className={cn(
        "grid h-[35px] items-center gap-x-3 border-b border-foreground/7 px-2.5 select-none",
        GRID_COLUMNS,
        props.dragging ? "cursor-grabbing" : "cursor-grab",
        props.dropZone === "into" && "bg-primary/12 shadow-[inset_0_0_0_1.5px_var(--primary)]",
        props.dropZone === "before" && "shadow-[inset_0_2px_0_0_var(--primary)]",
        props.dropZone === "after" && "shadow-[inset_0_-2px_0_0_var(--primary)]",
        props.dropZone === null &&
          props.selected &&
          "bg-primary/8 shadow-[inset_0_0_0_1px_color-mix(in_srgb,var(--primary)_32%,transparent)]",
        props.dragging && props.dropBlocked
          ? "opacity-40"
          : props.context
            ? "opacity-45"
            : deferred && "opacity-55",
      )}
      data-board-list-row={id}
      data-context={props.context ? "" : undefined}
      data-drop-zone={props.dropZone ?? undefined}
      data-drop-blocked={props.dragging && props.dropBlocked ? "" : undefined}
      draggable
      onClick={(event) => props.onClick(id, event)}
      onDoubleClick={() => props.onOpen(id)}
      onDragEnd={props.onDragEnd}
      onDragOver={(event) => props.onDragOver(id, event)}
      onDragStart={(event) => props.onDragStart(id, event)}
      onDrop={(event) => props.onDrop(id, event)}
      role="treeitem"
    >
      <div className="flex min-w-0 items-center gap-1.5">
        <span aria-hidden className="shrink-0" style={{ width: props.depth * INDENT_PX }} />
        {props.isGroup ? (
          <button
            aria-label={props.expanded ? `Collapse ${card.key}` : `Expand ${card.key}`}
            className="inline-flex size-4 shrink-0 cursor-pointer items-center justify-center rounded-sm text-muted-foreground hover:bg-accent hover:text-foreground"
            onClick={(event) => {
              event.stopPropagation();
              props.onToggle(id);
            }}
            type="button"
          >
            <ChevronDownIcon className={cn("size-3.5", !props.expanded && "-rotate-90")} />
          </button>
        ) : (
          <span aria-hidden className="size-4 shrink-0" />
        )}
        <button
          aria-checked={props.selected}
          aria-label={`Select ${card.key}`}
          className={cn(
            "inline-flex size-[15px] shrink-0 cursor-pointer items-center justify-center rounded-[4px] border text-primary-foreground",
            props.selected ? "border-primary bg-primary" : "border-input bg-card",
          )}
          onClick={(event) => {
            event.stopPropagation();
            props.onCheck(id);
          }}
          role="checkbox"
          type="button"
        >
          {props.selected ? (
            <svg aria-hidden className="size-2.5" fill="none" viewBox="0 0 24 24">
              <path
                d="M5.252 12.7 10.2 18.63 18.748 5.37"
                stroke="currentColor"
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth="3"
              />
            </svg>
          ) : null}
        </button>
        <KeyPill accentNameFor={props.accentNameFor} card={card} />
        <span
          className={cn(
            "min-w-0 truncate text-[13px] text-foreground",
            props.isGroup ? "font-semibold" : "font-normal",
          )}
        >
          {card.title}
        </span>
        {props.isGroup ? (
          <span className="shrink-0 text-[11px] text-muted-foreground tabular-nums">
            {props.childCount}
          </span>
        ) : null}
        {props.isGroup ? (
          <BoardHint label="Open its board">
            <button
              aria-label={`Open ${card.key}'s board`}
              className="inline-flex size-5 shrink-0 cursor-pointer items-center justify-center rounded-sm text-muted-foreground hover:bg-accent hover:text-foreground"
              onClick={(event) => {
                event.stopPropagation();
                props.onDrill(id);
              }}
              type="button"
            >
              <Columns3Icon className="size-3.5" />
            </button>
          </BoardHint>
        ) : null}
        <BoardHint label="View details">
          <button
            aria-label={`View ${card.key} details`}
            className="inline-flex size-5 shrink-0 cursor-pointer items-center justify-center rounded-sm text-muted-foreground hover:bg-accent hover:text-foreground"
            onClick={(event) => {
              event.stopPropagation();
              props.onOpen(id);
            }}
            type="button"
          >
            <EyeIcon className="size-3.5" />
          </button>
        </BoardHint>
      </div>
      <div className="min-w-0">
        <span
          className={cn(
            "inline-flex h-5 items-center rounded-md px-[7px] text-[11px] font-medium whitespace-nowrap",
            done
              ? "bg-success/14 text-success-foreground"
              : deferred
                ? "border border-dashed border-input text-muted-foreground"
                : "bg-accent text-foreground",
          )}
        >
          {props.stageLabel}
        </span>
      </div>
      <div className="flex min-w-0 items-center gap-2.5 overflow-hidden">
        {flags.map((flag) => (
          <StatusFlag key={flag.text} tone={flag.tone}>
            {flag.text}
          </StatusFlag>
        ))}
      </div>
      <div className="flex min-w-0 items-center gap-2">
        {stats !== null ? (
          <>
            <span className="flex min-w-0 flex-1 items-center gap-[2px]">
              {stats.active.map((child, index) => {
                const state = stats.states[index]!;
                return (
                  <span
                    className={cn("h-1 max-w-3 min-w-1 flex-1 rounded-[2px]", PIP_CLASS[state])}
                    data-state={state}
                    key={child.key}
                  />
                );
              })}
            </span>
            <span
              className={cn(
                "shrink-0 text-[11px] tabular-nums",
                stats.active.length > 0 &&
                  stats.done === stats.active.length &&
                  stats.deferred === 0
                  ? "text-success-foreground"
                  : "text-muted-foreground",
              )}
            >
              {stats.active.length > 0 ? `${stats.done}/${stats.active.length}` : "0"}
            </span>
          </>
        ) : null}
      </div>
      <div
        className={cn(
          "min-w-0 truncate font-mono text-[11px] font-medium",
          props.targetOwn ? "text-foreground" : "text-muted-foreground",
        )}
      >
        {props.target === null ? "" : `→ ${props.target}`}
      </div>
    </div>
  );
});

/** New group (an empty heading) or Group into new…: a heading where the
    selection sits, then the selection moved under it. Grouping never touches
    git. */
function BoardListNewGroupDialog({
  environmentId,
  cards,
  projects,
  shells,
  stages,
  keyPrefixFor,
  onClose,
  onCreated,
}: {
  readonly environmentId: EnvironmentId;
  readonly cards: Shells;
  readonly projects: ReadonlyArray<{ readonly id: ProjectId; readonly title: string }>;
  readonly shells: Shells;
  readonly stages: BoardState;
  readonly keyPrefixFor: (projectId: ProjectId) => string;
  readonly onClose: () => void;
  readonly onCreated: (cardId: string) => void;
}) {
  const createCard = useAtomCommand(boardEnvironment.createCard);
  const [title, setTitle] = useState("");
  const first = cards[0];
  const [projectId, setProjectId] = useState<string>(
    () => first?.projectId ?? projects[0]?.id ?? "",
  );
  const parent =
    first?.parentCardId === undefined
      ? undefined
      : shells.find((card) => card.cardId === first.parentCardId);
  const ready = title.trim().length > 0 && projectId.length > 0;
  const confirm = () => {
    if (!ready) return;
    onClose();
    const cardId = BoardCardId.make(randomUUID());
    const project = projectId as ProjectId;
    const ids = cards.map((card) => card.cardId);
    void (async () => {
      const created = await createCard({
        environmentId,
        input: {
          cardId,
          projectId: project,
          title: title.trim(),
          heading: true,
          stage: boardProjectFirstStageId(stages, project),
          ...(parent === undefined ? {} : { parentCardId: parent.cardId }),
          ...(ids.length === 0 ? {} : { adoptCardIds: ids }),
          keyPrefix: keyPrefixFor(project),
        },
      });
      if (failed(created)) {
        boardToast({
          tone: "error",
          title: "Could not create the group",
          description: describeBoardCommandFailure(created),
        });
        return;
      }
      onCreated(String(cardId));
      boardToast({
        title:
          ids.length > 0
            ? `Created group “${title.trim()}” with ${ids.length} ${ids.length === 1 ? "card" : "cards"}.`
            : `Created group “${title.trim()}”. Indent cards under it.`,
      });
    })();
  };
  return (
    <BoardDialogShell
      body={
        cards.length > 0
          ? "Creates a group where they sit and moves them under it. Grouping doesn't touch git."
          : "Creates an empty group heading. Indent cards under it, or move them in."
      }
      confirmDisabled={!ready}
      confirmLabel="Create group"
      items={cards.map((card) => ({
        id: String(card.cardId),
        cardKey: card.key,
        title: card.title,
      }))}
      onConfirm={confirm}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      open
      options={
        cards.length === 0 && projects.length > 1
          ? {
              items: projects.map((project) => ({
                id: project.id,
                label: project.title,
                description: "Create the group in this project",
              })),
              value: projectId,
              onChange: setProjectId,
            }
          : undefined
      }
      title={
        cards.length > 0
          ? `Group ${cards.length} ${cards.length === 1 ? "card" : "cards"}`
          : "New group"
      }
      titleInput={{
        label: "Group title",
        value: title,
        placeholder: "e.g. Billing",
        onChange: setTitle,
      }}
    />
  );
}
