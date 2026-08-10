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
  resolveBoardKeyPrefix,
  resolveBoardProjectAccent,
  type BoardCardShell,
  type BoardStage,
  type EnvironmentId,
  type ProjectId,
} from "@t3tools/contracts";
import {
  applyBoardCardPlacements,
  boardBuildingQueueInfo,
  boardColumnAppendOrderKey,
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
import {
  DndContext,
  DragOverlay,
  KeyboardSensor,
  PointerSensor,
  closestCorners,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragStartEvent,
} from "@dnd-kit/core";
import { arrayMove, sortableKeyboardCoordinates } from "@dnd-kit/sortable";
import type { LegendListRef } from "@legendapp/list/react";
import { useAtomValue } from "@effect/atom-react";
import { getRouteApi } from "@tanstack/react-router";
import * as Option from "effect/Option";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

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
import { cn, randomUUID } from "../lib/utils";
import { environmentShell } from "../state/shell";
import { boardEnvironment } from "../state/board";
import { usePrimaryEnvironmentId } from "../state/environments";
import { usePrimarySettings } from "../hooks/useSettings";
import { useAtomCommand } from "../state/use-atom-command";
import { COLLAPSED_SIDEBAR_TITLEBAR_INSET_CLASS } from "../workspaceTitlebar";
import { BoardCardContent } from "./BoardCardItem";
import { BoardColumn } from "./BoardColumn";
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
  const createCard = useAtomCommand(boardEnvironment.createCard);
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

  // ── Drag ────────────────────────────────────────────────────────────
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );
  const [activeCardId, setActiveCardId] = useState<string | null>(null);
  const activeCard = useMemo(() => findBoardCard(columns, activeCardId), [columns, activeCardId]);
  const suppressClickRef = useRef(false);

  const handleDragStart = useCallback((event: DragStartEvent) => {
    setActiveCardId(String(event.active.id));
  }, []);

  const handleDragCancel = useCallback(() => {
    setActiveCardId(null);
  }, []);

  const handleDragEnd = useCallback(
    (event: DragEndEvent) => {
      setActiveCardId(null);
      // A completed drag still fires a click on the dragged card; swallow it
      // so a drop does not also toggle selection.
      suppressClickRef.current = true;
      setTimeout(() => {
        suppressClickRef.current = false;
      }, 0);

      const over = event.over;
      if (over === null) return;
      const cardId = String(event.active.id);
      const source = findBoardCard(columns, cardId);
      if (source === null) return;

      const overData = over.data.current as
        | { readonly type?: string; readonly stage?: BoardStage }
        | undefined;
      let targetStage: BoardStage;
      const overId = String(over.id);
      let orderedIds: string[];
      if (overData?.type === "column" && overData.stage !== undefined) {
        targetStage = overData.stage;
        orderedIds = columns[targetStage]
          .map((card) => card.cardId as string)
          .filter((id) => id !== cardId);
        orderedIds.push(cardId);
      } else {
        const overCard = findBoardCard(columns, overId);
        if (overCard === null) return;
        targetStage = overCard.stage;
        const ids = columns[targetStage].map((card) => card.cardId as string);
        if (targetStage === source.stage) {
          orderedIds = arrayMove(ids, ids.indexOf(cardId), ids.indexOf(overId));
        } else {
          orderedIds = [...ids];
          orderedIds.splice(orderedIds.indexOf(overId), 0, cardId);
        }
      }

      const isMove = targetStage !== source.stage;
      if (!isMove) {
        const currentIds = columns[targetStage].map((card) => card.cardId as string);
        if (orderedIds.every((id, index) => id === currentIds[index])) return;
      }

      const keysByCardId = new Map<string, string>(
        columns[targetStage].map((card) => [card.cardId as string, card.orderKey]),
      );
      keysByCardId.set(cardId, source.card.orderKey);
      const assignments = planBoardCardReorder({
        orderedCardIds: orderedIds,
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

  // ── Selection and deep link (?card=…) ───────────────────────────────
  const selectedCardId = search.card ?? null;
  const handleSelectCard = useCallback(
    (card: BoardCardShell) => {
      if (suppressClickRef.current) return;
      void navigate({
        search: (previous) => {
          const { card: selected, ...rest } = previous;
          return selected === card.cardId ? rest : { ...rest, card: card.cardId };
        },
      });
    },
    [navigate],
  );

  const listRefs = useRef<Partial<Record<BoardStage, LegendListRef | null>>>({});
  const registerListRef = useCallback((stage: BoardStage, list: LegendListRef | null) => {
    listRefs.current[stage] = list;
  }, []);

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
        const index = columns[found.stage].findIndex((card) => card.cardId === cardId);
        if (index >= 0) {
          listRefs.current[found.stage]?.scrollToIndex({ index, animated: true });
        }
        document
          .querySelector(`[data-board-card="${window.CSS.escape(cardId)}"]`)
          ?.scrollIntoView({ block: "nearest", inline: "nearest" });
      });
    });
  }, [collapsedByStage, columns, search.card, setColumnCollapsed]);

  // ── Inline add ──────────────────────────────────────────────────────
  const handleAddCard = useCallback(
    (stage: BoardStage, title: string, projectId: ProjectId) => {
      const cardId = BoardCardId.make(randomUUID());
      const stageAppendKey = boardColumnAppendOrderKey(columns[stage]);
      void createCard({
        environmentId,
        input: {
          cardId,
          projectId,
          title,
          cardType: "feature",
          // The per-project key prefix from settings (t3o-07); the decider
          // falls back to the default when unset, so this is always safe.
          keyPrefix: resolveBoardKeyPrefix(boardSettings, projectId),
          // The domain creates into Backlog; landing in another column is a
          // follow-up move with a key appended to that column.
          orderKey:
            stage === "backlog" ? stageAppendKey : boardColumnAppendOrderKey(columns.backlog),
        },
      }).then((created) => {
        if (created._tag === "Failure") {
          if (!isAtomCommandInterrupted(created)) {
            toastManager.add({
              type: "error",
              title: "Card not created",
              description: commandFailureDescription(created),
            });
          }
          return;
        }
        if (stage === "backlog") return;
        void moveCard({
          environmentId,
          input: {
            cardId,
            toStage: stage,
            orderKey: stageAppendKey,
            ...(areBoardStagesAdjacent("backlog", stage) ? {} : { override: true }),
          },
        }).then((moved) => {
          if (moved._tag === "Failure" && !isAtomCommandInterrupted(moved)) {
            toastManager.add({
              type: "error",
              title: "Card created in Backlog",
              description: commandFailureDescription(moved),
            });
          }
        });
      });
    },
    [boardSettings, columns, createCard, environmentId, moveCard],
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
        {scopeProjectId === null && projects.length > 1 ? (
          <div className="flex min-w-0 items-center gap-3 overflow-hidden">
            {projects.map((project) => (
              <span
                className="inline-flex shrink-0 items-center gap-1.5 text-[11.5px] font-medium text-muted-foreground"
                key={project.id}
              >
                <span
                  className={cn(
                    "size-2 rounded-full",
                    projectAccent(project.id, accentNameFor(project.id)).dot,
                  )}
                />
                {project.title}
              </span>
            ))}
          </div>
        ) : null}
      </div>
      <DndContext
        collisionDetection={closestCorners}
        onDragCancel={handleDragCancel}
        onDragEnd={handleDragEnd}
        onDragStart={handleDragStart}
        sensors={sensors}
      >
        <div className="flex min-h-0 flex-1 gap-2.5 overflow-x-auto px-3 pb-3 sm:px-5">
          {BOARD_STAGES.map((stage) => (
            <BoardColumn
              accentNameFor={accentNameFor}
              addProjects={addProjects}
              cards={columns[stage]}
              collapsed={isBoardColumnCollapsed(collapsedByStage, stage)}
              key={stage}
              listRef={registerListRef}
              onAddCard={handleAddCard}
              onSelectCard={handleSelectCard}
              onSetCollapsed={setColumnCollapsed}
              queueSlots={queueSlots}
              selectedCardId={selectedCardId}
              stage={stage}
            />
          ))}
        </div>
        <DragOverlay>
          {activeCard !== null ? (
            <div className="w-68">
              <BoardCardContent
                card={activeCard.card}
                queueSlot={undefined}
                selected={false}
                accentName={accentNameFor(activeCard.card.projectId)}
              />
            </div>
          ) : null}
        </DragOverlay>
      </DndContext>
    </div>
  );
}

export default BoardPage;
