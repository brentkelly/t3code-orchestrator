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
  boardNewPhaseHeadingStage,
  boardStageWithRole,
  boardStagesInOrder,
  isBoardStageAtOrAfterBuild,
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
  boardGroupBranchName,
  boardGroupStartPlan,
  boardShellAncestors,
  boardShellDescendants,
  boardShellGroup,
  isBoardGroupShell,
} from "./boardGroups";
import { boardStageLabel } from "./boardStages";
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
  keyPrefix,
  shells,
  stages,
  onClose,
  onOpenBoard,
}: {
  readonly environmentId: EnvironmentId;
  readonly group: BoardCardShell;
  /** The project's key prefix, resolved as `board_new_phase` resolves it. */
  readonly keyPrefix: string;
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
  const headingStage = boardNewPhaseHeadingStage(
    stages,
    parent !== undefined && boardShellGroup(shells, parent)?.target === "own",
  );
  const headingPlace = `the ${boardStageLabel(stages.stages ?? [], headingStage)} of ${parent?.key ?? "the board"}`;
  const confirm = () => {
    const trimmed = title.trim();
    if (trimmed.length === 0 || chosen.length === 0) return;
    onClose();
    const first = boardStagesInOrder(stages)[0]!.stageId;
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
          keyPrefix,
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
        title: `New phase created with ${ids.length} ${ids.length === 1 ? "card" : "cards"} in ${headingPlace}.`,
        action: { label: "Open board", run: () => onOpenBoard(cardId) },
      });
    })();
  };
  return (
    <BoardDialogShell
      body={`Creates a new group next to ${group.key}, in ${headingPlace}. The ticked cards move into its ${boardStageLabel(stages.stages ?? [], boardStagesInOrder(stages)[0]!.stageId)}.`}
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

/** What archiving a group throws away (T3O-28, decision 14), read off the
    subtree's shells: children still building, pull requests open, and the
    branches the cleanup deletes, remote copies included. */
export function boardGroupArchiveLosses(
  shells: Shells,
  stages: BoardState,
  group: BoardCardShell,
): ReadonlyArray<string> {
  const doneStageId = boardStageWithRole(stages, "done")?.stageId ?? null;
  const subtree = [group, ...boardShellDescendants(shells, String(group.cardId))];
  const building = subtree.filter(
    (card) =>
      card.cardId !== group.cardId &&
      !isBoardGroupShell(shells, card) &&
      isBoardStageAtOrAfterBuild(stages, card.stage) &&
      card.stage !== doneStageId,
  );
  const pullRequests = subtree.filter((card) => card.hasPr && card.stage !== doneStageId);
  const branches = subtree.filter(
    (card) =>
      card.worktreeReady === true ||
      boardShellGroup(shells, card)?.target === "own" ||
      (!isBoardGroupShell(shells, card) &&
        isBoardStageAtOrAfterBuild(stages, card.stage) &&
        card.stage !== doneStageId),
  );
  const keys = (cards: Shells) => cards.map((card) => card.key).join(", ");
  return [
    ...(building.length === 0
      ? []
      : [`${building.length} building now, whose threads stop: ${keys(building)}`]),
    ...(pullRequests.length === 0
      ? []
      : [
          `${pullRequests.length} pull ${pullRequests.length === 1 ? "request" : "requests"} closed: ${keys(pullRequests)}`,
        ]),
    ...(branches.length === 0
      ? []
      : [
          `Branches deleted, remote copies included: ${branches
            .map((card) => boardGroupBranchName(card))
            .join(", ")}`,
        ]),
  ];
}

export function BoardArchiveGroupDialog({
  group,
  shells,
  stages,
  onClose,
  onConfirm,
}: {
  readonly group: BoardCardShell;
  readonly shells: Shells;
  readonly stages: BoardState;
  readonly onClose: () => void;
  /** Called with the typed key, which the server checks again. */
  readonly onConfirm: (confirmCardKey: string) => void;
}) {
  const [typed, setTyped] = useState("");
  const count = boardShellDescendants(shells, String(group.cardId)).length;
  const losses = boardGroupArchiveLosses(shells, stages, group);
  return (
    <BoardDialogShell
      afterNote="Unarchiving restores the cards, their plans and their history, but not the work on their branches."
      body={`Archives ${group.key} and all ${count} ${count === 1 ? "card" : "cards"} inside it, deferred ones included.`}
      confirmDanger
      confirmLabel="Archive group"
      losses={{
        title: "This is lost",
        items:
          losses.length === 0
            ? ["Nothing has started yet: no threads, pull requests or branches."]
            : losses,
      }}
      onConfirm={() => {
        onClose();
        onConfirm(typed.trim());
      }}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      open
      title={`Archive ${group.key} and everything in it?`}
      typedKey={{ key: group.key, value: typed, onChange: setTyped }}
    />
  );
}

/**
 * A started leaf asked to take children (T3O-28, decision 12). The default
 * keeps its work: a new group holds it and the moving cards side by side. The
 * destructive branch cancels its work so it can become the group — its thread
 * stops and its pull request closes; its branch is kept until the worktree is
 * reclaimed, not deleted here — and needs the card's typed key.
 */
export function BoardStartedParentDialog({
  environmentId,
  started,
  keyPrefix,
  moving,
  stages,
  onClose,
}: {
  readonly environmentId: EnvironmentId;
  readonly started: BoardCardShell;
  /** The project's key prefix, resolved as the create dialog resolves it. */
  readonly keyPrefix: string;
  readonly moving: Shells;
  readonly stages: BoardState;
  readonly onClose: () => void;
}) {
  const createCard = useAtomCommand(boardEnvironment.createCard);
  const moveCards = useAtomCommand(boardEnvironment.moveCards);
  const cancelCardWork = useAtomCommand(boardEnvironment.cancelCardWork);
  const [choice, setChoice] = useState<"parent" | "cancel">("parent");
  const [title, setTitle] = useState("");
  const [typed, setTyped] = useState("");
  const movingLabel = moving.length === 1 ? moving[0]!.key : `${moving.length} cards`;
  const movingIds = moving.map((card) => card.cardId);
  const fail = (heading: string, result: unknown) =>
    boardToast({ tone: "error", title: heading, description: describeBoardCommandFailure(result) });
  const confirm = () => {
    onClose();
    void (async () => {
      if (choice === "cancel") {
        const cancelled = await cancelCardWork({
          environmentId,
          input: { cardId: started.cardId, confirmCardKey: typed.trim() },
        });
        if (failed(cancelled)) return fail(`Could not cancel work on ${started.key}`, cancelled);
        if (movingIds.length === 0) return;
        const moved = await moveCards({
          environmentId,
          input: { cardId: movingIds[0]!, cardIds: movingIds, parentCardId: started.cardId },
        });
        if (failed(moved))
          return fail(`${started.key} is a group now, but the cards did not move`, moved);
        return;
      }
      const groupId = BoardCardId.make(randomUUID());
      const created = await createCard({
        environmentId,
        input: {
          cardId: groupId,
          projectId: started.projectId,
          title: title.trim(),
          heading: true,
          ...(started.parentCardId === undefined ? {} : { parentCardId: started.parentCardId }),
          keyPrefix,
        },
      });
      if (failed(created)) return fail("Could not create the shared parent", created);
      const ids = [started.cardId, ...movingIds];
      const moved = await moveCards({
        environmentId,
        input: { cardId: ids[0]!, cardIds: ids, parentCardId: groupId },
      });
      if (failed(moved))
        return fail("The shared parent was created, but the cards did not move", moved);
    })();
  };
  const cancelling = choice === "cancel";
  return (
    <BoardDialogShell
      body={`${started.key} · ${started.title} has a worktree and a branch, so it can't become the parent of ${movingLabel}.`}
      confirmDanger={cancelling}
      confirmDisabled={!cancelling && title.trim().length === 0}
      confirmLabel={cancelling ? "Cancel work and make it the parent" : "Create parent"}
      losses={
        cancelling
          ? {
              title: "This is abandoned",
              items: [
                <>
                  The commits on{" "}
                  <code className="font-mono text-[11.5px]">{boardGroupBranchName(started)}</code>{" "}
                  stop being built on. The branch is kept until its worktree is reclaimed, not
                  deleted.
                </>,
                `The ${boardStageLabel(stages.stages ?? [], started.stage).toLowerCase()} thread stops now`,
                ...(started.hasPr ? ["Its pull request will be closed"] : []),
              ],
            }
          : undefined
      }
      onConfirm={confirm}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      open
      options={{
        items: [
          {
            id: "parent",
            label: "Create a shared parent",
            description: `A new group holds ${started.key} and ${movingLabel} side by side. Nothing is lost.`,
          },
          {
            id: "cancel",
            label: `Cancel work on ${started.key} and make it the parent`,
            description: `Abandons what's been built so ${started.key} can become a group.`,
            danger: true,
          },
        ],
        value: choice,
        onChange: (id) => setChoice(id === "cancel" ? "cancel" : "parent"),
      }}
      title={`Work has started on ${started.key}`}
      titleInput={
        cancelling
          ? undefined
          : {
              label: "New parent's title",
              value: title,
              placeholder: "e.g. Event log overhaul",
              onChange: setTitle,
            }
      }
      typedKey={cancelling ? { key: started.key, value: typed, onChange: setTyped } : undefined}
    />
  );
}
