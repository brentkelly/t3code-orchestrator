/**
 * Asks before a card leaves Planning with no plan written (T3O-19).
 *
 * Shown on every way out — the forward button, the stage ladder and a drag —
 * because the card can be moved on before the agent has finished. Following the
 * sibling confirm dialogs, Cancel is the focused default: nothing moves until
 * the move button is clicked. The planning thread stays on the card either way,
 * and the copy says so, because a user who has moved on by mistake needs to
 * know how to get back.
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
import { boardStageLabelMidSentence } from "./boardCardThreadMenu";

export function BoardPlanningExitConfirmDialog({
  cardKey,
  fromStageLabel,
  toStageLabel,
  onConfirm,
  onOpenChange,
  open,
}: {
  readonly cardKey: string;
  /** The plan-role stage the card is leaving. */
  readonly fromStageLabel: string;
  readonly toStageLabel: string;
  readonly onConfirm: () => void;
  readonly onOpenChange: (open: boolean) => void;
  readonly open: boolean;
}) {
  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogPopup>
        <AlertDialogHeader>
          <AlertDialogTitle>
            Move {cardKey} to {toStageLabel} without a plan?
          </AlertDialogTitle>
          <AlertDialogDescription>
            <span className="block">No plan has been written for this card yet.</span>
            <span className="mt-1.5 block">
              Its {boardStageLabelMidSentence(fromStageLabel)} thread stays on the card, so moving
              the card back to {fromStageLabel} picks the conversation up where it left off.
            </span>
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <Button
            variant="outline"
            onClick={() => {
              onOpenChange(false);
              onConfirm();
            }}
          >
            Move to {toStageLabel}
          </Button>
          <AlertDialogClose autoFocus render={<Button variant="default" />}>
            Cancel
          </AlertDialogClose>
        </AlertDialogFooter>
      </AlertDialogPopup>
    </AlertDialog>
  );
}
