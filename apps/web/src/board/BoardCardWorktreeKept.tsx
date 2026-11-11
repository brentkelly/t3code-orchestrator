/**
 * The "Worktree kept" banner: a finished card whose cleanup would lose work. Amber,
 * since only a human can clear it. Check again re-runs the cleanup; Remove deletes the
 * checkout anyway but keeps the branch, so only uncommitted changes are lost.
 */
import { HardDriveIcon, RefreshCwIcon, Trash2Icon } from "lucide-react";
import { useState } from "react";

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
import { cn } from "../lib/utils";

export function BoardCardWorktreeKept(props: {
  /** Why it was kept (`boardCardWorktreeKeptReason`). */
  readonly reason: string;
  readonly path: string | null;
  readonly branch: string;
  /** Cancelled work: removing it deletes the branch too. */
  readonly cancelledWork: boolean;
  /** Absent where nothing can re-run the cleanup from here. */
  readonly onCheckAgain: (() => void) | null;
  readonly checking: boolean;
  readonly onRemove: (() => void) | null;
  readonly removing: boolean;
  /** Spacing from the layout that owns it. */
  readonly className?: string;
}) {
  const [confirming, setConfirming] = useState(false);
  return (
    <div
      className={cn(
        "flex flex-col gap-2 rounded-md border border-amber-500/30 bg-amber-500/10 px-2.5 py-2",
        props.className,
      )}
    >
      <div className="flex items-start gap-2">
        <HardDriveIcon
          aria-hidden="true"
          className="mt-px size-3.5 shrink-0 text-amber-600 dark:text-amber-400"
        />
        <div className="flex min-w-0 flex-col gap-1">
          <span className="text-[12px] font-medium text-amber-700 dark:text-amber-300">
            Worktree kept
          </span>
          <span className="break-words text-[12px] leading-[1.5] text-amber-700/90 dark:text-amber-300/90">
            {props.reason}
          </span>
          {props.path === null ? null : (
            <span className="break-all font-mono text-[11px] text-amber-700/75 dark:text-amber-300/75">
              {props.path}
            </span>
          )}
        </div>
      </div>
      {props.onCheckAgain === null && props.onRemove === null ? null : (
        <div className="flex justify-end gap-1.5">
          {props.onCheckAgain === null ? null : (
            <Button
              disabled={props.checking}
              onClick={props.onCheckAgain}
              size="xs"
              variant="outline"
            >
              <RefreshCwIcon aria-hidden="true" className="size-3.5" />
              Check again
            </Button>
          )}
          {props.onRemove === null ? null : (
            <Button
              disabled={props.removing}
              onClick={() => setConfirming(true)}
              size="xs"
              variant="destructive-outline"
            >
              <Trash2Icon aria-hidden="true" className="size-3.5" />
              Remove worktree
            </Button>
          )}
        </div>
      )}
      <AlertDialog open={confirming} onOpenChange={setConfirming}>
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove this worktree?</AlertDialogTitle>
            <AlertDialogDescription>
              It was kept because: {props.reason}.{" "}
              {props.cancelledWork
                ? `Its work was cancelled, so removing it deletes the worktree and the branch ${props.branch}, including any commits on it.`
                : `Removing it deletes any uncommitted changes in it. Committed work stays on the branch ${props.branch}.`}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <Button
              variant="destructive-outline"
              onClick={() => {
                setConfirming(false);
                props.onRemove?.();
              }}
            >
              Remove worktree
            </Button>
            <AlertDialogClose autoFocus render={<Button variant="default" />}>
              Cancel
            </AlertDialogClose>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    </div>
  );
}
