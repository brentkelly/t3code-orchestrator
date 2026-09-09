/**
 * The card detail's `Project ·` control (T3O-33).
 *
 * Editable while the card has never been built; pinned from Building onward and
 * on both halves of a sub-board. The lock is NOT a stage index — a card dragged
 * back out of Building still owns a worktree on the old project's checkout, and
 * a Done card whose branch was cleaned up still has its key on a merged pull
 * request — so it comes from `boardCardProjectLock`, the same predicate the
 * decider refuses on. The control and the rejection cannot disagree.
 *
 * Layout follows the prototype (`.plans/prototype/t3o.dc.html:7530-7700`): a
 * borderless trigger of dot + name + chevron, and a 200px menu opening upward
 * and left-aligned, each row carrying the key the card would be REISSUED as.
 */
import type { ProjectId } from "@t3tools/contracts";
import {
  assignBoardKeyPrefix,
  isBoardProjectHidden,
  resolveBoardProjectAccent,
  type BoardCardProjectLock,
  type BoardSettings,
} from "@t3tools/contracts";
import { CheckIcon, ChevronDownIcon, LockIcon } from "lucide-react";
import { useState } from "react";

import { Popover, PopoverPopup, PopoverTrigger } from "../components/ui/popover";
import { cn } from "../lib/utils";
import { BoardHint } from "./BoardHint";
import { projectAccent } from "./projectAccent";

/** One project as the row needs it: identity, name, and whether it is on disk
    here. `workspaceRoot === null` means the project is not on this server. */
export interface BoardProjectChoice {
  readonly id: ProjectId;
  readonly title: string;
  readonly workspaceRoot: string | null;
}

/** A menu row: the project, and the key the card would carry in it. */
export interface BoardProjectOption {
  readonly id: ProjectId;
  readonly title: string;
  readonly accent: string | null;
  /** `PREFIX-N`, the key the move would reissue. Empty on the current project's
      row, which shows a check instead. */
  readonly nextKey: string;
  readonly current: boolean;
}

/** The tooltip a pinned row carries, naming WHY rather than just saying no. */
export function boardCardProjectLockHint(lock: BoardCardProjectLock): string {
  switch (lock.kind) {
    case "built":
      return "Pinned — the build has a worktree on this project";
    case "child":
      return "Pinned — inherits its parent's project";
    case "parent":
      return "Pinned — this card was split into sub-board cards";
  }
}

/**
 * The projects a card may be moved to, in the order the board lists them, each
 * with the key the move would reissue.
 *
 * Hidden projects and projects with no workspace root here are excluded (D8):
 * the first would make the card vanish from the board, and the second fails at
 * Building, hours away from the choice that caused it. The card's CURRENT
 * project is always present and checked, even when it is one of those — a row
 * that cannot show you where you are is worse than one showing a bad option.
 *
 * The next key is a PREVIEW, derived from the keys the client can see. The
 * decider allocates authoritatively from the project's counter, and a card
 * archived or deleted out of the shell (or a concurrent create) can move the
 * real number — so this is what the move would most likely produce, never a
 * promise.
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
        accent: resolveBoardProjectAccent(input.settings, project.id),
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

function ProjectDot({ accent, projectId }: { accent: string | null; projectId: ProjectId }) {
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
  readonly accent: string | null;
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
          className="-ml-[3px] inline-flex h-5 items-center gap-1.5 rounded-md px-[5px] font-medium text-[11.5px] text-foreground hover:bg-accent"
          render={<button type="button" />}
        >
          <ProjectDot accent={accent} projectId={projectId} />
          <span>{label}</span>
          <ChevronDownIcon className="size-3 shrink-0 text-muted-foreground" />
        </PopoverTrigger>
      </BoardHint>
      {/* Upward and left-aligned, per the prototype: the row sits at the bottom
          of the side panel, so a downward menu would open off the panel. */}
      <PopoverPopup align="start" className="w-50 flex-col p-1" side="top">
        <p className="text-wrap px-[7px] pt-1.5 pb-1 text-[11px]/[1.4] text-muted-foreground">
          Moving reissues the task ID and resets the base branch.
        </p>
        {options.map((option) => (
          <button
            className="flex h-7 items-center gap-1.5 rounded-md px-[7px] text-left text-[12px] hover:bg-accent"
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
              <span className="shrink-0 font-medium font-mono text-[10.5px] text-muted-foreground">
                {option.nextKey}
              </span>
            )}
          </button>
        ))}
      </PopoverPopup>
    </Popover>
  );
}
