/**
 * Form parts shared by the card modal and the create dialog, so both sheets read
 * as one design. Pure presentation.
 */
import type { BoardCardId, BoardStageDefinition, BoardStageId } from "@t3tools/contracts";
import { ChevronDownIcon, XIcon } from "lucide-react";
import { useState } from "react";

import { Button } from "../components/ui/button";
import { cn } from "../lib/utils";
import { BoardSearchAddPicker, type BoardPickerOption } from "./BoardSearchAddPicker";
import { boardStageLabel } from "./boardStages";

/** The prototype's section label: 11px, uppercase, widely tracked. */
export function BoardSectionHeading({
  children,
  className,
}: {
  readonly children: React.ReactNode;
  readonly className?: string;
}) {
  return (
    <h3
      className={cn(
        "text-board-11 font-semibold uppercase tracking-board-7 text-muted-foreground",
        className,
      )}
    >
      {children}
    </h3>
  );
}

/** A sidebar section that opens on its header: collapsed by default,
    the header carrying a one-line summary of what is inside. */
export function BoardCollapsibleSection({
  title,
  summary,
  defaultOpen = false,
  className,
  children,
}: {
  readonly title: string;
  readonly summary?: React.ReactNode;
  readonly defaultOpen?: boolean;
  readonly className?: string;
  readonly children: React.ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className={cn("flex flex-col gap-2", className)}>
      <button
        aria-expanded={open}
        className="flex w-full min-w-0 items-center gap-1.5 text-left"
        onClick={() => setOpen((value) => !value)}
        type="button"
      >
        <span className="shrink-0 text-board-11 font-semibold uppercase tracking-board-7 text-muted-foreground">
          {title}
        </span>
        <span className="flex-1" />
        {summary === undefined ? null : (
          <span className="truncate text-board-11 font-medium text-foreground">{summary}</span>
        )}
        <ChevronDownIcon
          aria-hidden
          className={cn(
            "size-3 shrink-0 text-muted-foreground transition-transform duration-120",
            open && "rotate-180",
          )}
        />
      </button>
      {open ? children : null}
    </div>
  );
}

export interface BoardDependencyEntry {
  readonly cardId: BoardCardId;
  readonly key: string;
  readonly title: string | null;
  readonly stage: BoardStageId;
  /** False only when the id resolves to no card at all — rendered as an
      unknown reference, never hidden. An ARCHIVED dependency is known: it is
      a real card, resolved from the detail, and reads as
      archived rather than as a dangling id. */
  readonly known: boolean;
  /** Archived dependencies no longer gate the dependent card,
      so they are shown as archived rather than by stage. */
  readonly archived: boolean;
}

/** Heading, add-picker and the chosen dependencies as rows. */
export function BoardDependencySection({
  dependencies,
  options,
  stages,
  onAdd,
  onRemove,
  collapsible,
}: {
  readonly dependencies: ReadonlyArray<BoardDependencyEntry>;
  readonly options: ReadonlyArray<BoardPickerOption>;
  /** The read-model stage list, for resolving a dependency's stage label. */
  readonly stages: ReadonlyArray<BoardStageDefinition>;
  readonly onAdd: (cardId: BoardCardId) => void;
  readonly onRemove: (cardId: BoardCardId) => void;
  /** Collapsible behind a chevron and a summary: starts closed with
      no dependencies and open with some. Adding one opens it. Remount per
      card (a `key`) so the open state does not carry over. */
  readonly collapsible?: boolean;
}) {
  const [openOverride, setOpenOverride] = useState<boolean | null>(null);
  const open = collapsible !== true || (openOverride ?? dependencies.length > 0);
  const toggle = () => setOpenOverride(!open);
  return (
    <>
      <div className={cn("flex items-center gap-1.5", open && "mb-[7px]")}>
        {collapsible === true ? (
          <button className="cursor-pointer" onClick={toggle} type="button">
            <BoardSectionHeading>Dependencies</BoardSectionHeading>
          </button>
        ) : (
          <BoardSectionHeading>Dependencies</BoardSectionHeading>
        )}
        <BoardSearchAddPicker
          label="Add"
          onPick={(id) => {
            setOpenOverride(true);
            onAdd(id as BoardCardId);
          }}
          options={options}
          placeholder="Search cards…"
        />
        {collapsible === true ? (
          <button
            aria-expanded={open}
            aria-label={open ? "Collapse dependencies" : "Expand dependencies"}
            className="flex flex-1 cursor-pointer items-center justify-end gap-1.5 self-stretch"
            onClick={toggle}
            type="button"
          >
            <span className="text-board-11 font-medium text-foreground">
              {dependencies.length === 0 ? "None" : String(dependencies.length)}
            </span>
            <ChevronDownIcon className={cn("size-3 text-muted-foreground", open && "rotate-180")} />
          </button>
        ) : null}
      </div>
      {!open ? null : dependencies.length === 0 ? (
        <p className="text-board-13 text-muted-foreground">No dependencies.</p>
      ) : (
        <ul className="flex flex-col gap-1.5">
          {dependencies.map((dependency) => (
            <li
              className={cn(
                "flex items-center gap-2.25 rounded-lg border border-border bg-muted px-2.5 py-1.75",
                // An archived dependency is inert — it no longer gates this
                // card — so it recedes rather than reading like live work.
                dependency.archived && "opacity-60",
              )}
              key={dependency.cardId}
            >
              <span className="size-1.5 shrink-0 rounded-full bg-muted-foreground/45" />
              <span className="shrink-0 text-board-11 font-medium text-muted-foreground">
                {dependency.key}
              </span>
              <span className="min-w-0 flex-1 truncate text-board-13 text-foreground">
                {dependency.title ?? "Unknown task"}
              </span>
              <span
                className={cn(
                  "shrink-0 text-board-11",
                  dependency.known && !dependency.archived && dependency.stage === "done"
                    ? "text-success-foreground"
                    : "text-muted-foreground",
                )}
              >
                {!dependency.known
                  ? "unknown card"
                  : dependency.archived
                    ? "Archived"
                    : boardStageLabel(stages, dependency.stage)}
              </span>
              <Button
                onClick={() => onRemove(dependency.cardId)}
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
