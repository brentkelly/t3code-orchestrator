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
  BOARD_SEED_STAGE_IDS,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  DEFAULT_RUNTIME_MODE,
  ThreadId,
  isBoardReviewStageExecution,
  activeBoardCardThreadId,
  areBoardStagesAdjacent,
  boardStageWithRole,
  deriveBoardCardThreadState,
  resolveBoardStageExecution,
  type BoardCardThreadShell,
  type BoardState,
  type EnvironmentId,
  BOARD_REVIEW_MAX_ROUNDS,
  boardReviewLoopWalk,
  boardReviewRoundsStarted,
  effectiveBoardReviewRounds,
  EMPTY_BOARD_CARD_REVIEW_OVERRIDES,
  type BoardCardReviewOverrides,
} from "@t3tools/contracts";
import { boardColumnAppendOrderKey } from "@t3tools/client-runtime/state/shell";
import {
  isAtomCommandInterrupted,
  type AtomCommandResult,
} from "@t3tools/client-runtime/state/runtime";
import { useAtomValue } from "@effect/atom-react";
import * as Option from "effect/Option";
import { useCallback, useEffect, useMemo, useState } from "react";

import { Dialog } from "../components/ui/dialog";
import { randomUUID } from "../lib/utils";
import { resolveAppModelSelectionState } from "../modelSelection";
import { boardEnvironment } from "../state/board";
import { deriveProviderInstanceEntries } from "../providerInstances";
import { primaryServerProvidersAtom } from "../state/server";
import { environmentShell } from "../state/shell";
import { threadEnvironment } from "../state/threads";
import { usePrimarySettings } from "../hooks/useSettings";
import { useAtomCommand } from "../state/use-atom-command";
import {
  isBoardCardRunInFlight,
  resolveBoardThreadStageRestart,
  runBlankThreadCreation,
  type BlankThreadDispatch,
} from "./boardCardThreadMenu";
import type { BoardActivityAgentLookup } from "./BoardCardActivityRail";
import { boardStageLabel } from "./boardStages";
import { indexBoardLabels } from "./labelColour";
import {
  BoardCardDetailPopup,
  BoardCardDetailView,
  boardCardHasThreadPane,
  type BoardDetailDependency,
  type BoardDetailThreadLink,
} from "./BoardCardDetailView";
import type { BoardPickerOption } from "./BoardSearchAddPicker";
import { describeBoardCommandFailure, describeBoardMergeOutcome } from "./boardCommandFeedback";
import { openPullRequestLink } from "../lib/openPullRequestLink";
import { readLocalApi } from "../localApi";

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
  const stages = useAtomValue(boardEnvironment.stageListAtom(environmentId));
  const shellState = useAtomValue(environmentShell.stateValueAtom(environmentId));

  const updateCard = useAtomCommand(boardEnvironment.updateCard);
  const moveCard = useAtomCommand(boardEnvironment.moveCard);
  const archiveCard = useAtomCommand(boardEnvironment.archiveCard);
  const unarchiveCard = useAtomCommand(boardEnvironment.unarchiveCard);
  const linkThread = useAtomCommand(boardEnvironment.linkThread);
  const unlinkThread = useAtomCommand(boardEnvironment.unlinkThread);
  // Restart and blank-thread creation report their own failures (D4: log and
  // stop — the menu is its own recovery), so they opt out of the shared toast.
  const startStageThread = useAtomCommand(boardEnvironment.startStageThread, {
    reportFailure: false,
  });
  const createThread = useAtomCommand(threadEnvironment.create, { reportFailure: false });
  const deleteThread = useAtomCommand(threadEnvironment.delete, { reportFailure: false });
  // Both PR actions report their own outcomes below — a merge the forge
  // refused is a normal answer with the forge's own wording, not a command
  // failure the generic toast could describe usefully.
  const refreshCardPullRequest = useAtomCommand(boardEnvironment.refreshCardPullRequest, {
    reportFailure: false,
  });
  const mergeCardPullRequest = useAtomCommand(boardEnvironment.mergeCardPullRequest, {
    reportFailure: false,
  });
  const createLabel = useAtomCommand(boardEnvironment.createLabel);
  const updateLabel = useAtomCommand(boardEnvironment.updateLabel);
  const deleteLabel = useAtomCommand(boardEnvironment.deleteLabel);
  const undeleteLabel = useAtomCommand(boardEnvironment.undeleteLabel);

  /** The settled result of any board command atom — a tagged Success/Failure
      the dispatch helpers understand. */
  type BoardCommandResult = Awaited<ReturnType<typeof updateCard>>;

  const [feedback, setFeedback] = useState<string | null>(null);
  // Set for the whole merge round trip — the forge merge plus the local base
  // fast-forward take several seconds — so the button can say "Merging…" and
  // refuse a second click that would re-enter a merge already in flight.
  const [merging, setMerging] = useState(false);

  const snapshot = useMemo(() => Option.getOrNull(shellState.snapshot), [shellState.snapshot]);
  // Refresh trigger: the card detail opening. One of the moments the answer
  // plausibly changed AND is about to be read — the Merge button's condition is
  // the card's PR state, so it should be current at the instant it becomes
  // visible rather than as of whenever the card last did something. Keyed on
  // the card id so it fires once per open, not on every re-render; the
  // server-side lookup is cached for two minutes, so reopening a card in quick
  // succession costs no forge calls at all.
  useEffect(() => {
    void refreshCardPullRequest({ environmentId, input: { cardId } });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the command atom
    // is stable; re-running on its identity would defeat the once-per-open key.
  }, [environmentId, cardId]);
  const labelsById = useMemo(() => indexBoardLabels(catalogue), [catalogue]);
  const stageState = useMemo<BoardState>(
    () => ({ cards: [], stages, nextCardNumberByProject: {} }),
    [stages],
  );
  const boardSettings = usePrimarySettings((settings) => settings.board);
  // Full settings + providers resolve the default model for a blank thread — the
  // same resolution a Threads-view "new thread" uses, so a card-started blank
  // thread lands on the app's default model, not a board-specific one (D3).
  const allSettings = usePrimarySettings();
  const serverProviders = useAtomValue(primaryServerProvidersAtom);

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
  /** Whether a conflict-resolution step is running on this card. The merge
      stage auto-executes nothing, so a live step there can only be that one —
      which is exactly what disables the Merge button while the branch is being
      rewritten under the pull request. */
  const conflictStepRunning = useMemo(
    () => (snapshot?.cards ?? []).find((shell) => shell.cardId === cardId)?.stepRunning === true,
    [snapshot, cardId],
  );

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
        stage: resolved?.stage ?? BOARD_SEED_STAGE_IDS.backlog,
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

  // Agent display names and accents for the Activity rail (t3o-18, D11). Resolved
  // at render time from the provider instance list the app already holds, so a
  // renamed or recoloured instance relabels its own history rather than freezing
  // a stale label on every row it ever wrote.
  const providerEntries = useMemo(
    () => deriveProviderInstanceEntries(serverProviders ?? []),
    [serverProviders],
  );
  const agents = useMemo<BoardActivityAgentLookup>(() => {
    const byId = new Map(providerEntries.map((entry) => [entry.instanceId, entry]));
    return {
      displayName: (instanceId) => byId.get(instanceId)?.displayName ?? String(instanceId),
      accentColor: (instanceId) => byId.get(instanceId)?.accentColor,
    };
  }, [providerEntries]);

  // Each live-linked thread's cached todo list (t3o-18, D3), off the same shell
  // array the column cards read — the modal opens no extra subscription.
  const threadTodos = useMemo<ReadonlyMap<ThreadId, BoardCardThreadShell>>(
    () =>
      new Map(
        (snapshot?.boardCardThreads ?? [])
          .filter((entry) => entry.cardId === cardId)
          .map((entry) => [entry.threadId, entry]),
      ),
    [snapshot, cardId],
  );

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
        wide={shell !== undefined && boardCardHasThreadPane(stages, shell.stage)}
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

  // Per-card human-in-the-loop stance on the Build role (D6): shown only when
  // the card is on the build stage. The default flips on whether the card has a
  // plan; an explicit override wins over it.
  const buildStageId = boardStageWithRole(stageState, "build")?.stageId ?? null;
  const humanInLoop =
    buildStageId !== null && card.stage === buildStageId
      ? (() => {
          const exec = resolveBoardStageExecution(boardSettings, buildStageId);
          const fallback = detail.hasPlan ? exec.humanInLoopWithPlan : exec.humanInLoopWithoutPlan;
          return { value: card.humanInLoop ?? fallback, explicit: card.humanInLoop !== null };
        })()
      : null;

  /** Patch the card's review overrides, preserving the fields not being set.
      One write shape for all three controls (D8) — there is no second
      command. */
  const patchReviewOverrides = (patch: Partial<BoardCardReviewOverrides>) =>
    runCommand(
      updateCard({
        environmentId,
        input: {
          cardId: card.id,
          reviewOverrides: {
            ...(card.reviewOverrides ?? EMPTY_BOARD_CARD_REVIEW_OVERRIDES),
            ...patch,
          },
        },
      }),
    );

  // The `+` menu's restart affordance (t3o-14, D1): shown only when the card's
  // current stage auto-executes, and disabled while a supervised run is in
  // flight for the card — restarting then would leave two threads owning the
  // same step. Both facts are derived by pure helpers (asserted in
  // `boardCardThreadMenu.test.ts`); the in-flight proxy reads the card shell's
  // live status since the step-state read model is server-only.
  const cardShell = (snapshot?.cards ?? []).find((candidate) => candidate.cardId === cardId);

  // The review loop's round budget, for the Review pane's R1..Rn bar. Resolved
  // from the same settings the executor reads, so the bar and the real loop can
  // never disagree on the cap.
  const reviewExecution = resolveBoardStageExecution(boardSettings, BOARD_SEED_STAGE_IDS.review);
  /**
   * The highest round this card's loop has STARTED — the floor the budget
   * cannot go below (t3o-22, D3), and it must be the SAME number the decider
   * computes or the pane offers writes the server refuses.
   *
   * The ledger alone is not that number. A round whose review is dispatched and
   * running has recorded nothing yet, and the decider counts it (it reads the
   * card's live step). The detail payload carries completions but no step
   * state, so the card shell's `stepRunning` — the durable "the executor is
   * driving this card" flag — stands in for it: when it is lit, the round the
   * walk is sitting on is in flight, not merely next.
   */
  const reviewRoundsStarted = (() => {
    const completions = detail?.stepCompletions ?? [];
    const recorded = boardReviewRoundsStarted({ completions, liveStepId: null });
    if (cardShell?.stepRunning !== true) return recorded;
    const walk = boardReviewLoopWalk({
      completions,
      maxRounds: BOARD_REVIEW_MAX_ROUNDS,
      stopAfterRound: card.reviewOverrides?.stopAfterRound ?? null,
    });
    return Math.max(recorded, walk.currentRound);
  })();
  // The EFFECTIVE budget: the card's own override wins, clamped to that floor.
  const reviewMaxRounds = isBoardReviewStageExecution(reviewExecution)
    ? effectiveBoardReviewRounds({
        configured: reviewExecution.rounds,
        overrides: card.reviewOverrides,
        roundsStarted: reviewRoundsStarted,
      })
    : undefined;
  const stageRestart = resolveBoardThreadStageRestart({
    autoExecute: resolveBoardStageExecution(boardSettings, card.stage).autoExecute,
    stageLabel: boardStageLabel(stages, card.stage),
    runInFlight: isBoardCardRunInFlight(cardShell),
  });

  // Restart is a server command (D2): the reactor runs the stage's configured
  // prompt through the same envelope the automatic trigger uses, so the two
  // entry points cannot drift. Failure logs and stops (D4).
  const restartStage = () => {
    void startStageThread({ environmentId, input: { cardId: card.id } }).then((result) => {
      if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
        console.warn("Could not start a stage thread for the card.", result);
      }
    });
  };

  // "New blank thread" (D3): a real server thread with no first turn, linked so
  // its agent resolves the card through `board_get_card_context`. Returns the id
  // so the pane can select it (opening its composer). Failure logs and stops.
  const createBlankThread = async (): Promise<ThreadId | null> => {
    const threadId = ThreadId.make(randomUUID());
    // Flatten an atom-command result to a dispatch outcome: `step` drives the
    // orchestrator (a settled failure is definite; an interrupted one has an
    // unknown server outcome), and the raw result rides along as `detail` so a
    // definite-failure log keeps its error payload.
    const dispatch = (result: AtomCommandResult<unknown, unknown>): BlankThreadDispatch => ({
      step:
        result._tag !== "Failure"
          ? "ok"
          : isAtomCommandInterrupted(result)
            ? "interrupted"
            : "failed",
      detail: result,
    });
    const ok = await runBlankThreadCreation({
      createThread: async () =>
        dispatch(
          await createThread({
            environmentId,
            input: {
              threadId,
              projectId: card.projectId,
              title: `${card.key} · Thread`,
              modelSelection: resolveAppModelSelectionState(allSettings, serverProviders),
              runtimeMode: DEFAULT_RUNTIME_MODE,
              interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
              branch: null,
              worktreePath: null,
            },
          }),
        ),
      linkThread: async () =>
        dispatch(
          await linkThread({ environmentId, input: { cardId: card.id, threadId, role: "linked" } }),
        ),
      rollbackThread: async () =>
        dispatch(await deleteThread({ environmentId, input: { threadId } })),
      warn: (message, detail) => console.warn(message, detail),
    });
    return ok ? threadId : null;
  };

  return (
    <BoardCardDetailView
      adoptableThreads={adoptableThreads}
      stageRestart={stageRestart}
      onRestartStage={restartStage}
      onCreateBlankThread={createBlankThread}
      branch={branch}
      humanInLoop={humanInLoop}
      onSetHumanInLoop={(value) =>
        runCommand(updateCard({ environmentId, input: { cardId: card.id, humanInLoop: value } }))
      }
      stages={stages}
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
      conflictStepRunning={conflictStepRunning}
      merging={merging}
      onMergePullRequest={() => {
        setFeedback(null);
        setMerging(true);
        void mergeCardPullRequest({ environmentId, input: { cardId: card.id } }).then((result) => {
          setMerging(false);
          if (result._tag === "Failure") {
            if (!isAtomCommandInterrupted(result)) setFeedback(describeBoardCommandFailure(result));
            return;
          }
          setFeedback(describeBoardMergeOutcome(result.value));
        });
      }}
      onOpenPullRequest={(url) => {
        // Refresh on the way out: clicking through is the moment the user is
        // about to see the real state on the forge, so the card should not
        // still be showing them a stale one when they come back.
        void refreshCardPullRequest({ environmentId, input: { cardId: card.id } });
        const shell = readLocalApi()?.shell;
        if (shell === undefined) {
          setFeedback("Link opening is unavailable.");
          return;
        }
        void openPullRequestLink(shell, url).catch((error: unknown) => {
          setFeedback(error instanceof Error ? error.message : "Unable to open the pull request.");
        });
      }}
      onMoveStage={(toStage) => {
        const targetColumn = (snapshot?.cards ?? []).filter((shell) => shell.stage === toStage);
        runCommand(
          moveCard({
            environmentId,
            input: {
              cardId: card.id,
              toStage,
              orderKey: boardColumnAppendOrderKey(targetColumn),
              ...(areBoardStagesAdjacent(stageState, card.stage, toStage)
                ? {}
                : { override: true }),
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
      agents={agents}
      projectName={projectName ?? null}
      reviewMaxRounds={reviewMaxRounds}
      reviewOverrides={card.reviewOverrides}
      reviewRoundsStarted={reviewRoundsStarted}
      onSetReviewRounds={(rounds) => patchReviewOverrides({ rounds })}
      onSetReviewRoundModel={(round, model) =>
        patchReviewOverrides({
          roundModels: Object.fromEntries(
            Object.entries({
              ...card.reviewOverrides?.roundModels,
              [String(round)]: model,
            }).filter(([, value]) => value !== null),
          ) as BoardCardReviewOverrides["roundModels"],
        })
      }
      onStopAfterRound={(round) => patchReviewOverrides({ stopAfterRound: round })}
      threadLinks={threadLinks}
      threadTodos={threadTodos}
    />
  );
}
