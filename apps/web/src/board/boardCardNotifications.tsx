/**
 * T3o: alerts when a card on the board this device shows starts waiting on a
 * human, through upstream's notification mode, sound, toasts and badge. It runs
 * in the client, so nothing alerts while no client is open.
 */
import { presentThreadShell } from "@t3tools/client-runtime/state/models";
import { indexLiveCardThreadIds } from "@t3tools/client-runtime/state/shell";
import { isShownUnderParent } from "@t3tools/client-runtime/state/threads";
import { threadKey } from "@t3tools/client-runtime/state/entities";
import type { AnyRouter } from "@tanstack/react-router";
import {
  BOARD_SEED_STAGES,
  DEFAULT_SERVER_SETTINGS,
  boardShellAutoMergeArmedByCard,
  boardStageWithRole,
  deriveBoardCardPlanProgress,
  isBoardMergeStageExecution,
  isBoardProjectHidden,
  resolveBoardStageExecution,
  type BoardCardId,
  type BoardCardShell,
  type BoardProjectStageConfigShell,
  type BoardStageDefinition,
  type BoardState,
  type EnvironmentId,
  type OrchestrationV2ThreadShell,
  type ThreadId,
} from "@t3tools/contracts";
import type { ClientSettings } from "@t3tools/contracts/settings";
import * as Option from "effect/Option";
import type { AtomRegistry } from "effect/reactivity";
import { LockIcon, MessageCircleQuestionIcon, TriangleAlertIcon } from "lucide-react";

import { PullRequestGlyph } from "../components/pullRequest/pullRequestIcons";
import { resolveSidebarThreadStatus } from "../components/Sidebar.logic";
import { toastManager } from "../components/ui/toast";
import { getClientSettings, subscribeClientSettings } from "../hooks/useSettings";
import { boardEnvironment } from "../state/board";
import { environmentPresentations } from "../state/presentation";
import { primaryEnvironmentIdAtom } from "../state/primaryEnvironment";
import { serverEnvironment } from "../state/server";
import { environmentShell } from "../state/shell";
import { environmentThreadShells } from "../state/threads";
import {
  boardCardNotificationTag,
  hasDesktopNotifications,
  hasNotificationSound,
  playNotificationSound,
  setBoardNotificationBadge,
} from "../threadNotifications";
import { deriveBoardThreadIdleSince } from "./boardAttentionSettle";
import {
  boardCardNotifierNeeded,
  boardCardWaitAlreadyAlerted,
  createBoardCardNotificationGate,
  type BoardCardNotificationFiring,
  type BoardCardNotificationObservation,
  type BoardCardThreadAlertState,
} from "./boardCardNotifications.logic";
import { boardShellGroup } from "./boardGroups";
import { setBoardMutedRoutineThreads } from "./boardThreadAlertMute";
import { resolveBoardEnvironment, type BoardEnvironmentCandidate } from "./useBoardEnvironmentId";

type ToastId = ReturnType<typeof toastManager.add>;

const upstreamAlertsOn = (settings: ClientSettings) =>
  settings.notificationMode !== "off" || settings.inAppNotificationsEnabled;

function stageStateOf(
  stages: ReadonlyArray<BoardStageDefinition>,
  projectStageConfigs: Readonly<Record<string, BoardProjectStageConfigShell>>,
): BoardState {
  return {
    cards: [],
    stages,
    nextCardNumberByProject: {},
    projectStageConfigs: projectStageConfigs as unknown as BoardState["projectStageConfigs"],
  };
}

/** The board server this device shows, and whether it is connected right now. */
function resolveWatchedBoard(
  registry: AtomRegistry.AtomRegistry,
): { readonly environmentId: EnvironmentId; readonly connected: boolean } | null {
  const presentations = registry.get(environmentPresentations.presentationsAtom);
  const candidates = new Map<EnvironmentId, BoardEnvironmentCandidate>();
  for (const [environmentId, presentation] of presentations) {
    candidates.set(environmentId, {
      label: presentation.entry.target.label,
      enabled: presentation.entry.enabled,
      phase: presentation.connection.phase,
    });
  }
  const resolution = resolveBoardEnvironment({
    nominated: getClientSettings().boardEnvironmentId,
    primary: registry.get(primaryEnvironmentIdAtom),
    candidates,
  });
  if (resolution.kind !== "ready") return null;
  // A disconnected board keeps a stale snapshot, so the phase decides, not null.
  const phase = candidates.get(resolution.environmentId)?.phase;
  return { environmentId: resolution.environmentId, connected: phase === "connected" };
}

export function startBoardCardNotifications(
  registry: AtomRegistry.AtomRegistry,
  router: AnyRouter,
): () => void {
  const gate = createBoardCardNotificationGate();
  const pending = new Map<string, { cardId: BoardCardId; notification: Notification }>();
  const openToasts = new Map<BoardCardId, Array<ToastId>>();
  let watched: { environmentId: EnvironmentId; unsubscribe: () => void } | null = null;
  let wakeTimer: ReturnType<typeof setTimeout> | null = null;
  const withProgress = new WeakMap<BoardCardShell, BoardCardShell>();
  // Identity of every atom `evaluate` read last time: the board atom derives from the
  // shell, so one shell change notifies two subscriptions with nothing new for the second.
  let lastInputs: ReadonlyArray<unknown> = [];

  const syncBadge = () => setBoardNotificationBadge(pending.size);
  const clearPending = () => {
    for (const { notification } of pending.values()) notification.close();
    pending.clear();
    syncBadge();
  };
  const closeCard = (cardId: BoardCardId) => {
    for (const toastId of openToasts.get(cardId) ?? []) toastManager.close(toastId);
    openToasts.delete(cardId);
    for (const [tag, entry] of pending) {
      if (entry.cardId !== cardId) continue;
      entry.notification.close();
      pending.delete(tag);
    }
  };
  const closeAll = () => {
    for (const cardId of openToasts.keys()) closeCard(cardId);
    clearPending();
  };
  const openCard = (cardId: BoardCardId) => {
    // The board page sends a child card's link on to its parent's sub-board.
    void router.navigate({ to: "/board", search: { card: cardId } });
  };
  const cardDetailOpen = (cardId: BoardCardId) => {
    const { pathname, search } = router.state.location;
    return pathname.startsWith("/board") && (search as { card?: string }).card === cardId;
  };

  const present = (environmentId: EnvironmentId, { card, reason }: BoardCardNotificationFiring) => {
    const { notificationMode: mode, inAppNotificationsEnabled } = getClientSettings();
    const body = `${card.key}: ${card.title}`;
    if (hasNotificationSound(mode)) {
      void playNotificationSound("input", () =>
        hasNotificationSound(getClientSettings().notificationMode),
      );
    }
    const focused = document.visibilityState === "visible" && document.hasFocus();
    if (focused) {
      if (!inAppNotificationsEnabled || cardDetailOpen(card.cardId)) return;
      const toastId: ToastId = toastManager.add({
        onRemove: (): void => {
          const remaining = (openToasts.get(card.cardId) ?? []).filter((id) => id !== toastId);
          if (remaining.length === 0) openToasts.delete(card.cardId);
          else openToasts.set(card.cardId, remaining);
        },
        type: "warning",
        title: reason.title,
        description: body,
        data: {
          hideCopyButton: true,
          leadingIcon:
            reason.category === "waiting" ? (
              <MessageCircleQuestionIcon aria-hidden className="size-4 text-attention-foreground" />
            ) : reason.category === "readyForMerge" ? (
              <PullRequestGlyph.merged aria-hidden className="size-4 text-attention-foreground" />
            ) : reason.category === "blocked" ? (
              <LockIcon aria-hidden className="size-4 text-warning-foreground" />
            ) : (
              <TriangleAlertIcon aria-hidden className="size-4 text-warning-foreground" />
            ),
        },
        actionProps: {
          children: "Open card",
          onClick: () => {
            toastManager.close(toastId);
            openCard(card.cardId);
          },
        },
      });
      openToasts.set(card.cardId, [...(openToasts.get(card.cardId) ?? []), toastId]);
      return;
    }
    if (
      !hasDesktopNotifications(mode) ||
      typeof Notification === "undefined" ||
      Notification.permission !== "granted"
    )
      return;
    try {
      const tag = boardCardNotificationTag(environmentId, card.cardId);
      const notification = new Notification(reason.title, { body, tag, silent: true });
      pending.get(tag)?.notification.close();
      pending.set(tag, { cardId: card.cardId, notification });
      syncBadge();
      notification.addEventListener("click", () => {
        notification.close();
        window.focus();
        void window.desktopBridge?.revealWindow().catch(() => undefined);
        openCard(card.cardId);
      });
    } catch {
      // Some browsers expose Notification but reject desktop presentation.
    }
  };

  const readInputs = (environmentId: EnvironmentId): ReadonlyArray<unknown> => [
    registry.get(boardEnvironment.boardAtom(environmentId)),
    registry.get(environmentShell.stateValueAtom(environmentId)),
    registry.get(boardEnvironment.workersAtom(environmentId)),
    registry.get(boardEnvironment.stageListAtom(environmentId)),
    registry.get(boardEnvironment.projectStageConfigsAtom(environmentId)),
    registry.get(serverEnvironment.settingsValueAtom(environmentId)),
  ];
  const evaluateIfChanged = (environmentId: EnvironmentId) => {
    const inputs = readInputs(environmentId);
    if (inputs.length === lastInputs.length && inputs.every((value, i) => value === lastInputs[i]))
      return;
    evaluate(environmentId);
  };

  const evaluate = (environmentId: EnvironmentId) => {
    if (wakeTimer !== null) clearTimeout(wakeTimer);
    wakeTimer = null;
    lastInputs = readInputs(environmentId);
    const board = registry.get(boardEnvironment.boardAtom(environmentId));
    const shell = registry.get(environmentShell.stateValueAtom(environmentId));
    const target = resolveWatchedBoard(registry);
    // The baseline waits for both: the thread overlay racing the shell would
    // otherwise read as fresh waits at startup.
    if (
      board === null ||
      shell.status !== "live" ||
      Option.isNone(shell.snapshot) ||
      target?.environmentId !== environmentId ||
      !target.connected
    )
      return;
    const settings = getClientSettings();
    const threads = shell.snapshot.value.threads;
    const threadById = new Map(threads.map((thread) => [thread.id, thread]));
    const stageList = registry.get(boardEnvironment.stageListAtom(environmentId));
    const stages = stageList.length > 0 ? stageList : BOARD_SEED_STAGES;
    const stageState = stageStateOf(
      stages,
      registry.get(boardEnvironment.projectStageConfigsAtom(environmentId)),
    );
    const mergeStageId = boardStageWithRole(stageState, "merge")?.stageId ?? null;
    const boardSettings = (
      registry.get(serverEnvironment.settingsValueAtom(environmentId)) ?? DEFAULT_SERVER_SETTINGS
    ).board;
    const mergeExecution =
      mergeStageId === null ? null : resolveBoardStageExecution(boardSettings, mergeStageId);
    const workers = registry.get(boardEnvironment.workersAtom(environmentId));
    // Plan progress is client-derived; the split and held rules read it.
    const progress = deriveBoardCardPlanProgress({ cards: board.cards, stages });
    const cards: ReadonlyArray<BoardCardShell> =
      progress.size === 0
        ? board.cards
        : board.cards.map((card) => {
            const counts = progress.get(card.cardId);
            if (counts === undefined) return card;
            // Reuse the last spread so the gate's per-card cache, keyed on identity, hits.
            const prior = withProgress.get(card);
            if (prior?.planTotal === counts.total && prior.planDone === counts.done) return prior;
            const next = { ...card, planTotal: counts.total, planDone: counts.done };
            withProgress.set(card, next);
            return next;
          });
    const armedByCard = boardShellAutoMergeArmedByCard({
      shells: cards,
      boardWide:
        mergeExecution !== null && isBoardMergeStageExecution(mergeExecution)
          ? mergeExecution.autoMerge
          : false,
    });
    const idleByCard = deriveBoardThreadIdleSince({
      cards,
      threadOf: (threadId) => threadById.get(threadId),
    });
    const observations: Array<BoardCardNotificationObservation> = cards.map((card) => ({
      card,
      stages,
      mergeStageId,
      autoMergeArmed: armedByCard.get(String(card.cardId)) === true,
      isGroup: boardShellGroup(cards, card) !== null,
      projectHidden: isBoardProjectHidden(boardSettings, card.projectId),
      workers,
      threadIdleSince: idleByCard.get(String(card.cardId)) ?? null,
    }));
    const { fire, cleared, wakeAt } = gate.evaluate({
      cards: observations,
      settings: settings.boardNotifications,
      now: Date.now(),
    });

    const liveThreadIdsOf = indexLiveCardThreadIds(board.cardThreads);
    const doneStageId = boardStageWithRole(stageState, "done")?.stageId ?? null;
    // Only cards that can alert stand in for their threads' routine alerts.
    const liveThreadIds = new Set<string>();
    for (const card of cards) {
      if (
        card.archivedAt != null ||
        card.stage === doneStageId ||
        isBoardProjectHidden(boardSettings, card.projectId)
      )
        continue;
      for (const threadId of liveThreadIdsOf(card)) liveThreadIds.add(threadId);
    }
    setBoardMutedRoutineThreads(
      settings.boardNotifications.muteRoutineThreadAlerts ? liveThreadIds : null,
    );

    for (const cardId of cleared) closeCard(cardId);
    if (cleared.length > 0) syncBadge();
    const hidden = registry.get(environmentThreadShells.hiddenThreadKeysAtom);
    const delegated = registry.get(environmentThreadShells.delegatedUnderParentAtom);
    const threadState = (
      thread: OrchestrationV2ThreadShell,
      activeThreadId: ThreadId | null,
    ): BoardCardThreadAlertState => {
      const presented = presentThreadShell(environmentId, thread, null);
      let status = resolveSidebarThreadStatus(presented);
      if (status === "ready" && presented.latestRun?.status === "failed") status = "failed";
      return {
        status,
        archived: presented.archivedAt !== null,
        active: thread.id === activeThreadId,
        upstreamSkips:
          hidden.has(threadKey({ environmentId, threadId: thread.id })) ||
          isShownUnderParent({ environmentId, threadId: thread.id }, thread.lineage, delegated),
      };
    };
    for (const firing of fire) {
      const cardThreads = liveThreadIdsOf(firing.card).flatMap((threadId: ThreadId) => {
        const thread = threadById.get(threadId);
        return thread === undefined ? [] : [threadState(thread, firing.card.activeThreadId)];
      });
      if (
        boardCardWaitAlreadyAlerted({
          reason: firing.reason,
          card: firing.card,
          threads: cardThreads,
          upstreamAlertsOn: upstreamAlertsOn(settings),
          boardConnected: target.connected,
        })
      )
        continue;
      present(environmentId, firing);
    }
    if (wakeAt !== null) {
      // `+ 1` so the timer cannot land a millisecond short of the deadline.
      wakeTimer = setTimeout(() => evaluate(environmentId), Math.max(0, wakeAt - Date.now()) + 1);
    }
  };

  const watch = (environmentId: EnvironmentId) => {
    gate.reset();
    const reevaluate = () => evaluateIfChanged(environmentId);
    const unsubscribes = [
      registry.subscribe(boardEnvironment.boardAtom(environmentId), reevaluate, {
        immediate: true,
      }),
      registry.subscribe(environmentShell.stateValueAtom(environmentId), reevaluate),
      registry.subscribe(boardEnvironment.workersAtom(environmentId), reevaluate),
      registry.subscribe(boardEnvironment.stageListAtom(environmentId), reevaluate),
      registry.subscribe(boardEnvironment.projectStageConfigsAtom(environmentId), reevaluate),
      registry.subscribe(serverEnvironment.settingsValueAtom(environmentId), reevaluate),
    ];
    return () => {
      for (const unsubscribe of unsubscribes) unsubscribe();
    };
  };

  const unwatch = () => {
    watched?.unsubscribe();
    watched = null;
    lastInputs = [];
    if (wakeTimer !== null) clearTimeout(wakeTimer);
    wakeTimer = null;
    setBoardMutedRoutineThreads(null);
    closeAll();
  };

  const sync = () => {
    const settings = getClientSettings();
    const active =
      boardCardNotifierNeeded(settings.boardNotifications) && upstreamAlertsOn(settings);
    const target = active ? resolveWatchedBoard(registry) : null;
    if (target === null) {
      unwatch();
      return;
    }
    if (watched?.environmentId !== target.environmentId) {
      unwatch();
      watched = { environmentId: target.environmentId, unsubscribe: watch(target.environmentId) };
      return;
    }
    evaluate(target.environmentId);
  };

  // Desktop-mode listeners, rebuilt when the mode changes, as upstream's are. Upstream's
  // coordinator owns the audio unlock.
  let appliedMode: ClientSettings["notificationMode"] | null = null;
  let stopModeListeners = () => {};
  const applyMode = () => {
    const mode = getClientSettings().notificationMode;
    if (mode === appliedMode) return;
    appliedMode = mode;
    stopModeListeners();
    clearPending();
    const stops: Array<() => void> = [];
    if (hasDesktopNotifications(mode)) {
      const unsubscribeBadgeClear = window.desktopBridge?.onNotificationBadgeClear(clearPending);
      window.addEventListener("focus", clearPending);
      stops.push(() => {
        unsubscribeBadgeClear?.();
        window.removeEventListener("focus", clearPending);
      });
    }
    stopModeListeners = () => {
      for (const stop of stops) stop();
    };
  };

  const onSettings = () => {
    applyMode();
    sync();
  };
  const unsubscribeSettings = subscribeClientSettings(onSettings);
  const unsubscribeTargets = [
    registry.subscribe(environmentPresentations.presentationsAtom, sync),
    registry.subscribe(primaryEnvironmentIdAtom, sync),
  ];
  onSettings();

  return () => {
    unsubscribeSettings();
    for (const unsubscribe of unsubscribeTargets) unsubscribe();
    stopModeListeners();
    unwatch();
  };
}
