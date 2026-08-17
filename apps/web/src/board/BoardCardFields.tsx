/**
 * The card form's shared parts (t3o-06) — the pieces the card modal
 * (`BoardCardDetailView`) and the create dialog (`BoardCardCreateDialog`) both
 * render. Both sheets describe the same card, so they read as one design: the
 * prototype's uppercase section label, and one dependency section with the
 * same rows, the same empty state and the same search-and-add picker.
 *
 * Pure presentation — entries in, a pick or a removal out.
 */
import type { BoardCardId, BoardStage } from "@t3tools/contracts";
import { XIcon } from "lucide-react";

import { Button } from "../components/ui/button";
import { cn } from "../lib/utils";
import { BoardSearchAddPicker, type BoardPickerOption } from "./BoardSearchAddPicker";
import { BOARD_STAGE_LABELS } from "./boardStages";

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
        "text-[11px] font-semibold uppercase tracking-[0.07em] text-muted-foreground",
        className,
      )}
    >
      {children}
    </h3>
  );
}

export interface BoardDependencyEntry {
  readonly cardId: BoardCardId;
  readonly key: string;
  readonly title: string | null;
  readonly stage: BoardStage;
  /** False when the dependency id resolves to no live card (deleted, or
      another environment) — rendered as an unknown reference, never hidden. */
  readonly known: boolean;
}

/** Heading, add-picker and the chosen dependencies as rows. */
export function BoardDependencySection({
  dependencies,
  options,
  onAdd,
  onRemove,
}: {
  readonly dependencies: ReadonlyArray<BoardDependencyEntry>;
  readonly options: ReadonlyArray<BoardPickerOption>;
  readonly onAdd: (cardId: BoardCardId) => void;
  readonly onRemove: (cardId: BoardCardId) => void;
}) {
  return (
    <>
      <div className="mb-[7px] flex items-center gap-1.5">
        <BoardSectionHeading>Dependencies</BoardSectionHeading>
        <BoardSearchAddPicker
          label="Add"
          onPick={(id) => onAdd(id as BoardCardId)}
          options={options}
          placeholder="Search cards…"
        />
      </div>
      {dependencies.length === 0 ? (
        <p className="text-[13px] text-muted-foreground">No dependencies.</p>
      ) : (
        <ul className="flex flex-col gap-1.5">
          {dependencies.map((dependency) => (
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
