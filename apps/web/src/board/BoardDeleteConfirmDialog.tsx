/**
 * The gate before the board's only irreversible card action. Always shown, and it
 * states everything about to be destroyed. Cancel is focused.
 */
import type { BoardCardDependencyRef } from "@t3tools/contracts";

import { Button } from "../components/ui/button";
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "../components/ui/alert-dialog";

/** Enough dependents to show the shape of the problem; past this the list
    stops being scannable and a count reads better than a scroll. */
const DEPENDENT_LIST_MAX = 10;

const plural = (count: number, noun: string) => `${count} ${noun}${count === 1 ? "" : "s"}`;

/**
 * What is about to be destroyed. Undefined inputs mean "unknown" (the archive sheet
 * only has the shell), and the copy stays general rather than claim "0 threads".
 */
function describeDeletion(input: {
  readonly branch: string | null | undefined;
  readonly threadCount: number | undefined;
}): string {
  const threads =
    input.threadCount === undefined
      ? "its threads"
      : input.threadCount === 0
        ? null
        : plural(input.threadCount, "thread");
  const disk =
    input.branch === undefined
      ? "its worktree and branches, including any commits that were never merged"
      : input.branch === null
        ? null
        : `its worktree, and the local and remote ${input.branch} branches, including any commits that were never merged`;
  const also = [threads, disk].filter((part) => part !== null);
  const tail = also.length === 0 ? "" : `, along with ${also.join(" and ")}`;
  return `This cannot be undone. The card, its brief, its plans and its history go for good${tail}. Archiving instead keeps all of it and is reversible.`;
}

export function BoardDeleteConfirmDialog({
  branch,
  cardKey,
  dependents,
  onConfirm,
  onOpenChange,
  open,
  threadCount,
}: {
  /** The card's branch, named explicitly because "and its branches" is too
      vague to act on and this is the last chance to copy it somewhere. Null for
      a card that never reached Building; undefined for a caller that cannot
      tell the two apart (see `describeDeletion`). */
  readonly branch?: string | null | undefined;
  readonly cardKey: string;
  /** Live dependents only — the caller filters, so the count in the copy and
      the rows below can never disagree. */
  readonly dependents: ReadonlyArray<BoardCardDependencyRef>;
  readonly onConfirm: () => void;
  readonly onOpenChange: (open: boolean) => void;
  readonly open: boolean;
  /** Threads that go with the card; undefined when the caller cannot count
      them. */
  readonly threadCount?: number | undefined;
}) {
  const shown = dependents.slice(0, DEPENDENT_LIST_MAX);
  const hidden = dependents.length - shown.length;

  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogPopup>
        <AlertDialogHeader>
          <AlertDialogTitle>Delete {cardKey}?</AlertDialogTitle>
          <AlertDialogDescription>
            {describeDeletion({ branch, threadCount })}
          </AlertDialogDescription>
        </AlertDialogHeader>
        {dependents.length === 0 ? null : (
          <>
            <p className="px-6 pb-2 text-[13px] text-muted-foreground">
              {dependents.length === 1
                ? "1 card depends on this one and will lose the dependency:"
                : `${dependents.length} cards depend on this one and will lose the dependency:`}
            </p>
            <ul className="flex max-h-64 flex-col gap-1.5 overflow-y-auto px-6 pb-4">
              {shown.map((dependent) => (
                <li
                  className="flex items-center gap-[9px] rounded-lg border border-border bg-muted px-2.5 py-[7px]"
                  key={dependent.cardId}
                >
                  <span className="shrink-0 text-[11px] font-medium text-muted-foreground">
                    {dependent.key}
                  </span>
                  <span className="min-w-0 flex-1 truncate text-[13px] text-foreground">
                    {dependent.title}
                  </span>
                </li>
              ))}
              {hidden > 0 ? (
                <li className="px-0.5 text-[12px] text-muted-foreground">
                  +{hidden} more {hidden === 1 ? "card" : "cards"}
                </li>
              ) : null}
            </ul>
          </>
        )}
        <AlertDialogFooter>
          <Button
            variant="destructive"
            onClick={() => {
              onOpenChange(false);
              onConfirm();
            }}
          >
            Delete permanently
          </Button>
          <AlertDialogClose autoFocus render={<Button variant="default" />}>
            Cancel
          </AlertDialogClose>
        </AlertDialogFooter>
      </AlertDialogPopup>
    </AlertDialog>
  );
}
