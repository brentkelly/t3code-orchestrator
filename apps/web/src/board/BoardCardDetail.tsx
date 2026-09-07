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
  BOARD_SEED_STAGES,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  DEFAULT_RUNTIME_MODE,
  ThreadId,
  effectiveBoardRuntimeMode,
  isBoardReviewStageExecution,
  activeBoardCardThreadId,
  areBoardStagesAdjacent,
  boardCardAttention,
  boardStageWithRole,
  boardSubBoardFloorStage,
  isBoardStageAtOrAfterBuild,
  deriveBoardCardThreadState,
  boardBuildHumanInLoopDefault,
  resolveBoardStageExecution,
  type BoardCardShell,
  type BoardCardThreadShell,
  type BoardState,
  type EnvironmentId,
  boardReviewRoundsStarted,
  reviewStepId,
  effectiveBoardReviewRounds,
  EMPTY_BOARD_CARD_REVIEW_OVERRIDES,
  type BoardCardReviewOverrides,
  type BoardCardStageModelOverride,
} from "@t3tools/contracts";
import {
  boardBuildQueue,
  boardColumnAppendOrderKey,
  boardRunningStepCount,
  planBoardQueueMoveToFront,
} from "@t3tools/client-runtime/state/shell";
import {
  isAtomCommandInterrupted,
  type AtomCommandResult,
} from "@t3tools/client-runtime/state/runtime";
import { useAtomValue } from "@effect/atom-react";
import * as Option from "effect/Option";
import { useCallback, useEffect, useMemo, useState } from "react";

import { Dialog } from "../components/ui/dialog";
import { randomUUID } from "../lib/utils";
import { getCustomModelOptionsByInstance, resolveAppModelSelectionState } from "../modelSelection";
import { getTriggerDisplayModelName } from "../components/chat/providerIconUtils";
import { boardEnvironment } from "../state/board";
import { boardAttachmentLimits } from "./boardAttachmentUpload";
import { boardQueueInfo } from "./boardQueueInfo";
import { useEnvironment } from "../state/environments";
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
  boardCardIsDone,
  type BoardDetailDependency,
  type BoardDetailThreadLink,
} from "./BoardCardDetailView";
import type { BoardPickerOption } from "./BoardSearchAddPicker";
import {
  describeBoardCommandFailure,
  describeBoardMergeOutcome,
  describeBoardSubmitOutcome,
} from "./boardCommandFeedback";
import { openPullRequestLink } from "../lib/openPullRequestLink";
import { readLocalApi } from "../localApi";

/** The modal frame, empty, while `board.subscribeCard` opens — same sheet, so
    nothing jumps when the detail lands. */
function LoadingModal({
  onClose,
  wide,
  done,
}: {
  readonly onClose: () => void;
  readonly wide: boolean;
  readonly done: boolean;
}) {
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <BoardCardDetailPopup cardId={null} done={done} wide={wide}>
        <div className="flex items-center gap-2 px-4 py-16">
          <span className="flex-1 text-center text-sm text-muted-foreground">Loading card…</span>
        </div>
      </BoardCardDetailPopup>
    </Dialog>
  );
}

const EMPTY_SHELL_CARDS: ReadonlyArray<BoardCardShell> = [];

export function BoardCardDetail({
  environmentId,
  cardId,
  onClose,
  onOpenSubBoard,
}: {
  readonly environmentId: EnvironmentId;
  readonly cardId: BoardCardId;
  readonly onClose: () => void;
  /** Navigate into a parent's sub-board (t3o-25), optionally with a card's
      sheet open there — wired to the child sheet's "part of" chip and the
      parent plan pane's child chips. */
  readonly onOpenSubBoard?: ((parentCardId: string, cardId?: string) => void) | undefined;
}) {
  const detail = useAtomValue(boardEnvironment.cardDetailValueAtom({ environmentId, cardId }));
  const catalogue = useAtomValue(boardEnvironment.labelCatalogueAtom(environmentId));
  const stages = useAtomValue(boardEnvironment.stageListAtom(environmentId));
  const shellState = useAtomValue(environmentShell.stateValueAtom(environmentId));

  const updateCard = useAtomCommand(boardEnvironment.updateCard);
  const moveCard = useAtomCommand(boardEnvironment.moveCard);
  const reorderCard = useAtomCommand(boardEnvironment.reorderCard);
  const forceStartStep = useAtomCommand(boardEnvironment.forceStartStep);
  const reopenStep = useAtomCommand(boardEnvironment.reopenStep);
  const archiveCard = useAtomCommand(boardEnvironment.archiveCard);
  const unarchiveCard = useAtomCommand(boardEnvironment.unarchiveCard);
  const deleteCard = useAtomCommand(boardEnvironment.deleteCard);
  const approvePlans = useAtomCommand(boardEnvironment.approvePlans);
  const linkThread = useAtomCommand(boardEnvironment.linkThread);
  const unlinkThread = useAtomCommand(boardEnvironment.unlinkThread);
  // Brief attachments (t3o-32): an attach failure is shown on the staged row
  // itself, so it opts out of the shared toast.
  const attachCardFile = useAtomCommand(boardEnvironment.attachCardFile, { reportFailure: false });
  const detachCardFile = useAtomCommand(boardEnvironment.detachCardFile);
  const environment = useEnvironment(environmentId);
  const attachmentLimits = boardAttachmentLimits(
    environment?.serverConfig?.environment.capabilities ?? null,
  );
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
  // Same reason as the two above: every refusal is a normal answer with its own
  // wording ("this card has no branch to push"), not a command failure.
  const submitCardForMerge = useAtomCommand(boardEnvironment.submitCardForMerge, {
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
  /** Whether the card's step has SETTLED and left the card standing — the same
      `held` the card face reads for its "Needs a human" chip, ranked by
      `boardCardAttention` so the chip and the detail's forward button can never
      disagree (t3o-06 held-build-forward-button, D2). The ranking brings the
      guards with it: a running or queued step is not held, a card dragged back
      before the build role is not held, a parent building through its children
      is not held, and a `stalled` step outranks `held` so Restart keeps owning
      that case (D3). */
  const stepHeld = useMemo(() => {
    const shell = (snapshot?.cards ?? []).find((candidate) => candidate.cardId === cardId);
    return shell !== undefined && boardCardAttention({ card: shell, stages })?.reason === "held";
  }, [snapshot, cardId, stages]);
  /** Whether the card's live step has given up (t3o-17, D3) — the failure
      banner's gate and the reason a non-auto-executing stage still offers a
      restart (t3o-30, D3). */
  const stepStalled = useMemo(
    () => (snapshot?.cards ?? []).find((shell) => shell.cardId === cardId)?.stalled === true,
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
  // offers one from another project. A sub-board child's picker is narrower
  // still (t3o-25): siblings only, as materialised edges are scoped; the
  // decider refuses anything else on create, and offering it here would only
  // teach the rule by refusal. Children offered to a TOP-LEVEL card carry
  // their parent's key as a badge instead.
  const dependencyOptions = useMemo<ReadonlyArray<BoardPickerOption>>(() => {
    if (card === null) return [];
    const shells = snapshot?.cards ?? [];
    const keyById = new Map(shells.map((shell) => [String(shell.cardId), shell.key]));
    const existing = new Set<string>([card.id, ...card.dependsOn]);
    return shells
      .filter(
        (candidate) =>
          candidate.projectId === card.projectId &&
          !existing.has(candidate.cardId) &&
          (card.parentCardId === null || candidate.parentCardId === card.parentCardId),
      )
      .map((candidate) => ({
        id: candidate.cardId,
        key: candidate.key,
        title: candidate.title,
        ...(card.parentCardId === null && candidate.parentCardId !== undefined
          ? { parentKey: keyById.get(String(candidate.parentCardId)) }
          : {}),
      }));
  }, [card, snapshot]);

  // The child's parent, resolved for the sheet's "part of" chip (t3o-25). An
  // archived parent is off the live shell and its sub-board would redirect
  // straight back out — no chip rather than a dead door.
  const parentCard = useMemo(() => {
    if (card === null || card.parentCardId === null) return null;
    const parent = (snapshot?.cards ?? []).find((shell) => shell.cardId === card.parentCardId);
    return parent === undefined ? null : { cardId: String(parent.cardId), key: parent.key };
  }, [card, snapshot]);

  // THIS card's children, as shells (t3o-29, D1). The snapshot is unscoped —
  // a child is filtered out of the root board's COLUMNS by
  // `filterBoardColumnsByScope`, never out of the shell list — so the parent's
  // own modal can read every child's live stage, PR and step state without a
  // second subscription or a byte on the wire. Archived children are not here
  // (they leave the snapshot, D15); the Plans panel renders those from
  // `detail.children` instead.
  const childShells = useMemo(() => {
    if (card === null) return [];
    return (snapshot?.cards ?? []).filter((shell) => shell.parentCardId === card.id);
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
  // Resolve an override's model slug to its display name for the header pill
  // (t3o-29, D7), the same lookup the popover's placeholder uses — so the pill,
  // its tooltip and the popover all name a model the same way.
  const resolveModelDisplayName = useCallback(
    (override: BoardCardStageModelOverride): string => {
      const option = getCustomModelOptionsByInstance(
        allSettings,
        serverProviders ?? [],
        override.instanceId,
        override.model,
      )
        .get(override.instanceId)
        ?.find((candidate) => candidate.slug === override.model);
      return option ? getTriggerDisplayModelName(option) : override.model;
    },
    [allSettings, serverProviders],
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

  // ── Everything below this line runs before the loading early return ──
  // The card's own shell, and the queue state derived from it. These sit ABOVE
  // the `LoadingModal` branch because they include hooks: `detail` is null on
  // the first render of every card modal, so a hook declared after that branch
  // would be skipped on render one and present on render two. (The repo's
  // oxlint config carries no `rules-of-hooks`, so nothing catches that but a
  // crash in the app.)
  //
  // The in-flight proxy for the `+` menu's restart affordance (t3o-14, D1)
  // reads this same shell, since the step-state read model is server-only.
  const cardShell = (snapshot?.cards ?? []).find((candidate) => candidate.cardId === cardId);

  // The card's place in the board-wide build queue (t3o-33). Derived from the
  // shells the modal already holds — every project, since the queue is global —
  // so a queued card can say why it is waiting instead of opening on the
  // planning conversation it left behind and explaining nothing.
  //
  // Everything below is skipped for the overwhelmingly common case: the map is
  // empty unless something is actually queued.
  const allShellCards = snapshot?.cards ?? EMPTY_SHELL_CARDS;
  // Same fallback the board uses: before the first snapshot the stage list is
  // empty, and ranking every queued card equally would print a position that is
  // wrong rather than absent.
  const queueStages = stages.length > 0 ? stages : BOARD_SEED_STAGES;
  const queueInfo = useMemo(
    () =>
      cardShell?.queued !== true
        ? null
        : boardQueueInfo({
            slot: boardBuildQueue(allShellCards, queueStages).get(cardId),
            running: boardRunningStepCount(allShellCards),
            cap: boardSettings.concurrency.globalMaxConcurrent,
          }),
    [
      allShellCards,
      boardSettings.concurrency.globalMaxConcurrent,
      cardId,
      cardShell?.queued,
      queueStages,
    ],
  );
  // Null whenever reordering could not actually improve the card's position —
  // the rail hides the button rather than offering one that does nothing.
  const queueMoveToFront = useMemo(
    () =>
      queueInfo === null
        ? null
        : planBoardQueueMoveToFront({ cards: allShellCards, stages: queueStages, cardId }),
    [allShellCards, cardId, queueInfo, queueStages],
  );
  // Strictly "the command is in flight" — cleared when it settles, either way.
  // It deliberately does NOT wait for the card to leave the queue: the governor
  // can decline to start it (a worktree that will not provision), and a button
  // that waits for a signal which may never arrive is stuck forever. The
  // request is durable on the step row, so asking again is harmless.
  const [forceStartPending, setForceStartPending] = useState(false);

  if (detail === null || card === null) {
    // The shell already knows the stage, so the empty frame opens at the width
    // the detail will need — no jump from sheet to working surface.
    return (
      <LoadingModal
        done={cardShell !== undefined && boardCardIsDone(stages, cardShell.stage)}
        onClose={onClose}
        wide={cardShell !== undefined && boardCardHasThreadPane(stages, cardShell.stage)}
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
  // plan — a sub-board child counts as planned (t3o-23: its approved plan is
  // its brief) — and an explicit override wins over it. The same rule the
  // reactor runs the step under, so the hint here never contradicts the run.
  const buildStageId = boardStageWithRole(stageState, "build")?.stageId ?? null;
  const humanInLoop =
    buildStageId !== null && card.stage === buildStageId
      ? (() => {
          const exec = resolveBoardStageExecution(boardSettings, buildStageId);
          const fallback = boardBuildHumanInLoopDefault(exec, card, detail.hasPlan);
          return {
            value: card.humanInLoop ?? fallback,
            explicit: card.humanInLoop !== null,
            basis: card.parentCardId !== null ? "child" : detail.hasPlan ? "plan" : "no-plan",
          } as const;
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

  // The review loop's round budget, for the Review pane's R1..Rn bar. Resolved
  // from the same settings the executor reads, so the bar and the real loop can
  // never disagree on the cap.
  const reviewExecution = resolveBoardStageExecution(boardSettings, BOARD_SEED_STAGE_IDS.review);
  /**
   * The rounds this card's loop has RECORDED — the budget's floor.
   *
   * Strictly the ledger, and it must stay that way: `effectiveBoardReviewRounds`
   * clamps the budget UP to this number, so anything speculative here does not
   * merely disable a button, it invents a round. Folding in the walk's
   * `currentRound` did exactly that — the walk sits on the first round with no
   * `review@N`, which for a held loop is `lastRound + 1`, so the budget grew by
   * one and the pane could never reach the cap at all.
   *
   * The `−` button needs a slightly stricter floor than this (the decider also
   * counts a live step, which the detail payload cannot see); the pane derives
   * that for itself, where it gates a control rather than a budget.
   */
  const reviewRoundsRecorded = boardReviewRoundsStarted({
    completions: detail?.stepCompletions ?? [],
    liveStepId: null,
  });
  // The EFFECTIVE budget: the card's own override wins, clamped to that floor.
  const reviewMaxRounds = isBoardReviewStageExecution(reviewExecution)
    ? effectiveBoardReviewRounds({
        configured: reviewExecution.rounds,
        overrides: card.reviewOverrides,
        roundsStarted: reviewRoundsRecorded,
      })
    : undefined;
  const reviewPhaseRuntimeMode = isBoardReviewStageExecution(reviewExecution)
    ? effectiveBoardRuntimeMode(reviewExecution.phases.review.runtimeMode, "build")
    : undefined;
  const stageRestart = resolveBoardThreadStageRestart({
    autoExecute: resolveBoardStageExecution(boardSettings, card.stage).autoExecute,
    stageLabel: boardStageLabel(stages, card.stage),
    runInFlight: isBoardCardRunInFlight(cardShell),
    stalled: stepStalled,
  });
  /** What the failure banner renders (t3o-30, D3). Gated on `stalled` rather
      than on `stepError` alone: the error text sits on the run row until the
      next step replaces it, so a card that has since recovered would otherwise
      keep showing the stop it recovered from. A stall with no recorded reason —
      recovery exhausting its budget — still gets a banner, with the sentence
      that describes it. */
  const stepFailure = stepStalled
    ? { stageLabel: boardStageLabel(stages, card.stage), error: detail?.stepError ?? null }
    : null;

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

  // The approve gate (t3o-23, D1): two or more plans, nothing materialised
  // yet, a top-level card at or before the build stage, and a floor stage for
  // the children to land in. These are the cheap STRUCTURAL checks only — the
  // decider additionally gates on unmet dependencies, plan-graph cycles and a
  // live step, and a refusal from any of those surfaces through the shared
  // command feedback, so the button may offer an approval the decider still
  // declines with a reason.
  const buildStage = boardStageWithRole(stageState, "build");
  const floorStage = boardSubBoardFloorStage(stageState);
  const canApproveSplit =
    detail.plans.length >= 2 &&
    // Live children only, matching the decider's re-approval guard: a first
    // round whose children all archived may be re-split.
    detail.children.every((child) => child.archivedAt !== null) &&
    card.parentCardId === null &&
    card.archivedAt === null &&
    floorStage !== null &&
    buildStage !== null &&
    (!isBoardStageAtOrAfterBuild(stageState, card.stage) || card.stage === buildStage.stageId);

  return (
    <BoardCardDetailView
      adoptableThreads={adoptableThreads}
      stageRestart={stageRestart}
      stepFailure={stepFailure}
      onRestartStage={restartStage}
      onCreateBlankThread={createBlankThread}
      branch={branch}
      humanInLoop={humanInLoop}
      onSetHumanInLoop={(value) =>
        runCommand(updateCard({ environmentId, input: { cardId: card.id, humanInLoop: value } }))
      }
      stages={stages}
      canApproveSplit={canApproveSplit}
      approveSplitTargetLabel={floorStage?.label ?? null}
      onApproveSplit={() => runCommand(approvePlans({ environmentId, input: { cardId: card.id } }))}
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
      onDelete={() => {
        // Closed only once the delete LANDS. The modal is the card's last
        // remaining surface — its detail subscription resolves nothing after
        // the purge — so closing on dispatch would hide a refusal behind an
        // empty board. Staying open on failure leaves the inline feedback where
        // the user is already looking.
        void deleteCard({ environmentId, input: { cardId: card.id } }).then((result) => {
          if (result._tag === "Failure") {
            if (!isAtomCommandInterrupted(result)) setFeedback(describeBoardCommandFailure(result));
            return;
          }
          onClose();
        });
      }}
      onClose={onClose}
      queueInfo={queueInfo}
      queueForceStartPending={forceStartPending}
      onQueueForceStart={() => {
        setFeedback(null);
        setForceStartPending(true);
        void forceStartStep({ environmentId, input: { cardId: card.id } }).then((result) => {
          setForceStartPending(false);
          if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
            setFeedback(describeBoardCommandFailure(result));
          }
        });
      }}
      onQueueMoveToFront={
        queueMoveToFront === null
          ? undefined
          : () =>
              runCommand(
                reorderCard({
                  environmentId,
                  input: { cardId: card.id, orderKey: queueMoveToFront.orderKey },
                }),
              )
      }
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
      stepHeld={stepHeld}
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
      onSubmitForMerge={() => {
        setFeedback(null);
        void submitCardForMerge({ environmentId, input: { cardId: card.id } }).then((result) => {
          if (result._tag === "Failure") {
            if (!isAtomCommandInterrupted(result)) setFeedback(describeBoardCommandFailure(result));
            return;
          }
          setFeedback(describeBoardSubmitOutcome(result.value));
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
      attachmentLimits={attachmentLimits}
      onAttachFile={async (upload) => {
        const result = await attachCardFile({
          environmentId,
          input: { cardId: card.id, ...upload },
        });
        return result._tag === "Success" ? null : describeBoardCommandFailure(result);
      }}
      onDetachFile={(attachmentId) =>
        void detachCardFile({ environmentId, input: { cardId: card.id, attachmentId } })
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
      boardSettings={boardSettings}
      onSetModelOverrides={(modelOverrides) =>
        runCommand(updateCard({ environmentId, input: { cardId: card.id, modelOverrides } }))
      }
      resolveModelDisplayName={resolveModelDisplayName}
      // Queued counts as running for this note's purpose: a queued step has
      // already been selected onto the run row, so its model and authority are
      // frozen (t3o-21, D4) and an edit now lands on the run AFTER it — exactly
      // what the note exists to say. The review pane's step-active flag reads
      // the pair the same way.
      stepRunning={cardShell?.stepRunning === true || cardShell?.queued === true}
      reviewPhaseRuntimeMode={reviewPhaseRuntimeMode}
      reviewRoundsStarted={reviewRoundsRecorded}
      reviewStepActive={cardShell?.stepRunning === true || cardShell?.queued === true}
      onSetReviewRounds={(rounds) => patchReviewOverrides({ rounds })}
      // The way out of a round that recorded a payload nothing can read
      // (T3O-14). The server refuses it on a readable record, so a stale pane
      // cannot discard a round that actually landed.
      onReopenReviewRound={(round) =>
        runCommand(
          reopenStep({
            environmentId,
            input: { cardId: card.id, stepId: reviewStepId("review", round) },
          }),
        )
      }
      onResumeReview={(rounds) =>
        // "Run round N+1" is a resume, so it says both halves outright: at
        // least enough budget to reach that round (never LESS than the card
        // already has), and no pending stop to terminate on again.
        patchReviewOverrides({
          rounds: Math.max(rounds, card.reviewOverrides?.rounds ?? rounds),
          stopAfterRound: null,
        })
      }
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
      parentCard={parentCard}
      onOpenParentSubBoard={
        onOpenSubBoard === undefined || parentCard === null
          ? undefined
          : () => onOpenSubBoard(parentCard.cardId, card.id)
      }
      onOpenChildInSubBoard={
        onOpenSubBoard === undefined ? undefined : (childId) => onOpenSubBoard(card.id, childId)
      }
      onOpenOwnSubBoard={onOpenSubBoard === undefined ? undefined : () => onOpenSubBoard(card.id)}
      childShells={childShells}
    />
  );
}
