/**
 * Retarget confirmation for a card whose branch is already cut: the new base means
 * a rebase and a `--force-with-lease` push on the next review round, so it names the
 * branch, its cut point and the new target. Cancel is focused.
 */
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

export function BoardBaseBranchConfirmDialog({
  cardKey,
  branch,
  currentBase,
  nextBase,
  onConfirm,
  onOpenChange,
  open,
}: {
  readonly cardKey: string;
  /** The card's own branch — the thing that will be rebased. */
  readonly branch: string;
  /** What that branch was actually cut from (`worktree.baseRefName`). */
  readonly currentBase: string;
  /** The branch being chosen, by name. Always a real branch — a click on the
      project default names that branch even though it STORES null, so the copy
      never has to say "the default" at someone who just picked `main`. */
  readonly nextBase: string;
  readonly onConfirm: () => void;
  readonly onOpenChange: (open: boolean) => void;
  readonly open: boolean;
}) {
  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogPopup>
        <AlertDialogHeader>
          <AlertDialogTitle>Change {cardKey}&apos;s base branch?</AlertDialogTitle>
          <AlertDialogDescription>
            <code className="font-mono text-foreground">{branch}</code> was cut from{" "}
            <code className="font-mono text-foreground">{currentBase}</code> and already has commits
            on it. Pointing it at <code className="font-mono text-foreground">{nextBase}</code>{" "}
            means the card is rebased onto that branch and force-pushed with{" "}
            <code className="font-mono text-foreground">--force-with-lease</code> during its next
            code review round, followed by one more review of the rebased diff.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <Button
            variant="destructive-outline"
            onClick={() => {
              onOpenChange(false);
              onConfirm();
            }}
          >
            Change base branch
          </Button>
          <AlertDialogClose autoFocus render={<Button variant="default" />}>
            Cancel
          </AlertDialogClose>
        </AlertDialogFooter>
      </AlertDialogPopup>
    </AlertDialog>
  );
}
