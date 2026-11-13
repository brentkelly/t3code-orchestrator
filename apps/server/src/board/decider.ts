/**
 * Pure decision logic for board commands: read model in, planned events out,
 * `Crypto` as the only requirement (no SQL client). Card numbers come from
 * `nextCardNumberByProject`, so allocation is exact under the engine's total
 * command ordering. The decider validates moves but never advances a card itself.
 */
import {
  BOARD_SEED_STAGE_IDS,
  EMPTY_BOARD_CARD_RESOURCES,
  type BoardCardResources,
  canonicalJson,
  withBoardCardPlannerSize,
  withBoardCardSizeEdit,
  BOARD_DECISIONS_PER_CALL_MAX,
  isBoardCardAutoPlanPending,
  BOARD_CARD_BRIEF_BODY_KIND,
  BOARD_CARD_LABELS_MAX,
  boardAppendOrderKey,
  boardArrivalOrderKey,
  boardColumnOrderKeys,
  boardCardChildren,
  boardCardPendingSplit,
  boardCardProjectLock,
  boardCardPlans,
  boardCardUnfinishedChildren,
  BoardCardId,
  BoardCardModelOverrides,
  boardCardHasLiveBranch,
  isBoardCardBaseBranchShape,
  isEmptyBoardCardModelOverrides,
  boardCardAutoMergeHoldsEqual,
  boardAutomationTogglesTurnedOn,
  boardCardAutoMergeArmed,
  BOARD_AUTOMATION_TOGGLE_LABELS,
  type BoardAutomationChanged,
  resolveBoardCardAutomationIn,
  boardSubBoardFloorStage,
  boardOrderKeyBetween,
  boardCardPullRequestsEqual,
  boardPullRequestPredatesCard,
  isBoardCardPullRequestTerminal,
  boardCardDeletableThreadIds,
  boardCardStepCompletions,
  boardStepPayloadDefect,
  boardCardStepState,
  boardReviewRoundsStarted,
  boardRunLabel,
  deriveBoardCardReviewSummary,
  parseReviewStepId,
  boardLabelCatalogue,
  boardPlanId,
  boardStageById,
  boardStageIndex,
  boardStages,
  boardCardMergesIntoIntegrationBranch,
  boardStageWithRole,
  DEFAULT_BOARD_KEY_PREFIX,
  deriveBoardCardBlocked,
  effectiveBoardStageRole,
  EMPTY_BOARD_STATE,
  EventId,
  boardCardActiveChildren,
  boardCardAncestors,
  boardCardGroupOf,
  boardCardInheritedDependsOn,
  boardCreateDefaultStage,
  boardProjectFirstStageId,
  boardProjectStagesInOrder,
  boardCardGroupsEqual,
  boardCardIntegrationAncestor,
  boardCardLiveChildren,
  boardGroupRevertsToCard,
  boardCardLiveDescendants,
  boardGroupRevertStage,
  boardGroupTargetLockReason,
  boardNextStageId,
  boardCardMoveRefusal,
  boardStageOrderViolation,
  isBoardStageSwitchable,
  isBoardCiPassSettledPhase,
  defaultBoardCardGroup,
  boardSplitRecommendationFallback,
  boardSplitRecommendationOf,
  isBoardPlanPlanned,
  deriveBoardGroupStage,
  boardGroupOwnTargetProjectRefusal,
  boardGroupProjectRefusal,
  isBoardCardSelfOrAncestor,
  isBoardCardStarted,
  isBoardDeferredStage,
  type BoardCardGroup,
  isBoardStageAtOrAfterBuild,
  isBoardParkedStepStatus,
  isBoardTerminalStepStatus,
  isEmptyBoardCardReviewOverrides,
  EMPTY_BOARD_CARD_REVIEW_OVERRIDES,
  BOARD_REVIEW_FULL_ROUND,
  reviewStepId,
  type BoardReviewRoundMode,
  readBoardPlanReviewReport,
  pickNextBoardLabelColour,
  BOARD_CARD_ATTACHMENTS_MAX,
  sortBoardCardAttachments,
  sortBoardCardThreadLinks,
  unmetBoardCardDependencies,
  type BoardCard,
  type BoardCardExternalRef,
  type BoardCardEditSummary,
  type BoardCardUpdateCommand,
  type BoardCardReviewSummary,
  type BoardCardReviewOverrides,
  type BoardPlanId,
  type BoardCardPullRequestTransition,
  type BoardCardStepState,
  type BoardLabel,
  type BoardLabelId,
  type BoardPlan,
  type BoardPlanWithBody,
  type BoardStageDefinition,
  type BoardStageId,
  type BoardState,
  type BoardStepCompletion,
  type BoardCommand,
  type BoardEvent,
  type ProjectId,
  BOARD_LOCAL_WORKER_ABBREVIATION,
  BOARD_LOCAL_WORKER_ID,
  boardCardBoundWorkerId,
  boardCardEffectiveWorkerId,
  boardCardHoldsWorktree,
  boardCardWorkerRemovalOutcome,
  type BoardCardWorkerMove,
  type BoardWorkerId,
} from "@t3tools/contracts";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Effect from "effect/Effect";
import type * as PlatformError from "effect/PlatformError";

import { BoardCommandInvariantError } from "./errors.ts";
import {
  decideProjectConfigCommand,
  pruneDeletedStage,
  switchOnForProject,
} from "./projectConfig/decideProjectConfig.ts";
import {
  appendToBrief,
  boardBriefVersion,
  briefHeadingLevel,
  briefSectionBodyBreak,
  briefUnclosedFence,
  replaceBriefSection,
} from "./briefEdits.ts";
import { decideBoardCiRecord } from "./ci/ciRecord.ts";
import { isKeptStepThread } from "./planningThreadKeep.ts";
import { boardCompletionReopened } from "./planReview.ts";
import { projectBoardEvent, type BoardReadModel } from "./projector.ts";

export type { BoardCommand };

/** Label commands aggregate on the label, not the card — they carry
    `labelId` instead of `cardId`. Keyed on the `board.label.` prefix. */
type BoardLabelCommand = Extract<BoardCommand, { type: `board.label.${string}` }>;
function isBoardLabelCommand(command: BoardCommand): command is BoardLabelCommand {
  return command.type.startsWith("board.label.");
}

/** Stage-aggregate commands aggregate on the stage — they carry
    `stageId` instead of `cardId`. Keyed on the `board.stage.` prefix. */
type BoardStageCommand = Extract<BoardCommand, { type: `board.stage.${string}` }>;
function isBoardStageCommand(command: BoardCommand): command is BoardStageCommand {
  return command.type.startsWith("board.stage.");
}

/** Worker-registry commands aggregate on the worker — they carry a
    worker id and no card. Keyed on the `board.worker.` prefix. */
type BoardWorkerCommand = Extract<BoardCommand, { type: `board.worker.${string}` }>;
function isBoardWorkerCommand(command: BoardCommand): command is BoardWorkerCommand {
  return command.type.startsWith("board.worker.");
}

/** Project commands aggregate on the project: a project's
    `t3o.json` stage config. Keyed on the `board.project.` prefix. */
type BoardProjectCommand = Extract<BoardCommand, { type: `board.project.${string}` }>;
function isBoardProjectCommand(command: BoardCommand): command is BoardProjectCommand {
  return command.type.startsWith("board.project.");
}

/** Card-aggregate commands — every board command except the label, stage,
    worker and project ones; the only commands that carry a `cardId`. */
type BoardCardCommand = Exclude<
  BoardCommand,
  BoardLabelCommand | BoardStageCommand | BoardWorkerCommand | BoardProjectCommand
>;

// Distributive so the planned event stays a discriminated union — a plain
// `Omit` over the union flattens `type` and `payload` into independent
// unions and callers could no longer narrow payloads by event type.
type DistributiveOmit<T, K extends keyof T> = T extends unknown ? Omit<T, K> : never;
export type PlannedBoardEvent = DistributiveOmit<BoardEvent, "sequence">;

/**
 * Most commands decide one event. Archive, unarchive and delete decide a list,
 * because changing a dependency gate re-flags the cards on the other end of the edge.
 */
export type BoardDecision = PlannedBoardEvent | ReadonlyArray<PlannedBoardEvent>;

/** A decision as the list the engine appends — the single-event case is a
    list of one. Discriminated on `type`, which every event has and no array
    does: `Array.isArray` narrows to `any[]` and leaks `any` into the result. */
export function boardDecidedEvents(decided: BoardDecision): ReadonlyArray<PlannedBoardEvent> {
  return "type" in decided ? [decided] : decided;
}

/**
 * Aggregate ref for a board command — every board command aggregates on its
 * card. Called from `commandToAggregateRef` in the upstream engine
 * behind the `isBoardCommand` predicate.
 */
export function boardCommandAggregateRef(command: BoardCommand): {
  readonly aggregateKind: "card" | "label" | "stage" | "worker" | "project";
  readonly aggregateId: BoardCardId | BoardLabelId | BoardStageId | BoardWorkerId | ProjectId;
} {
  if (isBoardProjectCommand(command)) {
    return { aggregateKind: "project", aggregateId: command.projectId };
  }
  if (isBoardWorkerCommand(command)) {
    return {
      aggregateKind: "worker",
      aggregateId: command.type === "board.worker.register" ? command.worker.id : command.workerId,
    };
  }
  if (isBoardLabelCommand(command)) {
    return { aggregateKind: "label", aggregateId: command.labelId };
  }
  if (isBoardStageCommand(command)) {
    return { aggregateKind: "stage", aggregateId: command.stageId };
  }
  return { aggregateKind: "card", aggregateId: command.cardId };
}

const invariant = (command: BoardCommand, detail: string) =>
  new BoardCommandInvariantError({ commandType: command.type, detail });

function withoutPendingDiscard(worktree: BoardCard["worktree"]): BoardCard["worktree"] {
  if (worktree?.discardPending !== true) return worktree;
  const { discardPending: _cancelled, ...rest } = worktree;
  return rest;
}

/** A pending auto-plan request marked spent: the plan was approved,
    the card left planning before it arrived, or the run stopped being driven
    by the board. Anything else is untouched. */

function endBoardCardAutoPlan(card: BoardCard, at: string): Pick<BoardCard, "autoPlan"> {
  return card.autoPlan !== undefined && card.autoPlan.endedAt === null
    ? { autoPlan: { ...card.autoPlan, endedAt: at } }
    : {};
}

function requireBoardCard(input: {
  readonly board: BoardState;
  readonly command: BoardCardCommand;
}): Effect.Effect<BoardCard, BoardCommandInvariantError> {
  const card = input.board.cards.find((candidate) => candidate.id === input.command.cardId);
  return card === undefined
    ? Effect.fail(invariant(input.command, `Card '${input.command.cardId}' does not exist.`))
    : Effect.succeed(card);
}

function requireActiveBoardCard(input: {
  readonly board: BoardState;
  readonly command: BoardCardCommand;
}): Effect.Effect<BoardCard, BoardCommandInvariantError> {
  return requireBoardCard(input).pipe(
    Effect.filterOrFail(
      (card) => card.archivedAt === null,
      () => invariant(input.command, `Card '${input.command.cardId}' is archived.`),
    ),
  );
}

/**
 * The card's live step state, required to exist and match the command's
 * `stepId`. The reactor is the only dispatcher of the step-lifecycle
 * commands and always acts on the card's one current step, so a mismatch is a
 * bug (a stale command for a superseded step), rejected rather than applied.
 */
function requireLiveStepState(input: {
  readonly board: BoardState;
  readonly command: BoardCardCommand;
  readonly stepId: string;
}): Effect.Effect<BoardCardStepState, BoardCommandInvariantError> {
  const state = boardCardStepState(input.board, input.command.cardId);
  return state === null || state.stepId !== input.stepId
    ? Effect.fail(
        invariant(
          input.command,
          `Card '${input.command.cardId}' has no live step '${input.stepId}'.`,
        ),
      )
    : Effect.succeed(state);
}

/** Board-wide, so a card that changed project still guards its reference. Archived cards
    do not hold one: restoring a duplicate is the caller's to refuse. */
function externalRefTakenRefusal(
  board: BoardState,
  ref: BoardCardExternalRef,
  cardId: BoardCardId,
): string | null {
  const holder = board.cards.find(
    (card) =>
      card.id !== cardId &&
      card.archivedAt === null &&
      card.externalRef?.system === ref.system &&
      card.externalRef.id === ref.id,
  );
  return holder === undefined
    ? null
    : `Card '${holder.key}' already tracks ${ref.system} '${ref.id}'.`;
}

/** Move and start-stage-thread name unmet deps the same way: `KEY "title"`. */
function formatUnmetDependencies(board: BoardState, unmet: ReadonlyArray<BoardCardId>): string {
  return unmet
    .map((dependencyId) => {
      const dependency = board.cards.find((existing) => existing.id === dependencyId);
      return dependency === undefined
        ? `a card that no longer exists ('${dependencyId}')`
        : `${dependency.key} "${dependency.title}"`;
    })
    .join(", ");
}

/**
 * First dependency edge of `proposed` whose addition closes a cycle, with
 * the closing path for the rejection message. The graph is every card's
 * `dependsOn` with `cardId`'s list replaced by the proposed one.
 */
function findDependencyCycle(input: {
  readonly board: BoardState;
  readonly cardId: BoardCardId;
  readonly proposed: ReadonlyArray<BoardCardId>;
  /** The edges to test; the rest of `proposed` already existed. */
  readonly added: ReadonlyArray<BoardCardId>;
}): {
  readonly edgeFrom: BoardCardId;
  readonly edgeTo: BoardCardId;
  readonly path: ReadonlyArray<BoardCardId>;
} | null {
  // Tree-wide: a group waits for its children and they wait on its
  // dependencies, so a new edge can close a cycle that skips `cardId` itself.
  const before = boardTreeDependencyGraph(input.board.cards);
  const after = boardTreeDependencyGraph(
    input.board.cards.map((card) =>
      card.id === input.cardId ? { ...card, dependsOn: input.proposed } : card,
    ),
  );
  const ownEdges: Array<readonly [BoardCardId, BoardCardId]> = input.added.map(
    (dependency) => [input.cardId, dependency] as const,
  );
  const cycle = findNewCycleAlong(before, after, ownEdges);
  return cycle === null ? null : { edgeFrom: cycle[0]!, edgeTo: cycle[1]!, path: cycle };
}

/**
 * Why `dependency` cannot be a new dependency of `dependent`, or null. The one
 * refused shape is an edge along the card's own ancestry: a card inside a group
 * finishes before its group, and a group already waits for everything inside it.
 */
function dependencyTreeRefusal(input: {
  readonly board: BoardState;
  readonly dependent: Pick<BoardCard, "id" | "key" | "parentCardId">;
  readonly dependency: Pick<BoardCard, "id" | "key" | "parentCardId">;
}): string | null {
  const { board, dependent, dependency } = input;
  if (boardCardAncestors(board, dependent).some((ancestor) => ancestor.id === dependency.id)) {
    return `Card '${dependency.key}' is a group containing '${dependent.key}'; a card inside a group finishes before its group does, so it cannot also wait for it.`;
  }
  if (boardCardAncestors(board, dependency).some((ancestor) => ancestor.id === dependent.id)) {
    return `Card '${dependency.key}' is inside the group '${dependent.key}', which already waits for everything inside it.`;
  }
  return null;
}

/**
 * The dependency graph across the whole tree: every live card's
 * inherited `dependsOn` (its own plus every ancestor group's, which hold it
 * back), plus an edge from each group to its live children, because a group
 * is done only once they are. Cycle checks run over this.
 */
function boardTreeDependencyGraph(
  cards: ReadonlyArray<BoardCard>,
): Map<BoardCardId, ReadonlyArray<BoardCardId>> {
  const graph = new Map<BoardCardId, Array<BoardCardId>>(
    cards.map((card) => [
      card.id,
      [
        ...(card.archivedAt === null
          ? boardCardInheritedDependsOn({ cards }, card)
          : card.dependsOn),
      ],
    ]),
  );
  for (const card of cards) {
    if (card.parentCardId === null || card.archivedAt !== null) continue;
    graph.get(card.parentCardId)?.push(card.id);
  }
  return graph;
}

/** A path from `start` to `target` along `graph`, or null. */
function treeDependencyPath(
  graph: ReadonlyMap<BoardCardId, ReadonlyArray<BoardCardId>>,
  start: BoardCardId,
  target: BoardCardId,
): ReadonlyArray<BoardCardId> | null {
  if (start === target) return [start];
  const seen = new Set<BoardCardId>([start]);
  const walk = (from: BoardCardId): ReadonlyArray<BoardCardId> | null => {
    for (const next of graph.get(from) ?? []) {
      if (next === target) return [from, target];
      if (seen.has(next)) continue;
      seen.add(next);
      const rest = walk(next);
      if (rest !== null) return [from, ...rest];
    }
    return null;
  };
  return walk(start);
}

/**
 * A dependency cycle a regrouping creates, or null. Every new cycle runs
 * through at least one edge the regrouping added, so only those are checked:
 * a cycle that predates the move does not block it, and does not hide a new
 * one through the same card.
 */
function findNewTreeDependencyCycle(input: {
  readonly before: ReadonlyArray<BoardCard>;
  readonly after: ReadonlyArray<BoardCard>;
}): ReadonlyArray<BoardCardId> | null {
  return findNewCycleAlong(
    boardTreeDependencyGraph(input.before),
    boardTreeDependencyGraph(input.after),
    [],
  );
}

/**
 * A cycle through an edge of `after` that `before` lacks, as a closed path, or
 * null. `first` edges are tried before the rest so the edge a caller added is
 * the one blamed when it closes the cycle itself.
 */
function findNewCycleAlong(
  before: ReadonlyMap<BoardCardId, ReadonlyArray<BoardCardId>>,
  after: ReadonlyMap<BoardCardId, ReadonlyArray<BoardCardId>>,
  first: ReadonlyArray<readonly [BoardCardId, BoardCardId]>,
): ReadonlyArray<BoardCardId> | null {
  const edges = [
    ...first,
    ...[...after].flatMap(([from, targets]) => targets.map((to) => [from, to] as const)),
  ];
  for (const [from, to] of edges) {
    if ((before.get(from) ?? []).includes(to)) continue;
    const back = treeDependencyPath(after, to, from);
    if (back !== null) return [from, ...back];
  }
  return null;
}

/**
 * Bounds on a split's justification (t3o card 11). The floor exists only to
 * refuse lazy one-word compliance — it is not a quality bar, and nothing here
 * pretends to read the text. The ceiling stops the rationale becoming a second
 * brief on a row that is projected to every client.
 */
const SPLIT_RATIONALE_MIN_LENGTH = 40;
const SPLIT_RATIONALE_MAX_LENGTH = 2000;

/**
 * First dependency edge within a plan proposal (keyed by plan `key`) whose
 * addition closes a cycle. Separate from `findDependencyCycle` because plans are
 * keyed by their proposal-local slug, not a `BoardCardId`.
 */
function findProposedPlanCycle(
  plans: ReadonlyArray<{ readonly key: string; readonly dependsOn: ReadonlyArray<string> }>,
): { readonly from: string; readonly to: string; readonly path: ReadonlyArray<string> } | null {
  const dependsByKey = new Map<string, ReadonlyArray<string>>(
    plans.map((plan) => [plan.key, plan.dependsOn]),
  );
  const pathTo = (
    from: string,
    target: string,
    seen: Set<string>,
  ): ReadonlyArray<string> | null => {
    if (from === target) return [from];
    if (seen.has(from)) return null;
    seen.add(from);
    for (const next of dependsByKey.get(from) ?? []) {
      const rest = pathTo(next, target, seen);
      if (rest !== null) return [from, ...rest];
    }
    return null;
  };
  for (const plan of plans) {
    for (const dependency of plan.dependsOn) {
      const path = pathTo(dependency, plan.key, new Set());
      if (path !== null) {
        return { from: plan.key, to: dependency, path: [plan.key, ...path] };
      }
    }
  }
  return null;
}

const makeBoardEventBase = Effect.fn("makeBoardEventBase")(function* (input: {
  readonly cardId: BoardCardId;
  readonly occurredAt: string;
  readonly commandId: BoardCommand["commandId"];
}) {
  const crypto = yield* SecureRandom.SecureRandom;
  const eventId = yield* crypto.uuidV4();
  return {
    eventId: EventId.make(eventId),
    aggregateKind: "card" as const,
    aggregateId: input.cardId,
    occurredAt: input.occurredAt,
    commandId: input.commandId,
    causationEventId: null,
    correlationId: input.commandId,
    metadata: {},
  };
});

const withoutEmptyResources = (resources: BoardCardResources): BoardCardResources | null =>
  resources.sizing === null &&
  resources.grant === null &&
  resources.setup === null &&
  resources.setupDue !== true &&
  (resources.placement ?? null) === null
    ? null
    : resources;

/** A new worktree has never run setup, whatever ran in the card's last one. */
const withSetupDue = (resources: BoardCardResources | null): BoardCardResources => ({
  ...(resources ?? EMPTY_BOARD_CARD_RESOURCES),
  setup: null,
  setupDue: true,
});

/** T3o: a card with no placement on record (T3O-87). */
const withoutPlacement = (resources: BoardCardResources | null): BoardCardResources | null =>
  resources === null ? null : withoutEmptyResources({ ...resources, placement: null });

/** T3o: a card's resources changed (T3O-86), carrying the whole card. */
const cardResourcesRecordedEvent = Effect.fn("cardResourcesRecordedEvent")(function* (input: {
  readonly card: BoardCard;
  readonly resources: BoardCard["resources"];
  readonly command: Pick<BoardCommand, "commandId" | "createdAt">;
  readonly setupRequested?: "retry" | "cancel";
}) {
  const card: BoardCard = { ...input.card, resources: input.resources };
  return {
    ...(yield* makeBoardEventBase({
      cardId: card.id,
      occurredAt: input.command.createdAt,
      commandId: input.command.commandId,
    })),
    type: "board.card-resources-recorded" as const,
    payload: {
      cardId: card.id,
      card,
      ...(input.setupRequested === undefined ? {} : { setupRequested: input.setupRequested }),
    },
  } satisfies PlannedBoardEvent;
});

/** The planner's size for a card proposed one plan, or null when nothing changes. A split's
    sizes reach each child at approval instead. */
const plannerSizeRecorded = Effect.fn("plannerSizeRecorded")(function* (input: {
  readonly board: BoardState;
  readonly command: Pick<BoardCommand, "commandId" | "createdAt">;
  readonly card: BoardCard;
  readonly plans: ReadonlyArray<Pick<BoardPlan, "size" | "sizeReason">>;
}) {
  const only = input.plans.length === 1 ? input.plans[0]! : null;
  const planner =
    only?.size === undefined ? null : { size: only.size, reason: only.sizeReason ?? null };
  const current = input.card.resources?.sizing?.planner ?? null;
  if (canonicalJson(current) === canonicalJson(planner)) return null;
  return yield* cardResourcesRecordedEvent({
    card: input.card,
    resources: withBoardCardPlannerSize(input.card.resources, planner),
    command: input.command,
  });
});

/**
 * The `board.card-updated` events that keep dependents' stored `blocked` honest
 * when `changed` is archived or restored. Only a card whose flag flips emits, so a
 * no-op archive stays one event. A dependent is any card whose INHERITED
 * dependencies name `changed`, since a group's dependencies hold back its cards.
 */
const boardDependentBlockedEvents = Effect.fn("boardDependentBlockedEvents")(function* (input: {
  readonly board: BoardState;
  readonly command: BoardCardCommand;
  readonly changed: BoardCard;
}): Effect.fn.Return<
  ReadonlyArray<PlannedBoardEvent>,
  PlatformError.PlatformError,
  SecureRandom.SecureRandom
> {
  const cards = input.board.cards.map((card) =>
    card.id === input.changed.id ? input.changed : card,
  );
  return yield* boardReflagBlockedEvents({
    board: input.board,
    command: input.command,
    cards,
    includes: (card) =>
      card.id !== input.changed.id &&
      boardCardInheritedDependsOn({ cards }, card).includes(input.changed.id),
  });
});

/**
 * Re-derive the stored `blocked` of every live card `includes` selects,
 * against the post-command `cards`, and emit an update only where it flips.
 * The descendants of a group whose own dependencies or ancestry changed
 * inherit that change, so callers pass them through here too.
 */
const boardReflagBlockedEvents = Effect.fn("boardReflagBlockedEvents")(function* (input: {
  readonly board: BoardState;
  readonly command: BoardCardCommand;
  readonly cards: ReadonlyArray<BoardCard>;
  readonly includes: (card: BoardCard) => boolean;
}): Effect.fn.Return<
  ReadonlyArray<PlannedBoardEvent>,
  PlatformError.PlatformError,
  SecureRandom.SecureRandom
> {
  const events: PlannedBoardEvent[] = [];
  for (const dependent of input.cards) {
    if (dependent.archivedAt !== null) continue;
    if (!input.includes(dependent)) continue;
    const blocked = deriveBoardCardBlocked({
      board: input.board,
      stage: dependent.stage,
      dependsOn: boardCardInheritedDependsOn({ cards: input.cards }, dependent),
      cards: input.cards,
    });
    if (blocked === dependent.blocked) continue;
    const nextCard: BoardCard = {
      ...dependent,
      blocked,
      updatedAt: input.command.createdAt,
    };
    events.push({
      ...(yield* makeBoardEventBase({
        cardId: dependent.id,
        occurredAt: input.command.createdAt,
        commandId: input.command.commandId,
      })),
      type: "board.card-updated",
      payload: {
        cardId: dependent.id,
        card: nextCard,
      },
    });
  }
  return events;
});

/** Whether `ancestorId` is a strict ancestor of `card` within `cards`. */
const hasBoardAncestor = (
  board: BoardState,
  cards: ReadonlyArray<BoardCard>,
  card: BoardCard,
  ancestorId: BoardCardId,
): boolean =>
  card.id !== ancestorId && isBoardCardSelfOrAncestor({ ...board, cards }, card, ancestorId);

/**
 * Every key must name a stage the board has: a stale popover could otherwise
 * write an override no resolver ever reads. An emptied map normalises to `null` so
 * cleared and never-set stay indistinguishable (replay equals rehydration).
 */
const validateModelOverrides = Effect.fn("validateModelOverrides")(function* (input: {
  readonly board: BoardState;
  readonly command: BoardCardCommand;
  readonly proposed: BoardCardModelOverrides;
}) {
  const { board, command, proposed } = input;
  for (const stageId of Object.keys(proposed)) {
    if (!boardStages(board).some((stage) => stage.stageId === stageId)) {
      return yield* invariant(
        command,
        `Model override names stage '${stageId}', which does not exist on this board.`,
      );
    }
  }
  return isEmptyBoardCardModelOverrides(proposed) ? null : proposed;
});

/**
 * Shape only: the decider is pure and cannot ask git whether the branch exists.
 * Rejects the shapes that break silently downstream (`isBoardCardBaseBranchShape`),
 * such as an `origin/`-prefixed or `refs/`-qualified name.
 */
const validateBaseBranch = Effect.fn("validateBaseBranch")(function* (input: {
  readonly command: BoardCardCommand;
  readonly proposed: string;
}) {
  if (!isBoardCardBaseBranchShape(input.proposed)) {
    return yield* invariant(
      input.command,
      `Base branch '${input.proposed}' is not a local branch name; pass the local name (for example 'develop', never 'origin/develop' or 'refs/heads/develop').`,
    );
  }
  return input.proposed;
});

/**
 * The card's live plan-role step, or null (plan review). Plan review
 * only ever acts on this: a running step of the stage with the plan role.
 */
function livePlanReviewStep(board: BoardState, cardId: BoardCardId): BoardCardStepState | null {
  const state = boardCardStepState(board, cardId);
  const planStage = boardStageWithRole(board, "plan");
  if (state === null || planStage === null) return null;
  if (state.stepId !== planStage.stageId || isBoardTerminalStepStatus(state.status)) return null;
  return state;
}

/**
 * The plan step a card's own toggle may start a late review on, with
 * the state it starts from. A live step starts as it is; a paused one resumes,
 * as `resume-step` would; a step that settled `succeeded` with no review is
 * reopened on its thread. Failed or blocked steps belong to the recovery ladder.
 */
function latePlanReviewStep(
  board: BoardState,
  card: BoardCard,
  at: string,
): BoardCardStepState | null {
  const state = boardCardStepState(board, card.id);
  const planStage = boardStageWithRole(board, "plan");
  if (state === null || planStage === null) return null;
  if (state.stepId !== planStage.stageId || state.planReviewStartedAt !== undefined) return null;
  if (state.status !== "paused" && !isBoardTerminalStepStatus(state.status)) return state;
  // A settled planning step outlives the stage; only a card still there reopens.
  if (
    state.status !== "paused" &&
    (state.status !== "succeeded" || card.stage !== planStage.stageId)
  )
    return null;
  // Planning steps hold no slot, so a reopened one takes none.
  return reopenedPlanStep(state, at, state.status === "paused" && state.mode === "build");
}

/** A settled or paused plan step put back to running on its own thread. */
function reopenedPlanStep(
  state: BoardCardStepState,
  at: string,
  slotHeld = false,
): BoardCardStepState {
  return {
    ...state,
    status: "running",
    stallCount: 0,
    lastError: null,
    slotHeld,
    stalledReason: "gave-up",
    retryAt: null,
    lastNudgeAt: at,
  };
}

/** Start the plan review on the live plan step (plan review). */
const planReviewStartedEvent = Effect.fn("planReviewStartedEvent")(function* (input: {
  readonly command: BoardCardCommand;
  readonly state: BoardCardStepState;
  readonly rounds: number;
  /** Started by the card's toggle, after the plan was posted: the reactor
      sends the instructions, since no tool result will. */
  readonly turnedOnLate?: true;
}) {
  const event: PlannedBoardEvent = {
    ...(yield* makeBoardEventBase({
      cardId: input.command.cardId,
      occurredAt: input.command.createdAt,
      commandId: input.command.commandId,
    })),
    type: "board.plan-review-started",
    payload: {
      cardId: input.command.cardId,
      state: {
        ...input.state,
        planReviewStartedAt: input.command.createdAt,
        planReviewRounds: input.rounds,
        updatedAt: input.command.createdAt,
      },
      ...(input.turnedOnLate === undefined ? {} : { turnedOnLate: input.turnedOnLate }),
    },
  };
  return event;
});

/** The step with its plan review cleared (plan review). */
function clearedPlanReviewState(state: BoardCardStepState, at: string): BoardCardStepState {
  const { planReviewStartedAt: _startedAt, planReviewRounds: _rounds, ...rest } = state;
  return { ...rest, updatedAt: at };
}

/**
 * The client is not the guard. A round that has started (including one in flight)
 * can never be removed; raising the budget or requesting the next round clears a
 * pending stop; only the next round can be requested. A stop for a round already
 * past is rejected as a caller bug.
 */
const validateReviewOverrides = Effect.fn("validateReviewOverrides")(function* (input: {
  readonly board: BoardState;
  readonly command: BoardCardCommand;
  readonly card: BoardCard;
  readonly proposed: BoardCardReviewOverrides;
}) {
  const { board, command, card, proposed } = input;
  const stepState = boardCardStepState(board, card.id);
  const roundsStarted = boardReviewRoundsStarted({
    completions: boardCardStepCompletions(board, card.id),
    liveStepId:
      stepState === null || isBoardTerminalStepStatus(stepState.status) ? null : stepState.stepId,
  });

  if (proposed.rounds !== null && proposed.rounds < roundsStarted) {
    return yield* invariant(
      command,
      `Cannot set the review budget to ${proposed.rounds} round(s) for card '${card.id}': round ${roundsStarted} has already started and cannot be removed.`,
    );
  }

  // Clamped to one past the highest round started, so every extra round is one
  // deliberate click rather than a batch booked ahead.
  if (proposed.runThroughRound !== null && proposed.runThroughRound > roundsStarted + 1) {
    return yield* invariant(
      command,
      `Cannot ask card '${card.id}' to run through review round ${proposed.runThroughRound}: only round ${roundsStarted + 1} can be requested next.`,
    );
  }

  // A stop is cleared when the requested budget reaches past it AND the budget
  // moved. The pane's resume names an absolute round, so "bigger than last time" would
  // leave the stop in place; a stop set while the budget stays put is not a raise.
  const roundsChanged =
    proposed.rounds !== null && proposed.rounds !== (card.reviewOverrides?.rounds ?? null);
  const raisedRounds =
    roundsChanged &&
    proposed.rounds !== null &&
    (proposed.stopAfterRound === null || proposed.rounds > proposed.stopAfterRound);
  // A request to RUN round N outranks a stop at round N-1 or later: it is the more
  // recent decision by the same person.
  const requestedRound =
    proposed.runThroughRound !== null &&
    proposed.runThroughRound !== (card.reviewOverrides?.runThroughRound ?? null) &&
    (proposed.stopAfterRound === null || proposed.runThroughRound > proposed.stopAfterRound);
  const supersedesStop = raisedRounds || requestedRound;

  if (
    proposed.stopAfterRound !== null &&
    !supersedesStop &&
    proposed.stopAfterRound < roundsStarted
  ) {
    return yield* invariant(
      command,
      `Cannot stop card '${card.id}' after review round ${proposed.stopAfterRound}: the loop is already past it.`,
    );
  }

  const normalised: BoardCardReviewOverrides = {
    ...proposed,
    stopAfterRound: supersedesStop ? null : proposed.stopAfterRound,
  };
  return isEmptyBoardCardReviewOverrides(normalised) ? null : normalised;
});

/** Event base for label events: aggregates on the label. Separate
    from `makeBoardEventBase` rather than parametrised so the card call sites
    stay untouched. */
const makeBoardLabelEventBase = Effect.fn("makeBoardLabelEventBase")(function* (input: {
  readonly labelId: BoardLabelId;
  readonly occurredAt: string;
  readonly commandId: BoardCommand["commandId"];
}) {
  const crypto = yield* SecureRandom.SecureRandom;
  const eventId = yield* crypto.uuidV4();
  return {
    eventId: EventId.make(eventId),
    aggregateKind: "label" as const,
    aggregateId: input.labelId,
    occurredAt: input.occurredAt,
    commandId: input.commandId,
    causationEventId: null,
    correlationId: input.commandId,
    metadata: {},
  };
});

/** Whether a worker id names a worker this board has: `local`, or registered. */
function isKnownBoardWorker(board: BoardState, workerId: BoardWorkerId): boolean {
  return (
    workerId === BOARD_LOCAL_WORKER_ID ||
    (board.workers ?? []).some((worker) => worker.id === workerId)
  );
}

/** The pin a child takes from its parent: the parent's worker while the board
    still has it. An orphaned parent still points at its removed worker, and a
    child pinned there would wait for it unseen, so it follows the default. */
function inheritedBoardWorkerPin(
  board: BoardState,
  workerId: BoardWorkerId | null,
): BoardWorkerId | null {
  return workerId !== null && isKnownBoardWorker(board, workerId) ? workerId : null;
}

/** Event base for worker-registry events: aggregates on the worker. */
const makeBoardWorkerEventBase = Effect.fn("makeBoardWorkerEventBase")(function* (input: {
  readonly workerId: BoardWorkerId;
  readonly occurredAt: string;
  readonly commandId: BoardCommand["commandId"];
}) {
  const crypto = yield* SecureRandom.SecureRandom;
  const eventId = yield* crypto.uuidV4();
  return {
    eventId: EventId.make(eventId),
    aggregateKind: "worker" as const,
    aggregateId: input.workerId,
    occurredAt: input.occurredAt,
    commandId: input.commandId,
    causationEventId: null,
    correlationId: input.commandId,
    metadata: {},
  };
});

/** Event base for stage events: aggregates on the stage. */
const makeBoardStageEventBase = Effect.fn("makeBoardStageEventBase")(function* (input: {
  readonly stageId: BoardStageId;
  readonly occurredAt: string;
  readonly commandId: BoardCommand["commandId"];
}) {
  const crypto = yield* SecureRandom.SecureRandom;
  const eventId = yield* crypto.uuidV4();
  return {
    eventId: EventId.make(eventId),
    aggregateKind: "stage" as const,
    aggregateId: input.stageId,
    occurredAt: input.occurredAt,
    commandId: input.commandId,
    causationEventId: null,
    correlationId: input.commandId,
    metadata: {},
  };
});

/** Live (non-tombstoned) labels — the picker's view, and the set a name
    uniqueness check runs against. */
function liveBoardLabels(board: BoardState): ReadonlyArray<BoardLabel> {
  return boardLabelCatalogue(board).filter((label) => label.deletedAt === null);
}

/**
 * Dedupes, enforces `BOARD_CARD_LABELS_MAX`, and requires every id to be already
 * on the card or a live label: a card keeps a retired label it carried but cannot
 * ADD an unknown or tombstoned one. `existing` is the card's labels for a create.
 */
function validateCardLabels(input: {
  readonly board: BoardState;
  readonly command: BoardCommand;
  readonly proposed: ReadonlyArray<BoardLabelId>;
  readonly existing: ReadonlyArray<BoardLabelId>;
}): Effect.Effect<ReadonlyArray<BoardLabelId>, BoardCommandInvariantError> {
  const deduped = [...new Set(input.proposed)];
  if (deduped.length > BOARD_CARD_LABELS_MAX) {
    return Effect.fail(
      invariant(
        input.command,
        `A card may carry at most ${BOARD_CARD_LABELS_MAX} labels; ${deduped.length} were given.`,
      ),
    );
  }
  const existingSet = new Set(input.existing);
  const catalogue = boardLabelCatalogue(input.board);
  for (const labelId of deduped) {
    if (existingSet.has(labelId)) continue;
    const label = catalogue.find((candidate) => candidate.labelId === labelId);
    if (label === undefined) {
      return Effect.fail(invariant(input.command, `Label '${labelId}' does not exist.`));
    }
    if (label.deletedAt !== null) {
      return Effect.fail(
        invariant(input.command, `Label '${labelId}' is deleted and cannot be added.`),
      );
    }
  }
  return Effect.succeed(deduped);
}

/**
 * `labels` replaces the whole set; `addLabels`/`removeLabels` apply to the card as
 * it is when the update lands, so a label added in between is kept. The result goes
 * through `validateCardLabels` either way.
 */
function resolveCardUpdateLabels(input: {
  readonly board: BoardState;
  readonly card: BoardCard;
  readonly command: BoardCardUpdateCommand;
}): Effect.Effect<ReadonlyArray<BoardLabelId>, BoardCommandInvariantError> {
  const { board, card, command } = input;
  const incremental = command.addLabels !== undefined || command.removeLabels !== undefined;
  if (command.labels !== undefined && incremental) {
    return Effect.fail(
      invariant(
        command,
        "labels replaces the whole label set; pass it or addLabels/removeLabels, not both.",
      ),
    );
  }
  if (command.labels !== undefined) {
    return validateCardLabels({ board, command, proposed: command.labels, existing: card.labels });
  }
  if (!incremental) return Effect.succeed(card.labels);
  const adding = command.addLabels ?? [];
  const removing = new Set(command.removeLabels ?? []);
  const both = adding.find((id) => removing.has(id));
  if (both !== undefined) {
    const name = boardLabelCatalogue(board).find((label) => label.labelId === both)?.name ?? both;
    return Effect.fail(
      invariant(
        command,
        `Label '${name}' is both added and removed in one update; pass it to only one of them.`,
      ),
    );
  }
  const proposed = [...card.labels, ...adding].filter((id) => !removing.has(id));
  return validateCardLabels({ board, command, proposed, existing: card.labels });
}

/**
 * The card's review summary AFTER a completion lands. It rides the event because
 * `boardShellStreamEvent` sees one event, not the whole ledger. `undefined` for
 * non-review steps and for older events, which the projection recomputes.
 */
function reviewSummaryAfter(input: {
  readonly board: BoardState;
  readonly card: BoardCard;
  readonly completion: BoardStepCompletion;
}): BoardCardReviewSummary | undefined {
  if (parseReviewStepId(input.completion.stepId) === null) return undefined;
  return (
    deriveBoardCardReviewSummary({
      completions: [
        ...boardCardStepCompletions(input.board, input.card.id).filter(
          (recorded) => recorded.stepId !== input.completion.stepId,
        ),
        input.completion,
      ],
      ...reviewSummaryOverrideInputs(input.card.reviewOverrides),
    }) ?? undefined
  );
}

/** The override half of `deriveBoardCardReviewSummary`'s input, so every
    caller passes the carry fields as well as the review-loop ones. */
function reviewSummaryOverrideInputs(overrides: BoardCardReviewOverrides | null) {
  return {
    maxRounds: overrides?.rounds ?? null,
    stopAfterRound: overrides?.stopAfterRound ?? null,
    runThroughRound: overrides?.runThroughRound ?? null,
    carriedFindings: overrides?.carriedFindings ?? {},
    stuckWaivedThrough: overrides?.stuckWaivedThrough ?? null,
    roundModes: overrides?.roundModes ?? {},
  };
}

/** The card's review summary under the given overrides, or null with no
    review history. */
function boardCardReviewSummary(
  board: BoardState,
  cardId: BoardCardId,
  overrides: BoardCardReviewOverrides | null,
): BoardCardReviewSummary | null {
  return deriveBoardCardReviewSummary({
    completions: boardCardStepCompletions(board, cardId),
    ...reviewSummaryOverrideInputs(overrides),
  });
}

/** The round a card's review loop is stuck on, or null. */
function boardCardStuckReviewRound(board: BoardState, card: BoardCard): number | null {
  const summary = boardCardReviewSummary(board, card.id, card.reviewOverrides);
  return summary?.outcome === "stuck" ? summary.roundCurrent : null;
}

/**
 * The round modes after "Another review round": every round from the lowest with no succeeded
 * review through the requested one is full. A settling record on a round whose review failed
 * is overwritten too, or the executor would re-plan it settling on the way to the request.
 */
function forcedFullRoundModes(input: {
  readonly stored: Readonly<Record<string, BoardReviewRoundMode>>;
  readonly completions: ReadonlyArray<BoardStepCompletion>;
  readonly throughRound: number | null;
}): Record<string, BoardReviewRoundMode> {
  const next: Record<string, BoardReviewRoundMode> = { ...input.stored };
  if (input.throughRound === null) return next;
  const reviewed = new Set(
    input.completions
      .filter((completion) => completion.outcome === "succeeded")
      .map((completion) => completion.stepId),
  );
  let from = 1;
  while (reviewed.has(reviewStepId("review", from))) from += 1;
  for (let round = from; round <= input.throughRound; round++) {
    next[String(round)] = BOARD_REVIEW_FULL_ROUND;
  }
  return next;
}

/**
 * Keep the server-only carry fields through a client's override
 * write, whatever the client sent — including `reviewOverrides: null`. Only
 * `board.card.set-review-carry` writes them.
 */
function keepReviewCarry(
  next: BoardCardReviewOverrides | null,
  stored: BoardCardReviewOverrides | null,
): BoardCardReviewOverrides | null {
  const merged: BoardCardReviewOverrides = {
    ...(next ?? EMPTY_BOARD_CARD_REVIEW_OVERRIDES),
    carriedFindings: stored?.carriedFindings ?? {},
    stuckWaivedThrough: stored?.stuckWaivedThrough ?? null,
    roundModes: stored?.roundModes ?? {},
  };
  return isEmptyBoardCardReviewOverrides(merged) ? null : merged;
}

/**
 * State the engine loads before deciding. The brief body never rides the read
 * model, so an incremental brief edit gets it inside the engine's serial command
 * loop, where a read-change-write cannot interleave with another write.
 */
export interface BoardDecisionContext {
  /** The card's stored brief, or null when it has none. Loaded only when
      `boardCommandNeedsBrief` holds. */
  readonly brief?: string | null;
  /** Every project the environment knows, for the existence check a command
      naming a project makes. Loaded only when
      `boardCommandNeedsProjects` holds. */
  readonly projects?: ReadonlyArray<BoardProjectRef>;
  /** The thread a link or unlink names, or null when it does not exist.
      Loaded only when `boardCommandNeedsThread` holds. */
  readonly thread?: BoardThreadRef | null;
}

/** What the decider needs to know about a project: that it exists, and enough
    to name it back to a caller who got the id wrong. */
export interface BoardProjectRef {
  readonly id: ProjectId;
  readonly title: string;
  readonly deleted: boolean;
}

/** What the decider needs to know about a thread: whether it is deleted. */
export interface BoardThreadRef {
  readonly deleted: boolean;
}

/** Whether a command names a project the decider must check exists. */
export function boardCommandNeedsProjects(
  command: BoardCommand,
): command is Extract<BoardCommand, { type: "board.card.create" | "board.card.set-project" }> {
  return command.type === "board.card.create" || command.type === "board.card.set-project";
}

/** Whether a command names a thread the decider must check exists. */
export function boardCommandNeedsThread(
  command: BoardCommand,
): command is Extract<
  BoardCommand,
  { type: "board.card.link-thread" | "board.card.unlink-thread" | "board.card.retire-thread" }
> {
  return (
    command.type === "board.card.link-thread" ||
    command.type === "board.card.unlink-thread" ||
    command.type === "board.card.retire-thread"
  );
}

/**
 * The project a command names, or a refusal listing up to 10 live projects so a
 * caller that passed a title or folder name can correct the call.
 */
function requireBoardProject(input: {
  readonly command: BoardCommand;
  readonly context: BoardDecisionContext | undefined;
  readonly projectId: ProjectId;
}): Effect.Effect<BoardProjectRef, BoardCommandInvariantError> {
  const projects = input.context?.projects;
  if (projects === undefined) {
    return Effect.fail(
      invariant(input.command, "The project list was not loaded for this command; retry it."),
    );
  }
  const project = projects.find((candidate) => candidate.id === input.projectId);
  if (project !== undefined) return Effect.succeed(project);
  const live = projects.filter((candidate) => !candidate.deleted);
  const shown = live.slice(0, 10).map((candidate) => `${candidate.id} (${candidate.title})`);
  const available =
    shown.length === 0
      ? "(none)"
      : shown.join("; ") +
        (live.length > shown.length ? `; … and ${live.length - shown.length} more` : "");
  return Effect.fail(
    invariant(
      input.command,
      `Project '${input.projectId}' does not exist for command '${input.command.type}'. Available projects: ${available}.`,
    ),
  );
}

/** The stage a stage command names, or the refusal. */
function requireBoardStage(
  board: BoardState,
  command: Extract<BoardCommand, { readonly stageId: BoardStageId }>,
): Effect.Effect<BoardStageDefinition, BoardCommandInvariantError> {
  const stage = boardStageById(board, command.stageId);
  return stage === null
    ? Effect.fail(invariant(command, `Stage '${command.stageId}' does not exist.`))
    : Effect.succeed(stage);
}

/** Whether a command needs `BoardDecisionContext` loaded before it is decided:
    an update that edits the brief incrementally or guards it with a
    version. */
export function boardCommandNeedsBrief(command: BoardCommand): command is BoardCardUpdateCommand {
  return (
    command.type === "board.card.update" &&
    (command.briefAppend !== undefined ||
      command.briefSection !== undefined ||
      command.expectedBriefVersion !== undefined)
  );
}

/**
 * The brief and dependency set a `board.card.update` leaves behind, plus its
 * incremental edits for the Activity rail. Undefined means unchanged. Incremental
 * forms resolve against the card and loaded brief, so concurrent writes survive.
 */
const resolveCardUpdateEdits = Effect.fn("resolveCardUpdateEdits")(function* (input: {
  readonly board: BoardState;
  readonly card: BoardCard;
  readonly command: BoardCardUpdateCommand;
  readonly context: BoardDecisionContext | undefined;
}) {
  const { board, card, command } = input;

  const briefForms = [command.brief, command.briefAppend, command.briefSection].filter(
    (value) => value !== undefined,
  ).length;
  if (briefForms > 1) {
    return yield* invariant(
      command,
      "Pass only one of brief (replace), briefAppend and briefSection in one update.",
    );
  }
  if (command.expectedBriefVersion !== undefined && briefForms === 0) {
    return yield* invariant(
      command,
      "expectedBriefVersion guards a brief change; pass it with brief, briefAppend or briefSection.",
    );
  }
  const incrementalDeps =
    command.addDependsOn !== undefined || command.removeDependsOn !== undefined;
  if (command.dependsOn !== undefined && incrementalDeps) {
    return yield* invariant(
      command,
      "dependsOn replaces the whole dependency set; pass it or addDependsOn/removeDependsOn, not both.",
    );
  }

  let brief: string | null | undefined = command.brief;
  let briefEdit: "appended" | "section-replaced" | undefined;
  if (boardCommandNeedsBrief(command)) {
    if (input.context?.brief === undefined) {
      return yield* invariant(
        command,
        `The brief of card '${card.key}' was not loaded for this edit; retry the update.`,
      );
    }
    const current = input.context.brief;
    if (
      command.expectedBriefVersion !== undefined &&
      command.expectedBriefVersion !== boardBriefVersion(current)
    ) {
      return yield* invariant(
        command,
        `The brief of card '${card.key}' has changed since you read it (you expected version ${command.expectedBriefVersion}, it is now ${boardBriefVersion(current)}). Read the card again and reapply your change to the current brief.`,
      );
    }
    if (command.briefAppend !== undefined) {
      brief = appendToBrief(current, command.briefAppend);
      briefEdit = "appended";
    } else if (command.briefSection !== undefined) {
      if (briefHeadingLevel(command.briefSection.heading) === null) {
        return yield* invariant(
          command,
          `briefSection.heading must be a markdown heading line such as '## Notes from ${card.key}'; got '${command.briefSection.heading}'.`,
        );
      }
      const bodyBreak = briefSectionBodyBreak(
        command.briefSection.heading,
        command.briefSection.body,
      );
      if (bodyBreak !== null) {
        return yield* invariant(
          command,
          `briefSection.body contains the line '${bodyBreak}', which would end the section '${command.briefSection.heading.trim()}' early, so repeating the edit would duplicate everything after it. Use deeper headings (more #s) inside the section body, and leave out the section's end marker.`,
        );
      }
      // An unclosed fence hides every later heading, so the section would run
      // to the end of the brief and a repeat would delete what follows it.
      const bodyFence = briefUnclosedFence(command.briefSection.body);
      if (bodyFence !== null) {
        return yield* invariant(
          command,
          `briefSection.body opens a code fence ('${bodyFence}') that never closes; close it so the section's end can be found.`,
        );
      }
      const briefFence = briefUnclosedFence(current);
      if (briefFence !== null) {
        return yield* invariant(
          command,
          `The brief of card '${card.key}' opens a code fence ('${briefFence}') that never closes, so the section '${command.briefSection.heading.trim()}' has no reliable end. Use briefAppend, or fix the fence with a whole-brief replace first.`,
        );
      }
      brief = replaceBriefSection(current, command.briefSection.heading, command.briefSection.body);
      briefEdit = "section-replaced";
    }
  }

  // Duplicate edges add nothing to the graph; store each dependency once.
  let dependsOn: ReadonlyArray<BoardCardId> | undefined;
  let checkExistence: ReadonlyArray<BoardCardId> = [];
  if (command.dependsOn !== undefined) {
    dependsOn = [...new Set(command.dependsOn)];
    checkExistence = dependsOn;
  } else if (incrementalDeps) {
    const adding = command.addDependsOn ?? [];
    const removing = new Set(command.removeDependsOn ?? []);
    const both = adding.find((id) => removing.has(id));
    if (both !== undefined) {
      return yield* invariant(
        command,
        `Dependency '${both}' is both added and removed in one update; pass it to only one of them.`,
      );
    }
    // Only the ADDED ids must exist: an old edge to a since-deleted card is
    // the card's business, and must not block an unrelated add or remove.
    checkExistence = adding.filter((id) => !card.dependsOn.includes(id));
    dependsOn = [...new Set([...card.dependsOn, ...adding])].filter((id) => !removing.has(id));
  }
  if (dependsOn !== undefined) {
    for (const dependencyId of checkExistence) {
      const dependency = board.cards.find((candidate) => candidate.id === dependencyId);
      if (dependency === undefined) {
        return yield* invariant(command, `Dependency '${dependencyId}' does not exist.`);
      }
      // Only NEW edges are checked: an edge made before a rule must not
      // block re-saving the set it already sits in.
      if (card.dependsOn.includes(dependencyId)) continue;
      const treeRefusal = dependencyTreeRefusal({ board, dependent: card, dependency });
      if (treeRefusal !== null) return yield* invariant(command, treeRefusal);
    }
    // As above, only new edges can close a cycle the update is blamed for.
    const cycle = findDependencyCycle({
      board,
      cardId: command.cardId,
      proposed: dependsOn,
      added: dependsOn.filter((id) => !card.dependsOn.includes(id)),
    });
    if (cycle !== null) {
      return yield* invariant(
        command,
        `Dependency edge '${cycle.edgeFrom} -> ${cycle.edgeTo}' would create a cycle: ${cycle.path.join(" -> ")}.`,
      );
    }
  }

  const keyOf = (id: BoardCardId) =>
    board.cards.find((candidate) => candidate.id === id)?.key ?? id;
  const added =
    incrementalDeps && dependsOn !== undefined
      ? dependsOn.filter((id) => !card.dependsOn.includes(id)).map(keyOf)
      : [];
  const removed =
    incrementalDeps && dependsOn !== undefined
      ? card.dependsOn.filter((id) => !dependsOn.includes(id)).map(keyOf)
      : [];
  const edit: BoardCardEditSummary = {
    ...(briefEdit === undefined ? {} : { briefEdit }),
    ...(briefEdit === "section-replaced" && command.briefSection !== undefined
      ? { briefSection: command.briefSection.heading.trim() }
      : {}),
    ...(added.length === 0 ? {} : { dependenciesAdded: added }),
    ...(removed.length === 0 ? {} : { dependenciesRemoved: removed }),
  };

  return {
    brief,
    dependsOn,
    edit: Object.keys(edit).length === 0 ? undefined : edit,
  };
});

// ── Groups ───────────────────────────────────────────────

/** Ends a card's round of work: its pull request retires into the history
    and the floor rises over everything it has seen, so a merged link from a
    finished round can never authorise deleting the next round's branch. */
function retireBoardCardPullRequest(
  card: BoardCard,
): Pick<BoardCard, "pullRequest" | "pullRequestHistory" | "pullRequestFloor"> {
  const history =
    card.pullRequest === null
      ? card.pullRequestHistory
      : [...card.pullRequestHistory, card.pullRequest];
  return {
    pullRequest: null,
    pullRequestHistory: history,
    pullRequestFloor: history.reduce<BoardCard["pullRequestFloor"]>(
      (highest, entry) => (highest === null || entry.number > highest ? entry.number : highest),
      card.pullRequestFloor,
    ),
  };
}

/** Why `parent` cannot take a child, or null when it can. A leaf already
    being built has a branch of its own; turning it into a group would strand
    that work, so the shared-parent and cancel-work alternatives are offered
    instead (built by the integration card). */
function groupParentRefusal(board: BoardState, parent: BoardCard): string | null {
  if (isBoardCardStarted(board, parent) && !holdsOnlyIntegrationSlice(board, parent)) {
    return `Work has started on '${parent.key}', so it cannot become a group; put it and the new cards side by side under a new group instead.`;
  }
  return null;
}

/** An unbuilt leaf whose only branch is an integration branch it was given
    as a group and never checked out — what an own group reverts with. It may
    become a group again, or be deferred, without stranding any work. */
function holdsOnlyIntegrationSlice(board: BoardState, card: BoardCard): boolean {
  return card.worktree?.status === "branch-only" && !isBoardStageAtOrAfterBuild(board, card.stage);
}

/**
 * The own Automation toggles a backward move turns off: from Building or later back to before
 * it disarms Auto-build; back into Planning or earlier disarms Auto-plan. Only a toggle that is
 * effectively on is written off, so an inheriting card that was off stays inheriting.
 */
function backwardMoveDisarms(
  board: BoardState,
  card: BoardCard,
  toStage: BoardStageId,
): {
  readonly settings: Partial<Pick<BoardCard, "autoPlanSetting" | "autoBuildSetting">>;
  readonly changed: BoardAutomationChanged | null;
} {
  const from = boardStageIndex(board, card.stage);
  const to = boardStageIndex(board, toStage);
  if (from < 0 || to < 0 || to >= from || (card.group ?? null) !== null) {
    return { settings: {}, changed: null };
  }
  const resolved = resolveBoardCardAutomationIn({ board, card, boardWideAutoMerge: false });
  const plan = boardStageWithRole(board, "plan");
  const build = boardStageWithRole(board, "build");
  const planIndex = plan === null ? -1 : boardStageIndex(board, plan.stageId);
  const buildIndex = build === null ? -1 : boardStageIndex(board, build.stageId);
  const disarmBuild =
    buildIndex >= 0 && from >= buildIndex && to < buildIndex && resolved.autoBuild.value;
  const disarmPlan =
    planIndex >= 0 && from >= planIndex && to <= planIndex && resolved.autoPlan.value;
  if (!disarmBuild && !disarmPlan) return { settings: {}, changed: null };
  return {
    settings: {
      ...(disarmBuild ? { autoBuildSetting: false } : {}),
      ...(disarmPlan ? { autoPlanSetting: false } : {}),
    },
    changed: {
      ...(disarmBuild ? { autoBuild: true as const } : {}),
      ...(disarmPlan ? { autoPlan: true as const } : {}),
    },
  };
}

/** A group's settings after a human move of the group itself. */
function movedGroupSettings(input: {
  readonly board: BoardState;
  readonly group: BoardCardGroup;
  readonly card: BoardCard;
  readonly toStage: BoardStageId;
}): BoardCardGroup {
  const { board, card, toStage } = input;
  const done = boardStageWithRole(board, "done");
  // Leaving Done reopens the round; a stale `integrated` would snap it back.
  const group =
    done !== null && card.stage === done.stageId && toStage !== done.stageId
      ? { ...input.group, integrated: false }
      : input.group;
  if (isBoardDeferredStage(toStage)) return group;
  const build = boardStageWithRole(board, "build");
  if (build !== null && toStage === build.stageId) return { ...group, started: true };
  if (done !== null && toStage === done.stageId) return { ...group, integrated: true };
  if (!isBoardStageAtOrAfterBuild(board, toStage)) {
    // Placing the heading. Begun stays begun: only the group's
    // Auto-build switch stops its children starting.
    return { ...group, placed: toStage };
  }
  return group;
}

/** The events that turn a leaf into a group as it takes its first child. Any
    live planning step on it is abandoned by the reactor; its plans stay as a
    record. */
const groupConversionEvents = Effect.fn("groupConversionEvents")(function* (input: {
  readonly board: BoardState;
  readonly command: BoardCardCommand;
  readonly card: BoardCard;
}): Effect.fn.Return<
  ReadonlyArray<PlannedBoardEvent>,
  PlatformError.PlatformError,
  SecureRandom.SecureRandom
> {
  const { board, command, card } = input;
  // The leaf's resolved Auto-plan / Auto-build seed the group its children
  // inherit, and leave the card; its own Auto-merge stays, as the group's own
  // merge. Children landing on an ancestor's integration branch
  // merge with their auto-build, as migration 055 backfilled.
  const resolved = resolveBoardCardAutomationIn({ board, card, boardWideAutoMerge: false });
  const nextCard: BoardCard = {
    ...card,
    group: defaultBoardCardGroup(board, card, {
      autoPlan: resolved.autoPlan.value,
      autoBuild: resolved.autoBuild.value,
      autoMerge: resolved.autoBuild.value && boardCardMergesIntoIntegrationBranch(board, card),
    }),
    // Only leaves run, so a group has no priority (T3O-95).
    priority: "normal",
    autoPlanSetting: null,
    autoBuildSetting: null,
    updatedAt: command.createdAt,
  };
  return [
    {
      ...(yield* makeBoardEventBase({
        cardId: card.id,
        occurredAt: command.createdAt,
        commandId: command.commandId,
      })),
      type: "board.card-updated",
      payload: { cardId: card.id, card: nextCard, becameGroup: true },
    },
  ];
});

/** The order key a card takes when it lands under a new parent: next to the
    named sibling when it shares the card's column, else the column's arrival
    position. */
function regroupOrderKey(input: {
  readonly cards: ReadonlyArray<BoardCard>;
  readonly card: BoardCard;
  readonly stage: BoardStageId;
  readonly parentCardId: BoardCardId | null;
  readonly anchor: { readonly card: BoardCard; readonly side: "after" | "before" } | null;
  readonly doneStageId: BoardStageId | null;
}): string {
  const column = boardColumnOrderKeys({
    cards: input.cards.filter((candidate) => candidate.id !== input.card.id),
    stage: input.stage,
    parentCardId: input.parentCardId,
  }).toSorted();
  const anchor = input.anchor;
  if (anchor !== null && anchor.card.stage === input.stage) {
    const key = anchor.card.orderKey;
    const between =
      anchor.side === "after"
        ? boardOrderKeyBetween(key, column.find((candidate) => candidate > key) ?? null)
        : boardOrderKeyBetween(column.filter((candidate) => candidate < key).at(-1) ?? "", key);
    if (between !== null) return between;
  }
  return boardArrivalOrderKey({
    cards: input.cards.filter((candidate) => candidate.id !== input.card.id),
    stage: input.stage,
    parentCardId: input.parentCardId,
    doneStageId: input.doneStageId,
  });
}

/** The board as it stands once `planned` is applied — how a decision reads
    its own effects before deciding more. */
const projectPlannedBoardEvents = Effect.fn("projectPlannedBoardEvents")(function* (
  before: BoardState,
  command: BoardCommand,
  planned: ReadonlyArray<PlannedBoardEvent>,
): Effect.fn.Return<BoardState, BoardCommandInvariantError> {
  let model: BoardReadModel = { board: before };
  for (const event of planned) {
    model = yield* projectBoardEvent(model, { ...event, sequence: 0 } as BoardEvent).pipe(
      Effect.mapError((cause) =>
        invariant(command, `Failed to project the decision: ${String(cause)}`),
      ),
    );
  }
  return model.board ?? before;
});

/** Commands that can change a child's stage, parent, archive state or
    deferral — after each, every affected ancestor group is re-derived in the
    same decision. */
const GROUP_DERIVING_COMMANDS: ReadonlySet<BoardCommand["type"]> = new Set([
  "board.card.create",
  "board.card.move",
  "board.card.pipeline-move",
  "board.card.move-cards",
  "board.card.archive",
  "board.card.unarchive",
  "board.card.delete",
  "board.card.cancel-work",
  "board.plans.approve",
  "board.card.set-group-settings",
  "board.card.sync-groups",
]);

/**
 * Re-derive the groups a decision touched, deepest first so a parent sees its
 * child group's new stage. A group with no live child left reverts to a card unless
 * it is a heading. The card a human just moved by hand is left as they put it.
 */
const deriveGroupEvents = Effect.fn("deriveGroupEvents")(function* (input: {
  readonly before: BoardState;
  readonly command: BoardCardCommand;
  readonly planned: ReadonlyArray<PlannedBoardEvent>;
}): Effect.fn.Return<
  ReadonlyArray<PlannedBoardEvent>,
  BoardCommandInvariantError | PlatformError.PlatformError,
  SecureRandom.SecureRandom
> {
  const { before, command, planned } = input;
  const derivedFrom = yield* projectPlannedBoardEvents(before, command, planned);
  let board: BoardState = derivedFrom;
  const touched = new Set<BoardCardId>();
  for (const event of planned) {
    if (event.aggregateKind === "card") touched.add(event.aggregateId as BoardCardId);
  }
  if (command.type === "board.card.sync-groups") touched.add(command.cardId);
  const candidates = new Map<BoardCardId, number>();
  const addChain = (state: BoardState, id: BoardCardId) => {
    const card = state.cards.find((candidate) => candidate.id === id);
    if (card === undefined) return;
    const chain = boardCardAncestors(state, card);
    chain.forEach((ancestor, index) => {
      const depth = chain.length - index;
      candidates.set(ancestor.id, Math.max(candidates.get(ancestor.id) ?? 0, depth));
    });
  };
  for (const id of touched) {
    addChain(board, id);
    addChain(before, id);
  }
  if (
    command.type === "board.card.sync-groups" ||
    command.type === "board.card.set-group-settings"
  ) {
    candidates.set(command.cardId, Math.max(candidates.get(command.cardId) ?? 0, 1_000_000));
  }
  if (command.type === "board.card.move") candidates.delete(command.cardId);

  const doneStageId = boardStageWithRole(board, "done")?.stageId ?? null;
  const build = boardStageWithRole(board, "build");
  const laneFor = (card: BoardCard) =>
    build === null ? null : boardNextStageId(board, build.stageId, card.projectId);
  // A child moved into build by a human or the group cascade begins its parent
  // group; a child's own Auto-build start does not, so it never
  // starts its siblings.
  const begins =
    command.type === "board.card.move" &&
    command.cause !== "auto-build" &&
    build !== null &&
    command.toStage === build.stageId
      ? (board.cards.find((candidate) => candidate.id === command.cardId)?.parentCardId ?? null)
      : null;
  const events: Array<PlannedBoardEvent> = [];
  const ordered = [...candidates.entries()].toSorted((left, right) => right[1] - left[1]);
  for (const [cardId] of ordered) {
    const card = board.cards.find((candidate) => candidate.id === cardId);
    if (card === undefined || card.archivedAt !== null) continue;
    const group = boardCardGroupOf(board, card);
    if (group === null) continue;
    let next: BoardCard;
    if (boardCardLiveChildren(board, card.id).length === 0) {
      if (!boardGroupRevertsToCard(board, card, group)) continue;
      next = { ...card, group: null, stage: boardGroupRevertStage(board, card) };
    } else {
      const derived = deriveBoardGroupStage(board, card);
      const lane = laneFor(card);
      const laneIndex = lane === null ? -1 : boardStageIndex(board, lane);
      const reopened =
        group.integrated &&
        derived !== doneStageId &&
        (laneIndex < 0 || boardStageIndex(board, derived) < laneIndex);
      const reopenedGroup = reopened ? { ...group, integrated: false } : group;
      next = {
        ...card,
        stage: derived,
        group: begins === card.id ? { ...reopenedGroup, started: true } : reopenedGroup,
      };
    }
    const stageChanged = next.stage !== card.stage;
    const groupChanged = !boardCardGroupsEqual(next.group, card.group);
    // A legacy group is only written out alongside a real change.
    if (!stageChanged && (!groupChanged || card.group === null)) continue;
    // Leaving Done ends the group's round, exactly as a hand move does.
    const leavesDone =
      doneStageId !== null && card.stage === doneStageId && next.stage !== doneStageId;
    next = {
      ...next,
      ...(leavesDone && card.pullRequest !== null ? retireBoardCardPullRequest(card) : {}),
      orderKey:
        stageChanged && next.stage === doneStageId
          ? boardArrivalOrderKey({
              cards: board.cards,
              stage: next.stage,
              parentCardId: card.parentCardId,
              doneStageId,
            })
          : card.orderKey,
      blocked: deriveBoardCardBlocked({
        board,
        stage: next.stage,
        dependsOn: boardCardInheritedDependsOn(board, card),
        cards: board.cards,
      }),
      updatedAt: command.createdAt,
    };
    const base = yield* makeBoardEventBase({
      cardId: card.id,
      occurredAt: command.createdAt,
      commandId: command.commandId,
    });
    events.push(
      stageChanged
        ? {
            ...base,
            type: "board.card-moved",
            payload: { cardId: card.id, fromStage: card.stage, toStage: next.stage, card: next },
          }
        : { ...base, type: "board.card-updated", payload: { cardId: card.id, card: next } },
    );
    const crossesDone =
      doneStageId !== null && (card.stage === doneStageId) !== (next.stage === doneStageId);
    const cards = board.cards.map((c) => (c.id === card.id ? next : c));
    board = { ...derivedFrom, cards };
    if (crossesDone) {
      events.push(...(yield* boardDependentBlockedEvents({ board, command, changed: next })));
    }
  }
  return events;
});

const decideBoardCommandCore = Effect.fn("decideBoardCommandCore")(function* ({
  command,
  readModel,
  context,
}: {
  readonly command: BoardCommand;
  readonly readModel: BoardReadModel;
  /** Loaded by the engine before deciding: the brief, and the
      project and thread lookups that used to ride the v1 read model. */
  readonly context?: BoardDecisionContext;
}): Effect.fn.Return<
  // Archive and unarchive decide several events at once — the card's own,
  // plus a `blocked` re-flag per affected dependent. The engine
  // already appends an array inside one transaction, and each event carries
  // its own `aggregateId`, so a command may touch more than one card.
  BoardDecision,
  BoardCommandInvariantError | PlatformError.PlatformError,
  SecureRandom.SecureRandom
> {
  const board = readModel.board ?? EMPTY_BOARD_STATE;

  switch (command.type) {
    case "board.card.create": {
      yield* requireBoardProject({ command, context, projectId: command.projectId });
      if (board.cards.some((card) => card.id === command.cardId)) {
        return yield* invariant(command, `Card '${command.cardId}' already exists.`);
      }

      // A card may be created into any existing stage. A heading with no stage lands in
      // the project's first stage; a card with no stage joins a started parent group in
      // Planning.
      const createParent =
        command.parentCardId === undefined
          ? undefined
          : board.cards.find((existing) => existing.id === command.parentCardId);
      const stage =
        command.stage ??
        (command.heading === true
          ? boardProjectFirstStageId(board, command.projectId)
          : boardCreateDefaultStage(
              board,
              createParent !== undefined && boardCardGroupOf(board, createParent)?.started === true,
              command.projectId,
            ));
      // Deferred is a system stage outside the stage list, open only
      // inside a group.
      if (isBoardDeferredStage(stage)) {
        if (command.parentCardId === undefined) {
          return yield* invariant(
            command,
            `Only a card inside a group can be created in Deferred; a top-level card starts in Backlog.`,
          );
        }
      } else if (boardStageById(board, stage) === null) {
        return yield* invariant(command, `Stage '${stage}' does not exist.`);
      } else {
        // Only into a stage the card's project uses.
        const refusal = boardCardMoveRefusal(
          board,
          { stage, projectId: command.projectId },
          stage,
          { override: true },
        );
        if (refusal !== null) return yield* invariant(command, refusal);
      }

      const labels = yield* validateCardLabels({
        board,
        command,
        proposed: command.labels ?? [],
        existing: [],
      });
      if (command.externalRef !== undefined) {
        const refusal = externalRefTakenRefusal(board, command.externalRef, command.cardId);
        if (refusal !== null) return yield* invariant(command, refusal);
      }

      // Child create: any live card may take a child, at any
      // depth and across projects, unless it is a leaf already being built.
      // A leaf taking its first child becomes a group in the same decision.
      const parent = createParent;
      if (command.parentCardId !== undefined) {
        if (parent === undefined || parent.archivedAt !== null) {
          return yield* invariant(
            command,
            `Parent card '${command.parentCardId}' does not exist or is archived.`,
          );
        }
        const refusal = groupParentRefusal(board, parent);
        if (refusal !== null) return yield* invariant(command, refusal);
      }

      // Initial dependencies: dedupe and require each to exist. A
      // cycle is impossible at create — a brand-new card has no dependents, so
      // no existing edge can reach it — which is why create needs only the
      // existence check while `board.card.update` also gates cycles.
      const dependsOn = command.dependsOn === undefined ? [] : [...new Set(command.dependsOn)];
      for (const dependencyId of dependsOn) {
        const dependency = board.cards.find((existing) => existing.id === dependencyId);
        if (dependency === undefined) {
          return yield* invariant(command, `Dependency '${dependencyId}' does not exist.`);
        }
        // Dependencies may cross groups, but never run along the card's own
        // ancestry.
        const treeRefusal = dependencyTreeRefusal({
          board,
          dependent: {
            id: command.cardId,
            key: "the new card",
            parentCardId: command.parentCardId ?? null,
          },
          dependency,
        });
        if (treeRefusal !== null) return yield* invariant(command, treeRefusal);
      }

      // Dependency blocking is unconditional from the `build` role onward:
      // a card cannot be created directly into a build-or-later stage while it
      // has unmet dependencies, exactly as it cannot be moved there.
      if (isBoardStageAtOrAfterBuild(board, stage)) {
        const unmet = unmetBoardCardDependencies({
          board,
          dependsOn: boardCardInheritedDependsOn(board, {
            id: command.cardId,
            parentCardId: command.parentCardId ?? null,
            dependsOn,
          }),
          cards: board.cards,
        });
        if (unmet.length > 0) {
          return yield* invariant(
            command,
            `Card cannot be created in '${stage}' with unmet dependencies: ${unmet.join(", ")}.`,
          );
        }
      }

      // The per-card base branch. A sub-board child inherits its
      // parent's integration branch and never consults its own field, so a base
      // stored on one would be dead data no resolver reads — reject rather than
      // keep a read model that lies about what the card will branch from.
      const baseBranch =
        command.baseBranch === undefined
          ? null
          : command.parentCardId !== undefined
            ? yield* invariant(
                command,
                `Card '${command.cardId}' is a sub-board child of '${command.parentCardId}' and inherits that card's integration branch; it cannot set its own base branch.`,
              )
            : yield* validateBaseBranch({ command, proposed: command.baseBranch });

      // The worker pin: a registered worker, or absent to follow
      // the default. A hand-created child copies its parent's pin unless the
      // dialog picked one, exactly as a materialised child does.
      if (
        command.pinnedWorkerId !== undefined &&
        !isKnownBoardWorker(board, command.pinnedWorkerId)
      ) {
        return yield* invariant(command, `Worker '${command.pinnedWorkerId}' is not registered.`);
      }
      const pinnedWorkerId =
        command.pinnedWorkerId ??
        (command.parentCardId === undefined
          ? null
          : inheritedBoardWorkerPin(
              board,
              board.cards.find((existing) => existing.id === command.parentCardId)
                ?.pinnedWorkerId ?? null,
            ));

      const cardNumber = board.nextCardNumberByProject[command.projectId] ?? 1;
      const keyPrefix = command.keyPrefix ?? DEFAULT_BOARD_KEY_PREFIX;
      // Placed here rather than by the caller: a create dialog sees only its scoped slice,
      // not the whole column. A caller that names a key still means it.
      const orderKey =
        command.orderKey ??
        boardArrivalOrderKey({
          cards: board.cards,
          stage,
          parentCardId: command.parentCardId ?? null,
          doneStageId: boardStageWithRole(board, "done")?.stageId ?? null,
        });
      if (command.heading === true && command.priority !== undefined) {
        return yield* invariant(command, "A group has no priority; set it on its cards.");
      }
      // A heading is born a group and stays one while empty.
      const heading =
        command.heading === true
          ? defaultBoardCardGroup(board, { stage }, { heading: true })
          : null;
      if (parent !== undefined) {
        const refusal = boardGroupProjectRefusal(board, parent, [
          { key: command.title, projectId: command.projectId },
        ]);
        if (refusal !== null) return yield* invariant(command, refusal);
      }
      // The parent becoming a group is part of this decision: its first child
      // turns it from a leaf into a group.
      const becomesGroup =
        parent !== undefined && boardCardGroupOf(board, parent) === null
          ? yield* groupConversionEvents({ board, command, card: parent })
          : [];
      const created: PlannedBoardEvent = {
        ...(yield* makeBoardEventBase({
          cardId: command.cardId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        })),
        type: "board.card-created",
        payload: {
          cardId: command.cardId,
          projectId: command.projectId,
          title: command.title,
          key: `${keyPrefix}-${cardNumber}`,
          cardNumber,
          labels,
          // Body lives in `board_card_bodies`; omit the key when no brief
          // was given, matching the payload's key-optional shape.
          ...(command.brief === undefined ? {} : { brief: command.brief }),
          // A hand-created child carries its parent exactly as a
          // materialised one does; it just has no source plan.
          ...(command.parentCardId === undefined ? {} : { parentCardId: command.parentCardId }),
          // Key-optional like `brief`: absent IS "follow the project default",
          // which is what every pre-spec event decodes to.
          ...(baseBranch === null ? {} : { baseBranch }),
          // The scheduled start, key-optional for the same reason:
          // absent IS "start as soon as the pipeline reaches it". No validation
          // beyond the schema's instant — a PAST time is legal and means "now",
          // so there is nothing here to reject.
          ...(command.scheduledStartAt === undefined
            ? {}
            : { scheduledStartAt: command.scheduledStartAt }),
          // Key-optional like `baseBranch`: absent IS "follow the default".
          ...(pinnedWorkerId === null ? {} : { pinnedWorkerId }),
          ...(command.mergeStrategy === undefined ? {} : { mergeStrategy: command.mergeStrategy }),
          ...(command.priority === undefined || command.priority === "normal"
            ? {}
            : { priority: command.priority }),
          ...(command.externalRef === undefined ? {} : { externalRef: command.externalRef }),
          ...(heading === null ? {} : { group: heading }),
          dependsOn,
          stage,
          orderKey,
          createdAt: command.createdAt,
          updatedAt: command.createdAt,
        },
      };
      return becomesGroup.length === 0 ? created : [created, ...becomesGroup];
    }

    // Move a card to another project before it has ever been built.
    // The key is REISSUED against the target project's prefix and counter —
    // the card id never changes, so the open modal, its attachments (keyed by
    // card id), its labels, its brief and its dependencies all survive.
    case "board.card.set-project": {
      const card = yield* requireActiveBoardCard({ board, command });
      yield* requireBoardProject({ command, context, projectId: command.projectId });
      // Refused rather than treated as a no-op: an accepted no-op would still
      // emit an event, and that event would reissue the key for nothing.
      if (command.projectId === card.projectId) {
        return yield* invariant(
          command,
          `Card '${card.key}' is already in project '${command.projectId}'.`,
        );
      }
      const lock = boardCardProjectLock({
        board,
        card,
        childCount: boardCardChildren(board, card.id).length,
        integrationParentId: boardCardIntegrationAncestor(board, card)?.id ?? null,
      });
      switch (lock?.kind) {
        case "child":
          return yield* invariant(
            command,
            `Card '${card.key}' lands on the integration branch of '${lock.parentCardId}' and lives in that card's project; it cannot be moved on its own.`,
          );
        case "parent":
          return yield* invariant(
            command,
            `Card '${card.key}' cuts its own integration branch for ${lock.childCount} card${
              lock.childCount === 1 ? "" : "s"
            } in this project, so its project is pinned.`,
          );
        case "built":
          return yield* invariant(
            command,
            `Card '${card.key}' has already been built (it has a worktree, a pull request, or has reached the build stage), so its project is pinned.`,
          );
        case undefined:
          break;
      }
      // The target project must use the stage the card sits in, or the
      // card would land in a column that project's pipeline does not have.
      if (
        !isBoardDeferredStage(card.stage) &&
        !boardProjectStagesInOrder(board, command.projectId).some(
          (stage) => stage.stageId === card.stage && !stage.retired,
        )
      ) {
        const label = boardStageById(board, card.stage)?.label ?? card.stage;
        return yield* invariant(
          command,
          `That project doesn't use the ${label} stage; move '${card.key}' to a stage both projects use first.`,
        );
      }
      // Allocated exactly as `board.card.create` does, from the TARGET
      // project's counter, so a moved card and a newly created one draw from
      // one namespace.
      const cardNumber = board.nextCardNumberByProject[command.projectId] ?? 1;
      const keyPrefix = command.keyPrefix ?? DEFAULT_BOARD_KEY_PREFIX;
      const nextCard: BoardCard = {
        ...card,
        projectId: command.projectId,
        key: `${keyPrefix}-${cardNumber}`,
        cardNumber,
        // The pin does NOT survive. `release/2.0` almost certainly does
        // not exist in the new repository and would fail at
        // `ensureLocalBaseBranch` hours later at provisioning; `null` means
        // "follow this project's default", resolved live.
        baseBranch: null,
        updatedAt: command.createdAt,
      };
      // `orderKey` is untouched: the board merges every project into shared
      // stage columns, so the card keeps its place in the column it is in.
      return {
        ...(yield* makeBoardEventBase({
          cardId: command.cardId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        })),
        type: "board.card-project-changed",
        payload: {
          cardId: command.cardId,
          previousProjectId: card.projectId,
          previousKey: card.key,
          previousCardNumber: card.cardNumber,
          card: nextCard,
        },
      };
    }

    // The board's own move is decided exactly like a human's, less
    // CI's human move rules.
    case "board.card.pipeline-move":
    case "board.card.move": {
      const pipelineMove = command.type === "board.card.pipeline-move";
      const card = yield* requireActiveBoardCard({ board, command });
      if (command.toStage === card.stage) {
        return yield* invariant(
          command,
          `Card '${command.cardId}' is already in stage '${command.toStage}'.`,
        );
      }
      const toDeferred = isBoardDeferredStage(command.toStage);
      const fromDeferred = isBoardDeferredStage(card.stage);
      if (!toDeferred && boardStageById(board, command.toStage) === null) {
        return yield* invariant(command, `Stage '${command.toStage}' does not exist.`);
      }
      // A stage this card's project does not use is refused even with
      // override; the shared predicate is the drag layer's tooltip too.
      const projectRefusal = boardCardMoveRefusal(board, card, command.toStage, {
        override: true,
        pipeline: pipelineMove,
      });
      if (projectRefusal !== null) return yield* invariant(command, projectRefusal);
      // Deferred: a parking lot inside a group, just before the
      // first stage. Cards enter it from anywhere unstarted, and leave it for
      // any stage before build; further needs override, like any other skip.
      if (toDeferred) {
        if (card.parentCardId === null) {
          return yield* invariant(
            command,
            `Card '${card.key}' is not inside a group; only a group's cards can be deferred.`,
          );
        }
        if (isBoardCardStarted(board, card) && !holdsOnlyIntegrationSlice(board, card)) {
          return yield* invariant(
            command,
            `Work has started on '${card.key}'; let it finish, or archive it, rather than deferring it.`,
          );
        }
        const startedInside = boardCardLiveDescendants(board, card.id).find((descendant) =>
          isBoardCardStarted(board, descendant),
        );
        if (startedInside !== undefined) {
          return yield* invariant(
            command,
            `Work has started on '${startedInside.key}' inside '${card.key}'; let it finish, or archive it, rather than deferring the group.`,
          );
        }
      }
      // A group's own moves: its stage is derived from its children,
      // so a human move only places it before build, or starts it.
      const group = boardCardGroupOf(board, card);
      const buildStageForDeferred = boardStageWithRole(board, "build");
      const leavesDeferredBeforeBuild =
        fromDeferred &&
        (buildStageForDeferred === null ||
          boardStageIndex(board, command.toStage) <
            boardStageIndex(board, buildStageForDeferred.stageId));
      const adjacencyRefusal = boardCardMoveRefusal(board, card, command.toStage, {
        override: toDeferred || leavesDeferredBeforeBuild || command.override === true,
        pipeline: pipelineMove,
      });
      if (adjacencyRefusal !== null) return yield* invariant(command, adjacencyRefusal);
      // A split parent cannot pass the build-role stage while a child is unfinished: its
      // review describes the integration branch. Everything below that ceiling is free,
      // and a reactor regression back to build lands on the ceiling, not past it.
      {
        const unfinished = boardCardUnfinishedChildren(board, card.id);
        const buildStage = unfinished.length > 0 ? boardStageWithRole(board, "build") : null;
        if (buildStage !== null) {
          const buildIndex = boardStageIndex(board, buildStage.stageId);
          const targetIndex = boardStageIndex(board, command.toStage);
          if (buildIndex >= 0 && targetIndex > buildIndex) {
            return yield* invariant(
              command,
              `Card '${card.key}' advances through its ${unfinished.length} plan card${
                unfinished.length === 1 ? "" : "s"
              } (${unfinished
                .map((child) => child.key)
                .join(", ")}); it cannot pass '${buildStage.label}' until those finish.`,
            );
          }
        }
      }
      // An unapproved split holds the card at or before the plan-role stage. Backward
      // moves are free, and `override` does NOT bypass this. A board with no plan-role
      // stage pins the card where it sits.
      if (boardCardPendingSplit(board, command.cardId)) {
        const currentIndex = boardStageIndex(board, card.stage);
        const targetIndex = boardStageIndex(board, command.toStage);
        // Forward moves only. The ceiling is the plan-role stage CLAMPED below build,
        // because stage reordering may put the plan stage after build. The floor is
        // non-null whenever a card is pending.
        if (targetIndex > currentIndex) {
          const planStage = boardStageWithRole(board, "plan");
          const floor = boardSubBoardFloorStage(board);
          const floorIndex = floor === null ? currentIndex : boardStageIndex(board, floor.stageId);
          const ceiling =
            planStage === null
              ? currentIndex
              : Math.min(boardStageIndex(board, planStage.stageId), floorIndex);
          if (targetIndex > ceiling) {
            return yield* invariant(
              command,
              `Card '${card.key}' has ${boardCardPlans(board, command.cardId).length} unapproved plans; approve the split (or re-propose a single plan) before advancing it.`,
            );
          }
        }
      }
      // Dependency blocking applies on crossing into the build-role stage or anything
      // after it. Moves that stay on one side of that boundary stay open.
      if (
        !isBoardStageAtOrAfterBuild(board, card.stage) &&
        isBoardStageAtOrAfterBuild(board, command.toStage)
      ) {
        // A group's dependencies hold back every card inside it.
        const unmet = unmetBoardCardDependencies({
          board,
          dependsOn: boardCardInheritedDependsOn(board, card),
          cards: board.cards,
        });
        if (unmet.length > 0) {
          const names = formatUnmetDependencies(board, unmet);
          return yield* invariant(
            command,
            `Card '${card.key}' cannot enter '${command.toStage}' until ${
              unmet.length === 1 ? "its dependency is" : "its dependencies are"
            } done: ${names}.`,
          );
        }
      }

      // A stuck review loop leaves the review stage forward only by a
      // human's Advance, which takes responsibility for the code as it stands:
      // the waiver lands in this same event, so nothing re-plans in between.
      // Any other mover — an agent, automation, a worker — is refused.
      const fromStage = boardStageById(board, card.stage);
      const leavingReviewForward =
        fromStage !== null &&
        effectiveBoardStageRole(fromStage) === "review" &&
        !toDeferred &&
        boardStageIndex(board, command.toStage) > boardStageIndex(board, card.stage);
      const stuckRound = leavingReviewForward ? boardCardStuckReviewRound(board, card) : null;
      if (
        stuckRound !== null &&
        !(command.type === "board.card.move" && command.cause === "human")
      ) {
        return yield* invariant(
          command,
          `Review is stuck on card '${card.key}'; a human must Advance or resolve it.`,
        );
      }
      const advancedOverrides =
        stuckRound === null
          ? null
          : ({
              ...(card.reviewOverrides ?? EMPTY_BOARD_CARD_REVIEW_OVERRIDES),
              stuckWaivedThrough: Math.max(
                card.reviewOverrides?.stuckWaivedThrough ?? 0,
                stuckRound,
              ),
            } satisfies BoardCardReviewOverrides);

      const doneStageId = boardStageWithRole(board, "done")?.stageId ?? null;
      // LEAVING Done with a pull request starts the card's next round, on every path
      // (a reused worktree never re-provisions). Not gated on `merged`: the link is a
      // cache, and an irreversible branch deletion must not hang on a stale value. A
      // retired open pull request still shows via `boardCardDisplayPullRequest`.
      const startsNewRound =
        doneStageId !== null &&
        card.stage === doneStageId &&
        command.toStage !== doneStageId &&
        card.pullRequest !== null;
      // A card arriving in the done-role stage lands at the top (Done reads
      // newest-first) unless the mover named a position; elsewhere the card keeps its own
      // key. Same placement as a card created straight into Done.
      const nextOrderKey =
        command.orderKey ??
        (doneStageId !== null && command.toStage === doneStageId
          ? boardArrivalOrderKey({
              cards: board.cards,
              stage: doneStageId,
              parentCardId: card.parentCardId,
              doneStageId,
            })
          : card.orderKey);
      const disarmed = backwardMoveDisarms(board, card, command.toStage);
      const nextCard: BoardCard = {
        ...card,
        stage: command.toStage,
        orderKey: nextOrderKey,
        // Leaving planning spends an auto-plan request: the card can
        // be in planning only once per request, so any move ends it.
        ...endBoardCardAutoPlan(card, command.createdAt),
        ...disarmed.settings,
        group:
          group === null
            ? null
            : movedGroupSettings({ board, group, card, toStage: command.toStage }),
        blocked: deriveBoardCardBlocked({
          board,
          stage: command.toStage,
          dependsOn: boardCardInheritedDependsOn(board, card),
          cards: board.cards,
        }),
        ...(startsNewRound ? retireBoardCardPullRequest(card) : {}),
        // CI state belongs to the CI stage: a card leaving it carries
        // none, and one entering it starts clean.
        ...(card.stage === BOARD_SEED_STAGE_IDS.ci || command.toStage === BOARD_SEED_STAGE_IDS.ci
          ? { ci: null }
          : {}),
        ...(command.toStage === BOARD_SEED_STAGE_IDS.ci ? { ciLastOutcome: null } : {}),
        // A person moving the card starts its CI round trips again.
        ...(command.type === "board.card.move" && command.cause === "human"
          ? { ciRoundTrips: 0 }
          : {}),
        ...(advancedOverrides === null ? {} : { reviewOverrides: advancedOverrides }),
        updatedAt: command.createdAt,
      };
      const advancedSummary =
        advancedOverrides === null
          ? null
          : boardCardReviewSummary(board, command.cardId, advancedOverrides);
      const moved: PlannedBoardEvent = {
        ...(yield* makeBoardEventBase({
          cardId: command.cardId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        })),
        type: "board.card-moved",
        payload: {
          cardId: command.cardId,
          fromStage: card.stage,
          toStage: command.toStage,
          card: nextCard,
          ...(disarmed.changed === null ? {} : { automationChanged: disarmed.changed }),
          ...(advancedSummary === null ? {} : { reviewSummary: advancedSummary }),
        },
      };
      // A move across the done-role boundary changes what this card means as a
      // DEPENDENCY: dependents' stored `blocked` would otherwise
      // go stale — met on entering Done, unmet again on being dragged back out
      // — exactly the staleness the archive/unarchive paths already re-flag.
      const crossesDone =
        doneStageId !== null && (card.stage === doneStageId) !== (command.toStage === doneStageId);
      // A card leaving CI settles its unfinished pass here, the last place that
      // knows its run id: while a fix agent works there is no pass fiber to settle it.
      const leftCi: ReadonlyArray<PlannedBoardEvent> =
        card.stage === BOARD_SEED_STAGE_IDS.ci &&
        command.toStage !== BOARD_SEED_STAGE_IDS.ci &&
        card.ci !== null &&
        !isBoardCiPassSettledPhase(card.ci.phase)
          ? [
              {
                ...(yield* makeBoardEventBase({
                  cardId: command.cardId,
                  occurredAt: command.createdAt,
                  commandId: command.commandId,
                })),
                type: "board.card-ci-recorded",
                payload: {
                  cardId: command.cardId,
                  action: { kind: "finish-pass", runId: card.ci.runId, result: "cancelled" },
                  card: nextCard,
                  started: null,
                  settled: [
                    { runId: card.ci.runId, outcome: "cancelled", finishedAt: command.createdAt },
                  ],
                  activity: null,
                },
              },
            ]
          : [];
      return [
        moved,
        ...leftCi,
        ...(crossesDone
          ? yield* boardDependentBlockedEvents({ board, command, changed: nextCard })
          : []),
      ];
    }

    // The one regrouping primitive. Grouping alone never touches git;
    // the reactor sees ordinary card updates.
    case "board.card.move-cards": {
      if (command.cardIds.length === 0 || command.cardIds[0] !== command.cardId) {
        return yield* invariant(
          command,
          "move-cards needs at least one card, and `cardId` must be the first of `cardIds`.",
        );
      }
      const movers: Array<BoardCard> = [];
      for (const id of new Set(command.cardIds)) {
        const mover = board.cards.find((candidate) => candidate.id === id);
        if (mover === undefined || mover.archivedAt !== null) {
          return yield* invariant(command, `Card '${id}' does not exist or is archived.`);
        }
        movers.push(mover);
      }
      const parent =
        command.parentCardId === null
          ? null
          : (board.cards.find((candidate) => candidate.id === command.parentCardId) ?? null);
      if (command.parentCardId !== null && (parent === null || parent.archivedAt !== null)) {
        return yield* invariant(
          command,
          `Parent card '${command.parentCardId}' does not exist or is archived.`,
        );
      }
      if (parent !== null) {
        const inside = movers.find((mover) => isBoardCardSelfOrAncestor(board, parent, mover.id));
        if (inside !== undefined) {
          return yield* invariant(command, `Card '${inside.key}' can't move inside itself.`);
        }
        const refusal = groupParentRefusal(board, parent);
        if (refusal !== null) return yield* invariant(command, refusal);
      }
      // Ancestors first: a card whose ancestor also moves travels with it.
      const moverIds = new Set(movers.map((mover) => mover.id));
      const roots = movers.filter(
        (mover) => !boardCardAncestors(board, mover).some((ancestor) => moverIds.has(ancestor.id)),
      );
      const anchorId = command.afterCardId ?? command.beforeCardId;
      const anchorCard =
        anchorId === undefined
          ? undefined
          : board.cards.find((candidate) => candidate.id === anchorId);
      if (anchorId !== undefined) {
        if (
          anchorCard === undefined ||
          anchorCard.archivedAt !== null ||
          anchorCard.parentCardId !== command.parentCardId ||
          moverIds.has(anchorCard.id)
        ) {
          return yield* invariant(
            command,
            `Card '${anchorId}' is not a card under the destination to place next to.`,
          );
        }
      }

      const doneStageId = boardStageWithRole(board, "done")?.stageId ?? null;
      const nextParentGroup =
        parent === null
          ? null
          : (boardCardGroupOf(board, parent) ?? defaultBoardCardGroup(board, parent));
      let working: Array<BoardCard> = [...board.cards];
      const conversions =
        parent !== null && boardCardGroupOf(board, parent) === null
          ? yield* groupConversionEvents({ board, command, card: parent })
          : [];
      if (parent !== null && nextParentGroup !== null) {
        working = working.map((candidate) =>
          candidate.id === parent.id ? { ...candidate, group: nextParentGroup } : candidate,
        );
      }
      const moved: Array<BoardCard> = [];
      let anchor: { readonly card: BoardCard; readonly side: "after" | "before" } | null =
        anchorCard === undefined
          ? null
          : { card: anchorCard, side: command.afterCardId !== undefined ? "after" : "before" };
      for (const mover of command.beforeCardId !== undefined ? [...roots].reverse() : roots) {
        // A deferred card leaving every group lands in its project's first stage.
        const stage =
          parent === null && isBoardDeferredStage(mover.stage)
            ? boardProjectFirstStageId(board, mover.projectId)
            : mover.stage;
        const next: BoardCard = {
          ...mover,
          parentCardId: command.parentCardId,
          stage,
          orderKey: regroupOrderKey({
            cards: working,
            card: mover,
            stage,
            parentCardId: command.parentCardId,
            anchor,
            doneStageId,
          }),
          blocked: deriveBoardCardBlocked({
            board,
            stage,
            dependsOn: boardCardInheritedDependsOn(board, {
              ...mover,
              parentCardId: command.parentCardId,
            }),
            cards: board.cards,
          }),
          updatedAt: command.createdAt,
        };
        working = working.map((candidate) => (candidate.id === mover.id ? next : candidate));
        moved.push(next);
        if (anchor !== null && anchor.card.stage === stage)
          anchor = { side: anchor.side, card: next };
      }
      const after: BoardState = { ...board, cards: working };
      if (parent !== null) {
        const arriving = roots.flatMap((root) => [
          root,
          ...boardCardLiveDescendants(board, root.id),
        ]);
        const refusal = boardGroupProjectRefusal(
          after,
          after.cards.find((candidate) => candidate.id === parent.id)!,
          arriving,
        );
        if (refusal !== null) return yield* invariant(command, refusal);
      }

      // A started card's branch was cut from where it lands today; moving it
      // under a different integration branch would retarget work in flight.
      for (const mover of roots) {
        const affected = [mover, ...boardCardLiveDescendants(board, mover.id)];
        for (const card of affected) {
          if (!isBoardCardStarted(board, card)) continue;
          const landsBefore = boardCardIntegrationAncestor(board, card)?.id ?? null;
          const movedCard = after.cards.find((candidate) => candidate.id === card.id)!;
          const landsAfter = boardCardIntegrationAncestor(after, movedCard)?.id ?? null;
          if (landsBefore !== landsAfter) {
            const where = (id: BoardCardId | null) =>
              id === null
                ? "trunk"
                : `the integration branch of '${board.cards.find((c) => c.id === id)?.key ?? id}'`;
            return yield* invariant(
              command,
              `Can't move '${card.key}': it's built on ${where(landsBefore)}, and it would land on ${where(landsAfter)}. Rebase onto ${where(landsAfter)} first.`,
            );
          }
        }
      }
      // Dependencies may cross groups, but never along a card's own ancestry,
      // and never into a cycle through a group.
      const affectedIds = new Set<BoardCardId>(
        roots.flatMap((root) => [
          root.id,
          ...boardCardLiveDescendants(board, root.id).map((d) => d.id),
        ]),
      );
      for (const card of after.cards) {
        if (card.archivedAt !== null) continue;
        const involved =
          affectedIds.has(card.id) || card.dependsOn.some((id) => affectedIds.has(id));
        if (!involved) continue;
        for (const dependencyId of card.dependsOn) {
          const dependency = after.cards.find((candidate) => candidate.id === dependencyId);
          if (dependency === undefined) continue;
          const refusal = dependencyTreeRefusal({ board: after, dependent: card, dependency });
          if (refusal !== null) return yield* invariant(command, refusal);
        }
      }
      const cycle = findNewTreeDependencyCycle({
        before: board.cards,
        after: after.cards,
      });
      if (cycle !== null) {
        const keyOf = (id: BoardCardId) => after.cards.find((c) => c.id === id)?.key ?? id;
        return yield* invariant(
          command,
          `That regrouping would create a dependency cycle: ${cycle.map(keyOf).join(" -> ")}.`,
        );
      }

      const events: Array<PlannedBoardEvent> = [...conversions];
      for (const next of moved) {
        events.push({
          ...(yield* makeBoardEventBase({
            cardId: next.id,
            occurredAt: command.createdAt,
            commandId: command.commandId,
          })),
          type: "board.card-updated",
          payload: {
            cardId: next.id,
            card: next,
            // A same-parent reorder is not a regrouping; the group cascade
            // must not restart a sibling the human parked.
            ...(next.parentCardId ===
            board.cards.find((candidate) => candidate.id === next.id)?.parentCardId
              ? {}
              : { regrouped: true }),
          },
        });
      }
      // A moved group's cards now inherit their new ancestors' dependencies.
      const movedIds = new Set(moved.map((card) => card.id));
      events.push(
        ...(yield* boardReflagBlockedEvents({
          board: after,
          command,
          cards: after.cards,
          includes: (card) =>
            !movedIds.has(card.id) &&
            roots.some((root) => hasBoardAncestor(after, after.cards, card, root.id)),
        })),
      );
      return events;
    }

    case "board.card.set-group-settings": {
      const card = yield* requireActiveBoardCard({ board, command });
      const group = boardCardGroupOf(board, card);
      if (group === null) {
        return yield* invariant(command, `Card '${card.key}' is not a group.`);
      }
      if (command.target !== undefined && command.target !== group.target) {
        const locked = boardGroupTargetLockReason(board, card);
        if (locked !== null) return yield* invariant(command, locked);
      }
      // The reactor reads a non-own group holding a ready worktree as cancelled
      // work and deletes its branch with the checkout, so an own group in final
      // review must not shed its target while its integration worktree exists.
      if (
        command.target !== undefined &&
        command.target !== "own" &&
        group.target === "own" &&
        (card.worktree?.status === "ready" || card.worktree?.status === "provisioning")
      ) {
        return yield* invariant(
          command,
          `Can't stop '${card.key}' using its own branch while its integration worktree is still there; it can once that worktree is reclaimed.`,
        );
      }
      if (command.target === "own" && group.target !== "own") {
        const spans = boardGroupOwnTargetProjectRefusal(board, card);
        if (spans !== null) return yield* invariant(command, spans);
        const doneStage = boardStageWithRole(board, "done")?.stageId ?? null;
        const active = boardCardActiveChildren(board, card.id);
        if (active.length > 0 && active.every((child) => child.stage === doneStage)) {
          return yield* invariant(
            command,
            `Every card under '${card.key}' has already merged, so its own branch would have nothing to integrate.`,
          );
        }
        // A leaf whose work was cancelled to make it a parent still
        // holds that work's checkout until it is reclaimed; its branch must not
        // be mistaken for an integration branch.
        if (card.worktree?.status === "ready" || card.worktree?.status === "provisioning") {
          return yield* invariant(
            command,
            `Can't give '${card.key}' its own branch while the worktree of its cancelled work is still there; it can once that worktree is reclaimed.`,
          );
        }
      }
      // Own branch turns children's auto-merge on and Inherit turns it off —
      // only on a real target change, and only when this command
      // does not set auto-merge itself, so a full-settings save keeps a choice.
      const transitionMerge =
        command.autoMerge === undefined &&
        command.target !== undefined &&
        command.target !== group.target
          ? { autoMerge: command.target === "own" }
          : {};
      const nextGroup: BoardCardGroup = {
        ...group,
        ...(command.target === undefined ? {} : { target: command.target }),
        ...(command.autoBuild === undefined ? {} : { autoBuild: command.autoBuild }),
        ...(command.autoMerge === undefined ? {} : { autoMerge: command.autoMerge }),
        ...(command.autoPlan === undefined ? {} : { autoPlan: command.autoPlan }),
        ...transitionMerge,
      };
      if (boardCardGroupsEqual(nextGroup, card.group)) {
        return yield* invariant(command, `Group settings for '${card.key}' are unchanged.`);
      }
      const nextCard: BoardCard = { ...card, group: nextGroup, updatedAt: command.createdAt };
      return {
        ...(yield* makeBoardEventBase({
          cardId: card.id,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        })),
        type: "board.card-updated",
        payload: { cardId: card.id, card: nextCard, automationChanged: { group: true } },
      };
    }

    case "board.card.set-automation": {
      const card = yield* requireActiveBoardCard({ board, command });
      // Compare resolved values, so an inherit that picks up the group's "on"
      // is locked exactly like a true. The board-wide setting lives outside
      // the board state; its lock is the reactor's and the UI's to show.
      const turnedOn = boardAutomationTogglesTurnedOn({
        board,
        card,
        change: command,
        boardWideAutoMerge: false,
      });
      for (const { toggle, before } of turnedOn) {
        if (before.locked) {
          return yield* invariant(
            command,
            `Can't turn ${BOARD_AUTOMATION_TOGGLE_LABELS[toggle]} on for '${card.key}': ${before.lockReason ?? "it is locked."}`,
          );
        }
      }
      const nextSettings = {
        autoPlanSetting: command.autoPlan === undefined ? card.autoPlanSetting : command.autoPlan,
        autoBuildSetting:
          command.autoBuild === undefined ? card.autoBuildSetting : command.autoBuild,
        autoMergeSetting:
          command.autoMerge === undefined ? card.autoMergeSetting : command.autoMerge,
      };
      const changed: BoardAutomationChanged = {
        ...(nextSettings.autoPlanSetting === card.autoPlanSetting ? {} : { autoPlan: true }),
        ...(nextSettings.autoBuildSetting === card.autoBuildSetting ? {} : { autoBuild: true }),
        ...(nextSettings.autoMergeSetting === card.autoMergeSetting ? {} : { autoMerge: true }),
      };
      if (Object.keys(changed).length === 0) {
        return yield* invariant(command, `Automation for '${card.key}' is unchanged.`);
      }
      const mergeTurnedOff =
        changed.autoMerge === true &&
        !boardCardAutoMergeArmed({ board, card: { ...card, ...nextSettings } });
      const nextCard: BoardCard = {
        ...card,
        ...nextSettings,
        // A hold about a merge that is no longer going to happen is a stale label.
        autoMergeHold: mergeTurnedOff ? null : card.autoMergeHold,
        updatedAt: command.createdAt,
      };
      return {
        ...(yield* makeBoardEventBase({
          cardId: card.id,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        })),
        type: "board.card-updated",
        payload: { cardId: card.id, card: nextCard, automationChanged: changed },
      };
    }

    // The derivation itself runs in `decideBoardCommand` after this arm; the
    // command only names where to start.
    case "board.card.sync-groups": {
      yield* requireBoardCard({ board, command });
      return [];
    }

    case "board.card.reorder": {
      const card = yield* requireActiveBoardCard({ board, command });
      // A raced duplicate reorder re-emits the same state so the projection
      // is a no-op (mirrors thread.pin.reorder's keyUnchanged handling).
      const keyUnchanged = card.orderKey === command.orderKey;
      const nextCard: BoardCard = {
        ...card,
        orderKey: command.orderKey,
        updatedAt: keyUnchanged ? card.updatedAt : command.createdAt,
      };
      return {
        ...(yield* makeBoardEventBase({
          cardId: command.cardId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        })),
        type: "board.card-reordered",
        payload: {
          cardId: command.cardId,
          orderKey: command.orderKey,
          card: nextCard,
        },
      };
    }

    case "board.card.update": {
      const card = yield* requireActiveBoardCard({ board, command });
      if (
        command.title === undefined &&
        command.brief === undefined &&
        command.labels === undefined &&
        command.dependsOn === undefined &&
        command.externalRef === undefined &&
        command.humanInLoop === undefined &&
        command.reviewOverrides === undefined &&
        command.modelOverrides === undefined &&
        command.planReview === undefined &&
        command.baseBranch === undefined &&
        command.scheduledStartAt === undefined &&
        command.mergeStrategy === undefined &&
        command.priority === undefined &&
        command.briefAppend === undefined &&
        command.briefSection === undefined &&
        command.addDependsOn === undefined &&
        command.removeDependsOn === undefined &&
        command.addLabels === undefined &&
        command.removeLabels === undefined &&
        command.size === undefined
      ) {
        return yield* invariant(command, `Update for card '${command.cardId}' carries no changes.`);
      }

      if (command.priority !== undefined && card.group !== null) {
        return yield* invariant(
          command,
          `'${card.key}' is a group and has no priority; set it on its cards.`,
        );
      }
      const nextLabels = yield* resolveCardUpdateLabels({ board, card, command });
      // An unchanged reference re-sent is no new claim, even beside an older duplicate.
      if (
        command.externalRef !== undefined &&
        command.externalRef !== null &&
        (card.externalRef?.system !== command.externalRef.system ||
          card.externalRef.id !== command.externalRef.id)
      ) {
        const refusal = externalRefTakenRefusal(board, command.externalRef, card.id);
        if (refusal !== null) return yield* invariant(command, refusal);
      }

      // Brief and dependency edits, whole-value or incremental.
      const edits = yield* resolveCardUpdateEdits({ board, card, command, context });
      const proposedDependsOn = edits.dependsOn;

      // The review-loop overrides are validated and normalised before the card
      // is built, so an invalid budget rejects the whole
      // command rather than landing a half-applied edit.
      const reviewOverrides =
        command.reviewOverrides === undefined
          ? card.reviewOverrides
          : keepReviewCarry(
              command.reviewOverrides === null
                ? null
                : yield* validateReviewOverrides({
                    board,
                    command,
                    card,
                    proposed: command.reviewOverrides,
                  }),
              card.reviewOverrides,
            );

      // Validated before the card is built: an entry keyed by a stage the board does
      // not have is rejected outright. An emptied map normalises to null.
      const modelOverrides =
        command.modelOverrides === undefined
          ? card.modelOverrides
          : command.modelOverrides === null
            ? null
            : yield* validateModelOverrides({ board, command, proposed: command.modelOverrides });

      // The base branch. Rejected outright on a sub-board child,
      // which resolves its parent's integration branch whatever its own field
      // says — storing one would be a read model that lies about what the card
      // branches from. `null` clears the pin back to the project default.
      const baseBranch =
        command.baseBranch === undefined
          ? card.baseBranch
          : card.parentCardId !== null
            ? yield* invariant(
                command,
                `Card '${command.cardId}' is a sub-board child of '${card.parentCardId}' and inherits that card's integration branch; it cannot set its own base branch.`,
              )
            : command.baseBranch === null
              ? null
              : yield* validateBaseBranch({ command, proposed: command.baseBranch });

      const dependsOn = proposedDependsOn ?? card.dependsOn;

      // Plan review. Turning it off is always accepted and stops a
      // running review; changing its rounds mid-review tells the agent.
      const planReviewStep = livePlanReviewStep(board, card.id);
      const planReviewRunning =
        planReviewStep !== null && planReviewStep.planReviewStartedAt !== undefined;
      const changedPlanReviewRounds =
        planReviewRunning &&
        command.planReview != null &&
        command.planReview.enabled &&
        command.planReview.rounds !== planReviewStep.planReviewRounds
          ? command.planReview.rounds
          : null;
      // A null reset inherits a default the decider cannot see, so it could
      // stop the review with no stop event; the caller must say on or off.
      if (planReviewRunning && command.planReview === null) {
        return yield* invariant(
          command,
          `Card '${card.key}' is in a plan review; its setting cannot be reset to the default until it leaves Planning. Turn the review off to stop it.`,
        );
      }
      const planReview =
        command.planReview === undefined ? card.planReview : (command.planReview ?? undefined);
      const stopsPlanReview =
        planReviewRunning &&
        command.planReview?.enabled === false &&
        card.planReview?.enabled !== false;
      // Turned on after the plan was posted: nothing will propose again to
      // start it, so the update does, and the reactor sends the instructions.
      // Even after the step finished or was paused: the toggle is a
      // request for the review, so it reopens or resumes the step.
      const lateReviewStep =
        !planReviewRunning &&
        command.planReview?.enabled === true &&
        card.planReview?.enabled !== true &&
        boardCardPlans(board, card.id).length > 0 &&
        !boardCardChildren(board, card.id).some((child) => child.archivedAt === null)
          ? latePlanReviewStep(board, card, command.createdAt)
          : null;
      const { planReview: _priorPlanReview, ...cardWithoutPlanReview } = card;

      const mergeStrategy =
        command.mergeStrategy === undefined ? card.mergeStrategy : command.mergeStrategy;
      // A forge refusal of the old strategy is a permanent hold, so
      // picking another one must release it or an armed card stays parked.
      const mergeStrategyChanged = mergeStrategy !== card.mergeStrategy;

      const nextCard: BoardCard = {
        ...cardWithoutPlanReview,
        ...(planReview === undefined ? {} : { planReview }),
        title: command.title ?? card.title,
        labels: nextLabels,
        dependsOn,
        externalRef: command.externalRef === undefined ? card.externalRef : command.externalRef,
        briefRef:
          edits.brief === undefined
            ? card.briefRef
            : edits.brief === null
              ? null
              : BOARD_CARD_BRIEF_BODY_KIND,
        blocked:
          proposedDependsOn === undefined
            ? card.blocked
            : deriveBoardCardBlocked({
                board,
                stage: card.stage,
                dependsOn: boardCardInheritedDependsOn(board, { ...card, dependsOn }),
                cards: board.cards,
              }),
        humanInLoop: command.humanInLoop === undefined ? card.humanInLoop : command.humanInLoop,
        reviewOverrides,
        modelOverrides,
        baseBranch,
        // The scheduled start. Absent leaves it, `null` clears the
        // hold, an instant sets it. Nothing to validate: a past time is legal
        // and means "now", and the supervisor owns what setting one DOES to a
        // running step — the decider only records the intent.
        scheduledStartAt:
          command.scheduledStartAt === undefined ? card.scheduledStartAt : command.scheduledStartAt,
        autoMergeHold: mergeStrategyChanged ? null : card.autoMergeHold,
        mergeStrategy,
        // T3o: a size edit (T3O-86); null drops it, back to the planner's.
        resources:
          command.size === undefined
            ? card.resources
            : withBoardCardSizeEdit(
                card.resources,
                command.size === null
                  ? null
                  : { size: command.size, by: command.sizeEditor ?? "human" },
              ),
        priority: command.priority ?? card.priority,
        updatedAt: command.createdAt,
      };
      const updated: PlannedBoardEvent = {
        ...(yield* makeBoardEventBase({
          cardId: command.cardId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        })),
        type: "board.card-updated",
        payload: {
          cardId: command.cardId,
          ...(edits.brief === undefined ? {} : { brief: edits.brief }),
          card: nextCard,
          // Says the edit TOUCHED the schedule, not what it is — the card
          // already carries the value. The supervisor acts only on
          // an edit that named the field, so an unrelated edit to a parked card
          // never resumes it.
          ...(command.scheduledStartAt === undefined
            ? {}
            : { scheduledStartAt: command.scheduledStartAt }),
          // Says the edit TOUCHED the model overrides: the supervisor
          // restarts a provider-stalled step on Change model, and only then.
          ...(command.modelOverrides === undefined ? {} : { modelOverridesEdited: true as const }),
          // Says a strategy change RELEASED an auto-merge hold. That
          // hold was the retry, so the supervisor re-attempts the merge now;
          // a card that never held stays under the arrival rules.
          ...(mergeStrategyChanged && card.autoMergeHold !== null
            ? { autoMergeHoldReleased: true as const }
            : {}),
          ...(mergeStrategyChanged ? { mergeStrategyEdited: true as const } : {}),
          // Fold the review summary onto the event so an override edit updates the card
          // face live, only when the overrides moved and the card has review history.
          ...(command.reviewOverrides === undefined
            ? {}
            : (() => {
                const summary = boardCardReviewSummary(
                  board,
                  command.cardId,
                  nextCard.reviewOverrides,
                );
                return summary === null ? {} : { reviewSummary: summary };
              })()),
          ...(edits.edit === undefined ? {} : { edit: edits.edit }),
        },
      };
      const stopped: ReadonlyArray<PlannedBoardEvent> =
        stopsPlanReview && planReviewStep !== null
          ? [
              {
                ...(yield* makeBoardEventBase({
                  cardId: command.cardId,
                  occurredAt: command.createdAt,
                  commandId: command.commandId,
                })),
                type: "board.plan-review-stopped",
                payload: {
                  cardId: command.cardId,
                  stepId: planReviewStep.stepId,
                  threadId: planReviewStep.threadId,
                  state: clearedPlanReviewState(planReviewStep, command.createdAt),
                },
              },
            ]
          : lateReviewStep !== null && command.planReview != null
            ? [
                yield* planReviewStartedEvent({
                  command,
                  state: lateReviewStep,
                  rounds: command.planReview.rounds,
                  turnedOnLate: true,
                }),
              ]
            : changedPlanReviewRounds !== null && planReviewStep !== null
              ? [
                  {
                    ...(yield* makeBoardEventBase({
                      cardId: command.cardId,
                      occurredAt: command.createdAt,
                      commandId: command.commandId,
                    })),
                    type: "board.plan-review-rounds-changed",
                    payload: {
                      cardId: command.cardId,
                      state: {
                        ...planReviewStep,
                        planReviewRounds: changedPlanReviewRounds,
                        updatedAt: command.createdAt,
                      },
                    },
                  },
                ]
              : [];
      if (proposedDependsOn === undefined)
        return stopped.length === 0 ? updated : [updated, ...stopped];
      // A group's dependencies hold back every card inside it.
      const cards = board.cards.map((candidate) =>
        candidate.id === card.id ? nextCard : candidate,
      );
      return [
        updated,
        ...stopped,
        ...(yield* boardReflagBlockedEvents({
          board,
          command,
          cards,
          includes: (candidate) => hasBoardAncestor(board, cards, candidate, card.id),
        })),
      ];
    }

    case "board.card.link-thread": {
      const card = yield* requireActiveBoardCard({ board, command });
      const thread = context?.thread;
      if (thread === undefined || thread === null || thread.deleted) {
        return yield* invariant(
          command,
          `Thread '${command.threadId}' does not exist or is deleted and cannot be linked.`,
        );
      }
      // One thread, one card: a live or retired link anywhere — archived
      // cards included — owns the thread. Tombstoned links don't own anything
      // (their thread is deleted, which the existence check above rejects).
      const owner = board.cards.find((candidate) =>
        candidate.threadLinks.some(
          (link) => link.threadId === command.threadId && link.tombstonedAt === null,
        ),
      );
      // Relinking a thread this card retired brings it back in place.
      const retired =
        owner?.id === card.id
          ? card.threadLinks.find(
              (link) => link.threadId === command.threadId && link.retiredAt !== undefined,
            )
          : undefined;
      if (owner !== undefined && retired === undefined) {
        return yield* invariant(
          command,
          `Thread '${command.threadId}' is already linked to card '${owner.id}'.`,
        );
      }

      const linked = {
        threadId: command.threadId,
        role: command.role,
        linkedAt: command.createdAt,
        tombstonedAt: null,
        ...(command.workerId === undefined ? {} : { workerId: command.workerId }),
        round: card.pullRequestHistory.length,
      };
      const nextCard: BoardCard = {
        ...card,
        threadLinks: sortBoardCardThreadLinks(
          retired === undefined
            ? [...card.threadLinks, linked]
            : card.threadLinks.map((link) => (link === retired ? linked : link)),
        ),
        updatedAt: command.createdAt,
      };
      return {
        ...(yield* makeBoardEventBase({
          cardId: command.cardId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        })),
        type: "board.card-thread-linked",
        payload: {
          cardId: command.cardId,
          threadId: command.threadId,
          role: command.role,
          card: nextCard,
        },
      };
    }

    case "board.card.unlink-thread": {
      const card = yield* requireActiveBoardCard({ board, command });
      const link = card.threadLinks.find((candidate) => candidate.threadId === command.threadId);
      if (link === undefined) {
        return yield* invariant(
          command,
          `Thread '${command.threadId}' is not linked to card '${command.cardId}'.`,
        );
      }
      if (link.tombstonedAt !== null) {
        return yield* invariant(
          command,
          `Thread link '${command.threadId}' on card '${command.cardId}' is already tombstoned.`,
        );
      }

      // A deleted thread's link becomes a tombstone rather than vanishing:
      // a card whose triage thread was deleted must say so. Absent
      // counts as deleted — link-thread requires existence, so a linked
      // thread missing from the read model can only have been deleted.
      const thread = context?.thread;
      const threadDeleted = thread === undefined || thread === null || thread.deleted;
      const tombstonedAt = threadDeleted ? command.createdAt : null;
      const nextCard: BoardCard = {
        ...card,
        threadLinks: threadDeleted
          ? card.threadLinks.map((candidate) =>
              candidate.threadId === command.threadId ? { ...candidate, tombstonedAt } : candidate,
            )
          : card.threadLinks.filter((candidate) => candidate.threadId !== command.threadId),
        updatedAt: command.createdAt,
      };
      return {
        ...(yield* makeBoardEventBase({
          cardId: command.cardId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        })),
        type: "board.card-thread-unlinked",
        payload: {
          cardId: command.cardId,
          threadId: command.threadId,
          tombstonedAt,
          card: nextCard,
        },
      };
    }

    case "board.card.retire-thread": {
      const card = yield* requireActiveBoardCard({ board, command });
      const link = card.threadLinks.find((candidate) => candidate.threadId === command.threadId);
      if (link === undefined) {
        return yield* invariant(
          command,
          `Thread '${command.threadId}' is not linked to card '${command.cardId}'.`,
        );
      }
      if (link.tombstonedAt !== null || link.retiredAt !== undefined) {
        return yield* invariant(
          command,
          `Thread link '${command.threadId}' on card '${command.cardId}' is no longer live.`,
        );
      }
      // A deleted thread tombstones exactly as an unlink would.
      const thread = context?.thread;
      const threadDeleted = thread === undefined || thread === null || thread.deleted;
      const tombstonedAt = threadDeleted ? command.createdAt : null;
      const nextCard: BoardCard = {
        ...card,
        threadLinks: card.threadLinks.map((candidate) =>
          candidate.threadId !== command.threadId
            ? candidate
            : threadDeleted
              ? { ...candidate, tombstonedAt }
              : { ...candidate, retiredAt: command.createdAt },
        ),
        updatedAt: command.createdAt,
      };
      return {
        ...(yield* makeBoardEventBase({
          cardId: command.cardId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        })),
        type: "board.card-thread-unlinked",
        payload: {
          cardId: command.cardId,
          threadId: command.threadId,
          tombstonedAt,
          ...(threadDeleted ? {} : { retiredAt: command.createdAt }),
          card: nextCard,
        },
      };
    }

    case "board.card.attach": {
      // The RPC copied the file before dispatching (K2), so the decider only
      // guards the record: a live card, a free name, the per-card cap.
      const card = yield* requireActiveBoardCard({ board, command });
      if (card.attachments.length >= BOARD_CARD_ATTACHMENTS_MAX) {
        return yield* invariant(
          command,
          `Card '${card.key}' already has ${BOARD_CARD_ATTACHMENTS_MAX} attachments.`,
        );
      }
      // One attachment id, one card (the thread-link rule): the mirror table
      // keys on the id, so a second card holding it would relocate the row
      // and split the aggregate from the read model.
      const holder = board.cards.find((candidate) =>
        candidate.attachments.some((existing) => existing.id === command.attachment.id),
      );
      if (holder !== undefined) {
        return yield* invariant(
          command,
          `Attachment '${command.attachment.id}' is already on card '${holder.key}'.`,
        );
      }
      if (card.attachments.some((existing) => existing.name === command.attachment.name)) {
        return yield* invariant(
          command,
          `Card '${card.key}' already has an attachment named '${command.attachment.name}'.`,
        );
      }
      const nextCard: BoardCard = {
        ...card,
        attachments: sortBoardCardAttachments([...card.attachments, command.attachment]),
        updatedAt: command.createdAt,
      };
      return {
        ...(yield* makeBoardEventBase({
          cardId: command.cardId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        })),
        type: "board.card-attached",
        payload: { cardId: command.cardId, attachment: command.attachment, card: nextCard },
      };
    }

    case "board.card.detach": {
      const card = yield* requireActiveBoardCard({ board, command });
      const attachment = card.attachments.find(
        (candidate) => candidate.id === command.attachmentId,
      );
      if (attachment === undefined) {
        return yield* invariant(
          command,
          `Attachment '${command.attachmentId}' is not on card '${card.key}'.`,
        );
      }
      const nextCard: BoardCard = {
        ...card,
        attachments: card.attachments.filter((candidate) => candidate.id !== command.attachmentId),
        updatedAt: command.createdAt,
      };
      return {
        ...(yield* makeBoardEventBase({
          cardId: command.cardId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        })),
        type: "board.card-detached",
        payload: {
          cardId: command.cardId,
          attachmentId: command.attachmentId,
          attachment,
          card: nextCard,
        },
      };
    }

    case "board.card.archive": {
      const card = yield* requireBoardCard({ board, command });
      if (card.archivedAt !== null) {
        return yield* invariant(command, `Card '${command.cardId}' is already archived.`);
      }
      // A confirmed group archive (decision 14): the whole subtree,
      // for good.
      if (command.confirmCardKey !== undefined) {
        if (boardCardGroupOf(board, card) === null) {
          return yield* invariant(
            command,
            `Card '${card.key}' is not a group; archive it without a confirmation key.`,
          );
        }
        if (command.confirmCardKey !== card.key) {
          return yield* invariant(
            command,
            `The confirmation '${command.confirmCardKey}' does not match '${card.key}'; type the group's key to archive it.`,
          );
        }
        const subtree = [card, ...boardCardLiveDescendants(board, card.id)];
        const archivedIds = new Set(subtree.map((member) => member.id));
        let cards = board.cards.map((candidate) =>
          archivedIds.has(candidate.id)
            ? {
                ...candidate,
                archivedAt: command.createdAt,
                updatedAt: command.createdAt,
                worktree:
                  candidate.worktree === null
                    ? null
                    : { ...candidate.worktree, discardPending: true },
              }
            : candidate,
        );
        const events: Array<PlannedBoardEvent> = [];
        for (const member of subtree) {
          const nextCard = cards.find((candidate) => candidate.id === member.id)!;
          events.push({
            ...(yield* makeBoardEventBase({
              cardId: member.id,
              occurredAt: command.createdAt,
              commandId: command.commandId,
            })),
            type: "board.card-archived",
            payload: {
              cardId: member.id,
              archivedAt: command.createdAt,
              card: nextCard,
              discard: true,
            },
          });
        }
        for (const member of subtree) {
          const changed = cards.find((candidate) => candidate.id === member.id)!;
          const reflagged = yield* boardDependentBlockedEvents({
            board: { ...board, cards },
            command,
            changed,
          });
          for (const event of reflagged) {
            if (event.type !== "board.card-updated") continue;
            const next = event.payload.card;
            cards = cards.map((candidate) => (candidate.id === next.id ? next : candidate));
          }
          events.push(...reflagged);
        }
        return events;
      }
      // Archiving the supervisor of running work strands it. A
      // parent whose children are all done/archived archives normally.
      {
        const unfinished = boardCardUnfinishedChildren(board, card.id);
        if (unfinished.length > 0) {
          return yield* invariant(
            command,
            `Card '${card.key}' still has ${unfinished.length} unfinished plan card${
              unfinished.length === 1 ? "" : "s"
            } (${unfinished.map((child) => child.key).join(", ")}); finish or archive those first. To archive the whole group, have an agent call board_archive_card with its key confirmed.`,
          );
        }
      }
      const nextCard: BoardCard = {
        ...card,
        archivedAt: command.createdAt,
        updatedAt: command.createdAt,
      };
      // Dependencies survive the archive — nothing rewrites `dependsOn`
      // — but they stop gating, so dependents that were waiting on this card
      // unblock in the same commit.
      const archived: PlannedBoardEvent = {
        ...(yield* makeBoardEventBase({
          cardId: command.cardId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        })),
        type: "board.card-archived",
        payload: {
          cardId: command.cardId,
          archivedAt: command.createdAt,
          card: nextCard,
        },
      };
      return [
        archived,
        ...(yield* boardDependentBlockedEvents({ board, command, changed: nextCard })),
      ];
    }

    case "board.card.unarchive": {
      const card = yield* requireBoardCard({ board, command });
      if (card.archivedAt === null) {
        return yield* invariant(command, `Card '${command.cardId}' is not archived.`);
      }
      // A group archived with its subtree comes back with it: every
      // descendant archived in that same instant. Cards, plans and history
      // return; the discarded branch work does not.
      const restoring: Array<BoardCard> = [card];
      {
        const walk = (parentId: BoardCardId) => {
          for (const child of board.cards) {
            if (child.parentCardId !== parentId || child.archivedAt !== card.archivedAt) continue;
            if (restoring.some((seen) => seen.id === child.id)) continue;
            restoring.push(child);
            walk(child.id);
          }
        };
        walk(card.id);
      }
      const restoredIds = new Set(restoring.map((member) => member.id));
      // The parent may have moved on while the card sat in the archive. One
      // that is gone, archived, or a started leaf cannot take it back, so it
      // returns to the top level; an unstarted leaf becomes a group again,
      // exactly as if the card had been indented into it.
      const formerParent =
        card.parentCardId === null
          ? null
          : (board.cards.find((candidate) => candidate.id === card.parentCardId) ?? null);
      const parentIsGroup = formerParent !== null && boardCardGroupOf(board, formerParent) !== null;
      const firstStage = boardProjectFirstStageId(board, card.projectId);
      const restoreCards = (detach: boolean) =>
        board.cards.map((candidate) => {
          if (!restoredIds.has(candidate.id)) {
            if (!detach && !parentIsGroup && candidate.id === formerParent?.id) {
              return {
                ...candidate,
                group: defaultBoardCardGroup(board, candidate),
                priority: "normal" as const,
              };
            }
            return candidate;
          }
          // A discard the group archive had not finished is called off: the
          // card is back, and its branch is live work again.
          const worktree = withoutPendingDiscard(candidate.worktree);
          if (candidate.id === card.id && detach) {
            return {
              ...candidate,
              worktree,
              archivedAt: null,
              parentCardId: null,
              stage: isBoardDeferredStage(candidate.stage) ? firstStage : candidate.stage,
            };
          }
          return { ...candidate, worktree, archivedAt: null };
        });
      // Dependencies taken on the card while it sat in the archive may now
      // wait on the group it would rejoin; it returns to the top level instead
      // of deadlocking both, and a cycle the detach cannot break is refused.
      let detach =
        card.parentCardId !== null &&
        (formerParent === null ||
          formerParent.archivedAt !== null ||
          (!parentIsGroup && groupParentRefusal(board, formerParent) !== null));
      if (!detach && card.parentCardId !== null) {
        detach =
          findNewTreeDependencyCycle({ before: board.cards, after: restoreCards(false) }) !== null;
      }
      const unarchivedCards = restoreCards(detach);
      const cycle = findNewTreeDependencyCycle({ before: board.cards, after: unarchivedCards });
      if (cycle !== null) {
        const keyOf = (id: BoardCardId) => board.cards.find((c) => c.id === id)?.key ?? id;
        return yield* invariant(
          command,
          `Restoring '${card.key}' would create a dependency cycle: ${cycle.map(keyOf).join(" -> ")}.`,
        );
      }
      const conversions =
        formerParent !== null && !detach && !parentIsGroup
          ? yield* groupConversionEvents({ board, command, card: formerParent })
          : [];
      let cards = unarchivedCards.map((candidate) =>
        restoredIds.has(candidate.id)
          ? {
              ...candidate,
              // Dependencies may have finished while the card sat in the
              // archive; restore with a fresh derivation rather than the
              // stale flag.
              blocked: deriveBoardCardBlocked({
                board: { ...board, cards: unarchivedCards },
                stage: candidate.stage,
                dependsOn: boardCardInheritedDependsOn({ cards: unarchivedCards }, candidate),
                cards: unarchivedCards,
              }),
              updatedAt: command.createdAt,
            }
          : candidate,
      );
      const events: Array<PlannedBoardEvent> = [...conversions];
      for (const member of restoring) {
        const nextCard = cards.find((candidate) => candidate.id === member.id)!;
        events.push({
          ...(yield* makeBoardEventBase({
            cardId: member.id,
            occurredAt: command.createdAt,
            commandId: command.commandId,
          })),
          type: "board.card-unarchived",
          payload: { cardId: member.id, card: nextCard },
        });
      }
      // Restoring re-arms the gate the archive released: dependents
      // that these cards block again are re-flagged alongside them.
      for (const member of restoring) {
        const changed = cards.find((candidate) => candidate.id === member.id)!;
        const reflagged = yield* boardDependentBlockedEvents({
          board: { ...board, cards },
          command,
          changed,
        });
        for (const event of reflagged) {
          if (event.type !== "board.card-updated") continue;
          const next = event.payload.card;
          cards = cards.map((candidate) => (candidate.id === next.id ? next : candidate));
        }
        events.push(...reflagged);
      }
      return events;
    }

    case "board.card.cancel-work": {
      const card = yield* requireActiveBoardCard({ board, command });
      if (command.confirmCardKey !== card.key) {
        return yield* invariant(
          command,
          `The confirmation '${command.confirmCardKey}' does not match '${card.key}'; type the card's key to cancel its work.`,
        );
      }
      if (!isBoardCardStarted(board, card)) {
        return yield* invariant(
          command,
          `Work has not started on '${card.key}', so there is nothing to cancel; give it children directly.`,
        );
      }
      if (card.stage === boardStageWithRole(board, "done")?.stageId) {
        return yield* invariant(
          command,
          `'${card.key}' is Done and its work has merged, so there is nothing to cancel; use a shared parent instead.`,
        );
      }
      const capped = boardGroupRevertStage(board, {
        stage: card.stage,
        group: null,
        projectId: card.projectId,
      });
      const nextCard: BoardCard = {
        ...card,
        stage: capped,
        // A heading: it stays a group while the human moves cards into it.
        group: defaultBoardCardGroup(
          board,
          { stage: capped },
          { heading: true, prevStage: capped },
        ),
        priority: "normal",
        ...retireBoardCardPullRequest(card),
        autoPlanSetting: null,
        autoBuildSetting: null,
        autoMergeSetting: null,
        autoMergeHold: null,
        scheduledStartAt: null,
        blocked: deriveBoardCardBlocked({
          board,
          stage: capped,
          dependsOn: boardCardInheritedDependsOn(board, card),
          cards: board.cards,
        }),
        updatedAt: command.createdAt,
      };
      // An update, not a move: only an explicit move emits `card-moved`, and
      // the stage rides the whole card the projection upserts.
      return {
        ...(yield* makeBoardEventBase({
          cardId: card.id,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        })),
        type: "board.card-updated",
        payload: { cardId: card.id, card: nextCard, workCancelled: true },
      };
    }

    case "board.card.delete": {
      // Archived cards delete too (the archive sheet is where "never coming
      // back" gets decided), so this requires existence, not activity.
      const card = yield* requireBoardCard({ board, command });
      // A parent deletes only after its children are gone:
      // cascading N cards, branches and worktrees off one confirm is the
      // destructive surprise the dialog exists to prevent, and each child
      // delete already rewrites sibling edges and reclaims its own state.
      {
        const children = boardCardChildren(board, card.id);
        if (children.length > 0) {
          return yield* invariant(
            command,
            `Card '${card.key}' has ${children.length} materialised plan card${
              children.length === 1 ? "" : "s"
            } (${children.map((child) => child.key).join(", ")}); delete those first.`,
          );
        }
      }
      // The card is about to leave `board.cards`, so every derivation below is
      // computed against the board WITHOUT it — the same list the projector
      // and a from-empty replay will see.
      const remaining = board.cards.filter((candidate) => candidate.id !== command.cardId);
      const deleted: PlannedBoardEvent = {
        ...(yield* makeBoardEventBase({
          cardId: command.cardId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        })),
        type: "board.card-deleted",
        payload: {
          cardId: command.cardId,
          deletedAt: command.createdAt,
          card,
          threadIds: boardCardDeletableThreadIds(card),
          stepState: boardCardStepState(board, command.cardId),
        },
      };
      // Edges to the deleted card are REWRITTEN, not left dangling:
      // `unmetBoardCardDependencies` counts an unresolvable id as unmet forever, which
      // would block every dependent permanently.
      const rewritten = remaining.map((candidate) =>
        candidate.dependsOn.includes(command.cardId)
          ? { ...candidate, dependsOn: candidate.dependsOn.filter((id) => id !== command.cardId) }
          : candidate,
      );
      const edgeHolders = remaining.filter((candidate) =>
        candidate.dependsOn.includes(command.cardId),
      );
      const edited: Array<PlannedBoardEvent> = [];
      for (const dependent of edgeHolders) {
        const rewrittenCard = rewritten.find((candidate) => candidate.id === dependent.id)!;
        const nextCard: BoardCard = {
          ...rewrittenCard,
          blocked: deriveBoardCardBlocked({
            board,
            stage: dependent.stage,
            dependsOn: boardCardInheritedDependsOn({ cards: rewritten }, rewrittenCard),
            cards: remaining,
          }),
          updatedAt: command.createdAt,
        };
        edited.push({
          ...(yield* makeBoardEventBase({
            cardId: dependent.id,
            occurredAt: command.createdAt,
            commandId: command.commandId,
          })),
          type: "board.card-updated",
          payload: {
            cardId: dependent.id,
            card: nextCard,
          },
        });
      }
      // Cards inside a group that held the edge lose it too.
      edited.push(
        ...(yield* boardReflagBlockedEvents({
          board,
          command,
          cards: rewritten,
          includes: (candidate) =>
            !edgeHolders.some((holder) => holder.id === candidate.id) &&
            edgeHolders.some((holder) => hasBoardAncestor(board, rewritten, candidate, holder.id)),
        })),
      );
      // The edits ride FIRST: each upserts a dependent computed without the deleted
      // card, which is only correct before or after the removal, on live and replay alike.
      return [...edited, deleted];
    }

    case "board.label.create": {
      if (boardLabelCatalogue(board).some((label) => label.labelId === command.labelId)) {
        return yield* invariant(command, `Label '${command.labelId}' already exists.`);
      }
      // Case-insensitive uniqueness against LIVE labels — the prototype's
      // picker treats the catalogue as case-insensitively unique.
      const nameKey = command.name.toLowerCase();
      if (liveBoardLabels(board).some((label) => label.name.toLowerCase() === nameKey)) {
        return yield* invariant(command, `A label named '${command.name}' already exists.`);
      }
      const colour =
        command.colour ??
        pickNextBoardLabelColour(liveBoardLabels(board).map((label) => label.colour));
      const label: BoardLabel = {
        labelId: command.labelId,
        name: command.name,
        colour,
        deletedAt: null,
        createdAt: command.createdAt,
        updatedAt: command.createdAt,
      };
      return {
        ...(yield* makeBoardLabelEventBase({
          labelId: command.labelId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        })),
        type: "board.label-created",
        payload: { labelId: command.labelId, label },
      };
    }

    case "board.label.update": {
      const label = boardLabelCatalogue(board).find(
        (candidate) => candidate.labelId === command.labelId,
      );
      if (label === undefined) {
        return yield* invariant(command, `Label '${command.labelId}' does not exist.`);
      }
      // A tombstoned label is inert; restore it first (board.label.undelete) so
      // undelete's name-collision gate stays the single guard on a name re-entering.
      if (label.deletedAt !== null) {
        return yield* invariant(
          command,
          `Label '${command.labelId}' is deleted; restore it before editing.`,
        );
      }
      if (command.name === undefined && command.colour === undefined) {
        return yield* invariant(
          command,
          `Update for label '${command.labelId}' carries no changes.`,
        );
      }
      if (command.name !== undefined) {
        const nameKey = command.name.toLowerCase();
        const collision = liveBoardLabels(board).some(
          (candidate) =>
            candidate.labelId !== command.labelId && candidate.name.toLowerCase() === nameKey,
        );
        if (collision) {
          return yield* invariant(command, `A label named '${command.name}' already exists.`);
        }
      }
      const nextLabel: BoardLabel = {
        ...label,
        name: command.name ?? label.name,
        colour: command.colour ?? label.colour,
        updatedAt: command.createdAt,
      };
      return {
        ...(yield* makeBoardLabelEventBase({
          labelId: command.labelId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        })),
        type: "board.label-updated",
        payload: { labelId: command.labelId, label: nextLabel },
      };
    }

    case "board.label.delete": {
      const label = boardLabelCatalogue(board).find(
        (candidate) => candidate.labelId === command.labelId,
      );
      if (label === undefined) {
        return yield* invariant(command, `Label '${command.labelId}' does not exist.`);
      }
      if (label.deletedAt !== null) {
        return yield* invariant(command, `Label '${command.labelId}' is already deleted.`);
      }
      const nextLabel: BoardLabel = {
        ...label,
        deletedAt: command.createdAt,
        updatedAt: command.createdAt,
      };
      return {
        ...(yield* makeBoardLabelEventBase({
          labelId: command.labelId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        })),
        type: "board.label-deleted",
        payload: { labelId: command.labelId, deletedAt: command.createdAt, label: nextLabel },
      };
    }

    case "board.label.undelete": {
      const label = boardLabelCatalogue(board).find(
        (candidate) => candidate.labelId === command.labelId,
      );
      if (label === undefined) {
        return yield* invariant(command, `Label '${command.labelId}' does not exist.`);
      }
      if (label.deletedAt === null) {
        return yield* invariant(command, `Label '${command.labelId}' is not deleted.`);
      }
      // Undelete cannot resurrect into a name collision with a live label.
      const nameKey = label.name.toLowerCase();
      const collision = liveBoardLabels(board).some(
        (candidate) =>
          candidate.labelId !== command.labelId && candidate.name.toLowerCase() === nameKey,
      );
      if (collision) {
        return yield* invariant(
          command,
          `Cannot restore label '${label.name}': a live label with that name already exists.`,
        );
      }
      const nextLabel: BoardLabel = {
        ...label,
        deletedAt: null,
        updatedAt: command.createdAt,
      };
      return {
        ...(yield* makeBoardLabelEventBase({
          labelId: command.labelId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        })),
        type: "board.label-undeleted",
        payload: { labelId: command.labelId, label: nextLabel },
      };
    }

    // ── Stage aggregate ───────────────────────────────

    case "board.stage.create": {
      if (boardStageById(board, command.stageId) !== null) {
        return yield* invariant(command, `Stage '${command.stageId}' already exists.`);
      }
      const stage: BoardStageDefinition = {
        stageId: command.stageId,
        label: command.label,
        role: command.role ?? null,
        orderKey: command.orderKey,
        createdAt: command.createdAt,
        updatedAt: command.createdAt,
        // A stage made for one project is off for every other.
        projectId: command.forProjectId ?? null,
        defaultForProjects: command.forProjectId === undefined,
      };
      // A new role-holder would break "exactly one stage per role"; the four
      // roles are seeded and never created.
      if (stage.role !== null && boardStageWithRole(board, stage.role) !== null) {
        return yield* invariant(
          command,
          `A '${stage.role}' stage already exists; roles are unique.`,
        );
      }
      const violation = boardStageOrderViolation([...boardStages(board), stage]);
      if (violation !== null) {
        return yield* invariant(command, `Cannot create stage here: ${violation}.`);
      }
      const created = {
        ...(yield* makeBoardStageEventBase({
          stageId: command.stageId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        })),
        type: "board.stage-created" as const,
        payload: { stageId: command.stageId, stage },
      };
      if (command.forProjectId === undefined) return created;
      return [created, yield* switchOnForProject(board, command, command.forProjectId, stage)];
    }

    case "board.stage.set-default-for-projects": {
      const stage = yield* requireBoardStage(board, command);
      if (stage.stageId === BOARD_SEED_STAGE_IDS.ci || !isBoardStageSwitchable(board, stage)) {
        return yield* invariant(
          command,
          stage.stageId === BOARD_SEED_STAGE_IDS.ci
            ? "Continuous integration is on only for projects with CI steps; switch it per project."
            : `${stage.label} is on for every project.`,
        );
      }
      return {
        ...(yield* makeBoardStageEventBase({
          stageId: command.stageId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        })),
        type: "board.stage-updated",
        payload: {
          stageId: command.stageId,
          stage: { ...stage, defaultForProjects: command.on, updatedAt: command.createdAt },
        },
      };
    }

    case "board.stage.rename": {
      const stage = yield* requireBoardStage(board, command);
      const nextStage: BoardStageDefinition = {
        ...stage,
        label: command.label,
        updatedAt: command.createdAt,
      };
      return {
        ...(yield* makeBoardStageEventBase({
          stageId: command.stageId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        })),
        type: "board.stage-renamed",
        payload: { stageId: command.stageId, stage: nextStage },
      };
    }

    case "board.stage.reorder": {
      const stage = yield* requireBoardStage(board, command);
      const nextStage: BoardStageDefinition = {
        ...stage,
        orderKey: command.orderKey,
        updatedAt: command.createdAt,
      };
      const nextStages = boardStages(board).map((candidate) =>
        candidate.stageId === command.stageId ? nextStage : candidate,
      );
      const violation = boardStageOrderViolation(nextStages);
      if (violation !== null) {
        return yield* invariant(command, `Cannot reorder stage: ${violation}.`);
      }
      // `blocked` is re-derived only at a card move, so refuse a reorder that changes
      // any stage's at-or-after-build status, including every stage moving the build
      // stage itself flips.
      const buildStage = boardStageWithRole(board, "build");
      if (buildStage !== null) {
        const nextBoard: BoardState = { ...board, stages: nextStages };
        for (const candidate of boardStages(board)) {
          const wasAtOrAfter = isBoardStageAtOrAfterBuild(board, candidate.stageId);
          const willBeAtOrAfter = isBoardStageAtOrAfterBuild(nextBoard, candidate.stageId);
          if (wasAtOrAfter === willBeAtOrAfter) continue;
          const held = board.cards.filter((card) => card.stage === candidate.stageId).length;
          if (held > 0) {
            const moved = candidate.stageId === command.stageId;
            return yield* invariant(
              command,
              moved
                ? `Cannot move stage '${stage.label}' across the Build boundary while it holds ${held} card${held === 1 ? "" : "s"}.`
                : `Cannot move stage '${stage.label}' across the Build boundary: it would leave ${held} card${held === 1 ? "" : "s"} in '${candidate.label}' with a stale blocked flag.`,
            );
          }
        }
      }
      return {
        ...(yield* makeBoardStageEventBase({
          stageId: command.stageId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        })),
        type: "board.stage-reordered",
        payload: { stageId: command.stageId, stage: nextStage },
      };
    }

    case "board.stage.delete": {
      const stage = yield* requireBoardStage(board, command);
      // Effective role (not the raw field): a legacy stage list carries
      // Planning with a null role, and the plan pipeline must not lose its
      // stage on such a board.
      const heldRole = effectiveBoardStageRole(stage);
      if (heldRole !== null) {
        return yield* invariant(
          command,
          `Stage '${stage.label}' holds the '${heldRole}' role and cannot be deleted.`,
        );
      }
      if (stage.stageId === BOARD_SEED_STAGE_IDS.ci) {
        return yield* invariant(
          command,
          "Continuous integration can't be removed; switch it off per project instead.",
        );
      }
      // Refused if the stage holds ANY card, archived included. The error
      // names the count; the archive view is how the user clears them.
      const held = board.cards.filter((card) => card.stage === command.stageId).length;
      if (held > 0) {
        return yield* invariant(
          command,
          `Stage '${stage.label}' still holds ${held} card${held === 1 ? "" : "s"} (archived included); move them out first.`,
        );
      }
      const deleted = {
        ...(yield* makeBoardStageEventBase({
          stageId: command.stageId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        })),
        type: "board.stage-deleted" as const,
        payload: { stageId: command.stageId },
      };
      // No project's delta keeps a switch or override for it.
      return [deleted, ...(yield* pruneDeletedStage(board, command, command.stageId))];
    }

    case "board.card.record-ci": {
      const card = yield* requireBoardCard({ board, command });
      const decided = decideBoardCiRecord(card, command);
      if (!decided.ok) return yield* invariant(command, decided.refusal);
      return {
        ...(yield* makeBoardEventBase({
          cardId: command.cardId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        })),
        type: "board.card-ci-recorded",
        payload: { cardId: command.cardId, action: command.action, ...decided.payload },
      };
    }

    case "board.card.complete-step": {
      const card = yield* requireActiveBoardCard({ board, command });
      const existing = boardCardStepCompletions(board, command.cardId).find(
        (completion) => completion.stepId === command.stepId,
      );
      const current = boardCardStepState(board, command.cardId);
      const liveMatch =
        current !== null &&
        current.stepId === command.stepId &&
        !isBoardTerminalStepStatus(current.status);
      // A planning thread the card kept when it left Planning unfinished
      // may still record its own step: its interview runs on after the
      // move, and a finished plan must not read as unfinished on re-entry.
      const keptMatch = isKeptStepThread(board, card, command.stepId, command.threadId);
      const recordable = liveMatch || keptMatch;
      // The stepId must be the card's live step or an already-recorded
      // completion (an idempotent retry). Step ids are predictable, so without
      // this an agent could pre-complete a FUTURE step and the pinned record
      // would make `continueStage` / boot reconcile skip it as already-ran.
      if (existing === undefined && !recordable) {
        return yield* invariant(
          command,
          `Step '${command.stepId}' is not card '${command.cardId}''s live step${
            current === null ? "" : ` ('${current.stepId}', ${current.status})`
          } and has no recorded completion; complete the step you were assigned.`,
        );
      }
      // A `succeeded` completion is pinned: a retry re-emits it. A `failed`/`blocked`
      // completion is superseded while the same step is live again, so a successful retry
      // replaces the failure. A late plan review reopening a settled step also supersedes.
      // With no live step, the recorded outcome re-emits verbatim.
      const supersede =
        (existing !== undefined && existing.outcome !== "succeeded" && recordable) ||
        (command.outcome === "succeeded" &&
          liveMatch &&
          boardCompletionReopened(existing, current));
      // A `succeeded` record with an unreadable payload is not pinned: pinning it
      // deadlocks the review loop. A valid completion may replace it whether or not the
      // step is live again; a `failed` replacement is how the pane's reopen clears it.
      const repairsDefect =
        existing !== undefined &&
        existing.outcome === "succeeded" &&
        boardStepPayloadDefect({ stepId: existing.stepId, payload: existing.payload }) !== null &&
        (command.outcome !== "succeeded" ||
          boardStepPayloadDefect({ stepId: command.stepId, payload: command.payload }) === null);
      const replaces = supersede || repairsDefect;
      const completion: BoardStepCompletion =
        existing !== undefined && !replaces
          ? existing
          : {
              cardId: command.cardId,
              stepId: command.stepId,
              outcome: command.outcome,
              summary: command.summary,
              payload: command.payload,
              threadId: command.threadId,
              completedAt: command.createdAt,
            };
      // Plan review: the first succeeded completion of the live plan
      // step, with review on and not yet started, starts the review instead of
      // completing. The tool tells the agent to run it and call again.
      // Idempotent re-emits, kept threads and other outcomes are never gated.
      const recordsNew = existing === undefined || replaces;
      const reviewStep =
        command.outcome === "succeeded" && liveMatch && recordsNew
          ? livePlanReviewStep(board, command.cardId)
          : null;
      if (
        reviewStep !== null &&
        command.planReview?.enabled === true &&
        reviewStep.planReviewStartedAt === undefined &&
        boardCardPlans(board, command.cardId).length > 0
      ) {
        return yield* planReviewStartedEvent({
          command,
          state: reviewStep,
          rounds: command.planReview.rounds,
        });
      }
      const planReviewFinished =
        reviewStep !== null &&
        reviewStep.planReviewStartedAt !== undefined &&
        reviewStep.planReviewRounds !== undefined
          ? {
              rounds: reviewStep.planReviewRounds,
              ...readBoardPlanReviewReport(command.payload),
            }
          : undefined;
      const reviewSummary = reviewSummaryAfter({ board, card, completion });
      return {
        ...(yield* makeBoardEventBase({
          cardId: command.cardId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        })),
        type: "board.card-step-completed",
        payload: {
          cardId: command.cardId,
          completion,
          ...(reviewSummary === undefined ? {} : { reviewSummary }),
          // The reactor ignores a completion whose step already settled — right
          // for an idempotent retry, wrong for a repair, because the record the
          // stage executor reads just changed.
          ...(repairsDefect ? { repaired: true } : {}),
          ...(planReviewFinished === undefined ? {} : { planReviewFinished }),
        },
      };
    }

    case "board.card.reopen-step": {
      // The human's way out of a `succeeded` step with an unreadable payload: supersede
      // it with a `failed` record, and the executor (which counts only `succeeded`)
      // plans the round again.
      const card = yield* requireActiveBoardCard({ board, command });
      const existing = boardCardStepCompletions(board, command.cardId).find(
        (recorded) => recorded.stepId === command.stepId,
      );
      if (existing === undefined) {
        return yield* invariant(
          command,
          `Step '${command.stepId}' has no recorded completion on card '${command.cardId}' to reopen.`,
        );
      }
      // Reopening repairs only a `succeeded` completion with an unreadable payload. It
      // never re-runs landed work or rewrites a failure. Defects exist only for phases
      // that declare a payload shape, which confines this to the review loop.
      const defect = boardStepPayloadDefect({
        stepId: existing.stepId,
        payload: existing.payload,
      });
      if (existing.outcome !== "succeeded") {
        return yield* invariant(
          command,
          `Step '${command.stepId}' recorded '${existing.outcome}', not a success, so there is nothing to repair; the recovery ladder re-runs a step that did not succeed.`,
        );
      }
      if (defect === null) {
        return yield* invariant(
          command,
          `Step '${command.stepId}' completed with a payload the board can read, so there is nothing to repair.`,
        );
      }
      const completion: BoardStepCompletion = {
        cardId: command.cardId,
        stepId: command.stepId,
        outcome: "failed",
        // The recorded summary is the corrupted half of the same call, so it is
        // replaced rather than kept: what matters to whoever reads the ledger
        // next is that this step produced nothing usable and was sent back.
        summary: "Reopened: the recorded payload could not be read, so this step runs again.",
        payload: null,
        // Keeps whose run it was. The step is re-planned, not re-assigned.
        threadId: existing.threadId,
        completedAt: command.createdAt,
      };
      const reviewSummary = reviewSummaryAfter({ board, card, completion });
      return {
        ...(yield* makeBoardEventBase({
          cardId: command.cardId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        })),
        type: "board.card-step-completed",
        payload: {
          cardId: command.cardId,
          completion,
          ...(reviewSummary === undefined ? {} : { reviewSummary }),
          // Same reason as a repaired completion: the settled step's record
          // changed, so the reactor must re-ask the executor what runs next.
          repaired: true,
        },
      };
    }

    case "board.plans.propose": {
      const proposalCard = yield* requireActiveBoardCard({ board, command });
      // An approved split freezes the plans while any child is LIVE; a fully archived
      // round may re-plan. Distinct from `locked` (the file handover, below).
      if (boardCardChildren(board, command.cardId).some((child) => child.archivedAt === null)) {
        return yield* invariant(
          command,
          `Card '${command.cardId}' has materialised child cards; the plans are frozen. Work happens on the child cards now.`,
        );
      }
      // A locked plan means the card's plans are materialised to .plans/ at
      // Building entry; re-proposing over them would silently drop the
      // handover, so it is refused as a whole (edit the files).
      if (boardCardPlans(board, command.cardId).some((plan) => plan.locked)) {
        return yield* invariant(
          command,
          `Card '${command.cardId}' has locked (materialised) plans; edit the .plans/ files instead of re-proposing.`,
        );
      }
      // Validate the proposal is self-consistent BEFORE writing anything:
      // unique keys, every dependency references a plan in the proposal, and
      // no cycles — the offending edge is named (strictly better than
      // frontmatter, which only breaks later).
      const keys = command.plans.map((plan) => plan.key);
      const duplicateKey = keys.find((key, index) => keys.indexOf(key) !== index);
      if (duplicateKey !== undefined) {
        return yield* invariant(command, `Duplicate plan key '${duplicateKey}' in the proposal.`);
      }
      const keySet = new Set(keys);
      for (const plan of command.plans) {
        for (const dependency of plan.dependsOn) {
          if (!keySet.has(dependency)) {
            return yield* invariant(
              command,
              `Plan '${plan.key}' depends on unknown plan '${dependency}'.`,
            );
          }
        }
      }
      const cycle = findProposedPlanCycle(command.plans);
      if (cycle !== null) {
        return yield* invariant(
          command,
          `Plan dependency edge '${cycle.from} -> ${cycle.to}' would create a cycle: ${cycle.path.join(" -> ")}.`,
        );
      }
      // A multi-plan proposal is a card split, so the rejection names the consequence
      // and both ways forward. A single-plan proposal stores a null rationale, so
      // non-null means "the last proposal split this card".
      const splitRationale = command.plans.length >= 2 ? command.splitRationale : null;
      if (command.plans.length >= 2) {
        if (splitRationale === null) {
          return yield* invariant(
            command,
            `Card '${proposalCard.key}': ${command.plans.length} plans splits this card into ${command.plans.length} child cards, each with its own branch, build and review, and holds it behind a human approval gate. Pass splitRationale (at least ${SPLIT_RATIONALE_MIN_LENGTH} characters) explaining why this card needs splitting, or propose a single plan with several sections.`,
          );
        }
        if (splitRationale.length < SPLIT_RATIONALE_MIN_LENGTH) {
          return yield* invariant(
            command,
            `splitRationale must be at least ${SPLIT_RATIONALE_MIN_LENGTH} characters explaining why this card needs splitting into ${command.plans.length} child cards; propose a single plan if it does not.`,
          );
        }
        if (splitRationale.length > SPLIT_RATIONALE_MAX_LENGTH) {
          return yield* invariant(
            command,
            `splitRationale must be at most ${SPLIT_RATIONALE_MAX_LENGTH} characters; the plan bodies carry the detail.`,
          );
        }
      }
      // Preserve createdAt for a plan key that already exists (a re-proposal
      // edits in place); a genuinely new plan starts now.
      const existingById = new Map(
        boardCardPlans(board, command.cardId).map((plan) => [plan.planId, plan]),
      );
      const plans: ReadonlyArray<BoardPlanWithBody> = command.plans.map((plan, index) => {
        const planId = boardPlanId(command.cardId, plan.key);
        const prior = existingById.get(planId);
        return {
          planId,
          cardId: command.cardId,
          title: plan.title,
          summary: plan.summary,
          dependsOn: plan.dependsOn.map((dependency) => boardPlanId(command.cardId, dependency)),
          ordinal: index,
          locked: false,
          // Only a split's plans carry the flag; a single plan is the card's
          // own, which is planned by definition.
          ...(command.plans.length >= 2 && plan.planned === false ? { planned: false } : {}),
          ...(plan.size === undefined ? {} : { size: plan.size }),
          ...(plan.sizeReason === undefined ? {} : { sizeReason: plan.sizeReason }),
          createdAt: prior?.createdAt ?? command.createdAt,
          updatedAt: command.createdAt,
          body: plan.body,
        };
      });
      // The agent's advice for the split gate, each omitted field
      // filled from the shared fallback rules so the stored value is whole.
      const splitRecommendation =
        splitRationale === null
          ? undefined
          : (() => {
              const fallback = boardSplitRecommendationFallback({
                plans,
                underIntegrationBranch: boardCardMergesIntoIntegrationBranch(board, proposalCard),
              });
              return {
                autoBuild: command.recommendedAutoBuild ?? fallback.autoBuild,
                mergeTarget: command.recommendedMergeTarget ?? fallback.mergeTarget,
              };
            })();
      const proposed: PlannedBoardEvent = {
        ...(yield* makeBoardEventBase({
          cardId: command.cardId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        })),
        type: "board.plans-proposed",
        payload: {
          cardId: command.cardId,
          plans,
          splitRationale,
          ...(splitRecommendation === undefined ? {} : { splitRecommendation }),
        },
      };
      // Plan review: the first proposal on the live plan step, with
      // review on, starts the review in the same decision. The tool result
      // hands the agent its instructions.
      const reviewStep =
        command.planReview?.enabled === true && plans.length > 0
          ? livePlanReviewStep(board, command.cardId)
          : null;
      // T3o: a single plan's size is the card's own planner size (T3O-86); a split's
      // reaches each child at approval.
      const sized = yield* plannerSizeRecorded({ board, command, card: proposalCard, plans });
      if (reviewStep === null || reviewStep.planReviewStartedAt !== undefined) {
        return sized === null ? proposed : [proposed, sized];
      }
      return [
        proposed,
        ...(sized === null ? [] : [sized]),
        yield* planReviewStartedEvent({
          command,
          state: reviewStep,
          rounds: command.planReview?.rounds ?? reviewStep.planReviewRounds ?? 1,
        }),
      ];
    }

    case "board.plan.write": {
      yield* requireActiveBoardCard({ board, command });
      // Frozen after approval, exactly as re-proposal is — and,
      // like it, only by LIVE children.
      if (boardCardChildren(board, command.cardId).some((child) => child.archivedAt === null)) {
        return yield* invariant(
          command,
          `Card '${command.cardId}' has materialised child cards; the plans are frozen. Work happens on the child cards now.`,
        );
      }
      const plan = boardCardPlans(board, command.cardId).find(
        (candidate) => candidate.planId === command.planId,
      );
      if (plan === undefined) {
        return yield* invariant(
          command,
          `Plan '${command.planId}' does not exist on card '${command.cardId}'.`,
        );
      }
      // One source of truth at any moment: a locked plan lives
      // in .plans/, so the write is refused with a pointer to the file.
      if (plan.locked) {
        return yield* invariant(
          command,
          `Plan '${command.planId}' is locked (materialised to .plans/); edit the file instead.`,
        );
      }
      const nextPlan: BoardPlan = { ...plan, updatedAt: command.createdAt };
      return {
        ...(yield* makeBoardEventBase({
          cardId: command.cardId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        })),
        type: "board.plan-written",
        payload: {
          cardId: command.cardId,
          planId: command.planId,
          body: command.body,
          plan: nextPlan,
        },
      };
    }

    case "board.plans.approve": {
      // Materialise the split: the children's creations plus the approval record the
      // reactor keys the integration branch off. NOT a stage move: the parent stays put,
      // and its arrival in the build-role stage starts the sub-board.
      const card = yield* requireActiveBoardCard({ board, command });
      // A parent with a BUILD run in flight cannot be split: the agent would keep writing
      // the branch the children fork from. The plan-role stage is exempt, because its
      // step stays running until the human moves the card onward, and that move is refused
      // until the split is approved.
      {
        const state = boardCardStepState(board, command.cardId);
        const planStage = boardStageWithRole(board, "plan");
        const planning = planStage !== null && card.stage === planStage.stageId;
        if (state !== null && !isBoardTerminalStepStatus(state.status) && !planning) {
          return yield* invariant(
            command,
            // `boardRunLabel` is the shared rule: the step's own
            // label, or the stage label when the step has none — so the gate
            // names the run the same way every other reader does.
            `Card '${card.key}' has a live step ('${boardRunLabel(
              state,
            )}', ${state.status}); finish or stop it before approving a split.`,
          );
        }
      }
      {
        // Only LIVE children block re-approval, so a fully archived first round does not
        // wedge a second-round split. A Done-but-unarchived child still counts.
        const live = boardCardChildren(board, card.id).filter((child) => child.archivedAt === null);
        if (live.length > 0) {
          return yield* invariant(
            command,
            `Card '${card.key}' already has ${live.length} materialised plan card${
              live.length === 1 ? "" : "s"
            } on the board; a split is approved once.`,
          );
        }
      }
      const plans = boardCardPlans(board, command.cardId).toSorted(
        (left, right) => left.ordinal - right.ordinal,
      );
      if (plans.length < 2) {
        return yield* invariant(
          command,
          `Card '${card.key}' has ${plans.length} plan${
            plans.length === 1 ? "" : "s"
          }; a split needs at least two. Move the card onward instead.`,
        );
      }
      const buildStage = boardStageWithRole(board, "build");
      if (buildStage === null) {
        return yield* invariant(command, "The board has no build-role stage.");
      }
      // A parent already past Building has left the zone a split supervises;
      // sitting AT Building is fine (a card built conversationally can still
      // be split before its build starts in earnest).
      if (isBoardStageAtOrAfterBuild(board, card.stage) && card.stage !== buildStage.stageId) {
        return yield* invariant(
          command,
          `Card '${card.key}' is already past '${buildStage.label}'; a split supervises unbuilt work.`,
        );
      }
      // At Building is fine only before a checkout exists: a leaf with a live
      // worktree has build work a split would strand (the started-card rule).
      if (boardCardHoldsWorktree(card)) {
        return yield* invariant(
          command,
          `Work has started on '${card.key}' in its own worktree, so it cannot become a group; cancel its work first, or put it under a shared parent.`,
        );
      }
      const floor = boardSubBoardFloorStage(board);
      if (floor === null) {
        return yield* invariant(
          command,
          `The board has no stage before '${buildStage.label}' to hold materialised plan cards; add one first.`,
        );
      }
      // A child whose plan is only a brief lands in the first stage to be
      // planned on its own; a planned one lands on the floor.
      const backlog = boardProjectFirstStageId(board, card.projectId);
      const recommendation = boardSplitRecommendationOf(board, card);
      const settings = {
        autoBuild: command.autoBuild ?? recommendation.autoBuild,
        target: command.mergeTarget ?? recommendation.mergeTarget,
        ...(command.autoPlan === undefined ? {} : { autoPlan: command.autoPlan }),
        ...(command.autoMerge === undefined ? {} : { autoMerge: command.autoMerge }),
      };
      // The graph is agent-authored and therefore re-validated at the gate —
      // propose checked it on ingest, but the gate is where a human
      // commits to it.
      const cycle = findProposedPlanCycle(
        plans.map((plan) => ({ key: plan.planId, dependsOn: plan.dependsOn })),
      );
      if (cycle !== null) {
        return yield* invariant(
          command,
          `Plan dependency edge '${cycle.from} -> ${cycle.to}' is a cycle: ${cycle.path.join(" -> ")}.`,
        );
      }

      const crypto = yield* SecureRandom.SecureRandom;
      // Children share the parent's key sequence — its prefix, the project's
      // next numbers — exactly as if each had been created by hand.
      const lastDash = card.key.lastIndexOf("-");
      const keyPrefix = lastDash > 0 ? card.key.slice(0, lastDash) : DEFAULT_BOARD_KEY_PREFIX;
      let nextNumber = board.nextCardNumberByProject[card.projectId] ?? 1;
      // Appended at the bottom of the floor column in ordinal order; each key
      // feeds the next so siblings sort in plan order. The column is this
      // parent's sub-board — the only place a child renders — not
      // the root board's floor stage, which a child never appears in.
      const orderKeysByStage = new Map<BoardStageId, Array<string>>();
      const nextOrderKey = (stage: BoardStageId) => {
        let keys = orderKeysByStage.get(stage);
        if (keys === undefined) {
          keys = [...boardColumnOrderKeys({ cards: board.cards, stage, parentCardId: card.id })];
          orderKeysByStage.set(stage, keys);
        }
        const orderKey = boardAppendOrderKey(keys);
        keys.push(orderKey);
        return orderKey;
      };
      // A child runs where its parent is bound — its pin, or
      // the worker holding its worktree — and can be re-pinned after.
      const inheritedPin = inheritedBoardWorkerPin(board, boardCardBoundWorkerId(card));
      const childIdByPlan = new Map<BoardPlanId, BoardCardId>();
      for (const plan of plans) {
        childIdByPlan.set(plan.planId, BoardCardId.make(yield* crypto.uuidV4()));
      }
      const events: Array<PlannedBoardEvent> = [];
      const childCardIds: Array<BoardCardId> = [];
      for (const plan of plans) {
        const childId = childIdByPlan.get(plan.planId)!;
        childCardIds.push(childId);
        const planned = isBoardPlanPlanned(plan);
        const stage = planned ? floor.stageId : backlog;
        const orderKey = nextOrderKey(stage);
        const cardNumber = nextNumber;
        nextNumber += 1;
        events.push({
          ...(yield* makeBoardEventBase({
            cardId: childId,
            occurredAt: command.createdAt,
            commandId: command.commandId,
          })),
          type: "board.card-created",
          payload: {
            cardId: childId,
            projectId: card.projectId,
            title: plan.title,
            key: `${keyPrefix}-${cardNumber}`,
            cardNumber,
            labels: card.labels,
            // The plan BODY becomes the child's brief — by pointer, because
            // bodies never ride the read model; the SQL projector copies
            // it inside the same transaction.
            briefFromPlanId: plan.planId,
            ...(planned ? {} : { briefOnly: true }),
            dependsOn: plan.dependsOn.map((dependency) => childIdByPlan.get(dependency)!),
            parentCardId: card.id,
            sourcePlanId: plan.planId,
            ...(inheritedPin === null ? {} : { pinnedWorkerId: inheritedPin }),
            ...(plan.size === undefined
              ? {}
              : {
                  resources: {
                    sizing: {
                      planner: { size: plan.size, reason: plan.sizeReason ?? null },
                      edit: null,
                    },
                    grant: null,
                    setup: null,
                  },
                }),
            ...(card.priority === "normal" ? {} : { priority: card.priority }),
            stage,
            orderKey,
            createdAt: command.createdAt,
            updatedAt: command.createdAt,
          },
        });
      }
      // The parent becomes a group with the settings confirmed at the split gate, and
      // only its timestamp otherwise changes: no stage move, `blocked` untouched. Its
      // Auto-plan/Auto-build move into group settings; its own Auto-merge stays.
      const parentAfterApproval: BoardCard = {
        ...card,
        ...endBoardCardAutoPlan(card, command.createdAt),
        group: defaultBoardCardGroup(board, card, {
          ...settings,
          started: card.stage === buildStage.stageId,
        }),
        // Its children copied its priority above; a group has none.
        priority: "normal",
        autoPlanSetting: null,
        autoBuildSetting: null,
        updatedAt: command.createdAt,
      };
      events.push({
        ...(yield* makeBoardEventBase({
          cardId: card.id,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        })),
        type: "board.plans-approved",
        payload: {
          cardId: card.id,
          card: parentAfterApproval,
          childCardIds,
          approvedAt: command.createdAt,
        },
      });
      return events;
    }

    // Worktree lifecycle: server-internal commands the worktree service dispatches
    // after the git work. The decider records the state the service reports and
    // never advances a stage.

    case "board.card.provision-worktree": {
      const card = yield* requireActiveBoardCard({ board, command });
      // Which stages need a worktree is a settings question the pure decider cannot
      // read, so the reactor (the only dispatcher) gates on the resolved execution mode.
      // A worktree already provisioning or ready is never re-provisioned behind its back.
      if (
        card.worktree !== null &&
        card.worktree.status !== "failed" &&
        card.worktree.status !== "reclaimed" &&
        card.worktree.status !== "branch-only"
      ) {
        return yield* invariant(
          command,
          `Card '${command.cardId}' worktree is '${card.worktree.status}'; only a failed, reclaimed or branch-only worktree can be re-provisioned.`,
        );
      }
      // T3o: the placement gate records where the card goes before it provisions (T3O-87).
      if (card.placedWorkerId === null) {
        return yield* invariant(
          command,
          `Card '${command.cardId}' has no placement; the board places a card before it provisions it.`,
        );
      }
      // `failed` is a retry, so `attempts` climbs; `reclaimed` and `branch-only` are
      // fresh provisions, so it restarts. The round boundary belongs to the move out of
      // Done, not here: a worktree that survived Done is never re-provisioned.
      const attempts =
        card.worktree === null ||
        card.worktree.status === "reclaimed" ||
        card.worktree.status === "branch-only"
          ? 1
          : card.worktree.attempts + 1;
      const nextCard: BoardCard = {
        ...card,
        worktree: {
          branch: command.branch,
          baseRefName: command.baseRefName,
          path: null,
          status: "provisioning",
          attempts,
          lastError: null,
          reclaimBlockedReason: null,
        },
        // The worktree binds the card to the worker the gate placed it on (T3O-87). From
        // here only a move or the worker's removal changes it.
        placedWorkerId: card.placedWorkerId,
        resources: withSetupDue(card.resources),
        updatedAt: command.createdAt,
      };
      return {
        ...(yield* makeBoardEventBase({
          cardId: command.cardId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        })),
        type: "board.card-worktree-provisioning",
        payload: {
          cardId: command.cardId,
          branch: command.branch,
          baseRefName: command.baseRefName,
          card: nextCard,
        },
      };
    }

    case "board.card.record-integration-branch": {
      // A split parent's integration branch now exists on disk —
      // the reactor created it off the plans-approved event and reports back,
      // same effect-then-record discipline as record-worktree. `branch-only`:
      // real branch, no worktree until the parent's own review entry.
      const card = yield* requireActiveBoardCard({ board, command });
      // `failed` is a retry; `reclaimed` is a second-round split whose old
      // branch was deleted at Done. A live slice — branch-only,
      // provisioning, ready — must not be overwritten behind its own back.
      if (
        card.worktree !== null &&
        card.worktree.status !== "failed" &&
        card.worktree.status !== "reclaimed"
      ) {
        return yield* invariant(
          command,
          `Card '${command.cardId}' worktree is '${card.worktree.status}'; an integration branch is recorded only while no live branch exists.`,
        );
      }
      const nextCard: BoardCard = {
        ...card,
        worktree: {
          branch: command.branch,
          baseRefName: command.baseRefName,
          path: null,
          status: "branch-only",
          attempts: 1,
          lastError: null,
          reclaimBlockedReason: null,
        },
        updatedAt: command.createdAt,
      };
      return {
        ...(yield* makeBoardEventBase({
          cardId: command.cardId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        })),
        type: "board.card-integration-branch-recorded",
        payload: {
          cardId: command.cardId,
          branch: command.branch,
          baseRefName: command.baseRefName,
          card: nextCard,
        },
      };
    }

    case "board.card.record-base-ref": {
      // A retarget rebase landed: move the RECORDED base only. Accepts only live
      // statuses; on `failed` or `reclaimed` there is no branch a rebase could have moved.
      const card = yield* requireActiveBoardCard({ board, command });
      if (card.worktree === null || !boardCardHasLiveBranch(card)) {
        return yield* invariant(
          command,
          `Card '${command.cardId}' has no live branch; there is no recorded base to move.`,
        );
      }
      if (card.worktree.baseRefName === command.baseRefName) {
        return yield* invariant(
          command,
          `Card '${command.cardId}' already records base '${command.baseRefName}'; nothing to record.`,
        );
      }
      const nextCard: BoardCard = {
        ...card,
        worktree: { ...card.worktree, baseRefName: command.baseRefName },
        updatedAt: command.createdAt,
      };
      return {
        ...(yield* makeBoardEventBase({
          cardId: command.cardId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        })),
        type: "board.card-base-ref-recorded",
        payload: {
          cardId: command.cardId,
          baseRefName: command.baseRefName,
          card: nextCard,
        },
      };
    }

    case "board.card.record-worktree": {
      const card = yield* requireActiveBoardCard({ board, command });
      if (card.worktree === null || card.worktree.status !== "provisioning") {
        return yield* invariant(
          command,
          `Card '${command.cardId}' has no worktree in 'provisioning'; cannot record a ready worktree.`,
        );
      }
      const nextCard: BoardCard = {
        ...card,
        worktree: {
          ...card.worktree,
          path: command.path,
          status: "ready",
          lastError: null,
        },
        updatedAt: command.createdAt,
      };
      return {
        ...(yield* makeBoardEventBase({
          cardId: command.cardId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        })),
        type: "board.card-worktree-ready",
        payload: {
          cardId: command.cardId,
          path: command.path,
          card: nextCard,
        },
      };
    }

    case "board.card.record-pull-request": {
      const card = yield* requireActiveBoardCard({ board, command });
      const previous = card.pullRequest;
      const next = command.pullRequest;
      // The floor (`BoardCard.pullRequestFloor`) refuses a finished round's pull request,
      // which the forge lookup returns until the new round opens one. Exempt: a pull
      // request the forge reports `open` now (it is the branch's live one), and the card's
      // current link, so a re-adopted pull request can still record its own merge.
      const isCurrentLink =
        next !== null && card.pullRequest !== null && card.pullRequest.number === next.number;
      if (
        next !== null &&
        !isCurrentLink &&
        next.state !== "open" &&
        card.pullRequestFloor !== null &&
        next.number <= card.pullRequestFloor
      ) {
        return yield* invariant(
          command,
          `Card '${command.cardId}' pull request #${next.number} is ${next.state} and at or below its floor of #${card.pullRequestFloor}; it belongs to a completed round of work.`,
        );
      }
      // A pull request that closed before the card existed belongs to an earlier card
      // on the same branch name, so it is refused like the floor. The current link is
      // exempt so a link recorded before `closedAt` existed can be backfilled.
      if (
        next !== null &&
        !isCurrentLink &&
        next.linked !== true &&
        boardPullRequestPredatesCard(next, card.createdAt)
      ) {
        return yield* invariant(
          command,
          `Card '${command.cardId}' pull request #${next.number} ${next.state} before the card was created; it belongs to an earlier card on the same branch.`,
        );
      }
      // No-op guard here, not just at the caller: most refreshes return what the card
      // already holds. `checkedAt` is excluded; it moves on every lookup.
      if (boardCardPullRequestsEqual(previous, next)) {
        return yield* invariant(
          command,
          `Card '${command.cardId}' already records this pull request state; nothing to record.`,
        );
      }
      // An explicitly linked pull request is the card's by decision: a branch lookup
      // may neither replace nor clear it, only a same-number refresh carrying the marker.
      if (
        previous !== null &&
        previous.linked === true &&
        (next === null || next.number !== previous.number || next.linked !== true)
      ) {
        return yield* invariant(
          command,
          `Card '${command.cardId}' has pull request #${previous.number} linked explicitly; only a refresh of that pull request can record over it.`,
        );
      }
      // A merged link is never unlinked or demoted by a later lookup: a refresh may
      // commit `merged` between the reactor's read and this dispatch. Same-number
      // still-merged is the title backfill. Except a link the card never owned (merged
      // before the card existed), which the next lookup replaces.
      if (
        previous !== null &&
        isBoardCardPullRequestTerminal(previous) &&
        !(previous.linked !== true && boardPullRequestPredatesCard(previous, card.createdAt)) &&
        (next === null || next.number !== previous.number || next.state !== "merged")
      ) {
        return yield* invariant(
          command,
          `Card '${command.cardId}' already records a merged pull request; a lookup that is not the same number still merged cannot replace it.`,
        );
      }
      const transition: BoardCardPullRequestTransition =
        next === null
          ? "unlinked"
          : previous === null || previous.number !== next.number
            ? "linked"
            : previous.state === next.state
              ? "updated"
              : "state-changed";
      const nextCard: BoardCard = {
        ...card,
        pullRequest: next,
        updatedAt: command.createdAt,
      };
      return {
        ...(yield* makeBoardEventBase({
          cardId: command.cardId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        })),
        type: "board.card-pull-request-recorded",
        payload: {
          cardId: command.cardId,
          pullRequest: next,
          transition,
          ...(previous !== null && (transition === "linked" || transition === "unlinked")
            ? { previous }
            : {}),
          card: nextCard,
        },
      };
    }

    case "board.card.set-linked-pull-request": {
      const card = yield* requireActiveBoardCard({ board, command });
      const previous = card.pullRequest;
      // Stamped here rather than trusted from the caller, so a link is marked
      // however it arrived.
      const next =
        command.pullRequest === null ? null : { ...command.pullRequest, linked: true as const };
      // The floor applies to a link as to a branch lookup, with the same exemptions: an
      // open pull request or the card's current one.
      if (
        next !== null &&
        next.state !== "open" &&
        previous?.number !== next.number &&
        card.pullRequestFloor !== null &&
        next.number <= card.pullRequestFloor
      ) {
        return yield* invariant(
          command,
          `Card '${command.cardId}' pull request #${next.number} is ${next.state} and at or below its floor of #${card.pullRequestFloor}; it belongs to a completed round of work.`,
        );
      }
      if (next === null && previous?.linked !== true) {
        return yield* invariant(
          command,
          `Card '${command.cardId}' has no explicitly linked pull request to clear.`,
        );
      }
      // A merged pull request the card records is never replaced or cleared,
      // as `record-pull-request` holds. Dropping it would keep its number out
      // of `pullRequestHistory`, so the next round's floor would not cover it
      // and a later branch lookup could adopt it merged again.
      if (
        previous !== null &&
        isBoardCardPullRequestTerminal(previous) &&
        (next === null || next.number !== previous.number)
      ) {
        return yield* invariant(
          command,
          `Card '${command.cardId}' already records merged pull request #${previous.number}; a link cannot replace or clear it.`,
        );
      }
      // One slot per card, so linking the same pull request again is a no-op
      // rather than a duplicate.
      if (boardCardPullRequestsEqual(previous, next)) {
        return yield* invariant(
          command,
          `Card '${command.cardId}' already has pull request #${previous?.number} linked; nothing to record.`,
        );
      }
      const transition: BoardCardPullRequestTransition =
        next === null
          ? "unlinked"
          : previous === null || previous.number !== next.number
            ? "linked"
            : previous.state === next.state
              ? "updated"
              : "state-changed";
      const nextCard: BoardCard = {
        ...card,
        pullRequest: next,
        updatedAt: command.createdAt,
      };
      return {
        ...(yield* makeBoardEventBase({
          cardId: command.cardId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        })),
        type: "board.card-pull-request-recorded",
        payload: {
          cardId: command.cardId,
          pullRequest: next,
          transition,
          ...(previous !== null && (transition === "linked" || transition === "unlinked")
            ? { previous }
            : {}),
          card: nextCard,
        },
      };
    }

    case "board.card.set-review-carry": {
      // The review loop's server-only fields, written together so a
      // round is opened, a stuck round waived and a ruling carried in one
      // event — never a waiver that lands after the move it was for.
      const card = yield* requireActiveBoardCard({ board, command });
      const stored = card.reviewOverrides ?? EMPTY_BOARD_CARD_REVIEW_OVERRIDES;
      const stepState = boardCardStepState(board, card.id);
      const roundsStarted = boardReviewRoundsStarted({
        completions: boardCardStepCompletions(board, card.id),
        liveStepId:
          stepState === null || isBoardTerminalStepStatus(stepState.status)
            ? null
            : stepState.stepId,
      });
      if (
        command.runThroughRound === undefined &&
        command.clearStopAfterRound === undefined &&
        command.stuckWaivedThrough === undefined &&
        command.carry === undefined &&
        command.forceFullRound === undefined
      ) {
        return yield* invariant(command, `Review carry for card '${card.id}' carries no changes.`);
      }
      // The same clamp a client's request gets: only the next
      // round can be asked for.
      if (command.runThroughRound !== undefined && command.runThroughRound > roundsStarted + 1) {
        return yield* invariant(
          command,
          `Cannot ask card '${card.id}' to run through review round ${command.runThroughRound}: only round ${roundsStarted + 1} can be requested next.`,
        );
      }
      if (command.stuckWaivedThrough !== undefined && command.stuckWaivedThrough > roundsStarted) {
        return yield* invariant(
          command,
          `Cannot waive review round ${command.stuckWaivedThrough} on card '${card.id}': only ${roundsStarted} round(s) have started.`,
        );
      }
      if (command.carry !== undefined) {
        const key = String(command.carry.round);
        if (stored.carriedFindings[key] !== undefined) {
          return yield* invariant(
            command,
            `Card '${card.id}' already carries a ruling into review round ${command.carry.round}.`,
          );
        }
        if (command.carry.round <= roundsStarted) {
          return yield* invariant(
            command,
            `Cannot carry findings into review round ${command.carry.round} on card '${card.id}': it has already started.`,
          );
        }
      }
      const next: BoardCardReviewOverrides = {
        ...stored,
        runThroughRound: command.runThroughRound ?? stored.runThroughRound,
        stopAfterRound: command.clearStopAfterRound === true ? null : stored.stopAfterRound,
        stuckWaivedThrough:
          command.stuckWaivedThrough === undefined
            ? stored.stuckWaivedThrough
            : Math.max(stored.stuckWaivedThrough ?? 0, command.stuckWaivedThrough),
        carriedFindings:
          command.carry === undefined
            ? stored.carriedFindings
            : { ...stored.carriedFindings, [String(command.carry.round)]: command.carry.entry },
        roundModes:
          command.forceFullRound === true
            ? forcedFullRoundModes({
                stored: stored.roundModes,
                completions: boardCardStepCompletions(board, card.id),
                throughRound: command.runThroughRound ?? stored.runThroughRound,
              })
            : stored.roundModes,
      };
      const reviewOverrides = isEmptyBoardCardReviewOverrides(next) ? null : next;
      const nextCard: BoardCard = { ...card, reviewOverrides, updatedAt: command.createdAt };
      const summary = boardCardReviewSummary(board, card.id, reviewOverrides);
      return {
        ...(yield* makeBoardEventBase({
          cardId: command.cardId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        })),
        type: "board.card-updated",
        payload: {
          cardId: command.cardId,
          card: nextCard,
          ...(summary === null ? {} : { reviewSummary: summary }),
        },
      };
    }

    case "board.card.record-grant": {
      const card = yield* requireBoardCard({ board, command });
      const current = card.resources?.grant ?? null;
      if (command.clear === true) {
        if (current === null) return [];
        return yield* cardResourcesRecordedEvent({
          card,
          resources: { ...(card.resources ?? EMPTY_BOARD_CARD_RESOURCES), grant: null },
          command,
        });
      }
      // A grant needs a profile: one already granted, or the one the command brings.
      const profile = command.profile ?? current?.profile;
      if (profile === undefined) {
        return yield* invariant(command, `Card '${command.cardId}' has no grant to change.`);
      }
      const next = {
        profile,
        heavy: command.heavy ?? current?.heavy ?? false,
        claimId: current?.claimId ?? null,
        grantedAt: current?.grantedAt ?? command.createdAt,
        settled: command.settled ?? current?.settled ?? false,
      };
      if (current !== null && canonicalJson(current) === canonicalJson(next)) return [];
      return yield* cardResourcesRecordedEvent({
        card,
        resources: { ...(card.resources ?? EMPTY_BOARD_CARD_RESOURCES), grant: next },
        command,
      });
    }

    case "board.card.record-setup": {
      const card = yield* requireBoardCard({ board, command });
      const current = card.resources?.setup ?? null;
      if (canonicalJson(current) === canonicalJson(command.setup)) return [];
      const { setupDue: _due, ...base } = card.resources ?? EMPTY_BOARD_CARD_RESOURCES;
      return yield* cardResourcesRecordedEvent({
        card,
        resources: withoutEmptyResources({ ...base, setup: command.setup }),
        command,
      });
    }

    case "board.card.setup-action": {
      const card = yield* requireActiveBoardCard({ board, command });
      const setup = card.resources?.setup ?? null;
      // Nothing to act on: a click that raced the setup's end, or a card with no worktree.
      if (setup === null || card.worktree?.status !== "ready") return [];
      if (command.action === "cancel") {
        if (setup.status !== "running") return [];
        return yield* cardResourcesRecordedEvent({
          card,
          resources: { ...card.resources!, setup: { ...setup, status: "cancelled" } },
          command,
          setupRequested: "cancel",
        });
      }
      if (setup.status === "running") return [];
      // Retry re-runs the setup script only: fetch, checkout and submodules stand.
      return yield* cardResourcesRecordedEvent({
        card,
        resources: {
          ...card.resources!,
          setup: {
            ...setup,
            status: "running",
            stage: "setup-script",
            exitCode: null,
            startedAt: command.createdAt,
            durationMs: null,
            detail: null,
          },
        },
        command,
        setupRequested: "retry",
      });
    }

    case "board.card.undo-provision": {
      const card = yield* requireBoardCard({ board, command });
      // Only a provision still in flight is undone; one that landed or failed stands.
      if (card.worktree?.status !== "provisioning") return [];
      // The worktree that was due its setup never landed: the next provision marks it again.
      const { setupDue: _due, ...rest } = card.resources ?? EMPTY_BOARD_CARD_RESOURCES;
      // T3o: the claim expired, so the placement goes too and the card is ranked again
      // (T3O-87) — unless the restored record still binds it to its worker.
      const restoredHolds = boardCardHoldsWorktree({ worktree: command.restore });
      return yield* cardResourcesRecordedEvent({
        card: {
          ...card,
          worktree: command.restore,
          placedWorkerId: restoredHolds ? card.placedWorkerId : null,
          updatedAt: command.createdAt,
        },
        resources:
          card.resources === null
            ? null
            : withoutEmptyResources({
                ...rest,
                grant: null,
                ...(restoredHolds ? {} : { placement: null }),
              }),
        command,
      });
    }

    case "board.card.record-auto-merge-hold": {
      const card = yield* requireActiveBoardCard({ board, command });
      // No-op guard here, not just at the caller: the sweep re-probes a held card every
      // rung, and most answers are the hold the card already carries.
      if (boardCardAutoMergeHoldsEqual(card.autoMergeHold, command.hold)) {
        return yield* invariant(
          command,
          `Card '${command.cardId}' already records this auto-merge hold; nothing to record.`,
        );
      }
      const nextCard: BoardCard = {
        ...card,
        autoMergeHold: command.hold,
        updatedAt: command.createdAt,
      };
      return {
        ...(yield* makeBoardEventBase({
          cardId: command.cardId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        })),
        type: "board.card-auto-merge-hold-recorded",
        payload: { cardId: command.cardId, hold: command.hold, card: nextCard },
      };
    }

    case "board.card.record-decisions": {
      // The decision log. Append-only: a planning session records
      // what it decided, and a correction is a newer entry, not an edit.
      const card = yield* requireActiveBoardCard({ board, command });
      if (command.decisions.length === 0) {
        return yield* invariant(command, "Record at least one decision.");
      }
      if (command.decisions.length > BOARD_DECISIONS_PER_CALL_MAX) {
        return yield* invariant(
          command,
          `Record at most ${BOARD_DECISIONS_PER_CALL_MAX} decisions per call; split the rest into another call.`,
        );
      }
      const base = yield* makeBoardEventBase({
        cardId: card.id,
        occurredAt: command.createdAt,
        commandId: command.commandId,
      });
      return {
        ...base,
        type: "board.card-decisions-recorded",
        payload: {
          cardId: card.id,
          // Derived from the event id, so re-projecting the event inserts
          // nothing twice.
          decisions: command.decisions.map((decision, index) => ({
            ...decision,
            decisionId: `${base.eventId}:${index}`,
            cardId: card.id,
            stepId: command.stepId,
            threadId: command.threadId,
            createdAt: command.createdAt,
          })),
        },
      };
    }

    case "board.card.mark-auto-plan": {
      // Auto-planning applies to a leaf that is being planned and has no split
      // waiting on a human (decision 7). A group plans through its
      // children, and a pending split already has its plans.
      const card = yield* requireActiveBoardCard({ board, command });
      const planStage = boardStageWithRole(board, "plan");
      if (planStage === null || card.stage !== planStage.stageId) {
        return yield* invariant(
          command,
          `Card '${card.key}' is not in planning; only a card being planned can be auto-planned.`,
        );
      }
      if (boardCardGroupOf(board, card) !== null) {
        return yield* invariant(
          command,
          `Card '${card.key}' is a group; its children are planned one by one.`,
        );
      }
      if (boardCardPendingSplit(board, card.id)) {
        return yield* invariant(
          command,
          `Card '${card.key}' has a proposed split waiting for approval; approve it or ask for changes instead.`,
        );
      }
      if (isBoardCardAutoPlanPending(card)) {
        return yield* invariant(command, `Card '${card.key}' is already being auto-planned.`);
      }
      const finishedStep = boardCardStepState(board, card.id);
      // A step still reopened, by an earlier toggle or a late plan review, re-arms its handover.
      const stillReopened =
        finishedStep !== null &&
        finishedStep.status === "running" &&
        boardCompletionReopened(
          boardCardStepCompletions(board, card.id).find(
            (entry) => entry.stepId === finishedStep.stepId && entry.outcome === "succeeded",
          ),
          finishedStep,
        );
      if (
        command.reopenFinished === true &&
        (finishedStep === null ||
          finishedStep.stepId !== planStage.stageId ||
          (finishedStep.status !== "succeeded" && !stillReopened))
      ) {
        return yield* invariant(
          command,
          `Card '${card.key}' has no finished planning step to reopen.`,
        );
      }
      const nextCard: BoardCard = {
        ...card,
        autoPlan: { requestedAt: command.createdAt, endedAt: null },
        updatedAt: command.createdAt,
      };
      const marked: PlannedBoardEvent = {
        ...(yield* makeBoardEventBase({
          cardId: card.id,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        })),
        type: "board.card-updated",
        payload: { cardId: card.id, card: nextCard, autoPlanMarked: true },
      };
      if (command.reopenFinished !== true || finishedStep === null) return marked;
      // The agent that marked planning done is still working: its next
      // completion supersedes the pinned one (`boardCompletionReopened`).
      const reopened: PlannedBoardEvent = {
        ...(yield* makeBoardEventBase({
          cardId: card.id,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        })),
        type: "board.card-step-recovered",
        payload: {
          cardId: card.id,
          state: {
            ...(stillReopened ? finishedStep : reopenedPlanStep(finishedStep, command.createdAt)),
            reopenedAt: command.createdAt,
            updatedAt: command.createdAt,
          },
        },
      };
      return [marked, reopened];
    }

    case "board.card.end-auto-plan": {
      const card = yield* requireBoardCard({ board, command });
      if (!isBoardCardAutoPlanPending(card)) {
        return yield* invariant(command, `Card '${card.key}' is not being auto-planned.`);
      }
      return {
        ...(yield* makeBoardEventBase({
          cardId: card.id,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        })),
        type: "board.card-updated",
        payload: {
          cardId: card.id,
          card: {
            ...card,
            ...endBoardCardAutoPlan(card, command.createdAt),
            // A human stopped the run: Auto-plan goes off with it, so
            // the card is planned with them from here. No automation marker —
            // the supervisor caused this and owns its consequences.
            ...(command.turnOff === true ? { autoPlanSetting: false } : {}),
            updatedAt: command.createdAt,
          },
        },
      };
    }

    case "board.card.record-note": {
      // Reporting only: no card field changes, so no `card` on the payload and
      // no `updatedAt` bump. The card must still EXIST and be live — a rail
      // row on an archived or deleted card would have nowhere to render.
      const card = yield* requireActiveBoardCard({ board, command });
      return {
        ...(yield* makeBoardEventBase({
          cardId: card.id,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        })),
        type: "board.card-note-recorded",
        payload: { cardId: card.id, kind: command.kind, detail: command.detail },
      };
    }

    case "board.card.fail-worktree": {
      const card = yield* requireActiveBoardCard({ board, command });
      // A `ready` or `reclaimed` worktree is not an attempt in flight, so it cannot be
      // failed. An already `failed` one can, so a repeat failure records the fresh reason.
      if (
        card.worktree !== null &&
        card.worktree.status !== "provisioning" &&
        card.worktree.status !== "failed"
      ) {
        return yield* invariant(
          command,
          `Card '${command.cardId}' worktree is '${card.worktree.status}'; only a provisioning or failed worktree can be failed.`,
        );
      }
      // Pre-provision failure: no worktree record exists to mark, and none is invented.
      // The event is decided anyway so the reason reaches the card's activity rail, and
      // `worktree` stays null, the state a retry starts from.
      const nextCard: BoardCard =
        card.worktree === null
          ? card
          : {
              ...card,
              worktree: {
                ...card.worktree,
                status: "failed",
                lastError: command.error,
              },
              updatedAt: command.createdAt,
            };
      return {
        ...(yield* makeBoardEventBase({
          cardId: command.cardId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        })),
        type: "board.card-worktree-failed",
        payload: {
          cardId: command.cardId,
          error: command.error,
          card: nextCard,
        },
      };
    }

    case "board.card.reclaim-worktree": {
      // Reclaim runs at archive, so the card is usually archived —
      // requireBoardCard, not requireActiveBoardCard.
      const card = yield* requireBoardCard({ board, command });
      if (card.worktree === null) {
        return yield* invariant(command, `Card '${command.cardId}' has no worktree to reclaim.`);
      }
      // A reclaimed worktree is gone; neither a repeat `removed` nor a late
      // `blocked` re-flag should touch it (symmetric idempotency).
      if (card.worktree.status === "reclaimed") {
        if (command.discardSettled === true && card.worktree.discardPending === true) {
          const { discardPending: _settled, ...worktree } = card.worktree;
          return {
            ...(yield* makeBoardEventBase({
              cardId: command.cardId,
              occurredAt: command.createdAt,
              commandId: command.commandId,
            })),
            type: "board.card-updated",
            payload: { cardId: command.cardId, card: { ...card, worktree } },
          };
        }
        return yield* invariant(command, `Card '${command.cardId}' worktree is already reclaimed.`);
      }
      // `removed`: the service deleted a clean-and-pushed tree — the worktree
      // is gone, path returns to null (reverse state). `blocked`: the
      // service refused because deleting would lose work; the card keeps its
      // worktree and records why, never silently discarding uncommitted work.
      const reason = command.reason ?? null;
      const blockedReason = reason ?? "Worktree not clean and pushed.";
      const { discardPending: _settled, ...settledWorktree } = card.worktree;
      const nextCard: BoardCard =
        command.outcome === "removed"
          ? {
              ...card,
              worktree: {
                ...(command.discardSettled === true ? settledWorktree : card.worktree),
                path: null,
                status: "reclaimed",
                reclaimBlockedReason: null,
              },
              updatedAt: command.createdAt,
            }
          : {
              ...card,
              worktree: {
                ...card.worktree,
                reclaimBlockedReason: blockedReason,
              },
              updatedAt: command.createdAt,
            };
      return {
        ...(yield* makeBoardEventBase({
          cardId: command.cardId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        })),
        type: "board.card-worktree-reclaimed",
        payload: {
          cardId: command.cardId,
          outcome: command.outcome,
          reason: command.outcome === "removed" ? null : blockedReason,
          forced: command.outcome === "removed" && command.forced === true,
          ...(command.outcome === "removed" && command.hookWarning !== undefined
            ? { hookWarning: command.hookWarning }
            : {}),
          // The rail gets one row per distinct refusal, not one
          // per attempt — a kept worktree is re-checked on every card open.
          reasonChanged:
            command.outcome === "blocked" && card.worktree.reclaimBlockedReason !== blockedReason,
          card: nextCard,
        },
      };
    }

    // Step lifecycle: server-internal commands the supervisor reactor dispatches. None
    // of them moves a stage; a board-driven advance rides the ordinary `board.card.move`.

    case "board.card.select-step": {
      const selecting = yield* requireActiveBoardCard({ board, command });
      // A Stop or hold that settles the pass between the reactor's
      // begin-fix and this command must win; no agent starts on a held pass.
      if (
        selecting.stage === BOARD_SEED_STAGE_IDS.ci &&
        selecting.ci !== null &&
        isBoardCiPassSettledPhase(selecting.ci.phase)
      ) {
        return yield* invariant(
          command,
          `Card '${command.cardId}' has its CI pass ${selecting.ci.phase}; no step can start on it.`,
        );
      }
      // One step at a time: a new step cannot be selected while the card's
      // current step is still live. A terminal step is done and may be
      // superseded — that is how a re-entry starts after the last step settled.
      const current = boardCardStepState(board, command.cardId);
      if (current !== null && !isBoardTerminalStepStatus(current.status)) {
        return yield* invariant(
          command,
          `Card '${command.cardId}' already has a live step '${current.stepId}' (${current.status}); settle it before selecting another.`,
        );
      }
      // The reactor resolved and froze the stage's execution config; the
      // decider stamps it onto the run row verbatim.
      const state: BoardCardStepState = {
        cardId: command.cardId,
        stepId: command.stepId,
        stepLabel: command.stepLabel,
        stageLabel: command.stageLabel,
        // A fresh step starts its own count. `attempt` used to
        // carry the stage entry's cumulative total so the ceiling could be read
        // off it; the ceiling now counts recoveries, so this is once again just
        // "invocations of THIS step" and comparable with `maxAttempts`.
        attempt: 1,
        // A fresh step: no stalls yet and no nudge to measure progress
        // against — consecutive stalls are per-step.
        stallCount: 0,
        // The stage entry's recovery total IS carried across step replacement:
        // an intra-stage continuation (the next review phase) passes `priorRecoveries` so the
        // runaway ceiling survives the row being replaced; a genuine stage entry omits it and
        // resets to 0.
        stageEntryRecoveries: command.priorRecoveries ?? 0,
        // Resting value: only read while the step is
        // `awaiting-input`, and a fresh step never is.
        awaitingReason: "question",
        // …and the same for the loud half: a fresh step has not
        // stalled, so it carries no reason and no retry time. Setting them here
        // rather than letting them ride is what stops a re-entered stage
        // inheriting the previous entry's "resuming 2:50am".
        stalledReason: "gave-up",
        retryAt: null,
        queuedBy: null,
        queuedDetail: null,
        lastNudgeAt: null,
        // No human has typed into a fresh step, so no free turn-ending is owed.
        humanTurnAt: null,
        prompt: command.prompt,
        providerInstanceId: command.providerInstanceId,
        model: command.model,
        runtimeMode: command.runtimeMode,
        ...(command.modelOptions === undefined ? {} : { modelOptions: command.modelOptions }),
        mode: command.mode,
        humanInLoop: command.humanInLoop,
        maxAttempts: command.maxAttempts,
        timeoutMs: command.timeoutMs,
        // Measured or carried by the reactor; stamped verbatim
        // like every other frozen field.
        baseTipAtRoundStart: command.baseTipAtRoundStart,
        threadId: null,
        // A fresh step has not stopped for any reason yet.
        lastError: null,
        status: "pending",
        slotHeld: false,
        // A fresh step carries no cap override: forcing one step past
        // the ceiling never bleeds into the step after it.
        forceStart: false,
        startedAt: null,
        updatedAt: command.createdAt,
      };
      const selected = {
        ...(yield* makeBoardEventBase({
          cardId: command.cardId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        })),
        type: "board.card-step-selected" as const,
        payload: { cardId: command.cardId, state },
      };
      // A settling round is recorded in the decision that freezes its prompt, before any
      // thread spawns, so every later reader sees the mode the round was composed in.
      const roundMode = command.reviewRoundMode;
      const storedOverrides = selecting.reviewOverrides ?? EMPTY_BOARD_CARD_REVIEW_OVERRIDES;
      if (roundMode === undefined) return selected;
      const stored = storedOverrides.roundModes[String(roundMode.round)];
      if (stored !== undefined) {
        // The plan was composed before this record landed (a full-round request in the window
        // between plan and select-step), so its prompt is stale: refuse it and let the reactor
        // re-plan from the record.
        if (
          stored.kind !== roundMode.mode.kind ||
          (stored.kind === "settling" &&
            roundMode.mode.kind === "settling" &&
            stored.sinceSha !== roundMode.mode.sinceSha)
        ) {
          return yield* invariant(
            command,
            `Round ${roundMode.round} of card '${command.cardId}' is already recorded as a ${stored.kind} round; re-plan it from that record.`,
          );
        }
        return selected;
      }
      const reviewOverrides: BoardCardReviewOverrides = {
        ...storedOverrides,
        roundModes: { ...storedOverrides.roundModes, [String(roundMode.round)]: roundMode.mode },
      };
      const summary = boardCardReviewSummary(board, selecting.id, reviewOverrides);
      return [
        selected,
        {
          ...(yield* makeBoardEventBase({
            cardId: command.cardId,
            occurredAt: command.createdAt,
            commandId: command.commandId,
          })),
          type: "board.card-updated" as const,
          payload: {
            cardId: command.cardId,
            card: { ...selecting, reviewOverrides, updatedAt: command.createdAt },
            ...(summary === null ? {} : { reviewSummary: summary }),
          },
        },
      ];
    }

    case "board.card.start-stage-thread": {
      // On-demand kickoff: validate the card is active and emit the
      // request event the supervisor reactor reacts to. The reactor decides
      // first-entry-vs-re-entry and whether the stage auto-executes.
      const card = yield* requireActiveBoardCard({ board, command });
      // The dependency gate the move and create paths apply, derived live. The merge
      // role is exempt: its only run is the conflict fix for a merge a human initiated.
      const stage = boardStageById(board, card.stage);
      const mergeRole = stage !== null && effectiveBoardStageRole(stage) === "merge";
      if (!mergeRole && isBoardStageAtOrAfterBuild(board, card.stage)) {
        const unmet = unmetBoardCardDependencies({
          board,
          dependsOn: boardCardInheritedDependsOn(board, card),
          cards: board.cards,
        });
        if (unmet.length > 0) {
          const names = formatUnmetDependencies(board, unmet);
          return yield* invariant(
            command,
            `Card '${card.key}' cannot start a thread in '${card.stage}' until ${
              unmet.length === 1 ? "its dependency is" : "its dependencies are"
            } done: ${names}.`,
          );
        }
      }
      return {
        ...(yield* makeBoardEventBase({
          cardId: command.cardId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        })),
        type: "board.card-stage-thread-requested",
        payload: { cardId: command.cardId, stageId: card.stage },
      };
    }

    case "board.card.admit-step": {
      yield* requireActiveBoardCard({ board, command });
      const current = yield* requireLiveStepState({ board, command, stepId: command.stepId });
      if (current.status !== "pending" && current.status !== "queued") {
        return yield* invariant(
          command,
          `Card '${command.cardId}' step '${command.stepId}' is '${current.status}', not pending/queued; cannot admit.`,
        );
      }
      if (command.admitted && command.threadId === null) {
        return yield* invariant(
          command,
          `Card '${command.cardId}' step '${command.stepId}' was admitted without a thread.`,
        );
      }
      const state: BoardCardStepState = command.admitted
        ? {
            ...current,
            status: "running",
            threadId: command.threadId,
            // Only a build-mode step holds a concurrency slot; a plan-mode
            // step runs read-only with no worktree and no slot.
            slotHeld: current.mode === "build",
            // The override is spent the moment it lands: it named THIS
            // admission, and leaving it set would silently force the card's next
            // step past the cap too.
            forceStart: false,
            // The timeout sweep measures from `lastNudgeAt`, so admission moves it; a step
            // queued for hours would otherwise be overdue on admission.
            lastNudgeAt: command.createdAt,
            // Clear the stall reason here, where the step works again, so a later pause or
            // stall cannot inherit it. `requeue-step` carries it this far for the resume nudge.
            stalledReason: "gave-up",
            retryAt: null,
            queuedBy: null,
            queuedDetail: null,
            startedAt: command.createdAt,
            updatedAt: command.createdAt,
          }
        : current.status === "queued"
          ? // Re-recording which limit holds an already-queued step
            // touches only that: a resumed step waits queued on its own
            // thread, and dropping it would spawn a fresh one on admission.
            {
              ...current,
              queuedBy: command.queuedBy ?? null,
              queuedDetail: command.queuedDetail ?? null,
              updatedAt: command.createdAt,
            }
          : {
              ...current,
              status: "queued",
              threadId: null,
              slotHeld: false,
              // Which limit holds it; absent keeps plain "Queued".
              queuedBy: command.queuedBy ?? null,
              queuedDetail: command.queuedDetail ?? null,
              startedAt: null,
              updatedAt: command.createdAt,
            };
      return {
        ...(yield* makeBoardEventBase({
          cardId: command.cardId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        })),
        type: "board.card-step-admitted",
        payload: { cardId: command.cardId, state },
      };
    }

    case "board.card.await-step-input": {
      yield* requireActiveBoardCard({ board, command });
      const current = yield* requireLiveStepState({ board, command, stepId: command.stepId });
      if (current.status !== "running") {
        return yield* invariant(
          command,
          `Card '${command.cardId}' step '${command.stepId}' is '${current.status}', not running; cannot await input.`,
        );
      }
      // `question` when there is something to answer, `stopped` when a human-in-the-loop
      // turn ended. Either way the slot is RELEASED: no thread runs, so a parked card must
      // not hold capacity; on resume the step re-takes one.
      const state: BoardCardStepState = {
        ...current,
        status: "awaiting-input",
        awaitingReason: command.reason,
        slotHeld: false,
        updatedAt: command.createdAt,
      };
      return {
        ...(yield* makeBoardEventBase({
          cardId: command.cardId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        })),
        type: "board.card-step-awaiting-input",
        payload: { cardId: command.cardId, state },
      };
    }

    // Start a queued step over the concurrency cap. Names no step (one live step row
    // per card). Only `queued` is forceable: `pending` is not withheld yet, and every
    // other status is running or over.
    case "board.card.force-start-step": {
      yield* requireActiveBoardCard({ board, command });
      const current = boardCardStepState(board, command.cardId);
      if (current === null) {
        return yield* invariant(command, `Card '${command.cardId}' has no live step to start.`);
      }
      if (current.status !== "queued") {
        return yield* invariant(
          command,
          `Card '${command.cardId}' step '${current.stepId}' is '${current.status}', not queued; nothing to force-start.`,
        );
      }
      const state: BoardCardStepState = {
        ...current,
        forceStart: true,
        updatedAt: command.createdAt,
      };
      return {
        ...(yield* makeBoardEventBase({
          cardId: command.cardId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        })),
        type: "board.card-step-force-start-requested",
        payload: { cardId: command.cardId, state },
      };
    }

    case "board.card.recover-step": {
      yield* requireActiveBoardCard({ board, command });
      const current = yield* requireLiveStepState({ board, command, stepId: command.stepId });
      if (isBoardTerminalStepStatus(current.status)) {
        return yield* invariant(
          command,
          `Card '${command.cardId}' step '${command.stepId}' is settled ('${current.status}'); nothing to recover.`,
        );
      }
      // A step a human PAUSED is immune to recovery. This is the state-machine backstop
      // behind the reactor's own `running` gates.
      if (current.status === "paused") {
        return yield* invariant(
          command,
          `Card '${command.cardId}' step '${command.stepId}' is paused; a human stopped it, so it is not recovered.`,
        );
      }
      // Recovery reuses the held slot; escalation lands `stalled` and releases it.
      // `stageEntryRecoveries` feeds the runaway ceiling; `stallCount` resets on progress.
      // `lastError` is replaced, never merged. A quota park spends nothing and leaves
      // `lastNudgeAt` alone.
      const charge = command.chargeBudget ?? true;
      // The budget resets when the woken turn did real work. `stageEntryRecoveries` is
      // NOT reset: it alone bounds a card looping productively-looking for ever.
      const state: BoardCardStepState = {
        ...current,
        attempt: charge ? (command.progressed ? 1 : current.attempt + 1) : current.attempt,
        stallCount: charge ? (command.progressed ? 0 : current.stallCount) + 1 : current.stallCount,
        // The runaway ceiling's counter: a recovery — a nudge, an
        // escalation, or a spawn failure — is the ONLY thing that spends it.
        stageEntryRecoveries: charge
          ? current.stageEntryRecoveries + 1
          : current.stageEntryRecoveries,
        status: command.escalateToHuman ? "stalled" : "running",
        slotHeld: command.escalateToHuman ? false : current.slotHeld,
        threadId: command.threadId,
        lastError: command.lastError ?? null,
        // Why it stalled and when it next tries. Both are
        // REPLACED, never merged, for the same reason `lastError` is: a nudge
        // that puts the step back to running must not leave the card promising a
        // retry that has already happened.
        stalledReason: command.escalateToHuman ? (command.stalledReason ?? "gave-up") : "gave-up",
        retryAt: command.retryAt ?? null,
        lastNudgeAt: charge ? command.createdAt : current.lastNudgeAt,
        updatedAt: command.createdAt,
      };
      return {
        ...(yield* makeBoardEventBase({
          cardId: command.cardId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        })),
        type: "board.card-step-recovered",
        payload: { cardId: command.cardId, state },
      };
    }

    // A human stopped the step: park it, slot released, thread and worktree kept.
    // Accepted from `running`, `awaiting-input`, and `stalled` (the interrupted turn's
    // completion can escalate first; Stop downgrades it to `paused`). `paused` is
    // already there, which ends the reactor's re-interrupt.
    case "board.card.pause-step": {
      yield* requireActiveBoardCard({ board, command });
      const current = yield* requireLiveStepState({ board, command, stepId: command.stepId });
      if (
        current.status !== "running" &&
        current.status !== "awaiting-input" &&
        current.status !== "stalled"
      ) {
        return yield* invariant(
          command,
          `Card '${command.cardId}' step '${command.stepId}' is '${current.status}', not running, awaiting input or stalled; nothing to pause.`,
        );
      }
      // `attempt`, `stallCount` and `stageEntryRecoveries` are all UNTOUCHED:
      // the human asked for this, so it is not a stall and it spends none of the
      // recovery budget. `lastError` is cleared because a deliberate stop is not
      // a failure and the card must not wear the error from the stop before it.
      const state: BoardCardStepState = {
        ...current,
        status: "paused",
        slotHeld: false,
        lastError: null,
        updatedAt: command.createdAt,
      };
      return {
        ...(yield* makeBoardEventBase({
          cardId: command.cardId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        })),
        type: "board.card-step-paused",
        payload: { cardId: command.cardId, state },
      };
    }

    // The board-driven way out of a parked step: back to `queued` with no slot and
    // through the governor, KEEPING its thread so admission nudges the existing
    // conversation. Names no step (one live step row per card).
    case "board.card.requeue-step": {
      yield* requireActiveBoardCard({ board, command });
      const current = boardCardStepState(board, command.cardId);
      if (current === null) {
        return yield* invariant(command, `Card '${command.cardId}' has no live step to resume.`);
      }
      if (!isBoardParkedStepStatus(current.status)) {
        return yield* invariant(
          command,
          `Card '${command.cardId}' step '${current.stepId}' is '${current.status}', not parked; nothing to resume.`,
        );
      }
      // A human resume resets the ladder, like `resume-step`. A timer-driven board
      // resume does not: the clock advancing proves nothing, and resetting would let a
      // dead card be nudged for ever.
      const preserve = command.preserveBudget ?? false;
      const state: BoardCardStepState = {
        ...current,
        status: "queued",
        stallCount: preserve ? current.stallCount : 0,
        lastError: null,
        // The stall reason survives the requeue so admission knows what to say when it
        // nudges. Carried only off a `stalled` park; `admit-step` clears it.
        stalledReason: current.status === "stalled" ? current.stalledReason : "gave-up",
        retryAt: null,
        slotHeld: false,
        startedAt: null,
        updatedAt: command.createdAt,
      };
      return {
        ...(yield* makeBoardEventBase({
          cardId: command.cardId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        })),
        type: "board.card-step-recovered",
        payload: { cardId: command.cardId, state },
      };
    }

    case "board.card.resume-step": {
      yield* requireActiveBoardCard({ board, command });
      const current = yield* requireLiveStepState({ board, command, stepId: command.stepId });
      // Every parked status (`stalled`, `awaiting-input`, `paused`) resumes when a human
      // sends a turn into the step's thread.
      if (!isBoardParkedStepStatus(current.status)) {
        return yield* invariant(
          command,
          `Card '${command.cardId}' step '${command.stepId}' is '${current.status}', not parked; nothing to resume.`,
        );
      }
      // A human sent a turn into a parked step's thread, so it is running again. `attempt`
      // and `stageEntryRecoveries` count BOARD work and are untouched; `stallCount` resets.
      // The slot is TAKEN unconditionally (the agent is already working) and released once
      // at settle. `lastNudgeAt` moves to now.
      const state: BoardCardStepState = {
        ...current,
        status: "running",
        stallCount: 0,
        lastError: null,
        slotHeld: current.mode === "build",
        // The step is working again, so its park is over: a resumed card must not leave
        // a running row claiming `usage-limit` with a future `retryAt`.
        stalledReason: "gave-up",
        retryAt: null,
        lastNudgeAt: command.createdAt,
        updatedAt: command.createdAt,
      };
      return {
        ...(yield* makeBoardEventBase({
          cardId: command.cardId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        })),
        type: "board.card-step-recovered",
        payload: { cardId: command.cardId, state },
      };
    }

    case "board.card.settle-step": {
      // A card can be settled while archived (an abandonment at archive), so
      // require the card exists but not that it is active.
      yield* requireBoardCard({ board, command });
      const current = boardCardStepState(board, command.cardId);
      if (current === null || current.stepId !== command.stepId) {
        return yield* invariant(
          command,
          `Card '${command.cardId}' has no live step '${command.stepId}' to settle.`,
        );
      }
      // Idempotency: a step already settled re-emits its recorded
      // terminal state, so a raced double settle releases the slot once and
      // never double-transitions. The first outcome wins.
      const state: BoardCardStepState = isBoardTerminalStepStatus(current.status)
        ? current
        : {
            ...current,
            status: command.outcome,
            slotHeld: false,
            updatedAt: command.createdAt,
          };
      return {
        ...(yield* makeBoardEventBase({
          cardId: command.cardId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        })),
        type: "board.card-step-settled",
        payload: { cardId: command.cardId, state },
      };
    }

    case "board.card.retune-step": {
      yield* requireActiveBoardCard({ board, command });
      const current = yield* requireLiveStepState({ board, command, stepId: command.stepId });
      // Slot, worktree and thread are untouched — only the frozen
      // human-in-the-loop stance changes, so drop-monitoring honours the new
      // value.
      const state: BoardCardStepState = {
        ...current,
        humanInLoop: command.humanInLoop,
        updatedAt: command.createdAt,
      };
      return {
        ...(yield* makeBoardEventBase({
          cardId: command.cardId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        })),
        type: "board.card-step-retuned",
        payload: { cardId: command.cardId, state },
      };
    }

    case "board.card.note-human-turn": {
      yield* requireActiveBoardCard({ board, command });
      const current = yield* requireLiveStepState({ board, command, stepId: command.stepId });
      // A human's own turn is neither a board invocation nor a board recovery,
      // so `attempt` and `stageEntryRecoveries` do not move — the argument
      // `board.card.resume-step` already makes. Slot, worktree, thread and
      // status are untouched: this records who is driving, not what is running.
      const state: BoardCardStepState =
        command.at === null
          ? // The free ending has been spent. Nothing else moves:
            // the ladder was already reset when the turn was recorded.
            { ...current, humanTurnAt: null, updatedAt: command.createdAt }
          : {
              ...current,
              humanTurnAt: command.at,
              // The human steered, so the recovery ladder starts over and the "since the last
              // nudge" boundary moves to the human's turn.
              stallCount: 0,
              lastNudgeAt: command.at,
              updatedAt: command.createdAt,
            };
      return {
        ...(yield* makeBoardEventBase({
          cardId: command.cardId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        })),
        type: "board.card-step-steered",
        payload: { cardId: command.cardId, state },
      };
    }

    // Only a RUNNING step is checked in on. Status, slot and thread are untouched. A
    // charged check-in spends budget like an unprogressed recovery, so the ceilings
    // still escalate a background job that never ends.
    case "board.card.check-in-step": {
      yield* requireActiveBoardCard({ board, command });
      const current = yield* requireLiveStepState({ board, command, stepId: command.stepId });
      if (current.status !== "running") {
        return yield* invariant(
          command,
          `Card '${command.cardId}' step '${command.stepId}' is '${current.status}', not running; nothing to check in on.`,
        );
      }
      // Progress resets the ladder exactly as it does on `recover-step`;
      // `stageEntryRecoveries` is never reset, for the same reason.
      const state: BoardCardStepState = {
        ...current,
        attempt: command.progressed ? 1 : command.charged ? current.attempt + 1 : current.attempt,
        stallCount: (command.progressed ? 0 : current.stallCount) + (command.charged ? 1 : 0),
        stageEntryRecoveries: command.charged
          ? current.stageEntryRecoveries + 1
          : current.stageEntryRecoveries,
        lastNudgeAt: command.createdAt,
        ...(command.reopenedPrompt === true ? { reopenedPromptAt: command.createdAt } : {}),
        updatedAt: command.createdAt,
      };
      return {
        ...(yield* makeBoardEventBase({
          cardId: command.cardId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        })),
        type: "board.card-step-checked-in",
        payload: { cardId: command.cardId, state, charged: command.charged },
      };
    }

    // ── Worker registry ────────────────────────────────
    // Keyed on the worker, never a card. What happens to cards placed on a
    // removed worker belongs to the removal fallback, not here.
    // A project's delta, edited in Settings or imported.
    case "board.project.set-stage-switch":
    case "board.project.set-stage-override":
    case "board.project.set-ci-steps":
    case "board.project.set-ci-enabled":
    case "board.project.set-ci-stop-on-failure":
    case "board.project.set-resources":
    // T3o: the board's learned baseline (T3O-87).
    case "board.project.record-learned":
    case "board.project.reset":
    case "board.project.import-file":
    case "board.project.dismiss-import":
      return yield* decideProjectConfigCommand(board, command);

    case "board.worker.register": {
      if (command.worker.id === BOARD_LOCAL_WORKER_ID) {
        return yield* invariant(command, "The server hosting the board is already a worker.");
      }
      const existing = (board.workers ?? []).find((worker) => worker.id === command.worker.id);
      if (command.mode === "add" && existing !== undefined) {
        return yield* invariant(command, `${existing.label} is already a worker.`);
      }
      if (command.mode !== "add" && existing === undefined) {
        return yield* invariant(command, `Worker '${command.worker.id}' is not registered.`);
      }
      // T3o (T3O-84): an abbreviation is unique on the board, and `SRV` is the board server's.
      const abbreviation =
        command.mode === "rename"
          ? command.worker.abbreviation
          : (existing?.abbreviation ?? command.worker.abbreviation);
      if (abbreviation !== undefined) {
        if (abbreviation === BOARD_LOCAL_WORKER_ABBREVIATION) {
          return yield* invariant(command, `${abbreviation} is reserved for the board server.`);
        }
        const holder = (board.workers ?? []).find(
          (worker) => worker.id !== command.worker.id && worker.abbreviation === abbreviation,
        );
        if (holder !== undefined) {
          return yield* invariant(command, `${holder.label} already uses ${abbreviation}.`);
        }
      }
      // A re-join keeps the label, abbreviation and when it was added; it refreshes the
      // release and join time, and drops a direct-dial URL. A rename changes only names.
      const { url: _droppedUrl, ...existingWithoutUrl } = existing ?? command.worker;
      const worker =
        existing === undefined
          ? command.worker
          : command.mode === "rename"
            ? {
                ...existing,
                label: command.worker.label,
                ...(abbreviation === undefined ? {} : { abbreviation }),
              }
            : {
                ...existingWithoutUrl,
                ...(abbreviation === undefined ? {} : { abbreviation }),
                ...(command.worker.url === undefined ? {} : { url: command.worker.url }),
                ...(command.worker.t3oRelease === undefined
                  ? {}
                  : { t3oRelease: command.worker.t3oRelease }),
                ...(command.worker.joinedAt === undefined
                  ? {}
                  : { joinedAt: command.worker.joinedAt }),
              };
      const registered: PlannedBoardEvent = {
        ...(yield* makeBoardWorkerEventBase({
          workerId: worker.id,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        })),
        type: "board.worker-registered",
        payload: { worker },
      };
      // A server added back with the same environment id reattaches the cards
      // its removal left holding: they are placed there again.
      const reattached: PlannedBoardEvent[] = [];
      for (const card of command.mode === "rename" ? [] : board.cards) {
        if (card.placementOrphaned?.workerId !== worker.id) continue;
        // T3o: only a card still placed there reattaches; one placed elsewhere since is the
        // orphan sweep's (T3O-87).
        if (card.placedWorkerId !== null && card.placedWorkerId !== worker.id) continue;
        reattached.push({
          ...(yield* makeBoardEventBase({
            cardId: card.id,
            occurredAt: command.createdAt,
            commandId: command.commandId,
          })),
          type: "board.card-worker-removal",
          payload: {
            cardId: card.id,
            workerId: worker.id,
            workerLabel: worker.label,
            outcome: "reattached",
            card: { ...card, placementOrphaned: null, updatedAt: command.createdAt },
          },
        });
      }
      return reattached.length === 0 ? registered : [registered, ...reattached];
    }

    case "board.worker.remove": {
      // `local` is never a registry row, but an environment id is just a
      // string: say why rather than "not registered".
      if (command.workerId === BOARD_LOCAL_WORKER_ID) {
        return yield* invariant(command, "The server hosting the board can't be removed.");
      }
      const existing = (board.workers ?? []).find((worker) => worker.id === command.workerId);
      if (existing === undefined) {
        return yield* invariant(command, `Worker '${command.workerId}' is not registered.`);
      }
      const removed: PlannedBoardEvent = {
        ...(yield* makeBoardWorkerEventBase({
          workerId: command.workerId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        })),
        type: "board.worker-removed",
        payload: { workerId: command.workerId },
      };
      // Decided with the removal so no card points at a worker that is gone: a card
      // with nothing there follows the default worker; one with a worktree or a running
      // step holds for a human. Archived cards too.
      const cardEvents: PlannedBoardEvent[] = [];
      const afterRemoval = new Map<BoardCardId, BoardCard>();
      // T3o: the removal sequence classified each card it probed (T3O-87).
      const classified = new Map(
        (command.classifications ?? []).map((entry) => [entry.cardId, entry.outcome]),
      );
      const withoutWorker = (card: BoardCard): Pick<BoardCard, "pinnedWorkerId"> => ({
        pinnedWorkerId: card.pinnedWorkerId === command.workerId ? null : card.pinnedWorkerId,
      });
      const unplacedResources = (card: BoardCard) =>
        card.resources === null
          ? null
          : withoutEmptyResources({ ...card.resources, grant: null, placement: null });
      for (const card of board.cards) {
        // A worktree outcome stands only while the card still has its worktree there: a Move
        // that landed since the probe keeps its new one.
        const probed = classified.get(card.id);
        const classification =
          probed === "unplaced" ||
          (card.placedWorkerId === command.workerId && boardCardHoldsWorktree(card))
            ? probed
            : undefined;
        if (classification === "reclaimed" || classification === "fresh") {
          const nextCard: BoardCard = {
            ...card,
            ...withoutWorker(card),
            placedWorkerId: null,
            worktree:
              classification === "fresh" || card.worktree === null
                ? null
                : { ...card.worktree, status: "reclaimed", path: null },
            resources: unplacedResources(card),
            updatedAt: command.createdAt,
          };
          afterRemoval.set(card.id, nextCard);
          cardEvents.push({
            ...(yield* makeBoardEventBase({
              cardId: card.id,
              occurredAt: command.createdAt,
              commandId: command.commandId,
            })),
            type: "board.card-worker-removal",
            payload: {
              cardId: card.id,
              workerId: command.workerId,
              workerLabel: existing.label,
              outcome: "reclaimed",
              card: nextCard,
            },
          });
          continue;
        }
        const derived = boardCardWorkerRemovalOutcome(
          card,
          boardCardStepState(board, card.id),
          command.workerId,
        );
        const outcome =
          classification === "orphaned"
            ? "orphaned"
            : classification === "unplaced" && derived !== null
              ? "fallback"
              : derived;
        if (outcome === null) continue;
        const nextCard: BoardCard =
          outcome === "orphaned"
            ? {
                ...card,
                placementOrphaned: {
                  workerId: command.workerId,
                  workerLabel: existing.label,
                  orphanedAt: command.createdAt,
                },
                updatedAt: command.createdAt,
              }
            : {
                ...card,
                ...withoutWorker(card),
                placedWorkerId:
                  card.placedWorkerId === command.workerId ? null : card.placedWorkerId,
                ...(card.placedWorkerId === command.workerId
                  ? { resources: unplacedResources(card) }
                  : {}),
                updatedAt: command.createdAt,
              };
        afterRemoval.set(card.id, nextCard);
        cardEvents.push({
          ...(yield* makeBoardEventBase({
            cardId: card.id,
            occurredAt: command.createdAt,
            commandId: command.commandId,
          })),
          type: "board.card-worker-removal",
          payload: {
            cardId: card.id,
            workerId: command.workerId,
            workerLabel: existing.label,
            outcome,
            card: nextCard,
          },
        });
      }
      // A card moving TO the removed worker can't land there: its move fails
      // now, so the card shows Move failed and a human picks another worker.
      // The mover's own last step then finds nothing moving and is dropped.
      for (const card of board.cards) {
        const move = card.workerMove;
        if (move?.status !== "moving" || move.toWorkerId !== command.workerId) continue;
        const current = afterRemoval.get(card.id) ?? card;
        const step = {
          phase: "failed" as const,
          error: `${existing.label} was removed from the board during the move.`,
        };
        const failed: BoardCardWorkerMove = { ...move, status: "failed", error: step.error };
        cardEvents.push({
          ...(yield* makeBoardEventBase({
            cardId: card.id,
            occurredAt: command.createdAt,
            commandId: command.commandId,
          })),
          type: "board.card-worker-move-recorded",
          payload: {
            cardId: card.id,
            step,
            move: failed,
            card: {
              ...current,
              workerMove: boardCardHoldsWorktree(current) ? null : failed,
              updatedAt: command.createdAt,
            },
          },
        });
      }
      return cardEvents.length === 0 ? removed : [removed, ...cardEvents];
    }

    case "board.card.pin-worker": {
      const card = yield* requireActiveBoardCard({ board, command });
      if (command.workerId !== null && !isKnownBoardWorker(board, command.workerId)) {
        return yield* invariant(command, `Worker '${command.workerId}' is not registered.`);
      }
      if (card.workerMove !== null) {
        return yield* invariant(
          command,
          card.workerMove.status === "moving"
            ? `Card '${card.key}' is moving to another worker; wait for the move to finish.`
            : `Card '${card.key}''s last move failed; retry it or move it to another worker.`,
        );
      }
      // A card with a worktree is bound to its worker: changing that is a
      // move, which checks the work is pushed first. A pin that lands where the
      // worktree already is changes nothing about where the card runs.
      // T3o: Unpin on a placed card leaves it where it is (T3O-87).
      if (boardCardHoldsWorktree(card) && command.workerId !== null) {
        const current = boardCardEffectiveWorkerId(card);
        const target = command.workerId;
        if (target !== current) {
          return yield* invariant(
            command,
            `Card '${card.key}' has a worktree on worker '${current}'; move it to change where it runs.`,
          );
        }
      }
      // A card held by its worker's removal with no worktree (a running
      // planning step, stopped) is moved by a pin, which ends the hold.
      if (card.pinnedWorkerId === command.workerId && card.placementOrphaned === null) return [];
      const nextCard: BoardCard = {
        ...card,
        placementOrphaned: null,
        pinnedWorkerId: command.workerId,
        // No checkout binds it, so its next thread spawns on the new choice;
        // earlier threads keep the worker their links name.
        placedWorkerId: boardCardHoldsWorktree(card) ? card.placedWorkerId : null,
        updatedAt: command.createdAt,
      };
      return {
        ...(yield* makeBoardEventBase({
          cardId: command.cardId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        })),
        type: "board.card-worker-pinned",
        payload: { cardId: command.cardId, workerId: command.workerId, card: nextCard },
      };
    }

    case "board.card.place": {
      const card = yield* requireActiveBoardCard({ board, command });
      if (!isKnownBoardWorker(board, command.workerId)) {
        return yield* invariant(command, `Worker '${command.workerId}' is not registered.`);
      }
      if (boardCardHoldsWorktree(card)) {
        const current = boardCardEffectiveWorkerId(card);
        if (current !== command.workerId) {
          return yield* invariant(
            command,
            `Card '${card.key}' has a worktree on worker '${current}'; only a move places it elsewhere.`,
          );
        }
      } else if (card.pinnedWorkerId !== null && card.pinnedWorkerId !== command.workerId) {
        // A pin that landed after the pass ranked the card's workers.
        return yield* invariant(
          command,
          `Card '${card.key}' is pinned to worker '${card.pinnedWorkerId}'; it can't be placed on '${command.workerId}'.`,
        );
      }
      const placement = {
        workerId: command.workerId,
        at: command.createdAt,
        reason: command.reason ?? null,
      };
      if (
        card.placedWorkerId === command.workerId &&
        command.grantedProfile === undefined &&
        command.reason === undefined
      ) {
        return [];
      }
      // T3o: the gate's grant and its reason are on record before the provision (T3O-87).
      const base = card.resources ?? EMPTY_BOARD_CARD_RESOURCES;
      const resources: BoardCardResources = {
        ...base,
        placement,
        ...(command.grantedProfile === undefined
          ? {}
          : {
              grant: {
                profile: command.grantedProfile,
                heavy: command.heavyGranted ?? true,
                claimId: command.claimId ?? null,
                grantedAt: command.createdAt,
                settled: false,
              },
            }),
      };
      const nextCard: BoardCard = {
        ...card,
        placedWorkerId: command.workerId,
        resources,
        updatedAt: command.createdAt,
      };
      return {
        ...(yield* makeBoardEventBase({
          cardId: command.cardId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        })),
        type: "board.card-placed",
        payload: { cardId: command.cardId, workerId: command.workerId, card: nextCard },
      };
    }

    case "board.card.move-worker": {
      const card = yield* requireActiveBoardCard({ board, command });
      const { step } = command;
      const move = card.workerMove;
      let nextCard: BoardCard;
      let recorded: BoardCardWorkerMove;
      if (step.phase === "start") {
        if (!isKnownBoardWorker(board, step.toWorkerId)) {
          return yield* invariant(command, `Worker '${step.toWorkerId}' is not registered.`);
        }
        if (move?.status === "moving") {
          return yield* invariant(command, `Card '${card.key}' is already moving.`);
        }
        const live = boardCardStepState(board, card.id);
        // A force-move leaves a worker the board can't reach, where a
        // step may still read as running: the supervisor stalls it off this
        // event, and it continues on the new worker.
        if (
          step.force !== true &&
          live !== null &&
          (live.status === "running" || live.status === "completing")
        ) {
          return yield* invariant(
            command,
            `Card '${card.key}' has a step running; wait for it to finish or stop it, then move the card.`,
          );
        }
        const holds = boardCardHoldsWorktree(card);
        if (holds && card.worktree?.status !== "ready") {
          return yield* invariant(
            command,
            `Card '${card.key}''s worktree is still being created; move it once it is ready.`,
          );
        }
        // Only a card with work to carry is moved; one without is re-pinned.
        if (!holds && move === null) {
          return yield* invariant(
            command,
            `Card '${card.key}' has no worktree to move; pin it to the worker instead.`,
          );
        }
        const from = holds ? boardCardEffectiveWorkerId(card) : null;
        if (from === step.toWorkerId) {
          return yield* invariant(
            command,
            `Card '${card.key}' is already on worker '${step.toWorkerId}'.`,
          );
        }
        recorded = {
          fromWorkerId: from ?? move?.fromWorkerId ?? null,
          toWorkerId: step.toWorkerId,
          status: "moving",
          sha: step.sha,
          error: null,
          startedAt: command.createdAt,
        };
        nextCard = { ...card, workerMove: recorded, updatedAt: command.createdAt };
      } else {
        if (move === null || move.status !== "moving") {
          return yield* invariant(command, `Card '${card.key}' is not moving.`);
        }
        if (step.phase === "retired" || step.phase === "abandoned") {
          // `abandoned`: a force-move off a worker the board can't
          // reach leaves the old worktree there untouched — the event records
          // it — and is otherwise the same: the card is unassigned.
          recorded = move;
          // The old checkout is gone; the branch is on the remote. Unassigned
          // until the new worktree is ready.
          nextCard = {
            ...card,
            worktree:
              card.worktree === null
                ? null
                : { ...card.worktree, path: null, status: "reclaimed", reclaimBlockedReason: null },
            placedWorkerId: null,
            // Off the removed worker for good: the hold is over.
            placementOrphaned: null,
            resources: withoutPlacement(card.resources),
            updatedAt: command.createdAt,
          };
        } else if (step.phase === "done") {
          if (card.worktree === null) {
            return yield* invariant(
              command,
              `Card '${card.key}' has no branch recorded; there is nothing the new worktree carries.`,
            );
          }
          // Never lands on a worker the board no longer has. Removing the
          // target fails a move in flight, so this only guards that.
          if (!isKnownBoardWorker(board, move.toWorkerId)) {
            return yield* invariant(
              command,
              `Worker '${move.toWorkerId}' is no longer registered; the move can't land there.`,
            );
          }
          recorded = move;
          nextCard = {
            ...card,
            worktree: {
              ...card.worktree,
              path: step.worktreePath,
              status: "ready",
              lastError: null,
              reclaimBlockedReason: null,
            },
            pinnedWorkerId: move.toWorkerId,
            placedWorkerId: move.toWorkerId,
            workerMove: null,
            placementOrphaned: null,
            // T3o: the moved worktree runs setup once (T3O-86); the Worker row names where it
            // landed (T3O-87).
            resources: {
              ...withSetupDue(card.resources),
              placement: { workerId: move.toWorkerId, at: command.createdAt, reason: "moved here" },
            },
            updatedAt: command.createdAt,
          };
        } else if (step.phase === "restarted") {
          // A force-move with nothing on the remote: the card's branch
          // is forgotten, so its next build cuts a fresh one from the base on
          // the new worker. The move is over; the card waits there.
          recorded = move;
          nextCard = {
            ...card,
            worktree: null,
            pinnedWorkerId: move.toWorkerId,
            placedWorkerId: null,
            workerMove: null,
            placementOrphaned: null,
            resources: withoutPlacement(card.resources),
            updatedAt: command.createdAt,
          };
        } else {
          recorded = { ...move, status: "failed", error: step.error };
          // Failing before the old worktree was retired leaves the card where
          // it was, worktree intact: the move is over, not Move failed, so the
          // card runs on and can be pinned or moved again. The event still
          // records the failure for the activity rail.
          nextCard = {
            ...card,
            workerMove: boardCardHoldsWorktree(card) ? null : recorded,
            updatedAt: command.createdAt,
          };
        }
      }
      return {
        ...(yield* makeBoardEventBase({
          cardId: command.cardId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        })),
        type: "board.card-worker-move-recorded",
        payload: { cardId: command.cardId, step, move: recorded, card: nextCard },
      };
    }

    case "board.worker.set-default": {
      if (
        command.workerId !== BOARD_LOCAL_WORKER_ID &&
        !(board.workers ?? []).some((worker) => worker.id === command.workerId)
      ) {
        return yield* invariant(command, `Worker '${command.workerId}' is not registered.`);
      }
      // Idempotent: choosing the worker that is already the default changes
      // nothing, so there is nothing to record.
      if ((board.defaultWorkerId ?? BOARD_LOCAL_WORKER_ID) === command.workerId) return [];
      return {
        ...(yield* makeBoardWorkerEventBase({
          workerId: command.workerId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        })),
        type: "board.default-worker-set",
        payload: { workerId: command.workerId },
      };
    }

    default: {
      command satisfies never;
      // Runtime backstop for undecoded input: fail loudly rather than let
      // the generator fall through and return `undefined` in place of an
      // event.
      const fallback = command as never as { readonly type: string };
      return yield* new BoardCommandInvariantError({
        commandType: fallback.type,
        detail: `Unhandled board command type: ${fallback.type}`,
      });
    }
  }
});

/**
 * Decide a board command: the command's own events, then — for the
 * commands that can change a child — the derived stages of every affected
 * group, in the same transaction.
 */
/**
 * The follow-up commands a compound group flow carries: the cards
 * a new heading or a cancelled card adopts, and where New phase lands them.
 * Decided in the same decision as the command itself, so the flow lands whole
 * or not at all.
 */
function boardAdoptionCommands(command: BoardCommand): ReadonlyArray<BoardCommand> {
  if (command.type !== "board.card.create" && command.type !== "board.card.cancel-work") {
    return [];
  }
  const cardIds = command.adoptCardIds ?? [];
  if (cardIds.length === 0) return [];
  const moveCards: BoardCommand = {
    type: "board.card.move-cards",
    commandId: command.commandId,
    cardId: cardIds[0]!,
    cardIds,
    parentCardId: command.cardId,
    createdAt: command.createdAt,
  };
  const adoptStage = command.type === "board.card.create" ? command.adoptStage : undefined;
  return [
    moveCards,
    ...(adoptStage === undefined
      ? []
      : cardIds.map((cardId): BoardCommand => ({
          type: "board.card.move",
          commandId: command.commandId,
          cardId,
          toStage: adoptStage,
          createdAt: command.createdAt,
        }))),
  ];
}

export const decideBoardCommand = Effect.fn("decideBoardCommand")(function* (input: {
  readonly command: BoardCommand;
  readonly readModel: BoardReadModel;
  readonly context?: BoardDecisionContext;
}): Effect.fn.Return<
  BoardDecision,
  BoardCommandInvariantError | PlatformError.PlatformError,
  SecureRandom.SecureRandom
> {
  const { command } = input;
  const followUps = boardAdoptionCommands(command);
  if (followUps.length === 0) return yield* decideOneBoardCommand(input);
  if (command.type === "board.card.create" && command.heading !== true) {
    return yield* invariant(command, "Only a new group heading can adopt cards.");
  }
  if (command.type === "board.card.create" && command.adoptCardIds?.includes(command.cardId)) {
    return yield* invariant(command, "A new group can't adopt itself.");
  }
  const events: Array<PlannedBoardEvent> = [];
  let board = input.readModel.board ?? EMPTY_BOARD_STATE;
  for (const step of [command, ...followUps]) {
    const decided = boardDecidedEvents(
      yield* decideOneBoardCommand({
        ...input,
        command: step,
        readModel: { ...input.readModel, board },
      }),
    );
    events.push(...decided);
    board = yield* projectPlannedBoardEvents(board, step, decided);
  }
  return events;
});

const decideOneBoardCommand = Effect.fn("decideOneBoardCommand")(function* (input: {
  readonly command: BoardCommand;
  readonly readModel: BoardReadModel;
  readonly context?: BoardDecisionContext;
}): Effect.fn.Return<
  BoardDecision,
  BoardCommandInvariantError | PlatformError.PlatformError,
  SecureRandom.SecureRandom
> {
  const decided = yield* decideBoardCommandCore(input);
  const command = input.command;
  if (!GROUP_DERIVING_COMMANDS.has(command.type)) return decided;
  const planned = boardDecidedEvents(decided);
  const derived = yield* deriveGroupEvents({
    before: input.readModel.board ?? EMPTY_BOARD_STATE,
    command: command as BoardCardCommand,
    planned,
  });
  if (derived.length === 0) return decided;
  return [...planned, ...derived];
});
