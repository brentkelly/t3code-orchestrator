/**
 * Move-to-another-project confirmation (T3O-33, D6).
 *
 * Unconditional, unlike the base-branch dialog next door, because the one thing
 * that ALWAYS happens is effectively irreversible: the key is reissued and the
 * old number is retired behind the project's card-number floor, so moving the
 * card back yields a THIRD key rather than the original.
 *
 * The two conditional lines are the ones a user cannot see coming — an agent
 * being stopped, and the stage starting again in a different repository.
 * Cancel is the focused default, following `BoardArchiveConfirmDialog`: nothing
 * dispatches until the destructive action is clicked.
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
            <span className="block">
              Reissued as <code className="font-mono text-foreground">{nextKey}</code>. The{" "}
              <code className="font-mono text-foreground">{cardKey}</code> key is retired — moving
              the card back gives it a third key, not this one.
            </span>
            {/* Named by description rather than by branch: only the CURRENT
                project's default branch is resolvable client-side, and guessing
                a name the new repository may not have is worse than saying
                what actually happens — the pin is cleared, and the base is
                resolved live from wherever the card lands. */}
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
                in {currentProjectName} — a thread cannot move between projects, so anything you
                send there still runs against that repository.
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
