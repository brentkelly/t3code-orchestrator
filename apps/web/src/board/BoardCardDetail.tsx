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
  MessageId,
  ThreadId,
  activeBoardCardThreadId,
  areBoardStagesAdjacent,
  deriveBoardCardThreadState,
  resolveBoardPlanningStep,
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
import { primaryServerProvidersAtom } from "../state/server";
import { environmentShell } from "../state/shell";
import { threadEnvironment } from "../state/threads";
import { useAtomCommand } from "../state/use-atom-command";
import { usePrimarySettings } from "../hooks/useSettings";
import { resolveDefaultProviderModelSelection } from "../providerInstances";
import {
  blankThreadCreateInput,
  canRestartBoardPlanning,
  planningThreadTurnInput,
} from "./boardCardThreadSpawn";
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
  const startThreadTurn = useAtomCommand(threadEnvironment.startTurn);
  const createThread = useAtomCommand(threadEnvironment.create);

  // Read from CURRENT settings, never from the card's `recipeSnapshot` (t3o-14,
  // D1: planning snapshots nothing), so restarting planning always uses the
  // prompt as it stands in Settings → Board → Pipeline right now.
  const boardSettings = usePrimarySettings((settings) => settings.board);
  const serverProviders = useAtomValue(primaryServerProvidersAtom);
  const planningStep = useMemo(() => resolveBoardPlanningStep(boardSettings), [boardSettings]);

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

  // Resolved server-side (t3o-13, D4): the shell snapshot drops archived
  // cards, so resolving here would render every archived dependency as an
  // unknown id. `detail.dependencies` is already in `dependsOn` order and
  // omits only ids with no card left at all.
  const dependencies = useMemo<ReadonlyArray<BoardDetailDependency>>(() => {
    if (detail === null || card === null) return [];
    const resolvedById = new Map(detail.dependencies.map((entry) => [entry.cardId, entry]));
    return card.dependsOn.map((dependencyId) => {
      const resolved = resolvedById.get(dependencyId);
      return {
        cardId: dependencyId,
        key: resolved?.key ?? dependencyId,
        title: resolved?.title ?? null,
        stage: resolved?.stage ?? "backlog",
        known: resolved !== undefined,
        archived: resolved !== undefined && resolved.archivedAt !== null,
      };
    });
  }, [card, detail]);

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

  /** Link a freshly created thread to this card. The thread is already running
      by the time this fires, so a failed link leaves an orphan the supervisor
      and `board_get_card_context` cannot resolve to a card — say exactly that,
      rather than the generic command-rejected message `runCommand` shows, so
      the human can adopt or clean it up. The `.catch` covers the promise
      rejecting outright (not resolving to a `Failure` tag). */
  const linkNewThread = (threadId: ThreadId, role: string) => {
    void linkThread({ environmentId, input: { cardId: card.id, threadId, role } })
      .then((linked) => {
        if (linked._tag === "Failure") {
          if (!isAtomCommandInterrupted(linked)) {
            setFeedback(
              `The thread started but could not be linked to this card, so it may not resolve its card context — ${describeBoardCommandFailure(linked)}`,
            );
          }
        } else {
          setFeedback(null);
        }
      })
      .catch(() => {
        setFeedback("The thread started but linking it to this card failed unexpectedly.");
      });
  };

  /** Report a failed thread command (a different result type from the board
      commands `runCommand` handles) without swallowing it. */
  const reportThreadFailure = (result: { readonly _tag: string }) => {
    if (!isAtomCommandInterrupted(result as never)) {
      setFeedback(describeBoardCommandFailure(result));
    }
  };

  // "+ → New thread — restart planning": the same thread the supervisor spawns
  // on entry to Planning, from the CURRENT settings prompt (t3o-14, D8). Unlike
  // the automatic spawn it does not check for an existing thread — starting a
  // second planning pass on a card that already carries one is the point of it.
  const onRestartPlanning = () => {
    if (planningStep === null) return;
    const threadId = ThreadId.make(`thread-${randomUUID()}`);
    void startThreadTurn({
      environmentId,
      input: planningThreadTurnInput({
        card,
        step: planningStep,
        threadId,
        messageId: MessageId.make(`msg-${randomUUID()}`),
        createdAt: new Date().toISOString(),
      }),
    }).then((started) => {
      if (started._tag === "Failure") {
        reportThreadFailure(started);
        return;
      }
      linkNewThread(threadId, planningStep.id);
    });
  };

  // "+ → New thread": an empty thread, already linked, for you to type into.
  // The agent still resolves the card through `board_get_card_context` — the
  // link is what makes that work, not the first message.
  const onCreateBlankThread = () => {
    const project = snapshot?.projects.find((entry) => entry.id === card.projectId) ?? null;
    const modelSelection =
      resolveDefaultProviderModelSelection(serverProviders, project?.defaultModelSelection) ??
      (planningStep === null
        ? null
        : { instanceId: planningStep.providerInstanceId, model: planningStep.model });
    if (modelSelection === null) {
      setFeedback("No provider instance is configured, so a thread cannot be started.");
      return;
    }
    const threadId = ThreadId.make(`thread-${randomUUID()}`);
    void createThread({
      environmentId,
      input: blankThreadCreateInput({
        card,
        threadId,
        modelSelection,
        createdAt: new Date().toISOString(),
      }),
    }).then((created) => {
      if (created._tag === "Failure") {
        reportThreadFailure(created);
        return;
      }
      linkNewThread(threadId, "linked");
    });
  };

  return (
    <BoardCardDetailView
      adoptableThreads={adoptableThreads}
      branch={branch}
      canRestartPlanning={canRestartBoardPlanning(card.stage, planningStep)}
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
      onCreateBlankThread={onCreateBlankThread}
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
      onRestartPlanning={onRestartPlanning}
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
      onSaveTitle={(title) =>
        runCommand(updateCard({ environmentId, input: { cardId: card.id, title } }))
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
