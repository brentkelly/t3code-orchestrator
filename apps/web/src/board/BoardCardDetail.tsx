/**
 * Mounting this component IS the card's detail subscription: the heavy detail
 * streams here, never on the shell every column card renders from.
 */
import { sanitizeBranchFragment } from "@t3tools/shared/git";
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
  assignBoardKeyPrefix,
  boardCardAttention,
  boardCardProjectLock,
  boardStallIsWaiting,
  boardStageWithRole,
  boardCardWorktreeIsCancelledWork,
  boardCardWorktreeKept,
  boardCardWorktreeKeptReason,
  isBoardMergeStageExecution,
  isBoardCardBaseRetargeted,
  resolveBoardCardEffectiveBase,
  boardSubBoardFloorStage,
  boardShellMergesIntoIntegrationBranch,
  boardSplitRecommendationFallback,
  boardStagesInOrder,
  isBoardStageAtOrAfterBuild,
  deriveBoardCardThreadState,
  boardBuildHumanInLoopDefault,
  resolveBoardStageExecution,
  type BoardCardShell,
  type BoardCardThreadShell,
  type BoardStageId,
  type BoardState,
  type EnvironmentId,
  boardReviewRoundsStarted,
  effectiveBoardReviewRounds,
  EMPTY_BOARD_CARD_REVIEW_OVERRIDES,
  type BoardCardReviewOverrides,
  type BoardReviewCarryRuling,
  type BoardCardStageModelOverride,
  boardShellAncestorIds,
  boardShellAutoMergeArmedByCard,
  boardShellDescendantIds,
} from "@t3tools/contracts";
import {
  boardBuildQueue,
  boardCardBlockedPriority,
  boardColumnAppendOrderKey,
  boardRunningStepCount,
  boardThreadStateSourceWithSubagents,
  planBoardQueueMoveToFront,
} from "@t3tools/client-runtime/state/shell";
import {
  isAtomCommandInterrupted,
  type AtomCommandResult,
} from "@t3tools/client-runtime/state/runtime";
import { useAtomValue } from "@effect/atom-react";
import * as Option from "effect/Option";
import { useEffect, useState } from "react";

import { Dialog } from "../components/ui/dialog";
import { randomUUID } from "../lib/utils";
import { getCustomModelOptionsByInstance, resolveAppModelSelectionState } from "../modelSelection";
import { getTriggerDisplayModelName } from "../components/chat/providerIconUtils";
import { boardEnvironment } from "../state/board";
import { cardThreadIdsMissingFromShell, useBoardCardThreadRows } from "./boardCardThreadRows";
import { boardThreadWorker, threadWorkerRanOn } from "./workers/threadWorker";
import { boardAttachmentLimits } from "./boardAttachmentUpload";
import { boardConflictFix } from "./boardConflictFix";
import { boardScheduleKind } from "./boardSchedule";
import { boardQueueInfo } from "./boardQueueInfo";
import { BoardCardCapacityPanelHost } from "./BoardCardCapacityPanel";
import { boardCardBlocksHint, boardCardPriorityStartedNote } from "./boardCardPriority";
import { boardCardPlanReviewView, boardPlanStageExecution } from "./boardCardPlanReview";
import { projectIconColorOf } from "./projectAccent";
import { useEnvironment } from "../state/environments";
import { deriveProviderInstanceEntries } from "../providerInstances";
import { usePaginatedBranches } from "../state/queries";
import { environmentShell } from "../state/shell";
import { environmentThreadShells, threadEnvironment } from "../state/threads";
import {
  boardAdoptableThreads,
  useBoardAdoptKnownCardThreadIds,
  useBoardAdoptThreadSearch,
} from "./boardAdoptThreadSearch";
import { boardQueueReason, boardThreadMoveDividers } from "./workers/cardWorker";
import { useAtomCommand } from "../state/use-atom-command";
import {
  boardStageRestartBlockedReason,
  isBoardCardRunInFlight,
  resolveBoardThreadStageRestart,
  runBlankThreadCreation,
  type BlankThreadDispatch,
} from "./boardCardThreadMenu";
import type { BoardActivityAgentLookup } from "./BoardCardActivityRail";
import { boardStageLabel } from "./boardStages";
import { boardToast } from "./boardToast";
import { indexBoardLabels } from "./labelColour";
import {
  BoardCardDetailPopup,
  BoardCardDetailView,
  boardCardHasThreadPane,
  type BoardDetailDependency,
  type BoardDetailThreadLink,
} from "./BoardCardDetailView";
import { BoardPlanningExitConfirmDialog } from "./BoardPlanningExitConfirmDialog";
import { BoardArchiveGroupDialog } from "./BoardGroupDialogs";
import { BoardCardAutomation } from "./BoardCardAutomation";
import { boardCardPlanningFinishedFromDetail } from "./boardCardAutomation";
import {
  boardGroupNote,
  boardShellGroup,
  boardShellIntegrationAncestor,
  isBoardGroupShell,
} from "./boardGroups";
import { boardMoveLeavesPlanningUnwritten } from "./boardStageActions";
import { boardCardPipelineStages } from "./boardProjectPipelines";
import type { BoardCardNav } from "./BoardCardNavRails";
import { setBoardProjectSetting } from "../components/settings/BoardSettingsPanel.logic";
import { boardCardProjectOptions } from "./BoardCardProjectSelect";
import type { BoardPickerOption } from "./BoardSearchAddPicker";
import {
  describeBoardCheckWorktreeOutcome,
  describeBoardCommandFailure,
  describeBoardSkipCiOutcome,
  describeBoardMergeOutcome,
  // T3o: the forced re-check's answer.
  describeBoardRefreshOutcome,
  describeBoardRemoveWorktreeOutcome,
  describeBoardReviewRoundOutcome,
  describeBoardSubmitOutcome,
} from "./boardCommandFeedback";
import { useOpenLink } from "../browser/useOpenLink";
import { refreshBoardArchivedCards } from "./BoardArchivedCardsSheet";
import {
  useBoardServerProviders,
  useBoardSettings,
  useUpdateBoardSettings,
} from "./useBoardEnvironmentId";

/** The modal frame, empty, while `board.subscribeCard` opens — same sheet, so
    nothing jumps when the detail lands. */
function LoadingModal({
  nav,
  onClose,
  wide,
}: {
  readonly nav: BoardCardNav | null;
  readonly onClose: () => void;
  readonly wide: boolean;
}) {
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      {/* The empty frame takes the rails too, so stepping never blinks the
          chevrons out while the next card's subscription opens. */}
      <BoardCardDetailPopup cardId={null} nav={nav} wide={wide}>
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
  nav = null,
  onClose,
  onOpenSubBoard,
}: {
  readonly environmentId: EnvironmentId;
  readonly cardId: BoardCardId;
  /** Step to the card before/after this one on the board, or
      null when the board has no visible neighbours to step to. */
  readonly nav?: BoardCardNav | null | undefined;
  readonly onClose: () => void;
  /** Navigate into a parent's sub-board, optionally with a card's
      sheet open there — wired to the child sheet's "part of" chip and the
      parent plan pane's child chips. */
  readonly onOpenSubBoard?: ((parentCardId: string, cardId?: string) => void) | undefined;
}) {
  const detail = useAtomValue(boardEnvironment.cardDetailValueAtom({ environmentId, cardId }));
  const catalogue = useAtomValue(boardEnvironment.labelCatalogueAtom(environmentId));
  const allStages = useAtomValue(boardEnvironment.stageListAtom(environmentId));
  // The card's own project's pipeline.
  const projectStageConfigs = useAtomValue(boardEnvironment.projectStageConfigsAtom(environmentId));
  const pipelineCardProjectId = detail?.card.projectId ?? null;
  const pipelineCardStage = detail?.card.stage ?? null;
  const stages =
    pipelineCardProjectId === null || pipelineCardStage === null
      ? allStages
      : boardCardPipelineStages(
          { stages: allStages, projectStageConfigs },
          { stage: pipelineCardStage, projectId: pipelineCardProjectId },
        );
  const projectExecutionConfig =
    pipelineCardProjectId === null ? null : (projectStageConfigs[pipelineCardProjectId] ?? null);
  // The board's workers, for the queue's reason.
  const workersState = useAtomValue(boardEnvironment.workersAtom(environmentId));
  const shellState = useAtomValue(environmentShell.stateValueAtom(environmentId));

  const updateCard = useAtomCommand(boardEnvironment.updateCard);
  const moveCard = useAtomCommand(boardEnvironment.moveCard);
  const reorderCard = useAtomCommand(boardEnvironment.reorderCard);
  const forceStartStep = useAtomCommand(boardEnvironment.forceStartStep);
  const requeueStep = useAtomCommand(boardEnvironment.requeueStep);
  const reopenStep = useAtomCommand(boardEnvironment.reopenStep);
  const archiveCard = useAtomCommand(boardEnvironment.archiveCard);
  const unarchiveCard = useAtomCommand(boardEnvironment.unarchiveCard);
  const deleteCard = useAtomCommand(boardEnvironment.deleteCard);
  const approvePlans = useAtomCommand(boardEnvironment.approvePlans);
  const linkThread = useAtomCommand(boardEnvironment.linkThread);
  const unlinkThread = useAtomCommand(boardEnvironment.unlinkThread);
  // Moving the card to another project. Its own command rather than a
  // field on `board.card.update` — it reissues the key, clears the base pin and
  // restarts the stage, none of which is a partial edit.
  const setCardProject = useAtomCommand(boardEnvironment.setCardProject);
  // Brief attachments: an attach failure is shown on the staged row
  // itself, so it opts out of the shared toast.
  const attachCardFile = useAtomCommand(boardEnvironment.attachCardFile, { reportFailure: false });
  const detachCardFile = useAtomCommand(boardEnvironment.detachCardFile);
  const environment = useEnvironment(environmentId);
  const attachmentLimits = boardAttachmentLimits(
    environment?.serverConfig?.environment.capabilities ?? null,
  );
  // Restart and blank-thread creation report their own failures (log and
  // stop — the menu is its own recovery), so they opt out of the shared toast.
  const startStageThread = useAtomCommand(boardEnvironment.startStageThread, {
    reportFailure: false,
  });
  const createThread = useAtomCommand(threadEnvironment.create, { reportFailure: false });
  const deleteThread = useAtomCommand(threadEnvironment.delete, { reportFailure: false });
  // Both PR actions report their own outcomes below — a merge the forge
  // refused is a normal answer with the forge's own wording, not a command
  // failure the generic toast could describe usefully.
  // No thread beside the card to open a preview in, so this is the system browser.
  const openLink = useOpenLink(null);
  const refreshCardPullRequest = useAtomCommand(boardEnvironment.refreshCardPullRequest, {
    reportFailure: false,
  });
  const mergeCardPullRequest = useAtomCommand(boardEnvironment.mergeCardPullRequest, {
    reportFailure: false,
  });
  // T3o: "Link one". A refusal renders inline under the input.
  const linkCardPullRequest = useAtomCommand(boardEnvironment.linkCardPullRequest, {
    reportFailure: false,
  });
  // Same reason as the two above: every refusal is a normal answer with its own
  // wording ("this card has no branch to push"), not a command failure.
  const submitCardForMerge = useAtomCommand(boardEnvironment.submitCardForMerge, {
    reportFailure: false,
  });
  // "Another review round" / "Request review". Same reason again:
  // every refusal is a normal answer with its own wording.
  const requestReviewRound = useAtomCommand(boardEnvironment.requestReviewRound, {
    reportFailure: false,
  });
  // "Skip CI". A refusal is an answer, toasted below.
  const skipCi = useAtomCommand(boardEnvironment.skipCi, { reportFailure: false });
  const retryCi = useAtomCommand(boardEnvironment.retryCi, { reportFailure: false });
  const sendBackCi = useAtomCommand(boardEnvironment.sendBackCi, { reportFailure: false });
  const stopCi = useAtomCommand(boardEnvironment.stopCi, { reportFailure: false });
  const [skippingCi, setSkippingCi] = useState(false);
  const createCard = useAtomCommand(boardEnvironment.createCard);
  // "Remove worktree". Same reason again: a refusal is an answer.
  const removeCardWorktree = useAtomCommand(boardEnvironment.removeCardWorktree, {
    reportFailure: false,
  });
  const checkCardWorktree = useAtomCommand(boardEnvironment.checkCardWorktree, {
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
  // T3o: set across the "Check again" round trip, so the button spins
  // and a second click cannot re-enter a lookup already in flight.
  const [checkingForPullRequest, setCheckingForPullRequest] = useState(false);
  // The kept-worktree banner's two round trips.
  const [checkingWorktree, setCheckingWorktree] = useState(false);
  const [removingWorktree, setRemovingWorktree] = useState(false);

  const snapshot = Option.getOrNull(shellState.snapshot);
  // The board rides its own subscription, cards' thread state derived.
  const board = useAtomValue(boardEnvironment.boardAtom(environmentId));
  // Refresh trigger: the card detail opening. One of the moments the answer
  // plausibly changed AND is about to be read — the Merge button's condition is
  // the card's PR state, so it should be current at the instant it becomes
  // visible rather than as of whenever the card last did something. Keyed on
  // the card id so it fires once per open, not on every re-render; the
  // server-side lookup is cached for two minutes, so reopening a card in quick
  // succession costs no forge calls at all.
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- refreshes the card's pull request state from the forge once per card open
  useEffect(() => {
    void refreshCardPullRequest({ environmentId, input: { cardId } });
    // The command atom is stable, and is left out on purpose: re-running on its
    // identity would defeat the once-per-open key.
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- the command atom is stable; this runs once per card open.
  }, [environmentId, cardId]);
  const labelsById = indexBoardLabels(catalogue);
  const stageState: BoardState = { cards: [], stages, nextCardNumberByProject: {} };
  const boardSettings = useBoardSettings((settings) => settings.board);
  // Persisting a newly derived key prefix for the target project, the
  // same write the create dialog makes on a project's first card.
  const updateSettings = useUpdateBoardSettings();
  // Full settings + providers resolve the default model for a blank thread — the
  // same resolution a Threads-view "new thread" uses, so a card-started blank
  // thread lands on the app's default model, not a board-specific one.
  const allSettings = useBoardSettings();
  const serverProviders = useBoardServerProviders();

  /** Report a rejected command inline (the decider names cycles, missing
      dependencies, the label cap); clear it once the next command succeeds. */
  const runCommand = (promise: Promise<BoardCommandResult>) => {
    void promise.then((result) => {
      if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
        setFeedback(describeBoardCommandFailure(result));
      } else if (result._tag !== "Failure") {
        setFeedback(null);
      }
    });
  };

  const card = detail?.card ?? null;
  /** Whether a conflict fix is live, so merging now is meaningless. Read off the
      server's `stepConflictFix`, not inferred from `stepRunning` at the merge
      stage: a human can restart that stage's thread for something else. */
  const cardShell = (board?.cards ?? []).find((candidate) => candidate.cardId === cardId);
  const conflictFix =
    cardShell === undefined
      ? null
      : boardConflictFix({
          live: cardShell.stepConflictFix,
          checks: cardShell.stepChecksFix,
          queued: cardShell.queued,
          // Only the modal names the base branch: the shell carries none, and it
          // should not grow one for a tooltip.
          baseRef: detail?.card.pullRequest?.baseRef ?? null,
        });
  /** Whether the step settled and left the card standing — the same `held` the
      card face ranks via `boardCardAttention`, so chip and forward button never
      disagree. No `now` is passed: the chip's settle grace must not delay this. */
  const stepHeld =
    cardShell !== undefined && boardCardAttention({ card: cardShell, stages })?.reason === "held";
  /** Whether the card's live step has given up — the failure
      banner's gate and the reason a non-auto-executing stage still offers a
      restart. */
  const stepStalled = cardShell?.stalled === true;
  /** Whether a human stopped the card's live step — the paused
      banner's gate. Read off the same shell field the card face's neutral chip
      reads, so the board and the open modal cannot disagree about it. */
  const stepPausedByHuman = cardShell?.stepAwaiting === "paused";

  // Resolved server-side: the shell snapshot drops archived
  // cards, so resolving here would render every archived dependency as an
  // unknown id. `detail.dependencies` is already in `dependsOn` order and
  // omits only ids with no card left at all.
  const resolvedDependencyById = new Map(
    (detail?.dependencies ?? []).map((entry) => [entry.cardId, entry]),
  );
  const dependencies: ReadonlyArray<BoardDetailDependency> =
    detail === null || card === null
      ? []
      : card.dependsOn.map((dependencyId) => {
          const resolved = resolvedDependencyById.get(dependencyId);
          return {
            cardId: dependencyId,
            key: resolved?.key ?? dependencyId,
            title: resolved?.title ?? null,
            stage: resolved?.stage ?? BOARD_SEED_STAGE_IDS.backlog,
            known: resolved !== undefined,
            archived: resolved !== undefined && resolved.archivedAt !== null,
          };
        });

  // A dependency may name a card in another project: a card that changes project
  // inherits cross-project edges, so the picker must be able to make them too.

  const shells = board?.cards ?? [];
  const projectById = new Map(
    (snapshot?.projects ?? []).map((project) => [String(project.id), project]),
  );
  const existingDependencyIds = new Set<string>(card === null ? [] : [card.id, ...card.dependsOn]);
  // Dependencies cross groups; the card's own ancestors and
  // descendants are refused, so they are not offered.
  const relatedCardIds = new Set<string>(
    card === null
      ? []
      : [
          ...boardShellAncestorIds(shells, card.parentCardId),
          ...boardShellDescendantIds(shells, card.id),
        ],
  );
  const dependencyOptions: ReadonlyArray<BoardPickerOption> =
    card === null
      ? []
      : shells
          .filter(
            (candidate) =>
              !existingDependencyIds.has(candidate.cardId) && !relatedCardIds.has(candidate.cardId),
          )
          .map((candidate) => ({
            id: candidate.cardId,
            key: candidate.key,
            title: candidate.title,
            ...(candidate.projectId === card.projectId
              ? {}
              : {
                  project: {
                    id: candidate.projectId,
                    title: projectById.get(String(candidate.projectId))?.title ?? "Another project",
                    accent: projectIconColorOf(projectById.get(String(candidate.projectId))),
                  },
                }),
          }));

  // The child's parent, resolved for the sheet's "part of" chip. An
  // archived parent is off the live shell and its sub-board would redirect
  // straight back out — no chip rather than a dead door.
  const parentShell =
    card === null || card.parentCardId === null
      ? undefined
      : shells.find((shell) => shell.cardId === card.parentCardId);
  const parentCard =
    parentShell === undefined ? null : { cardId: String(parentShell.cardId), key: parentShell.key };

  // The snapshot is unscoped — children are filtered out of the root board's
  // columns, not the shell list — so this needs no second subscription. Archived
  // children leave the snapshot; the Plans panel reads `detail.children` for those.
  const childShells = card === null ? [] : shells.filter((shell) => shell.parentCardId === card.id);

  // T3o: the worker each thread lives on, for where it opens.
  const workers = useAtomValue(boardEnvironment.workersAtom(environmentId));
  // "today" in a move divider is measured from when the card was opened.
  const [openedAt] = useState(() => Date.now());
  // The group archive confirmation: a group always warns.
  const [archiveGroupOpen, setArchiveGroupOpen] = useState(false);
  // Older settled threads are not in the shell; read them so they are named, not "deleted".
  const missingThreadIds = cardThreadIdsMissingFromShell(
    card?.threadLinks ?? [],
    snapshot?.threads ?? [],
  );
  const offShellThreads = useBoardCardThreadRows(environmentId, missingThreadIds);
  // A subagent awaiting approval turns its parent's row violet.
  const subagentRequests = useAtomValue(
    environmentThreadShells.pendingSubagentRequestsAtom(environmentId),
  );
  const shellThreads = snapshot?.threads ?? [];
  // "Moved from {worker}" above the first thread after each move.
  const movedFrom = boardThreadMoveDividers({
    links: card?.threadLinks ?? [],
    moves: (detail?.activity ?? []).flatMap((entry) =>
      entry.kind === "card-worker-moved" && entry.payload.movePhase === "done"
        ? [{ at: entry.createdAt, fromWorkerId: entry.payload.fromWorkerId ?? null }]
        : [],
    ),
    state: workers,
    nowMs: openedAt,
  });
  const threadLinks: ReadonlyArray<BoardDetailThreadLink> = (card?.threadLinks ?? []).map(
    (link) => {
      const thread =
        shellThreads.find((candidate) => candidate.id === link.threadId) ??
        offShellThreads.threads.get(link.threadId);
      const source =
        thread === undefined
          ? undefined
          : boardThreadStateSourceWithSubagents(thread, subagentRequests);
      const { threadState, awaitingInput } = deriveBoardCardThreadState(source);
      const worker = boardThreadWorker({
        workerId: link.workerId,
        workers,
        boardEnvironmentId: environmentId,
      });
      return {
        threadId: link.threadId,
        role: link.role,
        tombstoned: link.tombstonedAt !== null,
        // A thread on another worker is not in this server's snapshot.
        title:
          thread?.title ??
          (link.workerId !== undefined
            ? `Thread on ${worker.label}`
            : offShellThreads.loading.has(link.threadId)
              ? "Loading thread…"
              : null),
        threadState,
        awaitingInput,
        subagentAwaitingApproval: source?.subagentAwaitingApproval === true,
        worker,
        ranOn: threadWorkerRanOn(worker, workers),
        movedFrom: movedFrom.get(link.threadId) ?? null,
      };
    },
  );

  // Agent display names and accents for the Activity rail. Resolved
  // at render time from the provider instance list the app already holds, so a
  // renamed or recoloured instance relabels its own history rather than freezing
  // a stale label on every row it ever wrote.
  const providerEntries = deriveProviderInstanceEntries(serverProviders ?? []);
  // Resolve an override's model slug to its display name for the header pill,
  // the same lookup the popover's placeholder uses — so the pill,
  // its tooltip and the popover all name a model the same way.
  const resolveModelDisplayName = (override: BoardCardStageModelOverride): string => {
    const option = getCustomModelOptionsByInstance(
      allSettings,
      serverProviders ?? [],
      override.instanceId,
      override.model,
    )
      .get(override.instanceId)
      ?.find((candidate) => candidate.slug === override.model);
    const driverKind = providerEntries.find(
      (entry) => entry.instanceId === override.instanceId,
    )?.driverKind;
    return option ? getTriggerDisplayModelName(option, driverKind) : override.model;
  };
  const providerEntryById = new Map(providerEntries.map((entry) => [entry.instanceId, entry]));
  const agents: BoardActivityAgentLookup = {
    displayName: (instanceId) =>
      providerEntryById.get(instanceId)?.displayName ?? String(instanceId),
    accentColor: (instanceId) => providerEntryById.get(instanceId)?.accentColor,
  };

  // Each live-linked thread's cached todo list, off the same shell
  // array the column cards read — the modal opens no extra subscription.
  const threadTodos: ReadonlyMap<ThreadId, BoardCardThreadShell> = new Map(
    (board?.cardThreads ?? [])
      .filter((entry) => entry.cardId === cardId)
      .map((entry) => [entry.threadId, entry]),
  );

  // The shell holds only the newest settled threads; the rest come from search.
  const [adoptQuery, setAdoptQuery] = useState("");
  const adoptSearchRead = useBoardAdoptThreadSearch(
    environmentId,
    card?.projectId ?? null,
    adoptQuery,
  );
  const [adoptOpen, setAdoptOpen] = useState(false);
  const knownCardThreads = useBoardAdoptKnownCardThreadIds(environmentId, adoptOpen);
  const threadIdsOnCards = new Set((board?.cardThreads ?? []).map((entry) => entry.threadId));
  const adoptableThreads: ReadonlyArray<BoardPickerOption> =
    card === null
      ? []
      : boardAdoptableThreads({
          projectId: card.projectId,
          cardThreadIds: card.threadLinks.map((link) => link.threadId),
          linkedElsewhere: (threadId) =>
            threadIdsOnCards.has(threadId) || (knownCardThreads?.has(threadId) ?? false),
          threads: [...(snapshot?.threads ?? []), ...adoptSearchRead.rows],
        });
  const adoptSearch = {
    onQueryChange: setAdoptQuery,
    onOpenChange: setAdoptOpen,
    pending: adoptSearchRead.pending,
  };

  // Hooks from here down must stay above the `LoadingModal` early return:
  // `detail` is null on every modal's first render, and no lint catches it.

  // The queue is global, so this reads every project's shells. The map is empty
  // unless something is actually queued.
  const allShellCards = board?.cards ?? EMPTY_SHELL_CARDS;
  // Same fallback the board uses: before the first snapshot the stage list is
  // empty, and ranking every queued card equally would print a position that is
  // wrong rather than absent.
  const queueStages = stages.length > 0 ? stages : BOARD_SEED_STAGES;
  const queueInfo =
    cardShell?.queued !== true
      ? null
      : boardQueueInfo({
          // oxlint-disable-next-line react/purity -- the queue order samples the clock when the shells change; the compiler recomputes it only then.
          slot: boardBuildQueue(allShellCards, queueStages, Date.now()).get(cardId),
          running: boardRunningStepCount(allShellCards),
          reason: boardQueueReason({
            card: cardShell,
            state: workersState,
            cardKeys: new Map(
              allShellCards.map((card) => [String(card.cardId), card.key] as const),
            ),
            // Named as the board's own queue pill names it.
            projectName:
              snapshot?.projects.find((project) => project.id === cardShell.projectId)?.title ??
              "this project",
          }),
        });
  // Null whenever reordering could not actually improve the card's position —
  // the rail hides the button rather than offering one that does nothing.
  const queueMoveToFront =
    queueInfo === null
      ? null
      : planBoardQueueMoveToFront({
          cards: allShellCards,
          stages: queueStages,
          cardId,
          // oxlint-disable-next-line react/purity -- the queue order samples the clock when the shells change; the compiler recomputes it only then.
          nowMs: Date.now(),
        });
  // Strictly "the command is in flight": the governor may decline to start the
  // card, so waiting for it to leave the queue could stick forever. The request
  // is durable on the step row, so asking again is harmless.
  const [forceStartPending, setForceStartPending] = useState(false);
  // The Resume button's in-flight guard, so a second press cannot queue
  // the same step twice.
  const [resumePending, setResumePending] = useState(false);
  // A forward move out of Planning with no plan written, held until the
  // human confirms it.
  const [unplannedMove, setUnplannedMove] = useState<BoardStageId | null>(null);

  // The effective base is one shared function, so the row, picker, divergence
  // line and reactor cannot disagree. A pinned card skips the ref query; when it
  // runs it shares the picker's atom.
  const baseBranchProject =
    snapshot?.projects.find((entry) => entry.id === card?.projectId) ?? null;
  const baseBranchWorkspaceRoot = baseBranchProject?.workspaceRoot ?? null;
  const projectRefs = usePaginatedBranches({
    environmentId,
    cwd: card !== null && card.baseBranch === null ? baseBranchWorkspaceRoot : null,
  });
  const projectDefaultBranch = projectRefs.refs.find((ref) => ref.isDefault)?.name ?? null;

  if (detail === null || card === null) {
    // The shell already knows the stage, so the empty frame opens at the width
    // the detail will need — no jump from sheet to working surface.
    return (
      <LoadingModal
        nav={nav}
        onClose={onClose}
        wide={cardShell !== undefined && boardCardHasThreadPane(stages, cardShell.stage)}
      />
    );
  }

  const projectName = snapshot?.projects.find((project) => project.id === card.projectId)?.title;

  // ── Project ───────────────────────────────────────────────────
  // The lock comes from the SAME predicate the decider refuses on, so the row
  // and the rejection cannot disagree. `detail.children` carries archived
  // children too, as the server's count does.
  const projectLock = boardCardProjectLock({
    board: stageState,
    card,
    childCount: detail.children.length,
    integrationParentId:
      cardShell === undefined
        ? card.parentCardId
        : (boardShellIntegrationAncestor(allShellCards, cardShell)?.cardId ?? null),
  });
  const projectOptions =
    projectLock === null
      ? boardCardProjectOptions({
          projects: (snapshot?.projects ?? []).map((project) => ({
            id: project.id,
            title: project.title,
            workspaceRoot: project.workspaceRoot,
            projectIcon: project.projectIcon,
          })),
          settings: boardSettings,
          currentProjectId: card.projectId,
          cardKeys: board?.cards ?? [],
        })
      : [];
  // An archived card gets the plain text row: the decider refuses the command and
  // a padlock for a pin it does not have would be a lie.
  const canSetProject = card.archivedAt === null;
  const projectNames = new Map(
    (snapshot?.projects ?? []).map((entry) => [String(entry.id), entry.title]),
  );
  // The card owns no branch — its active thread does. Shown when there is one,
  // absent otherwise (never a guessed default).
  const activeThreadId = activeBoardCardThreadId(card.threadLinks);
  const branch =
    activeThreadId === null
      ? null
      : (snapshot?.threads.find((thread) => thread.id === activeThreadId)?.branch ?? null);

  // A child reads its inherited base off its own `worktree.baseRefName`: the
  // parent's integration branch is not on the client.
  const baseBranchInfo =
    card.parentCardId !== null
      ? {
          effective: card.worktree?.baseRefName ?? null,
          retargeted: false,
          inheritedFrom: parentCard?.key ?? "its parent",
          workspaceRoot: baseBranchWorkspaceRoot,
        }
      : {
          effective: resolveBoardCardEffectiveBase({
            card,
            cards: [],
            defaultBranch: projectDefaultBranch,
          }),
          retargeted: isBoardCardBaseRetargeted({
            card,
            cards: [],
            defaultBranch: projectDefaultBranch,
          }),
          inheritedFrom: null,
          workspaceRoot: baseBranchWorkspaceRoot,
        };

  // Shown only on the build stage. The same rule the reactor runs the step under,
  // so the hint never contradicts the run.
  const buildStageId = boardStageWithRole(stageState, "build")?.stageId ?? null;
  const humanInLoop =
    buildStageId !== null && card.stage === buildStageId
      ? (() => {
          const exec = resolveBoardStageExecution(
            boardSettings,
            buildStageId,
            projectExecutionConfig,
          );
          const fallback = boardBuildHumanInLoopDefault(exec, detail.hasPlan);
          return {
            value: card.humanInLoop ?? fallback,
            explicit: card.humanInLoop !== null,
            basis: detail.hasPlan ? "plan" : "no-plan",
          } as const;
        })()
      : null;

  /** Patch the card's review overrides, preserving the fields not being set.
      One write shape for all three controls — there is no second
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
  const reviewExecution = resolveBoardStageExecution(
    boardSettings,
    BOARD_SEED_STAGE_IDS.review,
    projectExecutionConfig,
  );
  // The board-wide auto-merge default. Resolved off the
  // MERGE-ROLE stage, not off a stage literally named "Ready for merge": the
  // role is what the server reads, and keying on the name would silently
  // disagree with it on a renamed pipeline.
  const mergeStageId = boardStageWithRole(stageState, "merge")?.stageId ?? null;
  const mergeExecution =
    mergeStageId === null
      ? null
      : resolveBoardStageExecution(boardSettings, mergeStageId, projectExecutionConfig);
  const boardWideAutoMerge =
    mergeExecution !== null && isBoardMergeStageExecution(mergeExecution)
      ? mergeExecution.autoMerge
      : false;
  const boardMergeStrategy =
    mergeExecution !== null && isBoardMergeStageExecution(mergeExecution)
      ? mergeExecution.strategy
      : "squash";
  /**
   * Strictly the ledger: `effectiveBoardReviewRounds` clamps the budget UP to
   * this, so anything speculative here invents a round. The `−` button's
   * stricter floor (counting a live step) is derived in the pane.
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
        completions: detail?.stepCompletions ?? [],
      })
    : undefined;
  const reviewPhaseRuntimeMode = isBoardReviewStageExecution(reviewExecution)
    ? effectiveBoardRuntimeMode(reviewExecution.phases.review.runtimeMode, "build")
    : undefined;
  const doneStageId = boardStageWithRole(stageState, "done")?.stageId ?? null;
  const unmetDependencyKeys = dependencies
    .filter(
      (dependency) =>
        !dependency.known ||
        (!dependency.archived && (doneStageId === null || dependency.stage !== doneStageId)),
    )
    .map((dependency) => dependency.key);
  const restartBlocked =
    mergeStageId !== card.stage &&
    isBoardStageAtOrAfterBuild(stageState, card.stage) &&
    unmetDependencyKeys.length > 0;
  const stageRestart = resolveBoardThreadStageRestart({
    autoExecute: resolveBoardStageExecution(boardSettings, card.stage, projectExecutionConfig)
      .autoExecute,
    stageLabel: boardStageLabel(stages, card.stage),
    runInFlight: isBoardCardRunInFlight(cardShell),
    stalled: stepStalled,
    blockedReason: restartBlocked ? boardStageRestartBlockedReason(unmetDependencyKeys) : null,
  });
  /** Gated on `stalled`, not `stepError`: the error text lingers on the run row
      after the card recovers. A stall with no recorded reason still gets a banner. */
  const stepFailure = stepStalled
    ? {
        stageLabel: boardStageLabel(stages, card.stage),
        error: detail?.stepError ?? null,
        // Amber and "waiting to resume" rather than red and "stopped" when the
        // board is going to restart it itself — read off the same shell
        // field the card face's chip reads, so the two cannot disagree.
        waiting: boardStallIsWaiting(cardShell?.stalledReason),
      }
    : null;
  /** What the paused banner renders. Mutually exclusive with
      `stepFailure` by construction: `paused` and `stalled` are different step
      statuses and a card has one live step. */
  const stepPaused = stepPausedByHuman ? { stageLabel: boardStageLabel(stages, card.stage) } : null;
  /** The kept-worktree banner: the card is finished — archived, or
      in Done with `reclaimWorktreeOnDone` on — and still holds its worktree. */
  const worktreeKept =
    card.worktree !== null &&
    boardCardWorktreeKept({
      worktreeReady: card.worktree.status === "ready",
      archived: card.archivedAt !== null,
      inDoneStage: doneStageId !== null && card.stage === doneStageId,
      reclaimWorktreeOnDone: boardSettings.lifecycle.reclaimWorktreeOnDone,
      cancelledWork: boardCardWorktreeIsCancelledWork(card),
    })
      ? {
          reason: boardCardWorktreeKeptReason(card.worktree.reclaimBlockedReason),
          path: card.worktree.path,
          branch: card.worktree.branch,
          cancelledWork: boardCardWorktreeIsCancelledWork(card),
        }
      : null;

  /** Derived from the shell's step flags, which every other status affordance
      on this card reads, so the popover's wording cannot disagree with them. */
  const scheduleKind = boardScheduleKind({
    atOrAfterBuild: isBoardStageAtOrAfterBuild(stageState, card.stage),
    stepStatus:
      cardShell?.stepAwaiting != null || stepStalled
        ? "paused"
        : cardShell?.stepRunning === true
          ? "running"
          : null,
  });

  /** Whether ANY step is live on the card — running, queued, or parked
      (stalled, awaiting input, paused). The decider's one-step-at-a-time
      invariant reads exactly this set, so the button that is disabled by it
       must read the same set and not just "running". */
  const stepLive =
    cardShell?.stepRunning === true ||
    cardShell?.queued === true ||
    cardShell?.stalled === true ||
    (cardShell?.stepAwaiting ?? null) !== null;

  /** "Another review round" / "Request review". One RPC behind
      both the rail button and the pane's "Run round N+1": the server writes
      the override, records why, and moves the card, in that order. */
  const onRequestReviewRound = (carry?: {
    readonly ruling: BoardReviewCarryRuling;
    readonly note: string | null;
  }) => {
    setFeedback(null);
    void requestReviewRound({
      environmentId,
      input: { cardId: card.id, ...(carry === undefined ? {} : { carry }) },
    }).then((result) => {
      if (result._tag === "Failure") {
        if (!isAtomCommandInterrupted(result)) setFeedback(describeBoardCommandFailure(result));
        return;
      }
      setFeedback(describeBoardReviewRoundOutcome(result.value));
    });
  };

  /** Retry CI, Stop CI and "Send back to review anyway". */
  const onCiAction = (action: "retry" | "stop" | "send-back") => {
    const run = action === "retry" ? retryCi : action === "stop" ? stopCi : sendBackCi;
    const failed = {
      retry: "CI could not be retried",
      stop: "CI could not be stopped",
      "send-back": "The card could not be sent back",
    }[action];
    const refused = {
      retry: "CI was not retried",
      stop: "CI was not stopped",
      "send-back": "The card was not sent back",
    }[action];
    void run({ environmentId, input: { cardId: card.id } }).then((result) => {
      if (result._tag === "Failure") {
        if (!isAtomCommandInterrupted(result)) {
          boardToast({
            title: failed,
            description: describeBoardCommandFailure(result),
            tone: "error",
          });
        }
        return;
      }
      const outcome = result.value.outcome;
      if (outcome === "retried" || outcome === "sent-back" || outcome === "stopped") return;
      // A second Stop (a double-click) finds CI already stopped, which is what was asked.
      if (action === "stop" && outcome === "not-running") return;
      boardToast({
        title: refused,
        description:
          outcome === "ci-off"
            ? "CI is switched off for this project."
            : outcome === "running"
              ? "CI is still running on this card."
              : outcome === "not-running"
                ? "CI has already stopped on this card."
                : outcome === "not-stopped"
                  ? "Only a stopped CI pass can be sent back."
                  : outcome === "not-in-ci"
                    ? "The card is no longer in CI."
                    : "Try again in a moment.",
        tone: "error",
      });
    });
  };

  const onSkipCi = () => {
    setSkippingCi(true);
    void skipCi({ environmentId, input: { cardId: card.id } }).then((result) => {
      setSkippingCi(false);
      if (result._tag === "Failure") {
        if (!isAtomCommandInterrupted(result)) {
          boardToast({
            title: "CI could not be skipped",
            description: describeBoardCommandFailure(result),
            tone: "error",
          });
        }
        return;
      }
      boardToast(
        describeBoardSkipCiOutcome(result.value, card.key, (stageId) =>
          boardStageLabel(stages, stageId as BoardStageId),
        ),
      );
    });
  };

  /** A follow-up card in the first stage, for a decision worth revisiting. */
  const onCreateFollowUp = (draft: { readonly title: string; readonly brief: string }) => {
    const firstStage = stageState.stages?.[0];
    if (firstStage === undefined) return;
    runCommand(
      createCard({
        environmentId,
        input: {
          cardId: BoardCardId.make(randomUUID()),
          projectId: card.projectId,
          title: draft.title,
          brief: draft.brief,
          stage: firstStage.stageId,
          orderKey: boardColumnAppendOrderKey(
            (board?.cards ?? []).filter((shell) => shell.stage === firstStage.stageId),
          ),
        },
      }),
    );
  };

  // Restart is a server command: the reactor runs the stage's configured
  // prompt through the same envelope the automatic trigger uses, so the two
  // entry points cannot drift. Failure logs and stops.
  const restartStage = () => {
    setFeedback(null);
    runCommand(startStageThread({ environmentId, input: { cardId: card.id } }));
  };

  // "New blank thread": a real server thread with no first turn, linked so
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

  // Cheap structural checks only; the decider also gates on dependencies,
  // plan-graph cycles and a live step, so the button may offer an approval
  // the decider still declines with a reason.
  const buildStage = boardStageWithRole(stageState, "build");
  const floorStage = boardSubBoardFloorStage(stageState);
  const canApproveSplit =
    detail.plans.length >= 2 &&
    // Live children only, matching the decider's re-approval guard: a first
    // round whose children all archived may be re-split.
    detail.children.every((child) => child.archivedAt !== null) &&
    card.archivedAt === null &&
    floorStage !== null &&
    buildStage !== null &&
    (!isBoardStageAtOrAfterBuild(stageState, card.stage) || card.stage === buildStage.stageId);

  // What the split gate shows. An older proposal has no
  // stored recommendation, so it falls back to the server's rule.
  const firstStage = boardStagesInOrder(stageState)[0] ?? null;
  const splitGate =
    canApproveSplit && floorStage !== null && firstStage !== null
      ? {
          recommendation:
            card.splitRecommendation ??
            boardSplitRecommendationFallback({
              plans: detail.plans,
              underIntegrationBranch: boardShellMergesIntoIntegrationBranch(
                board?.cards ?? [],
                card,
              ),
            }),
          ownBranch: `board/${sanitizeBranchFragment(card.key)}`,
          landsOn: baseBranchInfo.effective ?? "the default branch",
          readyLabel: floorStage.label,
          backlogLabel: firstStage.label,
        }
      : null;

  const moveStage = (toStage: BoardStageId) => {
    const targetColumn = (board?.cards ?? []).filter((shell) => shell.stage === toStage);
    // Every column but Done takes the card at the bottom. Done takes it at
    // the top, and the server places it there — this sends no key
    // at all rather than a second implementation of the same rule.
    const toDone = toStage === boardStageWithRole(stageState, "done")?.stageId;
    runCommand(
      moveCard({
        environmentId,
        input: {
          cardId: card.id,
          toStage,
          ...(toDone ? {} : { orderKey: boardColumnAppendOrderKey(targetColumn) }),
          ...(areBoardStagesAdjacent(stageState, card.stage, toStage, null)
            ? {}
            : { override: true }),
        },
      }),
    );
  };

  // The group popup: Open board, the group's note, its settings and
  // the archive warning, all from the shells the board already holds.
  const groupShells = board?.cards ?? EMPTY_SHELL_CARDS;
  const groupStats =
    cardShell === undefined || !isBoardGroupShell(groupShells, cardShell)
      ? null
      : { shells: groupShells, stages: stageState, attentionFor: () => null };
  const groupView =
    groupStats === null || cardShell === undefined
      ? null
      : {
          chip: `Group · ${childShells.length} ${childShells.length === 1 ? "card" : "cards"}`,
          note: boardGroupNote(groupStats, cardShell),
          onOpenBoard: onOpenSubBoard === undefined ? undefined : () => onOpenSubBoard(card.id),
          onArchive: () => setArchiveGroupOpen(true),
          ownBranch: boardShellGroup(groupShells, cardShell)?.target === "own",
        };
  // The Automation section. A done or archived card has nothing left
  // to automate, so it gets none.
  const automationGroup = groupView === null || cardShell === undefined ? null : cardShell;
  const automation =
    card.archivedAt !== null ||
    boardStageWithRole(stageState, "done")?.stageId === card.stage ? null : (
      <BoardCardAutomation
        boardWideAutoMerge={boardWideAutoMerge}
        card={card}
        environmentId={environmentId}
        group={automationGroup}
        inPlanning={boardStageWithRole(stageState, "plan")?.stageId === card.stage}
        planningFinished={boardCardPlanningFinishedFromDetail({
          stages: stageState,
          stage: card.stage,
          stepCompletions: detail?.stepCompletions ?? [],
          stepLive:
            cardShell?.stepRunning === true ||
            cardShell?.queued === true ||
            (cardShell?.stepAwaiting ?? null) !== null,
        })}
        shells={groupShells}
        stages={stageState}
      />
    );
  // Priority (T3O-95): a group has none, so it gets no row or chip.
  const priorityStartedNote = boardCardPriorityStartedNote({
    stageId: card.stage,
    running: cardShell?.stepRunning === true,
    stages,
  });
  const priorityBlocksHint = boardCardBlocksHint(
    card.priority,
    boardCardBlockedPriority(
      detail?.dependents ?? [],
      new Map(groupShells.map((shell) => [shell.cardId as string, shell])),
    ),
  );
  const autoMergeArmed =
    boardShellAutoMergeArmedByCard({ shells: groupShells, boardWide: boardWideAutoMerge }).get(
      String(card.id),
    ) === true;
  // A group's child can be parked in Deferred.
  const parentIsGroup =
    card.parentCardId !== null && groupShells.some((shell) => shell.cardId === card.parentCardId);

  const view = (
    <BoardCardDetailView
      group={groupView}
      stageLadderDeferred={parentIsGroup && groupView === null}
      stalledReason={cardShell?.stalledReason}
      workerShell={cardShell}
      nav={nav}
      adoptSearch={adoptSearch}
      adoptableThreads={adoptableThreads}
      stageRestart={stageRestart}
      stepFailure={stepFailure}
      stepPaused={stepPaused}
      resumeStepPending={resumePending}
      onResumeStep={() => {
        setFeedback(null);
        setResumePending(true);
        void requeueStep({ environmentId, input: { cardId: card.id } }).then((result) => {
          setResumePending(false);
          if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
            setFeedback(describeBoardCommandFailure(result));
          }
        });
      }}
      onRestartStage={restartStage}
      onCreateBlankThread={createBlankThread}
      branch={branch}
      baseBranch={baseBranchInfo}
      project={{
        lock: projectLock,
        options: projectOptions,
        accent: projectIconColorOf(
          (snapshot?.projects ?? []).find((entry) => entry.id === card.projectId),
        ),
        names: projectNames,
        stopsAgent: isBoardCardRunInFlight(cardShell),
        restartsStage: resolveBoardStageExecution(boardSettings, card.stage, projectExecutionConfig)
          .autoExecute,
      }}
      onSetProject={
        canSetProject
          ? (projectId) => {
              // The target project's key prefix is resolved — and PERSISTED —
              // here, exactly as the create dialog does it: a prefix derived
              // per caller drifts, so the first writer settles it.
              const target = (snapshot?.projects ?? []).find((entry) => entry.id === projectId);
              const { prefix, assigned } = assignBoardKeyPrefix({
                board: boardSettings,
                projectId,
                projectTitle: target?.title ?? "",
              });
              if (assigned) {
                updateSettings({
                  board: {
                    projects: setBoardProjectSetting(boardSettings.projects, projectId, {
                      keyPrefix: prefix,
                    }),
                  },
                });
              }
              runCommand(
                setCardProject({
                  environmentId,
                  input: { cardId: card.id, projectId, keyPrefix: prefix },
                }),
              );
            }
          : undefined
      }
      onSetBaseBranch={
        card.parentCardId === null
          ? (next) =>
              runCommand(
                updateCard({ environmentId, input: { cardId: card.id, baseBranch: next } }),
              )
          : undefined
      }
      humanInLoop={humanInLoop}
      onSetHumanInLoop={(value) =>
        runCommand(updateCard({ environmentId, input: { cardId: card.id, humanInLoop: value } }))
      }
      planReview={boardCardPlanReviewView({
        card,
        isGroup: card.group !== null,
        stages,
        planStageExecution: boardPlanStageExecution(boardSettings, stages, projectExecutionConfig),
        planReviewStarted: detail.planReviewStarted,
      })}
      onSetPlanReview={(planReview) =>
        runCommand(updateCard({ environmentId, input: { cardId: card.id, planReview } }))
      }
      stages={stages}
      canApproveSplit={canApproveSplit}
      splitGate={splitGate}
      onApproveSplit={(settings) =>
        runCommand(
          approvePlans({
            environmentId,
            input: {
              cardId: card.id,
              autoBuild: settings.autoBuild,
              mergeTarget: settings.mergeTarget,
            },
          }),
        )
      }
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
        // Close only once the delete lands: the detail subscription resolves
        // nothing after the purge, so closing on dispatch would hide a refusal.
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
      conflictFix={conflictFix}
      stepHeld={stepHeld}
      merging={merging}
      checkingForPullRequest={checkingForPullRequest}
      worktreeKept={worktreeKept}
      checkingWorktree={checkingWorktree}
      removingWorktree={removingWorktree}
      onCheckWorktree={() => {
        // The server refreshes the pull request first, then re-runs the
        // cleanup and answers what it did: a repeat refusal changes nothing on
        // the card, so it has to be said.
        setFeedback(null);
        setCheckingWorktree(true);
        void checkCardWorktree({ environmentId, input: { cardId: card.id } }).then((result) => {
          setCheckingWorktree(false);
          if (result._tag === "Failure") {
            if (!isAtomCommandInterrupted(result)) setFeedback(describeBoardCommandFailure(result));
            return;
          }
          setFeedback(describeBoardCheckWorktreeOutcome(result.value));
          // The archive list reads a snapshot taken when it opened.
          if (card.archivedAt !== null) refreshBoardArchivedCards(environmentId);
        });
      }}
      onRemoveWorktree={() => {
        setFeedback(null);
        setRemovingWorktree(true);
        void removeCardWorktree({ environmentId, input: { cardId: card.id } }).then((result) => {
          setRemovingWorktree(false);
          if (result._tag === "Failure") {
            if (!isAtomCommandInterrupted(result)) setFeedback(describeBoardCommandFailure(result));
            return;
          }
          setFeedback(describeBoardRemoveWorktreeOutcome(result.value));
          // The archive list reads a snapshot taken when it opened.
          if (card.archivedAt !== null) refreshBoardArchivedCards(environmentId);
        });
      }}
      onCheckForPullRequest={() => {
        // T3o: `force`, so the answer is not the cached one that
        // produced the empty state being questioned.
        setFeedback(null);
        setCheckingForPullRequest(true);
        const branch = card.worktree?.branch ?? null;
        void refreshCardPullRequest({
          environmentId,
          input: { cardId: card.id, force: true },
        }).then((result) => {
          setCheckingForPullRequest(false);
          if (result._tag === "Failure") {
            if (!isAtomCommandInterrupted(result)) setFeedback(describeBoardCommandFailure(result));
            return;
          }
          setFeedback(describeBoardRefreshOutcome(result.value, branch));
        });
      }}
      onLinkPullRequest={(target) =>
        linkCardPullRequest({ environmentId, input: { cardId: card.id, target } }).then(
          (result) => {
            if (result._tag === "Failure") {
              return isAtomCommandInterrupted(result) ? null : describeBoardCommandFailure(result);
            }
            switch (result.value.outcome) {
              case "refused":
                return result.value.detail;
              case "unknown-card":
                return "This card no longer exists.";
              default:
                return null;
            }
          },
        )
      }
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
      onRequestReviewRound={onRequestReviewRound}
      onSkipCi={onSkipCi}
      onRetryCi={() => onCiAction("retry")}
      onStopCi={() => onCiAction("stop")}
      onCiSendBack={() => onCiAction("send-back")}
      skipCiPending={skippingCi}
      onCreateFollowUp={onCreateFollowUp}
      stepLive={stepLive}
      onOpenPullRequest={(url) => {
        // Refresh on the way out: clicking through is the moment the user is
        // about to see the real state on the forge, so the card should not
        // still be showing them a stale one when they come back.
        void refreshCardPullRequest({ environmentId, input: { cardId: card.id } });
        void openLink(url).catch((error: unknown) => {
          setFeedback(error instanceof Error ? error.message : "Unable to open the pull request.");
        });
      }}
      onOpenLink={(url) => {
        void openLink(url).catch((error: unknown) => {
          setFeedback(error instanceof Error ? error.message : "Unable to open the link.");
        });
      }}
      onMoveStage={(toStage) => {
        if (
          boardMoveLeavesPlanningUnwritten({
            stages,
            card,
            toStage,
            planCount: detail.plans.length,
          })
        ) {
          setUnplannedMove(toStage);
          return;
        }
        moveStage(toStage);
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
      projectExecutionConfig={projectExecutionConfig}
      onSetModelOverrides={(modelOverrides) =>
        runCommand(updateCard({ environmentId, input: { cardId: card.id, modelOverrides } }))
      }
      scheduleKind={scheduleKind}
      onSetScheduledStartAt={(scheduledStartAt) =>
        runCommand(updateCard({ environmentId, input: { cardId: card.id, scheduledStartAt } }))
      }
      automation={automation}
      autoMergeArmed={autoMergeArmed}
      autoMergeFromBoardSetting={boardWideAutoMerge}
      boardMergeStrategy={boardMergeStrategy}
      onSetMergeStrategy={(mergeStrategy) =>
        runCommand(updateCard({ environmentId, input: { cardId: card.id, mergeStrategy } }))
      }
      capacityPanel={
        // T3o: group cards take no claim and run no setup (T3O-86).
        card.group !== null ? null : (
          <BoardCardCapacityPanelHost
            card={card}
            environmentId={environmentId}
            projectResources={projectExecutionConfig?.resources ?? null}
            stepFailed={cardShell?.stalled === true}
            workersState={workersState}
          />
        )
      }
      onSetPriority={
        card.group !== null
          ? undefined
          : (priority) =>
              runCommand(updateCard({ environmentId, input: { cardId: card.id, priority } }))
      }
      priorityStartedNote={priorityStartedNote}
      priorityBlocksHint={priorityBlocksHint}
      resolveModelDisplayName={resolveModelDisplayName}
      // Queued counts as running: its model and authority are already frozen
      // onto the run row, so an edit lands on the run after it.
      stepRunning={cardShell?.stepRunning === true || cardShell?.queued === true}
      reviewPhaseRuntimeMode={reviewPhaseRuntimeMode}
      reviewRoundsStarted={reviewRoundsRecorded}
      reviewStepActive={cardShell?.stepRunning === true || cardShell?.queued === true}
      onSetReviewRounds={(rounds) => patchReviewOverrides({ rounds })}
      // The way out of a phase that recorded a payload nothing can read.
      // The pane hands back the halted step's own id — any of the
      // four phases can be the broken one — and the server refuses a readable
      // record, so a stale pane cannot discard work that actually landed.
      onReopenReviewStep={(stepId) =>
        runCommand(reopenStep({ environmentId, input: { cardId: card.id, stepId } }))
      }
      // The pane's "Run round N+1" and the rail's "Another review round" are
      // the same verb, so they are the same call: the server
      // resolves the round from the ledger, writes the override before it
      // moves the card, and there is no client-side patch to keep in agreement.
      onResumeReview={() => onRequestReviewRound()}
      onReviewRuling={(ruling, note) => onRequestReviewRound({ ruling, note })}
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

  return (
    <>
      <BoardPlanningExitConfirmDialog
        open={unplannedMove !== null}
        onOpenChange={(open) => {
          if (!open) setUnplannedMove(null);
        }}
        cardKey={card.key}
        fromStageLabel={boardStageLabel(stages, card.stage)}
        toStageLabel={unplannedMove === null ? "" : boardStageLabel(stages, unplannedMove)}
        onConfirm={() => {
          if (unplannedMove !== null) moveStage(unplannedMove);
        }}
      />
      {view}
      {archiveGroupOpen && cardShell !== undefined ? (
        <BoardArchiveGroupDialog
          group={cardShell}
          onClose={() => setArchiveGroupOpen(false)}
          onConfirm={(confirmCardKey) =>
            runCommand(archiveCard({ environmentId, input: { cardId: card.id, confirmCardKey } }))
          }
          shells={groupShells}
          stages={stageState}
        />
      ) : null}
    </>
  );
}
