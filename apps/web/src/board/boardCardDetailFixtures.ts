/** Card-detail fixtures shared by the static `BoardCardDetailView` tests and
    its browser tests. */
import {
  BOARD_SEED_STAGE_IDS,
  BOARD_SEED_STAGES,
  DEFAULT_SERVER_SETTINGS,
  EMPTY_BOARD_WORKERS_STATE,
  BoardCardId,
  BoardLabelId,
  BoardStageId,
  ProjectId,
  boardPlanId,
  makeBoardCardShell,
  type BoardCard,
  type BoardCardDetail,
  type BoardLabel,
} from "@t3tools/contracts";
import { boardThreadWorker } from "./workers/threadWorker";

export const NOW = "2026-01-01T00:00:00.000Z";
export const environmentId = "env-1" as never;

export const cardId = BoardCardId.make("card-1");

export function card(overrides?: Partial<BoardCard>): BoardCard {
  return {
    id: cardId,
    key: "T3-7",
    cardNumber: 7,
    projectId: ProjectId.make("project-gone"),
    labels: [],
    pullRequest: null,
    pullRequestHistory: [],
    pullRequestFloor: null,
    stage: BOARD_SEED_STAGE_IDS.ready,
    orderKey: "m",
    title: "Wire the widget",
    briefRef: null,
    dependsOn: [],
    parentCardId: null,
    sourcePlanId: null,
    group: null,
    threadLinks: [],
    attachments: [],
    externalRef: null,
    humanInLoop: null,
    reviewOverrides: null,
    modelOverrides: null,
    splitRationale: null,
    baseBranch: null,
    scheduledStartAt: null,
    autoStart: false,
    autoMerge: false,
    autoMergeHold: null,
    pinnedWorkerId: null,
    placedWorkerId: null,
    workerMove: null,
    placementOrphaned: null,
    worktree: null,
    blocked: false,
    archivedAt: null,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

export function detail(
  overrides?: Partial<BoardCard>,
  brief: string | null = null,
  edges?: Partial<
    Pick<
      BoardCardDetail,
      | "dependencies"
      | "groupDependencies"
      | "dependents"
      | "stepCompletions"
      | "activity"
      | "plans"
      | "decisions"
    >
  >,
): BoardCardDetail {
  const plans = edges?.plans ?? [];
  return {
    card: card(overrides),
    brief,
    hasPlan: plans.length > 0,
    plans,
    children: [],
    dependencies: edges?.dependencies ?? [],
    groupDependencies: edges?.groupDependencies ?? [],
    dependents: edges?.dependents ?? [],
    activity: edges?.activity ?? [],
    parentModelOverrides: null,
    stepError: null,
    stepCompletions: edges?.stepCompletions ?? [],
    decisions: edges?.decisions ?? [],
  };
}

/** A parent with `childCount` plans, and one materialised child per plan from
    `archivedFrom` onward marked archived (t3o-29). */
export function splitDetail(options: {
  readonly childCount: number;
  readonly archivedFrom?: number;
  readonly stage?: BoardStageId;
}): BoardCardDetail {
  const count = Math.max(options.childCount, 1);
  const plans = Array.from({ length: count }, (_, index) => ({
    planId: boardPlanId(cardId, `p${index}`),
    cardId,
    title: `Plan ${index + 1}`,
    summary: `Summary ${index + 1}`,
    dependsOn: index === 0 ? [] : [boardPlanId(cardId, "p0")],
    ordinal: index,
    locked: false,
    createdAt: NOW,
    updatedAt: NOW,
    body: `# Plan ${index + 1}`,
  })) as BoardCardDetail["plans"];
  const children =
    options.childCount === 0
      ? []
      : (Array.from({ length: options.childCount }, (_, index) => ({
          cardId: BoardCardId.make(`child-${index}`),
          key: `T3-1${index}`,
          title: `Plan ${index + 1}`,
          stage: BOARD_SEED_STAGE_IDS.ready,
          archivedAt:
            options.archivedFrom !== undefined && index >= options.archivedFrom ? NOW : null,
          sourcePlanId: boardPlanId(cardId, `p${index}`),
          dependsOn: [],
        })) as BoardCardDetail["children"]);
  return {
    ...detail({ stage: options.stage ?? BOARD_SEED_STAGE_IDS.planning }, null, { plans }),
    children,
  };
}

/** The children's shells, as the unscoped snapshot carries them. */
export function splitShells(count: number) {
  return Array.from({ length: count }, (_, index) =>
    makeBoardCardShell({
      cardId: BoardCardId.make(`child-${index}`),
      key: `T3-1${index}`,
      projectId: ProjectId.make("project-gone"),
      labelIds: [],
      stage: BOARD_SEED_STAGE_IDS.ready,
      orderKey: "m",
      title: `Plan ${index + 1}`,
      blocked: false,
      dependencyCount: 0,
      hasBrief: false,
      activeThreadId: null,
    }),
  );
}

export const noop = () => {};
export const localWorker = boardThreadWorker({
  workerId: undefined,
  workers: EMPTY_BOARD_WORKERS_STATE,
  boardEnvironmentId: environmentId,
});
export const baseProps = {
  environmentId,
  baseBranch: {
    effective: "main",
    retargeted: false,
    inheritedFrom: null,
    workspaceRoot: "/tmp/project",
  },
  project: {
    lock: null,
    options: [],
    accent: null,
    names: new Map<string, string>(),
    stopsAgent: false,
    restartsStage: false,
  },
  onMergePullRequest: noop,
  onOpenPullRequest: noop,
  conflictFix: null,
  stepFailure: null,
  stepPaused: null,
  merging: false,
  catalogue: [] as ReadonlyArray<BoardLabel>,
  stages: BOARD_SEED_STAGES,
  humanInLoop: null,
  onSetHumanInLoop: noop,
  labelsById: new Map<BoardLabelId, BoardLabel>(),
  branch: null,
  dependencies: [],
  dependencyOptions: [],
  threadLinks: [],
  attachments: [],
  adoptableThreads: [],
  stageRestart: null,
  onRestartStage: noop,
  onCreateBlankThread: () => Promise.resolve(null),
  feedback: null,
  maximised: false,
  onToggleMaximised: noop,
  paneChoice: null,
  onSelectPane: noop,
  onClose: noop,
  onSetLabels: noop,
  onCreateLabel: noop,
  onRecolourLabel: noop,
  onDeleteLabel: noop,
  onUndeleteLabel: noop,
  onSaveBrief: noop,
  attachmentLimits: { known: false, enabled: false, maxFileBytes: null },
  onAttachFile: () => Promise.resolve(null),
  onDetachFile: noop,
  onSaveTitle: noop,
  onAddDependency: noop,
  onRemoveDependency: noop,
  onMoveStage: noop,
  onArchiveToggle: noop,
  onDelete: noop,
  canApproveSplit: false,
  splitGate: null,
  onApproveSplit: noop,
  onLinkThread: noop,
  onUnlinkThread: noop,
  boardSettings: DEFAULT_SERVER_SETTINGS.board,
  onSetModelOverrides: noop,
  scheduleKind: "before-build" as const,
  onSetScheduledStartAt: noop,
} as const;
