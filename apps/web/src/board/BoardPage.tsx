/**
 * T3o board surface (t3o-05): mode tabs and project scope in a board-owned
 * top bar, the eight stage columns, and drag ordering.
 *
 * Every ordering number comes from `@t3tools/client-runtime` (t3o-04):
 * `compareBoardCardShells` orders columns, `boardColumnAppendOrderKey`
 * appends, `planBoardCardReorder` prices a drop, and the optimistic
 * placement overlay reconciles against the shell stream. This file decides
 * *when* to dispatch, never *what number* to store.
 */
import {
  BoardCardId,
  BOARD_STAGES,
  areBoardStagesAdjacent,
  resolveBoardProjectAccent,
  type BoardCardShell,
  type BoardStage,
  type EnvironmentId,
  type ProjectId,
} from "@t3tools/contracts";
import {
  applyBoardCardPlacements,
  boardBuildingQueueInfo,
  isBoardCardPlacementSettled,
  mergeBoardStageColumns,
  planBoardCardReorder,
  type BoardCardPlacement,
  type BoardStageColumns,
} from "@t3tools/client-runtime/state/shell";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { useAtomValue } from "@effect/atom-react";
import { getRouteApi } from "@tanstack/react-router";
import { ArchiveIcon, PlusIcon } from "lucide-react";
import * as Option from "effect/Option";
import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent } from "react";

import { Button } from "../components/ui/button";
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "../components/ui/select";
import { SidebarInset } from "../components/ui/sidebar";
import { toastManager } from "../components/ui/toast";
import { isElectron } from "../env";
import { cn } from "../lib/utils";
import { environmentShell } from "../state/shell";
import { boardEnvironment } from "../state/board";
import { usePrimaryEnvironmentId } from "../state/environments";
import { usePrimarySettings } from "../hooks/useSettings";
import { useAtomCommand } from "../state/use-atom-command";
import { COLLAPSED_SIDEBAR_TITLEBAR_INSET_CLASS } from "../workspaceTitlebar";
import { BoardArchivedCardsSheet, refreshBoardArchivedCards } from "./BoardArchivedCardsSheet";
import { BoardCardCreateDialog } from "./BoardCardCreateDialog";
import { describeBoardCommandFailure } from "./boardCommandFeedback";
import { BoardCardDetail } from "./BoardCardDetail";
import { BoardColumn, BOARD_CARD_GAP } from "./BoardColumn";
import { indexBoardLabels } from "./labelColour";
import { BoardModeTabs } from "./BoardModeTabs";
import { isBoardColumnCollapsed, useBoardUiStore } from "./boardUiStore";
import { projectAccent } from "./projectAccent";

const routeApi = getRouteApi("/board");

const EMPTY_COLUMNS: BoardStageColumns = mergeBoardStageColumns([]);

const ALL_PROJECTS = "__all__";

interface FoundCard {
  readonly stage: BoardStage;
  readonly card: BoardCardShell;
}

function findBoardCard(columns: BoardStageColumns, cardId: string | null): FoundCard | null {
  if (cardId === null) return null;
  for (const stage of BOARD_STAGES) {
    const card = columns[stage].find((existing) => existing.cardId === cardId);
    if (card !== undefined) return { stage, card };
  }
  return null;
}

interface BoardDrag {
  readonly cardId: string;
  readonly height: number;
}

interface BoardDragOver {
  readonly stage: BoardStage;
  readonly index: number;
}

/**
 * The insertion index a pointer at `y` maps to within a column element,
 * measured in the cards' "unshifted" coordinates: any card sitting below the
 * inserted placeholder is offset by its height, so we subtract that before
 * comparing midpoints — otherwise inserting the placeholder shifts the cards
 * and the next dragover computes a different index, flickering. (Ported from
 * the prototype's `dropIndexIn`.)
 */
function boardDropIndexIn(columnEl: Element, y: number): number {
  const placeholder = columnEl.querySelector("[data-board-ph]");
  const cards = columnEl.querySelectorAll("[data-board-card]");
  if (cards.length === 0) return 0;
  let shift = 0;
  let placeholderTop: number | null = null;
  if (placeholder !== null) {
    const rect = placeholder.getBoundingClientRect();
    shift = rect.height + BOARD_CARD_GAP;
    placeholderTop = rect.top;
  }
  for (let index = 0; index < cards.length; index++) {
    const rect = cards[index]!.getBoundingClientRect();
    const offset = placeholderTop !== null && rect.top > placeholderTop ? shift : 0;
    if (y < rect.top + rect.height / 2 - offset) return index;
  }
  return cards.length;
}

/** The invariant `detail` when the failure carries one (the decider's
    rejection messages name the unmet dependency), else the error message. */
function commandFailureDescription(result: unknown): string {
  const error: unknown = squashAtomCommandFailure(
    result as Parameters<typeof squashAtomCommandFailure>[0],
  );
  if (
    typeof error === "object" &&
    error !== null &&
    "detail" in error &&
    typeof error.detail === "string"
  ) {
    return error.detail;
  }
  return error instanceof Error ? error.message : "The server rejected the command.";
}

export function BoardPage() {
  const environmentId = usePrimaryEnvironmentId();
  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none bg-background text-foreground">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-x-hidden bg-background">
        <header
          className={cn(
            "workspace-topbar shrink-0 gap-2 px-3 sm:px-5",
            isElectron && "drag-region",
            COLLAPSED_SIDEBAR_TITLEBAR_INSET_CLASS,
          )}
        >
          <BoardModeTabs mode="board" />
        </header>
        {environmentId === null ? (
          <div className="flex flex-1 items-center justify-center">
            <p className="text-sm text-muted-foreground">No connected environment.</p>
          </div>
        ) : (
          <EnvironmentBoard environmentId={environmentId} />
        )}
      </div>
    </SidebarInset>
  );
}

function EnvironmentBoard({ environmentId }: { readonly environmentId: EnvironmentId }) {
  const search = routeApi.useSearch();
  const navigate = routeApi.useNavigate();
  const shellState = useAtomValue(environmentShell.stateValueAtom(environmentId));
  const cardsByProject = useAtomValue(boardEnvironment.cardsByProjectAtom(environmentId));
  const labelCatalogue = useAtomValue(boardEnvironment.labelCatalogueAtom(environmentId));
  const labelsById = useMemo(() => indexBoardLabels(labelCatalogue), [labelCatalogue]);
  const moveCard = useAtomCommand(boardEnvironment.moveCard);
  const reorderCard = useAtomCommand(boardEnvironment.reorderCard);

  const collapsedByStage = useBoardUiStore((state) => state.collapsedByStage);
  const setColumnCollapsed = useBoardUiStore((state) => state.setColumnCollapsed);

  // Board settings (t3o-07): the per-project key prefix used when creating a
  // card, and the configured accent used to colour a project's cards. Read
  // once here and threaded down, rather than subscribed per card.
  const boardSettings = usePrimarySettings((settings) => settings.board);
  const accentNameFor = useCallback(
    (projectId: ProjectId) => resolveBoardProjectAccent(boardSettings, projectId),
    [boardSettings],
  );

  const projects = useMemo(
    () => Option.getOrNull(shellState.snapshot)?.projects ?? [],
    [shellState.snapshot],
  );
  const scopeProjectId = (search.project ?? null) as ProjectId | null;
  // A stale deep link (project deleted, or another environment's id) still
  // needs a visible scope so the user can switch back to All projects.
  const scopeIsStale =
    scopeProjectId !== null &&
    projects.length > 0 &&
    !projects.some((project) => project.id === scopeProjectId);

  const liveColumns = useMemo(() => {
    if (scopeProjectId !== null) {
      return cardsByProject.get(scopeProjectId) ?? EMPTY_COLUMNS;
    }
    return mergeBoardStageColumns(cardsByProject.values());
  }, [cardsByProject, scopeProjectId]);

  // Optimistic drop placements: applied over the live shells immediately,
  // pruned as the server's deltas confirm them, removed on rejection.
  const [placements, setPlacements] = useState<ReadonlyArray<BoardCardPlacement>>([]);
  useEffect(() => {
    setPlacements((current) => {
      if (current.length === 0) return current;
      const remaining = current.filter(
        (placement) => !isBoardCardPlacementSettled(liveColumns, placement),
      );
      return remaining.length === current.length ? current : remaining;
    });
  }, [liveColumns]);
  const columns = useMemo(
    () => applyBoardCardPlacements(liveColumns, placements),
    [liveColumns, placements],
  );

  const queueSlots = useMemo(() => boardBuildingQueueInfo(columns.building), [columns.building]);

  // ── Drag (native HTML5, the prototype's model) ──────────────────────
  // dnd-kit's sortable transforms were incompatible with the virtualised
  // list — cards vanished mid-drag and no gap opened. Native drag carries a
  // tilted ghost clone; each column measures the drop index and opens a
  // placeholder gap; the drop reuses the command layer below.
  const [drag, setDrag] = useState<BoardDrag | null>(null);
  const [dragOver, setDragOver] = useState<BoardDragOver | null>(null);
  const ghostRef = useRef<HTMLElement | null>(null);
  const dragRef = useRef<BoardDrag | null>(null);

  const clearGhost = useCallback(() => {
    if (ghostRef.current !== null) {
      ghostRef.current.remove();
      ghostRef.current = null;
    }
  }, []);

  // Prices and dispatches a settled order for one column: the optimistic
  // placement lands first, then the move/reorder commands, with rejection
  // rollback and the Building queue toast. Shared by drop and (future) keyboard.
  const dispatchDrop = useCallback(
    (targetStage: BoardStage, orderedIds: ReadonlyArray<string>, source: FoundCard) => {
      const cardId = source.card.cardId as string;
      const isMove = targetStage !== source.stage;
      if (!isMove) {
        const currentIds = columns[targetStage].map((card) => card.cardId as string);
        if (
          orderedIds.length === currentIds.length &&
          orderedIds.every((id, index) => id === currentIds[index])
        ) {
          return;
        }
      }

      const keysByCardId = new Map<string, string>(
        columns[targetStage].map((card) => [card.cardId as string, card.orderKey]),
      );
      keysByCardId.set(cardId, source.card.orderKey);
      const assignments = planBoardCardReorder({
        orderedCardIds: [...orderedIds],
        keysByCardId,
        movedCardId: cardId,
      });
      if (assignments.length === 0) return;

      // Apply locally first — the drag never blocks on the round trip.
      setPlacements((current) => [
        ...current.filter(
          (placement) => !assignments.some((next) => next.cardId === placement.cardId),
        ),
        ...assignments.map((assignment) => ({
          cardId: assignment.cardId,
          stage: targetStage,
          orderKey: assignment.orderKey,
        })),
      ]);

      const dispatches = assignments.map((assignment) => {
        const command =
          isMove && assignment.cardId === cardId
            ? moveCard({
                environmentId,
                input: {
                  cardId: source.card.cardId,
                  toStage: targetStage,
                  orderKey: assignment.orderKey,
                  // A drag may cross several stages; override forces the
                  // non-adjacent transition (never the dependency gate).
                  ...(areBoardStagesAdjacent(source.stage, targetStage) ? {} : { override: true }),
                },
              })
            : reorderCard({
                environmentId,
                input: {
                  cardId: BoardCardId.make(assignment.cardId),
                  orderKey: assignment.orderKey,
                },
              });
        return command.then((result) => ({ cardId: assignment.cardId, result }));
      });

      void Promise.all(dispatches).then((settled) => {
        const rejected = settled.filter(
          ({ result }) => result._tag === "Failure" && !isAtomCommandInterrupted(result),
        );
        if (rejected.length > 0) {
          // Never let optimistic state survive a rejected command — and say
          // why it bounced (the decider names the unmet dependency).
          const rejectedIds = new Set(rejected.map(({ cardId: id }) => id));
          setPlacements((current) =>
            current.filter((placement) => !rejectedIds.has(placement.cardId)),
          );
          toastManager.add({
            type: "error",
            title: isMove ? "Move rejected" : "Reorder rejected",
            description: commandFailureDescription(rejected[0]!.result),
          });
          return;
        }
        if (targetStage === "building") {
          // D11: within Building, position is queue priority. Announce the
          // slot the drop landed in — derived from the `queued` field, so
          // this stays silent until t3o-11 populates the queue.
          const movedAssignment = assignments.find((next) => next.cardId === cardId);
          if (movedAssignment === undefined) return;
          const slot = boardBuildingQueueInfo(
            applyBoardCardPlacements(liveColumns, [
              { cardId, stage: targetStage, orderKey: movedAssignment.orderKey },
            ]).building,
          ).get(cardId);
          if (slot !== undefined) {
            toastManager.add({
              type: "success",
              title: slot.startsNext
                ? "Queued — starts next"
                : `Queued at position ${slot.position}`,
              description: `${source.card.key} ${
                slot.startsNext ? "is first in the build queue." : "joins the build queue."
              }`,
            });
          }
        }
      });
    },
    [columns, environmentId, liveColumns, moveCard, reorderCard],
  );

  // Turns a target stage + raw insertion index into the settled card order.
  // The index is in "full column" coordinates (the dragged card still counts);
  // convert it to a slot in the list without that card, matching the prototype.
  const commitDrop = useCallback(
    (targetStage: BoardStage, insertIndex: number, cardId: string) => {
      const source = findBoardCard(columns, cardId);
      if (source === null) return;
      const ids = columns[targetStage].map((card) => card.cardId as string);
      const own = ids.indexOf(cardId);
      const list = ids.filter((id) => id !== cardId);
      let index = Math.max(0, Math.min(ids.length, insertIndex));
      if (own >= 0 && index > own) index -= 1;
      list.splice(index, 0, cardId);
      dispatchDrop(targetStage, list, source);
    },
    [columns, dispatchDrop],
  );

  const handleCardDragStart = useCallback(
    (card: BoardCardShell, event: DragEvent<HTMLDivElement>) => {
      const element = event.currentTarget;
      const rect = element.getBoundingClientRect();
      event.dataTransfer.effectAllowed = "move";
      try {
        event.dataTransfer.setData("text/plain", card.cardId);
      } catch {
        // Some browsers disallow setData here; the drag still works without it.
      }
      // A tilted, shadowed clone is the drag image (the prototype's ghost). It
      // sits off-screen just long enough for the browser to snapshot it.
      const ghost = element.cloneNode(true) as HTMLElement;
      ghost.classList.remove("opacity-40");
      ghost.style.cssText +=
        `;position:fixed;top:-1000px;left:-1000px;pointer-events:none;opacity:1;width:${rect.width}px;` +
        "transform:rotate(4deg);box-shadow:0 18px 34px -14px rgb(0 0 0 / 55%)";
      document.body.appendChild(ghost);
      ghostRef.current = ghost;
      event.dataTransfer.setDragImage(ghost, event.clientX - rect.left, event.clientY - rect.top);
      setTimeout(clearGhost, 0);

      const source = findBoardCard(columns, card.cardId);
      const startIndex =
        source === null ? 0 : columns[source.stage].findIndex((c) => c.cardId === card.cardId);
      const next: BoardDrag = { cardId: card.cardId, height: Math.round(rect.height) };
      dragRef.current = next;
      setDrag(next);
      setDragOver(source === null ? null : { stage: source.stage, index: startIndex });
    },
    [clearGhost, columns],
  );

  const handleCardDragEnd = useCallback(() => {
    clearGhost();
    dragRef.current = null;
    setDrag(null);
    setDragOver(null);
  }, [clearGhost]);

  const handleColumnDragOver = useCallback((stage: BoardStage, event: DragEvent<HTMLElement>) => {
    if (dragRef.current === null) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
    const index = boardDropIndexIn(event.currentTarget, event.clientY);
    setDragOver((current) =>
      current !== null && current.stage === stage && current.index === index
        ? current
        : { stage, index },
    );
  }, []);

  const handleColumnDrop = useCallback(
    (stage: BoardStage, event: DragEvent<HTMLElement>) => {
      event.preventDefault();
      const active = dragRef.current;
      if (active === null) {
        handleCardDragEnd();
        return;
      }
      const index = boardDropIndexIn(event.currentTarget, event.clientY);
      commitDrop(stage, index, active.cardId);
      handleCardDragEnd();
    },
    [commitDrop, handleCardDragEnd],
  );

  // ── Selection and deep link (?card=…) ───────────────────────────────
  const selectedCardId = search.card ?? null;
  const handleSelectCard = useCallback(
    (card: BoardCardShell) => {
      // Native drag doesn't fire a click on the source after a drop, so no
      // click-suppression is needed here.
      void navigate({
        search: (previous) => {
          const { card: selected, ...rest } = previous;
          return selected === card.cardId ? rest : { ...rest, card: card.cardId };
        },
      });
    },
    [navigate],
  );
  const handleCloseDetail = useCallback(() => {
    void navigate({
      search: (previous) => {
        const { card: _card, ...rest } = previous;
        return rest;
      },
    });
  }, [navigate]);

  // Opening a card URL selects the card and brings it into view: expand its
  // column if collapsed, scroll the row into place. The detail pane that
  // opens from this selection is t3o-06's.
  const handledDeepLinkRef = useRef<string | null>(null);
  useEffect(() => {
    const cardId = search.card;
    if (cardId === undefined || handledDeepLinkRef.current === cardId) return;
    const found = findBoardCard(columns, cardId);
    if (found === null) return;
    handledDeepLinkRef.current = cardId;
    if (isBoardColumnCollapsed(collapsedByStage, found.stage)) {
      setColumnCollapsed(found.stage, false);
    }
    // Two frames: the first lets a just-expanded column mount its list.
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        document
          .querySelector(`[data-board-card="${window.CSS.escape(cardId)}"]`)
          ?.scrollIntoView({ block: "nearest", inline: "nearest" });
      });
    });
  }, [collapsedByStage, columns, search.card, setColumnCollapsed]);

  // ── Create dialog ───────────────────────────────────────────────────
  // Both the column add buttons and the top-bar button open the same dialog
  // (t3o-06). The dialog owns creation (title, brief, labels, project, stage
  // and initial dependencies land in one atomic create); this only tracks
  // which stage to prefill. Absent means closed.
  const [createStage, setCreateStage] = useState<BoardStage | null>(null);
  const openCreate = useCallback((stage: BoardStage) => setCreateStage(stage), []);

  // ── Archive (t3o-13, D7) ────────────────────────────────────────────
  // Archived cards are off the live shell by design, so they need a place to
  // be seen and restored from — otherwise archiving is a one-way door.
  const [archiveOpen, setArchiveOpen] = useState(false);
  const unarchiveCard = useAtomCommand(boardEnvironment.unarchiveCard);
  const handleRestoreCard = useCallback(
    (cardId: BoardCardId) => {
      void unarchiveCard({ environmentId, input: { cardId } }).then((result) => {
        if (result._tag === "Failure") {
          if (isAtomCommandInterrupted(result)) return;
          toastManager.add({
            title: "Could not restore card",
            description: describeBoardCommandFailure(result),
          });
          return;
        }
        // The card is back on the live board; drop it from the archive list.
        refreshBoardArchivedCards(environmentId);
      });
    },
    [environmentId, unarchiveCard],
  );

  const addProjects = useMemo(
    () =>
      (scopeProjectId === null
        ? projects
        : projects.filter((project) => project.id === scopeProjectId)
      ).map((project) => ({ id: project.id, title: project.title })),
    [projects, scopeProjectId],
  );

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 items-center gap-3 px-3 py-2 sm:px-5">
        <Select
          items={[
            { value: ALL_PROJECTS, label: "All projects" },
            ...projects.map((project) => ({ value: project.id as string, label: project.title })),
            ...(scopeIsStale ? [{ value: scopeProjectId, label: "Unknown project" }] : []),
          ]}
          modal={false}
          onValueChange={(value: string | null) => {
            void navigate({
              search: (previous) => {
                const { project: _project, ...rest } = previous;
                return value === null || value === ALL_PROJECTS
                  ? rest
                  : { ...rest, project: value };
              },
            });
          }}
          value={scopeProjectId ?? ALL_PROJECTS}
        >
          <SelectTrigger aria-label="Project scope" size="xs" variant="ghost">
            <span
              className={cn(
                "size-2 rounded-full",
                scopeProjectId === null
                  ? "bg-muted-foreground/40"
                  : projectAccent(scopeProjectId, accentNameFor(scopeProjectId)).dot,
              )}
            />
            <SelectValue />
          </SelectTrigger>
          <SelectPopup>
            <SelectItem value={ALL_PROJECTS}>All projects</SelectItem>
            {projects.map((project) => (
              <SelectItem key={project.id} value={project.id}>
                <span className="inline-flex items-center gap-1.5">
                  <span
                    className={cn(
                      "size-2 rounded-full",
                      projectAccent(project.id, accentNameFor(project.id)).dot,
                    )}
                  />
                  {project.title}
                </span>
              </SelectItem>
            ))}
            {scopeIsStale ? <SelectItem value={scopeProjectId}>Unknown project</SelectItem> : null}
          </SelectPopup>
        </Select>
        {/* The legend: which colour is which project, for as long as the board
            is showing more than one project's cards. The prototype's swatch is
            a short bar, not the scope picker's dot — the two never read as the
            same control. Shown for a single project too: its colour is on every
            card, so the board still owes you the key to it. */}
        {scopeProjectId === null && projects.length > 0 ? (
          <div className="flex min-w-0 items-center gap-3 overflow-hidden">
            {projects.map((project) => (
              <span
                className="inline-flex shrink-0 items-center gap-1.5 text-[11.5px] font-medium text-muted-foreground"
                key={project.id}
              >
                <span
                  className={cn(
                    "h-[3px] w-[9px] shrink-0 rounded-[2px]",
                    projectAccent(project.id, accentNameFor(project.id)).dot,
                  )}
                />
                {project.title}
              </span>
            ))}
          </div>
        ) : null}
        <span className="flex-1" />
        <Button onClick={() => setArchiveOpen(true)} size="xs" variant="ghost">
          <ArchiveIcon />
          Archived
        </Button>
        {projects.length > 0 ? (
          <Button onClick={() => openCreate("backlog")} size="xs" variant="secondary">
            <PlusIcon />
            New card
          </Button>
        ) : null}
      </div>
      <div className="flex min-h-0 flex-1">
        {/* `items-start` lets each column size to its cards; a collapsed rail
            opts back into full height with `self-stretch`. The row scrolls in
            both axes, so a column taller than the viewport is reachable. */}
        <div className="flex min-h-0 flex-1 items-start gap-2.5 overflow-auto px-3 pb-3 sm:px-5">
          {BOARD_STAGES.map((stage) => (
            <BoardColumn
              accentNameFor={accentNameFor}
              addProjects={addProjects}
              cards={columns[stage]}
              labelsById={labelsById}
              collapsed={isBoardColumnCollapsed(collapsedByStage, stage)}
              draggedCardId={drag?.cardId ?? null}
              dragHeight={drag?.height ?? 0}
              dragOverIndex={
                drag !== null && dragOver !== null && dragOver.stage === stage
                  ? dragOver.index
                  : null
              }
              key={stage}
              onCardDragEnd={handleCardDragEnd}
              onCardDragStart={handleCardDragStart}
              onColumnDragOver={handleColumnDragOver}
              onColumnDrop={handleColumnDrop}
              onRequestCreate={openCreate}
              onSelectCard={handleSelectCard}
              onSetCollapsed={setColumnCollapsed}
              queueSlots={queueSlots}
              selectedCardId={selectedCardId}
              stage={stage}
            />
          ))}
        </div>
      </div>
      {/* The card opens as a centred modal over the board (t3o-06), not a
          rail beside it — so it never squeezes the columns. */}
      {selectedCardId !== null ? (
        <BoardCardDetail
          cardId={BoardCardId.make(selectedCardId)}
          environmentId={environmentId}
          key={selectedCardId}
          onClose={handleCloseDetail}
        />
      ) : null}
      <BoardArchivedCardsSheet
        environmentId={environmentId}
        onOpenChange={setArchiveOpen}
        onRestore={handleRestoreCard}
        onSelectCard={(cardId) => {
          setArchiveOpen(false);
          void navigate({ search: (previous) => ({ ...previous, card: cardId }) });
        }}
        open={archiveOpen}
        scopeProjectId={scopeProjectId}
      />
      <BoardCardCreateDialog
        defaultProjectId={scopeProjectId}
        defaultStage={createStage ?? "backlog"}
        environmentId={environmentId}
        onOpenChange={(open) => {
          if (!open) setCreateStage(null);
        }}
        open={createStage !== null}
        projects={addProjects}
      />
    </div>
  );
}

export default BoardPage;
