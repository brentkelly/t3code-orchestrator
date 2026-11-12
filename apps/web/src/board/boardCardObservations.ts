/**
 * T3o: each card's resolved inputs, as the card notifier and the tab title both read them, so
 * neither can disagree with the other about why a card waits.
 */
import {
  BOARD_SEED_STAGES,
  DEFAULT_SERVER_SETTINGS,
  boardShellAutoMergeArmedByCard,
  boardStageWithRole,
  deriveBoardCardPlanProgress,
  isBoardMergeStageExecution,
  isBoardProjectHidden,
  resolveBoardStageExecution,
  type BoardCardShell,
  type BoardProjectStageConfigShell,
  type BoardStageDefinition,
  type BoardState,
  type BoardWorkersState,
  type OrchestrationV2ThreadShell,
  type ServerSettings,
  type ThreadId,
} from "@t3tools/contracts";

import { deriveBoardThreadIdleSince } from "./boardAttentionSettle";
import type { BoardCardNotificationObservation } from "./boardCardNotifications.logic";
import { boardShellGroup } from "./boardGroups";

export interface BoardCardObservationSources {
  readonly cards: ReadonlyArray<BoardCardShell>;
  readonly threadOf: (
    threadId: ThreadId,
  ) => Pick<OrchestrationV2ThreadShell, "latestRunCompletedAt"> | undefined;
  readonly stageList: ReadonlyArray<BoardStageDefinition>;
  readonly projectStageConfigs: Readonly<Record<string, BoardProjectStageConfigShell>>;
  readonly serverSettings: ServerSettings | null;
  readonly workers: BoardWorkersState;
}

export interface BoardCardObservations {
  /** The shells with client-derived plan progress applied. */
  readonly cards: ReadonlyArray<BoardCardShell>;
  readonly stages: ReadonlyArray<BoardStageDefinition>;
  readonly stageState: BoardState;
  readonly mergeStageId: string | null;
  readonly boardSettings: ServerSettings["board"];
  /** Each card's thread idle time, by card id: the settle grace's clock. */
  readonly idleByCard: ReadonlyMap<string, string>;
  readonly observations: ReadonlyArray<BoardCardNotificationObservation>;
}

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

/**
 * A builder that reuses each card's plan-progress spread while its counts hold, so per-card
 * caches keyed on the shell's identity keep hitting across evaluations.
 */
export function createBoardCardObserver(): (
  sources: BoardCardObservationSources,
) => BoardCardObservations {
  const withProgress = new WeakMap<BoardCardShell, BoardCardShell>();
  return (sources) => {
    const stages = sources.stageList.length > 0 ? sources.stageList : BOARD_SEED_STAGES;
    const stageState = stageStateOf(stages, sources.projectStageConfigs);
    const mergeStageId = boardStageWithRole(stageState, "merge")?.stageId ?? null;
    const boardSettings = (sources.serverSettings ?? DEFAULT_SERVER_SETTINGS).board;
    const mergeExecution =
      mergeStageId === null ? null : resolveBoardStageExecution(boardSettings, mergeStageId);
    // Plan progress is client-derived; the split and held rules read it.
    const progress = deriveBoardCardPlanProgress({ cards: sources.cards, stages });
    const cards: ReadonlyArray<BoardCardShell> =
      progress.size === 0
        ? sources.cards
        : sources.cards.map((card) => {
            const counts = progress.get(card.cardId);
            if (counts === undefined) return card;
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
    const idleByCard = deriveBoardThreadIdleSince({ cards, threadOf: sources.threadOf });
    const observations: Array<BoardCardNotificationObservation> = cards.map((card) => ({
      card,
      stages,
      mergeStageId,
      autoMergeArmed: armedByCard.get(String(card.cardId)) === true,
      isGroup: boardShellGroup(cards, card) !== null,
      projectHidden: isBoardProjectHidden(boardSettings, card.projectId),
      workers: sources.workers,
      threadIdleSince: idleByCard.get(String(card.cardId)) ?? null,
    }));
    return {
      cards,
      stages,
      stageState,
      mergeStageId,
      boardSettings,
      idleByCard,
      observations,
    };
  };
}
