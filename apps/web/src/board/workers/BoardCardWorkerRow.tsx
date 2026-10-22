/**
 * T3o (T3O-65, prototype 4.3 and 6): the card's Worker row in the details
 * column, and the worker notices' panel actions.
 *
 * Before a worktree exists, picking a worker just re-pins the card. Once it has
 * one the card is bound where it is, and picking another worker opens Move.
 * Absent on a board with one worker.
 */
import {
  BOARD_LOCAL_WORKER_ID,
  boardCardBoundWorkerId,
  boardCardHoldsWorktree,
  type BoardCard,
  type BoardCardStepStalledReason,
  type BoardWorkerId,
  type EnvironmentId,
  type ThreadId,
} from "@t3tools/contracts";
import { useState } from "react";

import { Button } from "../../components/ui/button";
import { boardEnvironment } from "../../state/board";
import { useAtomCommand } from "../../state/use-atom-command";
import { BoardCardMoveDialog } from "./BoardCardMoveDialog";
import { BoardWorkerPicker } from "./BoardWorkerPicker";
import { boardWorkerFieldLabel, boardWorkerLabel } from "./cardWorker";
import { useBoardWorkerChoices } from "./useBoardWorkerChoices";

export function BoardCardWorkerRow(props: {
  readonly environmentId: EnvironmentId;
  readonly card: BoardCard;
  /** The live step's stall reason, from the card's shell. */
  readonly stalledReason?: BoardCardStepStalledReason | undefined;
  readonly onOpenThread: (threadId: ThreadId) => void;
}) {
  const { card, environmentId } = props;
  const field = useBoardWorkerChoices(environmentId, card.projectId);
  const pin = useAtomCommand(boardEnvironment.pinCardWorker);
  const [moveTo, setMoveTo] = useState<BoardWorkerId | null>(null);
  if (!field.shown) return null;
  const { workers } = field;

  const holds = boardCardHoldsWorktree(card);
  const bound = boardCardBoundWorkerId(card);
  const move = card.workerMove;
  const value =
    holds && card.pinnedWorkerId === null
      ? {
          label: `${boardWorkerLabel(bound ?? BOARD_LOCAL_WORKER_ID, workers)} · follows default`,
          pinned: false,
        }
      : boardWorkerFieldLabel(card.pinnedWorkerId, workers);
  const select = (workerId: BoardWorkerId | null) => {
    // A worktree (or a move that retired one) means the card's work has to
    // travel: that is a Move, which checks it is pushed first. Choosing the
    // worker the worktree is already on moves nothing, so it is just a pin.
    const staysPut = holds && move === null && (workerId ?? workers.defaultWorkerId) === bound;
    if ((holds || move !== null) && !staysPut) {
      setMoveTo(workerId ?? workers.defaultWorkerId);
      return;
    }
    void pin({ environmentId, input: { cardId: card.id, workerId } });
  };
  const runsOn = boardWorkerLabel(bound ?? workers.defaultWorkerId, workers);

  return (
    <div className="flex flex-col gap-1 py-1">
      <div className="flex items-center gap-1.5">
        <span>Worker ·</span>
        <BoardWorkerPicker
          choices={field.choices}
          className="h-6 flex-1 text-[11.5px]"
          followLabel={`Follow default — ${boardWorkerLabel(workers.defaultWorkerId, workers)}`}
          onSelect={select}
          onSetUp={field.setUp}
          pinnedWorkerId={card.pinnedWorkerId}
          side="top"
          value={value}
        />
      </div>
      {holds && move === null ? (
        <span className="text-[11px]/[1.45]">
          Worktree is on {runsOn}. Choosing another worker moves the card.
        </span>
      ) : null}
      {move?.status === "moving" ? (
        // Blue: the move is in progress, not a fault.
        <span className="rounded-md bg-info/10 px-2 py-1.5 text-info-foreground">
          Moving to {boardWorkerLabel(move.toWorkerId, workers)}. Creating a worktree from{" "}
          <span className="font-mono">{card.worktree?.branch}</span>
          {move.sha === null ? null : (
            <>
              {" "}
              at <span className="font-mono">{move.sha.slice(0, 7)}</span>
            </>
          )}
          .
        </span>
      ) : null}
      {move?.status === "failed" ? (
        <div className="flex flex-col gap-1.5 rounded-md bg-warning/10 px-2 py-1.5 text-warning-foreground">
          <span>
            Move to {boardWorkerLabel(move.toWorkerId, workers)} failed. {move.error} The old
            worktree is already retired, so pick a worker to try again.
          </span>
          <span className="flex gap-1.5">
            <Button onClick={() => setMoveTo(move.toWorkerId)} size="xs" variant="outline">
              Retry
            </Button>
          </span>
        </div>
      ) : null}
      {props.stalledReason === "provider-not-on-worker" ? (
        <span className="rounded-md bg-warning/10 px-2 py-1.5 text-warning-foreground">
          Provider not on worker. This step's provider isn't on {runsOn}, so the step hasn't
          started. Pick another worker above, or change the stage's model in Models to one {runsOn}{" "}
          offers.
        </span>
      ) : null}
      <BoardCardMoveDialog
        key={moveTo ?? "closed"}
        card={card}
        environmentId={environmentId}
        onClose={() => setMoveTo(null)}
        onOpenThread={(threadId) => {
          setMoveTo(null);
          props.onOpenThread(threadId);
        }}
        toWorkerId={moveTo}
        workers={workers}
      />
    </div>
  );
}
