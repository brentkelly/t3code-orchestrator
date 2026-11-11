/**
 * Archive confirmation, shown when live cards depend on this one: archiving is
 * reversible but silently ungates those dependents, so they are named. Cancel is focused.
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

export function BoardArchiveConfirmDialog({
  cardKey,
  dependents,
  onConfirm,
  onOpenChange,
  open,
}: {
  readonly cardKey: string;
  /** Live dependents only — the caller filters, so the count in the copy and
      the rows below can never disagree. */
  readonly dependents: ReadonlyArray<BoardCardDependencyRef>;
  readonly onConfirm: () => void;
  readonly onOpenChange: (open: boolean) => void;
  readonly open: boolean;
}) {
  const shown = dependents.slice(0, DEPENDENT_LIST_MAX);
  const hidden = dependents.length - shown.length;

  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogPopup>
        <AlertDialogHeader>
          <AlertDialogTitle>Archive {cardKey}?</AlertDialogTitle>
          <AlertDialogDescription>
            {dependents.length === 1
              ? "1 card depends on this one, and it is not done."
              : `${dependents.length} cards depend on this one, and it is not done.`}{" "}
            Archiving keeps those links but stops this card blocking them. Restoring it puts the
            block back.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <ul className="flex max-h-64 flex-col gap-1.5 overflow-y-auto px-6 pb-4">
          {shown.map((dependent) => (
            <li
              className="flex items-center gap-2.25 rounded-lg border border-border bg-muted px-2.5 py-1.75"
              key={dependent.cardId}
            >
              <span className="shrink-0 text-board-11 font-medium text-muted-foreground">
                {dependent.key}
              </span>
              <span className="min-w-0 flex-1 truncate text-board-13 text-foreground">
                {dependent.title}
              </span>
            </li>
          ))}
          {hidden > 0 ? (
            <li className="px-0.5 text-board-12 text-muted-foreground">
              +{hidden} more {hidden === 1 ? "card" : "cards"}
            </li>
          ) : null}
        </ul>
        <AlertDialogFooter>
          <Button
            variant="destructive-outline"
            onClick={() => {
              onOpenChange(false);
              onConfirm();
            }}
          >
            Archive anyway
          </Button>
          <AlertDialogClose autoFocus render={<Button variant="default" />}>
            Cancel
          </AlertDialogClose>
        </AlertDialogFooter>
      </AlertDialogPopup>
    </AlertDialog>
  );
}
