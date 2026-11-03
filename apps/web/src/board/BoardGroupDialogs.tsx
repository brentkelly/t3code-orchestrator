/**
 * The group confirmations on the board (T3O-29), each a fill of
 * `BoardDialogShell`:
 *
 * - **Start** — dropping a group on Building. With auto-build on it arms the
 *   group (the cascade starts its ready children, now and as they unblock),
 *   even when none is ready yet; with it off it is a one-off start of the
 *   ready, unblocked children.
 * - **New phase** — the group's deferred cards move to a fresh sibling heading
 *   and land in its Backlog. The rules are `boardNewPhasePlan`'s, shared with
 *   `board_new_phase`; the decider re-checks every step.
 */
import {
  BoardCardId,
  areBoardStagesAdjacent,
  boardNewPhaseBrief,
  boardNextPhaseTitle,
  boardStageBeforeBuild,
  boardStagesInOrder,
  type BoardCardShell,
  type BoardStageId,
  type BoardState,
  type EnvironmentId,
} from "@t3tools/contracts";
import { isAtomCommandInterrupted } from "@t3tools/client-runtime/state/runtime";
import { useState } from "react";

import { randomUUID } from "../lib/utils";
import { boardEnvironment } from "../state/board";
import { useAtomCommand } from "../state/use-atom-command";
import { BoardDialogShell } from "./BoardDialogShell";
import { describeBoardCommandFailure } from "./boardCommandFeedback";
import {
  boardDeferredChildren,
  boardGroupStartPlan,
  boardShellAncestors,
  boardShellGroup,
} from "./boardGroups";
import { boardToast } from "./boardToast";

type Shells = ReadonlyArray<BoardCardShell>;

const failed = (result: { readonly _tag: string }) =>
  result._tag === "Failure" && !isAtomCommandInterrupted(result as never);

export function BoardGroupStartDialog({
  environmentId,
  group,
  shells,
  stages,
  buildStageId,
  onClose,
}: {
  readonly environmentId: EnvironmentId;
  readonly group: BoardCardShell;
  readonly shells: Shells;
  readonly stages: BoardState;
  readonly buildStageId: BoardStageId;
  readonly onClose: () => void;
}) {
  const moveCard = useAtomCommand(boardEnvironment.moveCard);
  const plan = boardGroupStartPlan(shells, stages, group);
  const confirm = () => {
    onClose();
    const moves = plan.autoBuild
      ? [
          moveCard({
            environmentId,
            input: {
              cardId: group.cardId,
              toStage: buildStageId,
              ...(areBoardStagesAdjacent(stages, group.stage, buildStageId)
                ? {}
                : { override: true }),
            },
          }),
        ]
      : plan.ready.map((child) =>
          moveCard({ environmentId, input: { cardId: child.cardId, toStage: buildStageId } }),
        );
    void Promise.all(moves).then((results) => {
      const rejected = results.find(failed);
      if (rejected !== undefined) {
        boardToast({
          tone: "error",
          title: `Could not start ${group.key}`,
          description: describeBoardCommandFailure(rejected),
        });
        return;
      }
      boardToast({
        title: plan.autoBuild
          ? `Auto-build started on ${group.key}. ${plan.ready.length} building now; the rest follow as they unblock.`
          : `${plan.ready.length} ${plan.ready.length === 1 ? "child" : "children"} of ${group.key} started.`,
      });
    });
  };
  return (
    <BoardDialogShell
      body={plan.body}
      confirmDisabled={!plan.autoBuild && plan.ready.length === 0}
      confirmLabel={plan.confirmLabel}
      items={plan.ready.map((child) => ({
        id: String(child.cardId),
        cardKey: child.key,
        title: child.title,
        note: "Ready",
      }))}
      onConfirm={confirm}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      open
      title={plan.title}
    />
  );
}

export function BoardNewPhaseDialog({
  environmentId,
  group,
  shells,
  stages,
  onClose,
  onOpenBoard,
}: {
  readonly environmentId: EnvironmentId;
  readonly group: BoardCardShell;
  readonly shells: Shells;
  readonly stages: BoardState;
  readonly onClose: () => void;
  readonly onOpenBoard: (groupCardId: string) => void;
}) {
  const createCard = useAtomCommand(boardEnvironment.createCard);
  const moveCards = useAtomCommand(boardEnvironment.moveCards);
  const moveCard = useAtomCommand(boardEnvironment.moveCard);
  const deferred = boardDeferredChildren(shells, String(group.cardId));
  const [title, setTitle] = useState(() => boardNextPhaseTitle(group.title));
  const [picked, setPicked] = useState<ReadonlySet<string>>(
    () => new Set(deferred.map((card) => String(card.cardId))),
  );
  const chosen = deferred.filter((card) => picked.has(String(card.cardId)));
  const parent = boardShellAncestors(shells, group)[0];
  const confirm = () => {
    const trimmed = title.trim();
    if (trimmed.length === 0 || chosen.length === 0) return;
    onClose();
    const first = boardStagesInOrder(stages)[0]!.stageId;
    // Under an own-branch parent the heading sits on the floor, its first
    // legal column; the moved cards land in the heading's own Backlog.
    const headingStage =
      parent !== undefined && boardShellGroup(shells, parent)?.target === "own"
        ? (boardStageBeforeBuild(stages)?.stageId ?? first)
        : first;
    const cardId = BoardCardId.make(randomUUID());
    const ids = chosen.map((card) => card.cardId);
    void (async () => {
      const created = await createCard({
        environmentId,
        input: {
          cardId,
          projectId: group.projectId,
          title: trimmed,
          brief: boardNewPhaseBrief(group),
          heading: true,
          stage: headingStage,
          ...(group.parentCardId === undefined ? {} : { parentCardId: group.parentCardId }),
          keyPrefix: group.key.replace(/-\d+$/, ""),
        },
      });
      if (failed(created)) {
        boardToast({
          tone: "error",
          title: "Could not create the phase",
          description: describeBoardCommandFailure(created),
        });
        return;
      }
      const moved = await moveCards({
        environmentId,
        input: { cardId: ids[0]!, cardIds: ids, parentCardId: cardId },
      });
      if (failed(moved)) {
        boardToast({
          tone: "error",
          title: "The phase was created, but its cards did not move",
          description: describeBoardCommandFailure(moved),
        });
        return;
      }
      const landed = await Promise.all(
        ids.map((id) => moveCard({ environmentId, input: { cardId: id, toStage: first } })),
      );
      const rejected = landed.find(failed);
      if (rejected !== undefined) {
        boardToast({
          tone: "error",
          title: "The cards moved, but some are still deferred",
          description: describeBoardCommandFailure(rejected),
        });
        return;
      }
      boardToast({
        title: `New phase created with ${ids.length} ${ids.length === 1 ? "card" : "cards"} in the Backlog of ${parent?.key ?? "the board"}.`,
        action: { label: "Open board", run: () => onOpenBoard(cardId) },
      });
    })();
  };
  return (
    <BoardDialogShell
      body={`Creates a new group next to ${group.key}, in the Backlog of ${parent?.key ?? "the board"}. The ticked cards move into its Backlog.`}
      checks={{
        items: deferred.map((card) => ({
          id: String(card.cardId),
          cardKey: card.key,
          title: card.title,
          checked: picked.has(String(card.cardId)),
        })),
        onToggle: (id) =>
          setPicked((current) => {
            const next = new Set(current);
            if (!next.delete(id)) next.add(id);
            return next;
          }),
      }}
      confirmDisabled={title.trim().length === 0 || chosen.length === 0}
      confirmLabel={`Create phase with ${chosen.length}`}
      onConfirm={confirm}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      open
      title="Move deferred cards to a new phase"
      titleInput={{ label: "Phase title", value: title, onChange: setTitle }}
    />
  );
}
