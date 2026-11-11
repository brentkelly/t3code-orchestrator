/**
 * The card detail's `Project ·` control. The lock comes from `boardCardProjectLock`,
 * the predicate the decider refuses on, not a stage index: a card dragged back out
 * of Building still owns a worktree on the old project.
 */
import type { ProjectIconColor, ProjectIconOverride, ProjectId } from "@t3tools/contracts";
import {
  assignBoardKeyPrefix,
  isBoardProjectHidden,
  type BoardCardProjectLock,
  type BoardSettings,
} from "@t3tools/contracts";
import { CheckIcon, ChevronDownIcon, LockIcon } from "lucide-react";
import { useState } from "react";

import { Popover, PopoverTrigger } from "../components/ui/popover";
import { cn } from "../lib/utils";
import { BoardHint } from "./BoardHint";
import { projectAccent, projectIconColorOf } from "./projectAccent";
import { BoardPopoverPopup } from "./ui/BoardPopoverPopup";

/** One project as the row needs it: identity, name, icon (for its colour),
    and whether it is on disk here. `workspaceRoot === null` means the project
    is not on this server. */
export interface BoardProjectChoice {
  readonly id: ProjectId;
  readonly title: string;
  readonly workspaceRoot: string | null;
  readonly projectIcon: ProjectIconOverride | null | undefined;
}

/** A menu row: the project, and the key the card would carry in it. */
export interface BoardProjectOption {
  readonly id: ProjectId;
  readonly title: string;
  readonly accent: ProjectIconColor | null;
  /** `PREFIX-N`, the key the move would reissue. Empty on the current project's
      row, which shows a check instead. */
  readonly nextKey: string;
  readonly current: boolean;
}

/** The tooltip a pinned row carries, naming WHY rather than just saying no. */
export function boardCardProjectLockHint(lock: BoardCardProjectLock): string {
  switch (lock.kind) {
    case "built":
      return "Pinned: the build has a worktree on this project";
    case "child":
      return "Pinned: lands on a group's integration branch in this project";
    case "parent":
      return "Pinned: its own integration branch lives in this project";
  }
}

/**
 * Move targets with the key each move would reissue (a preview; the decider
 * allocates). Hidden and rootless projects are excluded, but the current project
 * is always present and checked.
 */
export function boardCardProjectOptions(input: {
  readonly projects: ReadonlyArray<BoardProjectChoice>;
  readonly settings: BoardSettings;
  readonly currentProjectId: ProjectId;
  /** Every live card's key, with the project it belongs to — the shell list. */
  readonly cardKeys: ReadonlyArray<{ readonly projectId: ProjectId; readonly key: string }>;
}): ReadonlyArray<BoardProjectOption> {
  const highest = new Map<ProjectId, number>();
  for (const card of input.cardKeys) {
    const number = boardCardKeyNumber(card.key);
    if (number === null) continue;
    highest.set(card.projectId, Math.max(highest.get(card.projectId) ?? 0, number));
  }
  return input.projects
    .filter(
      (project) =>
        project.id === input.currentProjectId ||
        (!isBoardProjectHidden(input.settings, project.id) && project.workspaceRoot !== null),
    )
    .map((project) => {
      const current = project.id === input.currentProjectId;
      const { prefix } = assignBoardKeyPrefix({
        board: input.settings,
        projectId: project.id,
        projectTitle: project.title,
      });
      return {
        id: project.id,
        title: project.title,
        accent: projectIconColorOf(project),
        nextKey: current ? "" : `${prefix}-${(highest.get(project.id) ?? 0) + 1}`,
        current,
      };
    });
}

/** The trailing number of a `PREFIX-N` key, or null when the key has no
    numeric tail (a legacy or hand-written key). */
function boardCardKeyNumber(key: string): number | null {
  const tail = key.slice(key.lastIndexOf("-") + 1);
  if (tail.length === 0 || !/^\d+$/u.test(tail)) return null;
  return Number.parseInt(tail, 10);
}

function ProjectDot({
  accent,
  projectId,
}: {
  accent: ProjectIconColor | null;
  projectId: ProjectId;
}) {
  return (
    <span
      className={cn("size-[7px] shrink-0 rounded-full", projectAccent(projectId, accent).dot)}
    />
  );
}

export function BoardCardProjectRowValue({
  projectId,
  projectName,
  accent,
  lock,
  options,
  onSelect,
}: {
  readonly projectId: ProjectId;
  /** The project's title, or null when it is not on this server. */
  readonly projectName: string | null;
  readonly accent: ProjectIconColor | null;
  /** Why the row is pinned; null makes it editable. */
  readonly lock: BoardCardProjectLock | null;
  readonly options: ReadonlyArray<BoardProjectOption>;
  readonly onSelect: (projectId: ProjectId) => void;
}) {
  const [open, setOpen] = useState(false);
  const label = projectName ?? "Project not on disk";

  if (lock !== null) {
    return (
      <BoardHint label={boardCardProjectLockHint(lock)}>
        <span className="inline-flex items-center gap-1.5 font-medium text-foreground">
          <ProjectDot accent={accent} projectId={projectId} />
          <span>{label}</span>
          <LockIcon className="size-2.5 shrink-0 text-muted-foreground" />
        </span>
      </BoardHint>
    );
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <BoardHint label="Move this task to another project">
        <PopoverTrigger
          aria-label="Project"
          className="-ml-[3px] inline-flex h-5 items-center gap-1.5 rounded-md px-1.25 font-medium text-board-11-5 text-foreground hover:bg-accent"
          render={<button type="button" />}
        >
          <ProjectDot accent={accent} projectId={projectId} />
          <span>{label}</span>
          <ChevronDownIcon className="size-3 shrink-0 text-muted-foreground" />
        </PopoverTrigger>
      </BoardHint>
      {/* Upward and left-aligned, per the prototype: the row sits at the bottom
          of the side panel, so a downward menu would open off the panel. */}
      <BoardPopoverPopup align="start" className="w-50 flex-col" inset="1" side="top">
        <p className="text-wrap px-1.75 pt-1.5 pb-1 text-board-11 leading-board-1-4 text-muted-foreground">
          Moving reissues the task ID and resets the base branch.
        </p>
        {options.map((option) => (
          <button
            className="flex h-7 items-center gap-1.5 rounded-md px-1.75 text-left text-board-12 hover:bg-accent"
            key={option.id}
            onClick={() => {
              setOpen(false);
              // Picking the project the card is already in is not a refusal to
              // show the user — it is a no-op that closes the menu.
              if (!option.current) onSelect(option.id);
            }}
            type="button"
          >
            <ProjectDot accent={option.accent} projectId={option.id} />
            <span className="min-w-0 flex-1 truncate">{option.title}</span>
            {option.current ? (
              <CheckIcon className="size-3 shrink-0 text-muted-foreground" />
            ) : (
              <span className="shrink-0 font-medium font-mono text-board-10-5 text-muted-foreground">
                {option.nextKey}
              </span>
            )}
          </button>
        ))}
      </BoardPopoverPopup>
    </Popover>
  );
}
