/**
 * T3o card detail modal — connected (t3o-06). Opens `board.subscribeCard` for
 * the one selected card (D7: the heavy detail streams here, never on the shell
 * that every column card renders from), reads the label catalogue and the
 * shell snapshot for dependency/thread resolution, and wires the board
 * commands to the pure `BoardCardDetailView`.
 *
 * Mounting this component IS the detail subscription — it exists only while a
 * card is selected, so the board at rest opens none.
 */
import {
  BoardCardId,
  BoardLabelId,
  activeBoardCardThreadId,
  areBoardStagesAdjacent,
  deriveBoardCardThreadState,
  type EnvironmentId,
} from "@t3tools/contracts";
import { boardColumnAppendOrderKey } from "@t3tools/client-runtime/state/shell";
import { isAtomCommandInterrupted } from "@t3tools/client-runtime/state/runtime";
import { useAtomValue } from "@effect/atom-react";
import * as Option from "effect/Option";
import { useCallback, useMemo, useState } from "react";

import { Dialog } from "../components/ui/dialog";
import { randomUUID } from "../lib/utils";
import { boardEnvironment } from "../state/board";
import { environmentShell } from "../state/shell";
import { useAtomCommand } from "../state/use-atom-command";
import { indexBoardLabels } from "./labelColour";
import {
  BoardCardDetailPopup,
  BoardCardDetailView,
  boardCardHasThreadPane,
  type BoardDetailDependency,
  type BoardDetailThreadLink,
} from "./BoardCardDetailView";
import type { BoardPickerOption } from "./BoardSearchAddPicker";
import { describeBoardCommandFailure } from "./boardCommandFeedback";

/** The modal frame, empty, while `board.subscribeCard` opens — same sheet, so
    nothing jumps when the detail lands. */
function LoadingModal({ onClose, wide }: { readonly onClose: () => void; readonly wide: boolean }) {
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <BoardCardDetailPopup cardId={null} wide={wide}>
        <div className="flex items-center gap-2 px-4 py-16">
          <span className="flex-1 text-center text-sm text-muted-foreground">Loading card…</span>
        </div>
      </BoardCardDetailPopup>
    </Dialog>
  );
}

export function BoardCardDetail({
  environmentId,
  cardId,
  onClose,
}: {
  readonly environmentId: EnvironmentId;
  readonly cardId: BoardCardId;
  readonly onClose: () => void;
}) {
  const detail = useAtomValue(boardEnvironment.cardDetailValueAtom({ environmentId, cardId }));
  const catalogue = useAtomValue(boardEnvironment.labelCatalogueAtom(environmentId));
  const shellState = useAtomValue(environmentShell.stateValueAtom(environmentId));

  const updateCard = useAtomCommand(boardEnvironment.updateCard);
  const moveCard = useAtomCommand(boardEnvironment.moveCard);
  const archiveCard = useAtomCommand(boardEnvironment.archiveCard);
  const unarchiveCard = useAtomCommand(boardEnvironment.unarchiveCard);
  const linkThread = useAtomCommand(boardEnvironment.linkThread);
  const unlinkThread = useAtomCommand(boardEnvironment.unlinkThread);
  const createLabel = useAtomCommand(boardEnvironment.createLabel);
  const updateLabel = useAtomCommand(boardEnvironment.updateLabel);
  const deleteLabel = useAtomCommand(boardEnvironment.deleteLabel);
  const undeleteLabel = useAtomCommand(boardEnvironment.undeleteLabel);

  /** The settled result of any board command atom — a tagged Success/Failure
      the dispatch helpers understand. */
  type BoardCommandResult = Awaited<ReturnType<typeof updateCard>>;

  const [feedback, setFeedback] = useState<string | null>(null);

  const snapshot = useMemo(() => Option.getOrNull(shellState.snapshot), [shellState.snapshot]);
  const labelsById = useMemo(() => indexBoardLabels(catalogue), [catalogue]);

  /** Report a rejected command inline (the decider names cycles, missing
      dependencies, the label cap); clear it once the next command succeeds. */
  const runCommand = useCallback((promise: Promise<BoardCommandResult>) => {
    void promise.then((result) => {
      if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
        setFeedback(describeBoardCommandFailure(result));
      } else if (result._tag !== "Failure") {
        setFeedback(null);
      }
    });
  }, []);

  const card = detail?.card ?? null;

  const dependencies = useMemo<ReadonlyArray<BoardDetailDependency>>(() => {
    if (card === null) return [];
    const cards = snapshot?.cards ?? [];
    return card.dependsOn.map((dependencyId) => {
      const shell = cards.find((candidate) => candidate.cardId === dependencyId);
      return {
        cardId: dependencyId,
        key: shell?.key ?? dependencyId,
        title: shell?.title ?? null,
        stage: shell?.stage ?? "backlog",
        known: shell !== undefined,
      };
    });
  }, [card, snapshot]);

  // A dependency only ever names a card in the same project — the picker never
  // offers one from another project.
  const dependencyOptions = useMemo<ReadonlyArray<BoardPickerOption>>(() => {
    if (card === null) return [];
    const existing = new Set<string>([card.id, ...card.dependsOn]);
    return (snapshot?.cards ?? [])
      .filter(
        (candidate) => candidate.projectId === card.projectId && !existing.has(candidate.cardId),
      )
      .map((candidate) => ({ id: candidate.cardId, key: candidate.key, title: candidate.title }));
  }, [card, snapshot]);

  const threadLinks = useMemo<ReadonlyArray<BoardDetailThreadLink>>(() => {
    if (card === null) return [];
    const threads = snapshot?.threads ?? [];
    return card.threadLinks.map((link) => {
      const thread = threads.find((candidate) => candidate.id === link.threadId);
      const { threadState, awaitingInput } = deriveBoardCardThreadState(thread);
      return {
        threadId: link.threadId,
        role: link.role,
        tombstoned: link.tombstonedAt !== null,
        title: thread?.title ?? null,
        threadState,
        awaitingInput,
      };
    });
  }, [card, snapshot]);

  const adoptableThreads = useMemo<ReadonlyArray<BoardPickerOption>>(() => {
    if (card === null) return [];
    const linkedLive = new Set(
      card.threadLinks.filter((link) => link.tombstonedAt === null).map((link) => link.threadId),
    );
    return (snapshot?.threads ?? [])
      .filter(
        (thread) =>
          thread.projectId === card.projectId &&
          thread.archivedAt === null &&
          !linkedLive.has(thread.id),
      )
      .map((thread) => ({ id: thread.id, key: "", title: thread.title }));
  }, [card, snapshot]);

  if (detail === null || card === null) {
    // The shell already knows the stage, so the empty frame opens at the width
    // the detail will need — no jump from sheet to working surface.
    const shell = (snapshot?.cards ?? []).find((candidate) => candidate.cardId === cardId);
    return (
      <LoadingModal
        onClose={onClose}
        wide={shell !== undefined && boardCardHasThreadPane(shell.stage)}
      />
    );
  }

  const projectName = snapshot?.projects.find((project) => project.id === card.projectId)?.title;
  // The card owns no branch — its active thread does. Shown when there is one,
  // absent otherwise (never a guessed default).
  const activeThreadId = activeBoardCardThreadId(card.threadLinks);
  const branch =
    activeThreadId === null
      ? null
      : (snapshot?.threads.find((thread) => thread.id === activeThreadId)?.branch ?? null);

  return (
    <BoardCardDetailView
      adoptableThreads={adoptableThreads}
      branch={branch}
      catalogue={catalogue}
      dependencies={dependencies}
      dependencyOptions={dependencyOptions}
      detail={detail}
      environmentId={environmentId}
      feedback={feedback}
      labelsById={labelsById}
      onAddDependency={(dependencyId) =>
        runCommand(
          updateCard({
            environmentId,
            input: { cardId: card.id, dependsOn: [...card.dependsOn, dependencyId] },
          }),
        )
      }
      onArchiveToggle={() =>
        runCommand(
          (card.archivedAt === null ? archiveCard : unarchiveCard)({
            environmentId,
            input: { cardId: card.id },
          }),
        )
      }
      onClose={onClose}
      onCreateLabel={(name) => {
        // Create the label, then tag this card with it in one gesture — a
        // client-generated id lets the tag reference it without a round trip,
        // and command ordering guarantees the label exists first.
        const labelId = BoardLabelId.make(randomUUID());
        void createLabel({ environmentId, input: { labelId, name } }).then((created) => {
          if (created._tag === "Failure") {
            if (!isAtomCommandInterrupted(created))
              setFeedback(describeBoardCommandFailure(created));
            return;
          }
          runCommand(
            updateCard({
              environmentId,
              input: { cardId: card.id, labels: [...card.labels, labelId] },
            }),
          );
        });
      }}
      onDeleteLabel={(labelId) => runCommand(deleteLabel({ environmentId, input: { labelId } }))}
      onLinkThread={(threadId, role) =>
        runCommand(linkThread({ environmentId, input: { cardId: card.id, threadId, role } }))
      }
      onMoveStage={(toStage) => {
        const targetColumn = (snapshot?.cards ?? []).filter((shell) => shell.stage === toStage);
        runCommand(
          moveCard({
            environmentId,
            input: {
              cardId: card.id,
              toStage,
              orderKey: boardColumnAppendOrderKey(targetColumn),
              ...(areBoardStagesAdjacent(card.stage, toStage) ? {} : { override: true }),
            },
          }),
        );
      }}
      onRecolourLabel={(labelId, colour) =>
        runCommand(updateLabel({ environmentId, input: { labelId, colour } }))
      }
      onRemoveDependency={(dependencyId) =>
        runCommand(
          updateCard({
            environmentId,
            input: {
              cardId: card.id,
              dependsOn: card.dependsOn.filter((id) => id !== dependencyId),
            },
          }),
        )
      }
      onSaveBrief={(brief) =>
        runCommand(updateCard({ environmentId, input: { cardId: card.id, brief } }))
      }
      onSetLabels={(labels) =>
        runCommand(updateCard({ environmentId, input: { cardId: card.id, labels } }))
      }
      onUndeleteLabel={(labelId) =>
        runCommand(undeleteLabel({ environmentId, input: { labelId } }))
      }
      onUnlinkThread={(threadId) =>
        runCommand(unlinkThread({ environmentId, input: { cardId: card.id, threadId } }))
      }
      projectName={projectName ?? null}
      threadLinks={threadLinks}
    />
  );
}
