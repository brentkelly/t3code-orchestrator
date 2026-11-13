/**
 * The card's Worker row. Before a worktree exists, picking re-pins; after, it
 * opens Move. Absent on a single-worker board unless the card's worker was
 * removed. Offline or removed workers are left by force-move.
 */
import {
  BOARD_LOCAL_WORKER_ID,
  boardCardBoundWorkerId,
  boardCardHoldsWorktree,
  type BoardCard,
  type BoardCardShell,
  type BoardCardStepStalledReason,
  type BoardWorkerId,
  type EnvironmentId,
  type ThreadId,
} from "@t3tools/contracts";
import { useState } from "react";

import { Button } from "../../components/ui/button";
import { boardEnvironment } from "../../state/board";
import { useAtomCommand } from "../../state/use-atom-command";
import { BoardCardForceMoveDialog } from "./BoardCardForceMoveDialog";
import { BoardCardMoveDialog } from "./BoardCardMoveDialog";
import { BoardWorkerPicker } from "./BoardWorkerPicker";
import {
  BOARD_ANY_READY_WORKER_LABEL,
  boardCardPlacementLine,
  boardCardWorkerTrouble,
  boardWorkerFieldLabel,
  boardWorkerLabel,
} from "./cardWorker";
import { useBoardWorkerChoices } from "./useBoardWorkerChoices";

export function BoardCardWorkerRow(props: {
  readonly environmentId: EnvironmentId;
  readonly card: BoardCard;
  /** The live step's stall reason, from the card's shell. */
  readonly stalledReason?: BoardCardStepStalledReason | undefined;
  /** What the card's shell says of its work, for Worker offline. */
  readonly shell?:
    | Pick<
        BoardCardShell,
        "workerId" | "placementOrphaned" | "stepRunning" | "queued" | "stepAwaiting"
      >
    | undefined;
  readonly onOpenThread: (threadId: ThreadId) => void;
}) {
  const { card, environmentId } = props;
  const field = useBoardWorkerChoices(environmentId, card.projectId);
  const pin = useAtomCommand(boardEnvironment.pinCardWorker);
  const [moveTo, setMoveTo] = useState<BoardWorkerId | null>(null);
  // Follow default is a Move to the default that lands the card unpinned.
  const [followDefault, setFollowDefault] = useState(false);
  const [forcing, setForcing] = useState(false);
  const { workers } = field;
  const trouble =
    props.shell === undefined
      ? card.placementOrphaned === null
        ? null
        : boardCardWorkerTrouble(
            {
              placementOrphaned: { workerLabel: card.placementOrphaned.workerLabel },
              stepRunning: false,
              queued: false,
            },
            workers,
          )
      : boardCardWorkerTrouble(props.shell, workers);
  // The force-move dialog unmounts without onClose when the trouble clears (the
  // worker came back); forget it, so a later outage doesn't reopen it unasked.
  if (trouble === null && forcing) setForcing(false);
  if (!field.shown && trouble === null) return null;

  const holds = boardCardHoldsWorktree(card);
  const bound = boardCardBoundWorkerId(card);
  const move = card.workerMove;
  const value =
    holds && card.pinnedWorkerId === null
      ? {
          label: `${boardWorkerLabel(bound ?? BOARD_LOCAL_WORKER_ID, workers)} · placed`,
          pinned: false,
        }
      : boardWorkerFieldLabel(card.pinnedWorkerId, workers);
  const select = (workerId: BoardWorkerId | null) => {
    // A worktree (or a move that retired one) means the card's work has to
    // travel: that is a Move, which checks it is pushed first. Choosing the
    // worker the worktree is already on moves nothing, so it is just a pin.
    // T3o: Unpin leaves a placed card where it is (T3O-87).
    const staysPut = holds && move === null && (workerId === null || workerId === bound);
    // Off a worker the board can't reach, the only move is a force-move.
    if (trouble !== null && holds && !staysPut) {
      setForcing(true);
      return;
    }
    if ((holds || move !== null) && !staysPut && workerId !== null) {
      setFollowDefault(false);
      setMoveTo(workerId);
      return;
    }
    void pin({ environmentId, input: { cardId: card.id, workerId } });
  };
  const runsOn = boardWorkerLabel(bound ?? BOARD_LOCAL_WORKER_ID, workers);
  const stuckOn = card.placementOrphaned?.workerId ?? trouble?.workerId ?? null;

  return (
    <div className="flex flex-col gap-1 py-1">
      {trouble === null ? null : (
        // Worker removed or Worker offline: amber, with the one way
        // out — a force-move from the pushed branch.
        <div className="flex flex-col gap-1.5 rounded-md bg-warning/10 px-2 py-1.5 text-warning-foreground">
          <span className="font-semibold">{trouble.panelTitle}</span>
          <span>{trouble.panelBody}</span>
          <span className="flex gap-1.5">
            <Button onClick={() => setForcing(true)} size="xs" variant="outline">
              {trouble.kind === "removed" ? "Move…" : "Force-move…"}
            </Button>
          </span>
        </div>
      )}
      {!field.shown ? null : (
        <div className="flex items-center gap-1.5">
          <span>Worker ·</span>
          <BoardWorkerPicker
            choices={field.choices}
            className="h-6 flex-1 text-board-11-5"
            followLabel={BOARD_ANY_READY_WORKER_LABEL}
            onSelect={select}
            onSetUp={field.setUp}
            pinnedWorkerId={card.pinnedWorkerId}
            side="top"
            value={value}
          />
        </div>
      )}
      {field.shown ? (
        <span className="text-board-11 leading-board-1-45">
          {boardCardPlacementLine(card.resources?.placement ?? null, holds, workers)}
        </span>
      ) : null}
      {holds && move === null ? (
        <span className="text-board-11 leading-board-1-45">
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
            <Button
              onClick={() => {
                setFollowDefault(false);
                setMoveTo(move.toWorkerId);
              }}
              size="xs"
              variant="outline"
            >
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
      {trouble === null || !forcing ? null : (
        <BoardCardForceMoveDialog
          card={card}
          choices={field.choices}
          environmentId={environmentId}
          onClose={() => setForcing(false)}
          open
          source={{ label: trouble.workerLabel, removed: trouble.kind === "removed" }}
          sourceWorkerId={stuckOn}
          workers={workers}
        />
      )}
      <BoardCardMoveDialog
        key={moveTo ?? "closed"}
        card={card}
        environmentId={environmentId}
        followDefault={followDefault}
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
