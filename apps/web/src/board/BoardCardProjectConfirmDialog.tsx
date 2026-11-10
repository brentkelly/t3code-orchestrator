/**
 * Move-to-another-project confirmation. Unconditional: the key is always reissued
 * and the old number retired, so moving back yields a third key. Cancel is focused.
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

export function BoardCardProjectConfirmDialog({
  cardKey,
  nextKey,
  projectName,
  stageLabel,
  stopsAgent,
  restartsStage,
  retainedThreads,
  currentProjectName,
  onConfirm,
  onOpenChange,
  open,
}: {
  /** The key being retired. */
  readonly cardKey: string;
  /** The key the move would most likely reissue — a preview, so the copy says
      so rather than promising it. */
  readonly nextKey: string;
  readonly projectName: string;
  readonly stageLabel: string;
  /** Whether an agent is working the card right now. */
  readonly stopsAgent: boolean;
  /** Whether the card's stage will start again on a fresh thread. */
  readonly restartsStage: boolean;
  /** How many of the card's other live threads STAY where they are. A thread is
      created in a project and never moves between them, so a link the move does
      not clear still opens a composer against the old repository — disclosed
      here rather than discovered later. */
  readonly retainedThreads: number;
  /** The project the card is leaving, for that line. */
  readonly currentProjectName: string;
  readonly onConfirm: () => void;
  readonly onOpenChange: (open: boolean) => void;
  readonly open: boolean;
}) {
  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogPopup>
        <AlertDialogHeader>
          <AlertDialogTitle>
            Move {cardKey} to {projectName}?
          </AlertDialogTitle>
          <AlertDialogDescription>
            {/* `nextKey` is a client preview; the decider allocates the real key. */}
            <span className="block">
              Reissued as <code className="font-mono text-foreground">{nextKey}</code>, the next
              free number in {projectName}. The{" "}
              <code className="font-mono text-foreground">{cardKey}</code> key is retired: moving
              the card back gives it a third key, not this one.
            </span>
            {/* Described, not named: only the current project's default branch is
                resolvable client-side. */}
            <span className="mt-1.5 block">
              Its base branch resets to {projectName}&apos;s default.
            </span>
            {stopsAgent ? (
              <span className="mt-1.5 block">
                The running {stageLabel} agent is stopped and its thread abandoned.
              </span>
            ) : null}
            {restartsStage ? (
              <span className="mt-1.5 block">
                {stageLabel} restarts in {projectName} on a new thread.
              </span>
            ) : null}
            {retainedThreads > 0 ? (
              <span className="mt-1.5 block">
                {retainedThreads === 1
                  ? "One other thread on this card stays"
                  : `${retainedThreads} other threads on this card stay`}{" "}
                in {currentProjectName}. A thread cannot move between projects, so anything you send
                there still runs against that repository.
              </span>
            ) : null}
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
            Move to {projectName}
          </Button>
          <AlertDialogClose autoFocus render={<Button variant="default" />}>
            Cancel
          </AlertDialogClose>
        </AlertDialogFooter>
      </AlertDialogPopup>
    </AlertDialog>
  );
}
