/**
 * T3o board column (t3o-05): header with count and inline add, a virtualised
 * card list (`@legendapp/list`, the app's list virtualiser — long columns
 * must not render every card), and a collapsed rail form that stays a drop
 * target.
 */
import type { BoardCardShell, BoardStage, ProjectId } from "@t3tools/contracts";
import { useDroppable } from "@dnd-kit/core";
import { SortableContext, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { LegendList, type LegendListRef } from "@legendapp/list/react";
import { ChevronLeftIcon, ChevronRightIcon, PlusIcon } from "lucide-react";
import { useCallback, useRef, useState } from "react";

import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "../components/ui/select";
import { cn } from "../lib/utils";
import { BOARD_STAGE_LABELS } from "./boardStages";
import { projectAccent } from "./projectAccent";
import { SortableBoardCard, type BoardCardQueueSlot } from "./BoardCardItem";

export const boardColumnDroppableId = (stage: BoardStage) => `board-column:${stage}`;

export interface BoardAddProject {
  readonly id: ProjectId;
  readonly title: string;
}

export interface BoardColumnProps {
  readonly stage: BoardStage;
  readonly cards: ReadonlyArray<BoardCardShell>;
  readonly collapsed: boolean;
  readonly queueSlots: ReadonlyMap<string, BoardCardQueueSlot>;
  readonly selectedCardId: string | null;
  /** Projects new cards may be created in; empty disables the inline add. */
  readonly addProjects: ReadonlyArray<BoardAddProject>;
  readonly onSetCollapsed: (stage: BoardStage, collapsed: boolean) => void;
  readonly onSelectCard: (card: BoardCardShell) => void;
  readonly onAddCard: (stage: BoardStage, title: string, projectId: ProjectId) => void;
  readonly listRef?: (stage: BoardStage, list: LegendListRef | null) => void;
}

export function BoardColumn(props: BoardColumnProps) {
  return props.collapsed ? <CollapsedColumn {...props} /> : <ExpandedColumn {...props} />;
}

function CollapsedColumn({ stage, cards, onSetCollapsed }: BoardColumnProps) {
  // The rail stays a drop target so a card can be dropped on a collapsed
  // column (it appends at the column tail).
  const { setNodeRef, isOver } = useDroppable({
    id: boardColumnDroppableId(stage),
    data: { type: "column", stage },
  });
  return (
    <button
      ref={setNodeRef}
      className={cn(
        "flex h-full w-10 shrink-0 cursor-pointer flex-col items-center gap-2 rounded-xl border border-transparent bg-muted/50 py-2.5 transition-colors hover:bg-muted",
        isOver && "border-ring bg-muted",
      )}
      onClick={() => onSetCollapsed(stage, false)}
      title="Expand column"
      type="button"
    >
      <ChevronRightIcon className="size-3.5 shrink-0 text-muted-foreground" />
      <span className="text-[11px] font-medium text-muted-foreground">{cards.length}</span>
      <span className="text-sm font-semibold text-muted-foreground [writing-mode:vertical-rl]">
        {BOARD_STAGE_LABELS[stage]}
      </span>
    </button>
  );
}

function ExpandedColumn({
  stage,
  cards,
  queueSlots,
  selectedCardId,
  addProjects,
  onSetCollapsed,
  onSelectCard,
  onAddCard,
  listRef,
}: BoardColumnProps) {
  const { setNodeRef, isOver } = useDroppable({
    id: boardColumnDroppableId(stage),
    data: { type: "column", stage },
  });
  const [adding, setAdding] = useState(false);

  const renderItem = useCallback(
    ({ item }: { item: BoardCardShell }) => (
      <SortableBoardCard
        card={item}
        queueSlot={queueSlots.get(item.cardId)}
        selected={item.cardId === selectedCardId}
        onSelect={onSelectCard}
      />
    ),
    [onSelectCard, queueSlots, selectedCardId],
  );

  return (
    <div
      className={cn(
        "flex h-full w-72 shrink-0 flex-col rounded-xl border border-transparent bg-muted/40 p-2",
        isOver && "border-ring/60",
      )}
    >
      <div className="group/column-header flex shrink-0 items-center gap-1 px-1 pb-2">
        <Button
          className="-ml-1 opacity-0 group-hover/column-header:opacity-100"
          onClick={() => onSetCollapsed(stage, true)}
          size="icon-xs"
          title="Collapse column"
          variant="ghost"
        >
          <ChevronLeftIcon />
        </Button>
        <span className="truncate text-sm font-semibold text-muted-foreground">
          {BOARD_STAGE_LABELS[stage]}
        </span>
        <span className="flex-1" />
        <span className="text-[11px] font-medium text-muted-foreground">{cards.length}</span>
        {addProjects.length > 0 ? (
          <Button
            onClick={() => setAdding(true)}
            size="icon-xs"
            title="New card here"
            variant="ghost"
          >
            <PlusIcon />
          </Button>
        ) : null}
      </div>
      {adding && addProjects.length > 0 ? (
        <InlineAddForm
          onCancel={() => setAdding(false)}
          onSubmit={(title, projectId) => {
            onAddCard(stage, title, projectId);
            setAdding(false);
          }}
          projects={addProjects}
        />
      ) : null}
      <div ref={setNodeRef} className="min-h-0 flex-1">
        <SortableContext
          items={cards.map((card) => card.cardId)}
          strategy={verticalListSortingStrategy}
        >
          {cards.length === 0 ? (
            <div className="flex h-full items-center justify-center rounded-lg border border-dashed border-border/60 text-xs text-muted-foreground">
              No cards
            </div>
          ) : (
            <LegendList<BoardCardShell>
              ref={(list) => listRef?.(stage, list)}
              className="h-full min-h-0"
              data={cards as BoardCardShell[]}
              estimatedItemSize={92}
              keyExtractor={(card) => card.cardId}
              renderItem={renderItem}
            />
          )}
        </SortableContext>
      </div>
    </div>
  );
}

function InlineAddForm({
  projects,
  onSubmit,
  onCancel,
}: {
  readonly projects: ReadonlyArray<BoardAddProject>;
  readonly onSubmit: (title: string, projectId: ProjectId) => void;
  readonly onCancel: () => void;
}) {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [projectId, setProjectId] = useState<ProjectId>(projects[0]!.id);
  return (
    <form
      className="flex shrink-0 flex-col gap-1 pb-2"
      onSubmit={(event) => {
        event.preventDefault();
        const title = inputRef.current?.value.trim() ?? "";
        if (title.length === 0) return;
        onSubmit(title, projectId);
      }}
    >
      <div className="flex items-center gap-1">
        <Input
          ref={inputRef}
          autoFocus
          className="h-7 flex-1 text-sm"
          onKeyDown={(event) => {
            if (event.key === "Escape") onCancel();
          }}
          placeholder="Card title"
        />
        <Button size="xs" type="submit" variant="secondary">
          Add
        </Button>
      </div>
      {projects.length > 1 ? (
        <Select
          items={projects.map((project) => ({ value: project.id as string, label: project.title }))}
          modal={false}
          onValueChange={(value: string | null) => {
            const next = projects.find((project) => project.id === value);
            if (next !== undefined) setProjectId(next.id);
          }}
          value={projectId}
        >
          <SelectTrigger aria-label="Project" className="w-fit" size="xs" variant="ghost">
            <span className={cn("size-2 rounded-full", projectAccent(projectId).dot)} />
            <SelectValue />
          </SelectTrigger>
          <SelectPopup>
            {projects.map((project) => (
              <SelectItem key={project.id} value={project.id}>
                {project.title}
              </SelectItem>
            ))}
          </SelectPopup>
        </Select>
      ) : null}
    </form>
  );
}
