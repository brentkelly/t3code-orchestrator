/**
 * T3o board decider — `decideBoardCommand`.
 *
 * Pure decision logic for board commands, delegated to from the upstream
 * decider behind the `isBoardCommand` predicate. Mirrors the upstream decider
 * contract exactly: read model in, planned event(s) out, `Crypto` as the only
 * requirement (D8 — the decider has no SQL client).
 *
 * Key allocation assumption: the per-project key prefix is a *setting* in the
 * spec, but the settings surface does not land until t3o-07. Until then the
 * create command carries an optional `keyPrefix` and falls back to
 * `DEFAULT_BOARD_KEY_PREFIX`; t3o-07 wires the real settings source into the
 * dispatch site with no schema change here. The number half of the key comes
 * from `nextCardNumberByProject` in the read model, so allocation is exact
 * and race-free under the engine's total command ordering.
 *
 * Stage advancement (t3o-15, D8): a card advances either by a client move
 * command (the human gate) or by the reactor's auto-advance — a successful
 * unattended run dispatches an ordinary `board.card.move` to the next stage in
 * order. The decider validates every move the same way regardless of who sent
 * it; it never advances a card on its own.
 */
import {
  areBoardStagesAdjacent,
  BOARD_CARD_BRIEF_BODY_KIND,
  BOARD_CARD_LABELS_MAX,
  boardAppendOrderKey,
  boardCardChildren,
  boardCardPendingSplit,
  boardCardPlans,
  boardCardUnfinishedChildren,
  BoardCardId,
  BoardCardModelOverrides,
  isEmptyBoardCardModelOverrides,
  boardSubBoardFloorStage,
  isBoardStageAtOrAfterSubBoardFloor,
  boardCardPullRequestsEqual,
  BOARD_REVIEW_MAX_ROUNDS,
  boardCardDeletableThreadIds,
  boardCardStepCompletions,
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
  boardStagesInOrder,
  boardStageWithRole,
  compareBoardStages,
  DEFAULT_BOARD_KEY_PREFIX,
  deriveBoardCardBlocked,
  effectiveBoardStageRole,
  EMPTY_BOARD_STATE,
  EventId,
  isBoardCommand,
  isBoardStageAtOrAfterBuild,
  isBoardTerminalStepStatus,
  isEmptyBoardCardReviewOverrides,
  pickNextBoardLabelColour,
  BOARD_CARD_ATTACHMENTS_MAX,
  sortBoardCardAttachments,
  sortBoardCardThreadLinks,
  unmetBoardCardDependencies,
  type BoardCard,
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
  type OrchestrationCommand,
  type OrchestrationEvent,
  type OrchestrationReadModel,
} from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import type * as PlatformError from "effect/PlatformError";

import { OrchestrationCommandInvariantError } from "../orchestration/Errors.ts";
import { requireProject } from "../orchestration/commandInvariants.ts";

export type BoardCommand = Extract<OrchestrationCommand, { type: `board.${string}` }>;

/** Label commands (t3o-06a) aggregate on the label, not the card — they carry
    `labelId` instead of `cardId`. Keyed on the `board.label.` prefix. */
type BoardLabelCommand = Extract<BoardCommand, { type: `board.label.${string}` }>;
function isBoardLabelCommand(command: BoardCommand): command is BoardLabelCommand {
  return command.type.startsWith("board.label.");
}

/** Stage-aggregate commands (t3o-15) aggregate on the stage — they carry
    `stageId` instead of `cardId`. Keyed on the `board.stage.` prefix. */
type BoardStageCommand = Extract<BoardCommand, { type: `board.stage.${string}` }>;
function isBoardStageCommand(command: BoardCommand): command is BoardStageCommand {
  return command.type.startsWith("board.stage.");
}

/** Card-aggregate commands — every board command except the label and stage
    ones; the only commands that carry a `cardId`. */
type BoardCardCommand = Exclude<BoardCommand, BoardLabelCommand | BoardStageCommand>;

// Re-exported so upstream seams import predicate + delegate on one line.
export { isBoardCommand };

// Distributive so the planned event stays a discriminated union — a plain
// `Omit` over the union flattens `type` and `payload` into independent
// unions and callers could no longer narrow payloads by event type.
type DistributiveOmit<T, K extends keyof T> = T extends unknown ? Omit<T, K> : never;
type PlannedOrchestrationEvent = DistributiveOmit<OrchestrationEvent, "sequence">;

/**
 * What one board command decides. Almost every command decides a single
 * event; archive and unarchive decide a list, because releasing or re-arming
 * a dependency gate re-flags the cards on the other end of the edge (t3o-13,
 * D5), and delete decides a list for the same reason plus the edge rewrites
 * a permanent removal forces. The engine accepts either.
 */
export type BoardDecision = PlannedOrchestrationEvent | ReadonlyArray<PlannedOrchestrationEvent>;

/** A decision as the list the engine appends — the single-event case is a
    list of one. Discriminated on `type`, which every event has and no array
    does: `Array.isArray` narrows to `any[]` and leaks `any` into the result. */
export function boardDecidedEvents(
  decided: BoardDecision,
): ReadonlyArray<PlannedOrchestrationEvent> {
  return "type" in decided ? [decided] : decided;
}

/**
 * Aggregate ref for a board command — every board command aggregates on its
 * card (D9). Called from `commandToAggregateRef` in the upstream engine
 * behind the `isBoardCommand` predicate.
 */
export function boardCommandAggregateRef(command: BoardCommand): {
  readonly aggregateKind: "card" | "label" | "stage";
  readonly aggregateId: BoardCardId | BoardLabelId | BoardStageId;
} {
  if (isBoardLabelCommand(command)) {
    return { aggregateKind: "label", aggregateId: command.labelId };
  }
  if (isBoardStageCommand(command)) {
    return { aggregateKind: "stage", aggregateId: command.stageId };
  }
  return { aggregateKind: "card", aggregateId: command.cardId };
}

const invariant = (command: BoardCommand, detail: string) =>
  new OrchestrationCommandInvariantError({ commandType: command.type, detail });

function requireBoardCard(input: {
  readonly board: BoardState;
  readonly command: BoardCardCommand;
}): Effect.Effect<BoardCard, OrchestrationCommandInvariantError> {
  const card = input.board.cards.find((candidate) => candidate.id === input.command.cardId);
  return card === undefined
    ? Effect.fail(invariant(input.command, `Card '${input.command.cardId}' does not exist.`))
    : Effect.succeed(card);
}

function requireActiveBoardCard(input: {
  readonly board: BoardState;
  readonly command: BoardCardCommand;
}): Effect.Effect<BoardCard, OrchestrationCommandInvariantError> {
  return requireBoardCard(input).pipe(
    Effect.filterOrFail(
      (card) => card.archivedAt === null,
      () => invariant(input.command, `Card '${input.command.cardId}' is archived.`),
    ),
  );
}

/**
 * The card's live step state, required to exist and match the command's
 * `stepId` (t3o-10). The reactor is the only dispatcher of the step-lifecycle
 * commands and always acts on the card's one current step, so a mismatch is a
 * bug (a stale command for a superseded step), rejected rather than applied.
 */
function requireLiveStepState(input: {
  readonly board: BoardState;
  readonly command: BoardCardCommand;
  readonly stepId: string;
}): Effect.Effect<BoardCardStepState, OrchestrationCommandInvariantError> {
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

/**
 * First dependency edge of `proposed` whose addition closes a cycle, with
 * the closing path for the rejection message. The graph is every card's
 * `dependsOn` with `cardId`'s list replaced by the proposed one.
 */
function findDependencyCycle(input: {
  readonly board: BoardState;
  readonly cardId: BoardCardId;
  readonly proposed: ReadonlyArray<BoardCardId>;
}): {
  readonly edgeFrom: BoardCardId;
  readonly edgeTo: BoardCardId;
  readonly path: ReadonlyArray<BoardCardId>;
} | null {
  const dependsOnById = new Map<BoardCardId, ReadonlyArray<BoardCardId>>(
    input.board.cards.map((card) => [card.id, card.dependsOn]),
  );
  dependsOnById.set(input.cardId, input.proposed);

  // A proposed edge cardId -> dependency closes a cycle iff cardId is
  // reachable from that dependency. DFS returns the path for the message.
  const pathTo = (
    from: BoardCardId,
    target: BoardCardId,
    seen: Set<BoardCardId>,
  ): ReadonlyArray<BoardCardId> | null => {
    if (from === target) return [from];
    if (seen.has(from)) return null;
    seen.add(from);
    for (const next of dependsOnById.get(from) ?? []) {
      const rest = pathTo(next, target, seen);
      if (rest !== null) return [from, ...rest];
    }
    return null;
  };

  for (const dependency of input.proposed) {
    const path = pathTo(dependency, input.cardId, new Set());
    if (path !== null) {
      return { edgeFrom: input.cardId, edgeTo: dependency, path: [input.cardId, ...path] };
    }
  }
  return null;
}

/**
 * First dependency edge within a plan proposal (keyed by plan `key`) whose
 * addition closes a cycle, with the closing path for the rejection message.
 * The proposal is self-contained — every edge references a key in the same
 * array — so the graph is exactly the proposed `dependsOn` sets. Mirrors
 * `findDependencyCycle` for cards; kept separate because plans are keyed by
 * their proposal-local slug, not a `BoardCardId`.
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
  const crypto = yield* Crypto.Crypto;
  const eventId = yield* crypto.randomUUIDv4;
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

/**
 * The `board.card-updated` events that keep dependents' stored `blocked`
 * honest when `changed` is archived or restored (t3o-13, D5).
 *
 * `blocked` is a column, re-derived at each move / dependency edit; archiving
 * now changes what a dependency means (D1), so the flag on every dependent
 * would otherwise go stale — a card wearing a blocked badge the decider will
 * happily move. Deriving against the card set with `changed` substituted in
 * gives the post-event answer, and only a card whose flag actually flips
 * emits, so a no-op archive stays a one-event command.
 *
 * One level deep is complete: the gate reads only a card's own `dependsOn`,
 * so blocking never propagates past the direct dependents.
 */
const boardDependentBlockedEvents = Effect.fn("boardDependentBlockedEvents")(function* (input: {
  readonly board: BoardState;
  readonly command: BoardCardCommand;
  readonly changed: BoardCard;
}): Effect.fn.Return<
  ReadonlyArray<PlannedOrchestrationEvent>,
  PlatformError.PlatformError,
  Crypto.Crypto
> {
  const cards = input.board.cards.map((card) =>
    card.id === input.changed.id ? input.changed : card,
  );
  const events: PlannedOrchestrationEvent[] = [];
  for (const dependent of cards) {
    if (dependent.id === input.changed.id) continue;
    if (dependent.archivedAt !== null) continue;
    if (!dependent.dependsOn.includes(input.changed.id)) continue;
    const blocked = deriveBoardCardBlocked({
      board: input.board,
      stage: dependent.stage,
      dependsOn: dependent.dependsOn,
      cards,
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

/**
 * Per-card model overrides (t3o-29, D1). One rule: every key must name a stage
 * the board actually has.
 *
 * The client is not the guard. The popover only ever writes the build- and
 * review-role stage ids, but a stale one — held open while the pipeline was
 * edited in another tab — would write an id for a stage that no longer exists,
 * and the entry would then sit in the column where no resolver could ever read
 * it. The user would have set a model and be watching the card run on a
 * different one, with nothing anywhere saying why. Rejecting is the only
 * outcome that cannot lie.
 *
 * An emptied map normalises to `null` so a cleared override and one that was
 * never set stay indistinguishable in the read model — the same rule the
 * projection's NULL column encodes, and what keeps replay equal to rehydration.
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
 * Validate and normalise a card's incoming review-loop overrides (t3o-22).
 *
 * Two rules, both here rather than in the pane, because the client is not the
 * guard and a stale pane must never be able to strand a live run:
 *
 *  - **A round that has STARTED can never be removed** (D3). The floor is the
 *    highest round the loop has entered — counting the round whose review is in
 *    flight with no completion yet, which is precisely the dangerous case:
 *    dropping the budget below it would leave a running agent whose completion
 *    lands beyond the cap, a walk that never reaches it again, and a wedged
 *    loop holding a concurrency slot.
 *  - **A stop cannot outlive a decision to buy more rounds** (D5). Raising the
 *    budget is the later expression of intent, so it clears a pending stop;
 *    otherwise the executor would keep terminating at the stopped round and the
 *    extra rounds could never run.
 *
 * Setting a stop for a round the loop is already past is rejected rather than
 * silently dropped — nothing in the UI does it, so it is a caller bug worth
 * surfacing.
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

  if (proposed.rounds !== null) {
    if (proposed.rounds < roundsStarted) {
      return yield* invariant(
        command,
        `Cannot set the review budget to ${proposed.rounds} round(s) for card '${card.id}': round ${roundsStarted} has already started and cannot be removed.`,
      );
    }
    if (proposed.rounds > BOARD_REVIEW_MAX_ROUNDS) {
      return yield* invariant(
        command,
        `Review budget of ${proposed.rounds} rounds for card '${card.id}' exceeds the ceiling of ${BOARD_REVIEW_MAX_ROUNDS}.`,
      );
    }
  }

  // Does this write ask the loop to run PAST a pending stop?
  //
  // Not "is the budget bigger than last time" — the pane's resume names an
  // absolute round, so a card whose budget was raised to 8 and then stopped at
  // 2 sends `rounds: 3` to resume, which is smaller than 8 and would read as
  // "not a raise". The stop would survive, the executor would terminate on it
  // again, and the button would be inert forever.
  //
  // What actually matters is whether the requested budget reaches past the
  // stop, and whether the budget MOVED at all — a stop set while the budget
  // stays put is the stop button doing its job, not a contradiction. D5's rule
  // stated exactly: raising the budget past a stop clears it.
  const roundsChanged =
    proposed.rounds !== null && proposed.rounds !== (card.reviewOverrides?.rounds ?? null);
  const raisedRounds =
    roundsChanged &&
    proposed.rounds !== null &&
    (proposed.stopAfterRound === null || proposed.rounds > proposed.stopAfterRound);

  if (
    proposed.stopAfterRound !== null &&
    !raisedRounds &&
    proposed.stopAfterRound < roundsStarted
  ) {
    return yield* invariant(
      command,
      `Cannot stop card '${card.id}' after review round ${proposed.stopAfterRound}: the loop is already past it.`,
    );
  }

  const normalised: BoardCardReviewOverrides = {
    ...proposed,
    stopAfterRound: raisedRounds ? null : proposed.stopAfterRound,
  };
  return isEmptyBoardCardReviewOverrides(normalised) ? null : normalised;
});

/** Event base for label events (t3o-06a): aggregates on the label. Separate
    from `makeBoardEventBase` rather than parametrised so the card call sites
    stay untouched. */
const makeBoardLabelEventBase = Effect.fn("makeBoardLabelEventBase")(function* (input: {
  readonly labelId: BoardLabelId;
  readonly occurredAt: string;
  readonly commandId: BoardCommand["commandId"];
}) {
  const crypto = yield* Crypto.Crypto;
  const eventId = yield* crypto.randomUUIDv4;
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

/** Event base for stage events (t3o-15): aggregates on the stage. */
const makeBoardStageEventBase = Effect.fn("makeBoardStageEventBase")(function* (input: {
  readonly stageId: BoardStageId;
  readonly occurredAt: string;
  readonly commandId: BoardCommand["commandId"];
}) {
  const crypto = yield* Crypto.Crypto;
  const eventId = yield* crypto.randomUUIDv4;
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

/** Whether a proposed stage ordering keeps the D3 spine invariant: the `build`
    stage precedes the `review` stage, and the `done` stage is last. Ordinary
    stages may sit anywhere else. Returned as a human message when violated, or
    null when the order is valid. */
function boardStageOrderViolation(stages: ReadonlyArray<BoardStageDefinition>): string | null {
  const ordered = [...stages].sort(compareBoardStages);
  const buildIndex = ordered.findIndex((stage) => stage.role === "build");
  const reviewIndex = ordered.findIndex((stage) => stage.role === "review");
  const doneIndex = ordered.findIndex((stage) => stage.role === "done");
  if (buildIndex >= 0 && reviewIndex >= 0 && buildIndex >= reviewIndex) {
    return "the Build stage must come before the Code review stage";
  }
  if (doneIndex >= 0 && doneIndex !== ordered.length - 1) {
    return "the Done stage must be last";
  }
  return null;
}

/**
 * Validate and normalise a card's label set (t3o-06a). Dedupes (a card holds
 * each label once), enforces `BOARD_CARD_LABELS_MAX`, and requires every id to
 * be either already on the card (grandfathering a reference to a
 * since-tombstoned label the user did not touch) or a live label — so a card
 * keeps a retired label it already carried but cannot ADD an unknown or
 * tombstoned one. `existing` is the card's current labels for a create.
 */
function validateCardLabels(input: {
  readonly board: BoardState;
  readonly command: BoardCommand;
  readonly proposed: ReadonlyArray<BoardLabelId>;
  readonly existing: ReadonlyArray<BoardLabelId>;
}): Effect.Effect<ReadonlyArray<BoardLabelId>, OrchestrationCommandInvariantError> {
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

export const decideBoardCommand = Effect.fn("decideBoardCommand")(function* ({
  command,
  readModel,
}: {
  readonly command: BoardCommand;
  readonly readModel: OrchestrationReadModel;
}): Effect.fn.Return<
  // Archive and unarchive decide several events at once — the card's own,
  // plus a `blocked` re-flag per affected dependent (t3o-13, D5). The engine
  // already appends an array inside one transaction, and each event carries
  // its own `aggregateId`, so a command may touch more than one card.
  BoardDecision,
  OrchestrationCommandInvariantError | PlatformError.PlatformError,
  Crypto.Crypto
> {
  const board = readModel.board ?? EMPTY_BOARD_STATE;

  switch (command.type) {
    case "board.card.create": {
      yield* requireProject({
        readModel,
        command,
        projectId: command.projectId,
      });
      if (board.cards.some((card) => card.id === command.cardId)) {
        return yield* invariant(command, `Card '${command.cardId}' already exists.`);
      }

      // A card may be created into any stage (D10) — `BOARD_CREATABLE_STAGES`
      // is gone; Mode governs worktree/slot on entry, so creation and dragging
      // follow an identical path. The target stage must exist.
      const stage = command.stage ?? boardStagesInOrder(board)[0]!.stageId;
      if (boardStageById(board, stage) === null) {
        return yield* invariant(command, `Stage '${stage}' does not exist.`);
      }

      const labels = yield* validateCardLabels({
        board,
        command,
        proposed: command.labels ?? [],
        existing: [],
      });

      // Child create (t3o-25): the drill-in's create dialog presets a parent.
      // The card must land where a materialised child could live — a live
      // top-level parent in the same project, a floor-onward stage — so a
      // hand-created child is indistinguishable from an approved plan's.
      if (command.parentCardId !== undefined) {
        const parent = board.cards.find((existing) => existing.id === command.parentCardId);
        if (parent === undefined || parent.archivedAt !== null) {
          return yield* invariant(
            command,
            `Parent card '${command.parentCardId}' does not exist or is archived.`,
          );
        }
        if (parent.parentCardId !== null) {
          return yield* invariant(
            command,
            `Card '${parent.id}' is itself a sub-board child; sub-boards do not nest.`,
          );
        }
        if (parent.projectId !== command.projectId) {
          return yield* invariant(
            command,
            `Parent card '${parent.id}' belongs to a different project.`,
          );
        }
        if (!isBoardStageAtOrAfterSubBoardFloor(board, stage)) {
          return yield* invariant(
            command,
            `A sub-board child cannot be created in '${stage}'; children live from the materialisation floor onward.`,
          );
        }
      }

      // Initial dependencies (t3o-06): dedupe and require each to exist. A
      // cycle is impossible at create — a brand-new card has no dependents, so
      // no existing edge can reach it — which is why create needs only the
      // existence check while `board.card.update` also gates cycles.
      const dependsOn = command.dependsOn === undefined ? [] : [...new Set(command.dependsOn)];
      for (const dependencyId of dependsOn) {
        const dependency = board.cards.find((existing) => existing.id === dependencyId);
        if (dependency === undefined) {
          return yield* invariant(command, `Dependency '${dependencyId}' does not exist.`);
        }
        // A child may only depend on siblings (t3o-25, as materialised edges
        // are scoped): never on a top-level card or another sub-board's child.
        if (
          command.parentCardId !== undefined &&
          dependency.parentCardId !== command.parentCardId
        ) {
          return yield* invariant(
            command,
            `Dependency '${dependencyId}' is not a sibling in parent '${command.parentCardId}''s sub-board.`,
          );
        }
      }

      // Dependency blocking is unconditional from the `build` role onward (D11):
      // a card cannot be created directly into a build-or-later stage while it
      // has unmet dependencies, exactly as it cannot be moved there.
      if (isBoardStageAtOrAfterBuild(board, stage)) {
        const unmet = unmetBoardCardDependencies({ board, dependsOn, cards: board.cards });
        if (unmet.length > 0) {
          return yield* invariant(
            command,
            `Card cannot be created in '${stage}' with unmet dependencies: ${unmet.join(", ")}.`,
          );
        }
      }

      const cardNumber = board.nextCardNumberByProject[command.projectId] ?? 1;
      const keyPrefix = command.keyPrefix ?? DEFAULT_BOARD_KEY_PREFIX;
      return {
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
          // Body lives in `board_card_bodies` (D8); omit the key when no brief
          // was given, matching the payload's key-optional shape.
          ...(command.brief === undefined ? {} : { brief: command.brief }),
          // A hand-created child (t3o-25) carries its parent exactly as a
          // materialised one does; it just has no source plan.
          ...(command.parentCardId === undefined ? {} : { parentCardId: command.parentCardId }),
          dependsOn,
          stage,
          orderKey: command.orderKey,
          createdAt: command.createdAt,
          updatedAt: command.createdAt,
        },
      };
    }

    case "board.card.move": {
      const card = yield* requireActiveBoardCard({ board, command });
      if (command.toStage === card.stage) {
        return yield* invariant(
          command,
          `Card '${command.cardId}' is already in stage '${command.toStage}'.`,
        );
      }
      if (boardStageById(board, command.toStage) === null) {
        return yield* invariant(command, `Stage '${command.toStage}' does not exist.`);
      }
      if (
        command.override !== true &&
        !areBoardStagesAdjacent(board, card.stage, command.toStage)
      ) {
        return yield* invariant(
          command,
          `Stage move '${card.stage}' -> '${command.toStage}' is not adjacent; a drag sends override to force it.`,
        );
      }
      // Sub-board plan cards (t3o-23, D3) are materialised work, restricted
      // to the materialisation floor and beyond — draggable back out of
      // Building to the floor (reverse states), but no override reopens the
      // ideation stages.
      if (
        card.parentCardId !== null &&
        !isBoardStageAtOrAfterSubBoardFloor(board, command.toStage)
      ) {
        return yield* invariant(
          command,
          `Card '${command.cardId}' is a sub-board plan card and cannot enter '${command.toStage}'.`,
        );
      }
      // A split parent's review describes an integration branch (t3o-28, D2),
      // so it cannot pass the build-role stage while a child is still working
      // — that description would be a lie. Everything BELOW that ceiling is
      // free: the parent walks Planning → Ready → Building on the ordinary
      // forward button (its arrival in build is what starts the sub-board,
      // t3o-28 D3), retreats as freely as any other card, and reorders where
      // it stands.
      //
      // This replaces t3o-23 D4's pin, which froze the parent at one stage
      // outright. The pin only ever made sense while approval PARKED the
      // parent in Building; now that approval leaves it alone (D1), the pin
      // would forbid the very move that begins the build. The t3o-24 D4
      // regression back to build — how the reactor corrects a parent left
      // ahead of reality by a child dragged out of Done — needs no carve-out
      // here either: it lands on the ceiling, not past it.
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
      // An unapproved split blocks advancement PAST planning (t3o-27): a card
      // whose planning produced ≥2 plans cannot reach any stage beyond the
      // plan-role stage until the split is approved (materialising the child
      // cards) or the human re-proposes down to a single plan. Realistically
      // the work cannot proceed until the split is resolved, so — unlike
      // dependency blocking, which only guards the build boundary — this
      // holds the card at planning. Backward moves are always free (they are
      // how you get back to fix the plans), and forward moves stay open up to
      // the plan stage — a card retreated to Sprint can come home to Planning
      // to finish planning. Drag sends `override`, which does NOT bypass
      // this: the gate is a truth about the card, and the modal replaces its
      // forward button with "Approve split" to match. A board with no
      // plan-role stage falls back to pinning the card where it sits (no
      // planning home exists to return to).
      if (boardCardPendingSplit(board, command.cardId)) {
        const currentIndex = boardStageIndex(board, card.stage);
        const targetIndex = boardStageIndex(board, command.toStage);
        // FORWARD moves only — backward moves stay free in every case (AC2:
        // retreating is how you get back to fix the plans, wherever the card
        // sits). The ceiling is the plan-role stage, CLAMPED below the build
        // role: stage reordering can legally place the plan stage after
        // Building (only build<review and done-last are spine invariants), and
        // an unclamped ceiling would then open the build stage to a pending
        // split — the one crossing this gate exists to refuse. The floor is
        // non-null whenever a card is pending (the predicate requires it).
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
      // Dependency blocking is unconditional from the `build` role onward (D11):
      // a card with unmet dependencies cannot enter the build-role stage or
      // anything after it, whatever the stages are called. A move that stays
      // before build, or that stays within the build-or-after zone, is not a
      // crossing and stays open. The message names the unmet dependencies.
      if (
        !isBoardStageAtOrAfterBuild(board, card.stage) &&
        isBoardStageAtOrAfterBuild(board, command.toStage)
      ) {
        const unmet = unmetBoardCardDependencies({
          board,
          dependsOn: card.dependsOn,
          cards: board.cards,
        });
        if (unmet.length > 0) {
          const names = unmet.map((dependencyId) => {
            const dependency = board.cards.find((existing) => existing.id === dependencyId);
            return dependency === undefined
              ? `a card that no longer exists ('${dependencyId}')`
              : `${dependency.key} "${dependency.title}"`;
          });
          return yield* invariant(
            command,
            `Card '${card.key}' cannot enter '${command.toStage}' until ${
              names.length === 1 ? "its dependency is" : "its dependencies are"
            } done: ${names.join(", ")}.`,
          );
        }
      }

      const doneStageId = boardStageWithRole(board, "done")?.stageId ?? null;
      // ── The round boundary ────────────────────────────────────────────
      //
      // LEAVING Done with a merged pull request is what starts a card's next
      // round of work, so it is here — not at worktree re-provision — that the
      // finished round retires into the history and `pullRequestFloor` rises.
      //
      // Tying it to the worktree was wrong: a worktree is reclaimed at Done
      // only when `reclaimWorktreeOnDone` is on AND the tree is clean and
      // pushed. Both of the other paths keep a `ready` worktree, which
      // `ensureWorktree` then REUSES — no re-provision, so no boundary, so the
      // card carried its merged pull request into round two. `merged` is
      // terminal, so every refresh short-circuited and the new round's pull
      // request was never adopted; the card's next arrival at Done then handed
      // branch cleanup a stale `merged` link for a live branch and deleted
      // round two's branch out from under its open pull request. That is
      // verbatim the outcome `BoardCard.pullRequestFloor` exists to foreclose,
      // and only a boundary that fires on EVERY path forecloses it.
      //
      // Deliberately NOT gated on the pull request being `merged`.
      //
      // `card.pullRequest` is a CACHE of forge state, refreshed only at this
      // design's event triggers — and this decider is pure, so it reads
      // whatever was last cached, not what the forge says now. A card sitting
      // in Done with a link cached `open` that has since merged would take the
      // no-boundary path: no floor, the stale link surviving into round two,
      // and the card's next arrival at Done handing the settle a `merged` link
      // for a branch now carrying round two's unmerged commits. Reclaim runs
      // first, so the checkout goes, then the local and remote branches — and
      // round two's work exists nowhere. Deciding an irreversible deletion off
      // a value that is allowed to be stale is the mistake; not the staleness.
      //
      // So leaving Done ENDS THE ROUND, whatever the link says. The trade, in
      // the one case that is really still open: that pull request is retired
      // rather than kept current, so the card no longer offers to merge it and
      // the floor blocks re-adopting it by number. It is not lost —
      // `boardCardDisplayPullRequest` keeps the badge and the View PR link
      // pointing at it — and the failure is toward doing nothing rather than
      // toward deleting a branch, which is the direction this whole module
      // errs in by construction.
      const startsNewRound =
        doneStageId !== null &&
        card.stage === doneStageId &&
        command.toStage !== doneStageId &&
        card.pullRequest !== null;
      const retiredHistory = startsNewRound
        ? [...card.pullRequestHistory, card.pullRequest]
        : card.pullRequestHistory;
      const nextCard: BoardCard = {
        ...card,
        stage: command.toStage,
        orderKey: command.orderKey ?? card.orderKey,
        blocked: deriveBoardCardBlocked({
          board,
          stage: command.toStage,
          dependsOn: card.dependsOn,
          cards: board.cards,
        }),
        ...(startsNewRound
          ? {
              pullRequest: null,
              pullRequestHistory: retiredHistory,
              // Highest across EVERYTHING the card has seen, not just the entry
              // retiring now: a round that ended without a pull request of its
              // own must not lower a floor an earlier round already raised.
              pullRequestFloor: retiredHistory.reduce<BoardCard["pullRequestFloor"]>(
                (highest, entry) =>
                  highest === null || entry.number > highest ? entry.number : highest,
                card.pullRequestFloor,
              ),
            }
          : {}),
        updatedAt: command.createdAt,
      };
      const moved: PlannedOrchestrationEvent = {
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
        },
      };
      // A move across the done-role boundary changes what this card means as a
      // DEPENDENCY (t3o-13, D5): dependents' stored `blocked` would otherwise
      // go stale — met on entering Done, unmet again on being dragged back out
      // — exactly the staleness the archive/unarchive paths already re-flag.
      const crossesDone =
        doneStageId !== null && (card.stage === doneStageId) !== (command.toStage === doneStageId);
      return crossesDone
        ? [moved, ...(yield* boardDependentBlockedEvents({ board, command, changed: nextCard }))]
        : moved;
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
        command.modelOverrides === undefined
      ) {
        return yield* invariant(command, `Update for card '${command.cardId}' carries no changes.`);
      }

      const nextLabels =
        command.labels === undefined
          ? card.labels
          : yield* validateCardLabels({
              board,
              command,
              proposed: command.labels,
              existing: card.labels,
            });

      // Duplicate edges add nothing to the graph; store each dependency once.
      const proposedDependsOn =
        command.dependsOn === undefined ? undefined : [...new Set(command.dependsOn)];
      if (proposedDependsOn !== undefined) {
        for (const dependencyId of proposedDependsOn) {
          if (!board.cards.some((candidate) => candidate.id === dependencyId)) {
            return yield* invariant(command, `Dependency '${dependencyId}' does not exist.`);
          }
        }
        const cycle = findDependencyCycle({
          board,
          cardId: command.cardId,
          proposed: proposedDependsOn,
        });
        if (cycle !== null) {
          return yield* invariant(
            command,
            `Dependency edge '${cycle.edgeFrom} -> ${cycle.edgeTo}' would create a cycle: ${cycle.path.join(" -> ")}.`,
          );
        }
      }

      // The review-loop overrides are validated and normalised before the card
      // is built (t3o-22, D3/D5), so an invalid budget rejects the whole
      // command rather than landing a half-applied edit.
      const reviewOverrides =
        command.reviewOverrides === undefined
          ? card.reviewOverrides
          : command.reviewOverrides === null
            ? null
            : yield* validateReviewOverrides({
                board,
                command,
                card,
                proposed: command.reviewOverrides,
              });

      // Per-stage model overrides, validated before the card is built for the
      // same reason (t3o-29, D1): an entry keyed by a stage the board does not
      // have would sit in the column where nothing ever reads it, so a stale
      // popover writing one is rejected outright rather than half-applied. An
      // emptied map normalises to null so "cleared" and "never set" stay
      // indistinguishable in the read model.
      const modelOverrides =
        command.modelOverrides === undefined
          ? card.modelOverrides
          : command.modelOverrides === null
            ? null
            : yield* validateModelOverrides({ board, command, proposed: command.modelOverrides });

      const dependsOn = proposedDependsOn ?? card.dependsOn;
      const nextCard: BoardCard = {
        ...card,
        title: command.title ?? card.title,
        labels: nextLabels,
        dependsOn,
        externalRef: command.externalRef === undefined ? card.externalRef : command.externalRef,
        briefRef:
          command.brief === undefined
            ? card.briefRef
            : command.brief === null
              ? null
              : BOARD_CARD_BRIEF_BODY_KIND,
        blocked:
          proposedDependsOn === undefined
            ? card.blocked
            : deriveBoardCardBlocked({ board, stage: card.stage, dependsOn, cards: board.cards }),
        humanInLoop: command.humanInLoop === undefined ? card.humanInLoop : command.humanInLoop,
        reviewOverrides,
        modelOverrides,
        updatedAt: command.createdAt,
      };
      return {
        ...(yield* makeBoardEventBase({
          cardId: command.cardId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        })),
        type: "board.card-updated",
        payload: {
          cardId: command.cardId,
          ...(command.brief === undefined ? {} : { brief: command.brief }),
          card: nextCard,
          // Fold the review summary onto the event when the edit could change
          // it (t3o-22, D7), so a pure override edit updates the card face live
          // — the same reason the step-completion path folds it. Only when the
          // overrides actually moved AND the card has review history; a title
          // or label edit carries nothing and the SQL cache is untouched.
          ...(command.reviewOverrides === undefined
            ? {}
            : (() => {
                const summary = deriveBoardCardReviewSummary({
                  completions: boardCardStepCompletions(board, command.cardId),
                  maxRounds: nextCard.reviewOverrides?.rounds ?? null,
                  stopAfterRound: nextCard.reviewOverrides?.stopAfterRound ?? null,
                });
                return summary === null ? {} : { reviewSummary: summary };
              })()),
        },
      };
    }

    case "board.card.link-thread": {
      const card = yield* requireActiveBoardCard({ board, command });
      const thread = readModel.threads.find((candidate) => candidate.id === command.threadId);
      if (thread === undefined || thread.deletedAt !== null) {
        return yield* invariant(
          command,
          `Thread '${command.threadId}' does not exist or is deleted and cannot be linked.`,
        );
      }
      // One thread, one card (D9): a live link anywhere — archived cards
      // included — owns the thread. Tombstoned links don't own anything (their
      // thread is deleted, which the existence check above already rejects).
      const owner = board.cards.find((candidate) =>
        candidate.threadLinks.some(
          (link) => link.threadId === command.threadId && link.tombstonedAt === null,
        ),
      );
      if (owner !== undefined) {
        return yield* invariant(
          command,
          `Thread '${command.threadId}' is already linked to card '${owner.id}'.`,
        );
      }

      const nextCard: BoardCard = {
        ...card,
        threadLinks: sortBoardCardThreadLinks([
          ...card.threadLinks,
          {
            threadId: command.threadId,
            role: command.role,
            linkedAt: command.createdAt,
            tombstonedAt: null,
          },
        ]),
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

      // A deleted thread's link becomes a tombstone rather than vanishing
      // (D9): a card whose triage thread was deleted must say so. Absent
      // counts as deleted — link-thread requires existence, so a linked
      // thread missing from the read model can only have been deleted.
      const thread = readModel.threads.find((candidate) => candidate.id === command.threadId);
      const threadDeleted = thread === undefined || thread.deletedAt !== null;
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
      // Archiving the supervisor of running work strands it (t3o-23, D7). A
      // parent whose children are all done/archived archives normally.
      {
        const unfinished = boardCardUnfinishedChildren(board, card.id);
        if (unfinished.length > 0) {
          return yield* invariant(
            command,
            `Card '${card.key}' still has ${unfinished.length} unfinished plan card${
              unfinished.length === 1 ? "" : "s"
            } (${unfinished.map((child) => child.key).join(", ")}); finish or archive those first.`,
          );
        }
      }
      const nextCard: BoardCard = {
        ...card,
        archivedAt: command.createdAt,
        updatedAt: command.createdAt,
      };
      // Dependencies survive the archive (D1) — nothing rewrites `dependsOn`
      // — but they stop gating, so dependents that were waiting on this card
      // unblock in the same commit.
      const archived: PlannedOrchestrationEvent = {
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
      const nextCard: BoardCard = {
        ...card,
        archivedAt: null,
        // Dependencies may have finished while the card sat in the archive;
        // restore with a fresh derivation rather than the stale flag.
        blocked: deriveBoardCardBlocked({
          board,
          stage: card.stage,
          dependsOn: card.dependsOn,
          cards: board.cards,
        }),
        updatedAt: command.createdAt,
      };
      // Restoring re-arms the gate the archive released (D1/D5): dependents
      // that this card blocks again are re-flagged alongside it.
      const unarchived: PlannedOrchestrationEvent = {
        ...(yield* makeBoardEventBase({
          cardId: command.cardId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        })),
        type: "board.card-unarchived",
        payload: {
          cardId: command.cardId,
          card: nextCard,
        },
      };
      return [
        unarchived,
        ...(yield* boardDependentBlockedEvents({ board, command, changed: nextCard })),
      ];
    }

    case "board.card.delete": {
      // Archived cards delete too (the archive sheet is where "never coming
      // back" gets decided), so this requires existence, not activity.
      const card = yield* requireBoardCard({ board, command });
      // A parent deletes only after its children are gone (t3o-23, D7):
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
      const deleted: PlannedOrchestrationEvent = {
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
      // Dependency edges pointing at the deleted card are REWRITTEN, not left
      // to dangle — the one place delete and archive genuinely differ on
      // dependencies (D1). An archived dependency stops gating because the
      // archive is reversible and the edge must survive to be re-armed; a
      // deleted one can never come back, and `unmetBoardCardDependencies`
      // counts an unresolvable id as unmet forever, so leaving the edge would
      // block every dependent permanently with no card left to unblock them.
      const edited: Array<PlannedOrchestrationEvent> = [];
      for (const dependent of remaining) {
        if (!dependent.dependsOn.includes(command.cardId)) continue;
        const dependsOn = dependent.dependsOn.filter((id) => id !== command.cardId);
        const nextCard: BoardCard = {
          ...dependent,
          dependsOn,
          blocked: deriveBoardCardBlocked({
            board,
            stage: dependent.stage,
            dependsOn,
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
      // The edits ride FIRST. Each carries a `card` the projector upserts
      // wholesale, and an upsert of a dependent computed without the deleted
      // card is only correct once — or before — the deleted card is gone;
      // ordering them ahead of the removal makes that true on the live path
      // and on replay alike.
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
      // A tombstoned label is inert: it is out of the picker and cards render
      // it muted, so renaming or recolouring it is meaningless. Restore it
      // first (board.label.undelete), then edit — one clear path, and it keeps
      // undelete's name-collision gate the single guard on a name re-entering
      // the live set.
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

    // ── Stage aggregate (t3o-15, D2/D3/D9) ───────────────────────────────

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
      return {
        ...(yield* makeBoardStageEventBase({
          stageId: command.stageId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        })),
        type: "board.stage-created",
        payload: { stageId: command.stageId, stage },
      };
    }

    case "board.stage.rename": {
      const stage = boardStageById(board, command.stageId);
      if (stage === null) {
        return yield* invariant(command, `Stage '${command.stageId}' does not exist.`);
      }
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
      const stage = boardStageById(board, command.stageId);
      if (stage === null) {
        return yield* invariant(command, `Stage '${command.stageId}' does not exist.`);
      }
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
      // Crossing the `build` boundary re-answers "is this card subject to
      // dependency blocking?", and `blocked` is a stored column re-derived only
      // at a card move — refuse the reorder rather than leave stale flags (D9).
      // Moving an ordinary stage flips its own membership; moving the `build`
      // stage itself flips every stage that ends up on the other side of it, so
      // the guard checks EVERY stage whose at-or-after-build status changes, not
      // just the one being moved.
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
      const stage = boardStageById(board, command.stageId);
      if (stage === null) {
        return yield* invariant(command, `Stage '${command.stageId}' does not exist.`);
      }
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
      // Refused if the stage holds ANY card, archived included (D9). The error
      // names the count; t3o-13's archive view is how the user clears them.
      const held = board.cards.filter((card) => card.stage === command.stageId).length;
      if (held > 0) {
        return yield* invariant(
          command,
          `Stage '${stage.label}' still holds ${held} card${held === 1 ? "" : "s"} (archived included); move them out first.`,
        );
      }
      return {
        ...(yield* makeBoardStageEventBase({
          stageId: command.stageId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        })),
        type: "board.stage-deleted",
        payload: { stageId: command.stageId },
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
      // The stepId must be the card's live step or an already-recorded
      // completion (an idempotent retry). Step ids are predictable, so without
      // this an agent could pre-complete a FUTURE step and the pinned record
      // would make `continueStage` / boot reconcile skip it as already-ran.
      if (existing === undefined && !liveMatch) {
        return yield* invariant(
          command,
          `Step '${command.stepId}' is not card '${command.cardId}''s live step${
            current === null ? "" : ` ('${current.stepId}', ${current.status})`
          } and has no recorded completion; complete the step you were assigned.`,
        );
      }
      // Idempotency (D4), outcome-aware: a `succeeded` completion is pinned
      // forever — a retried call re-emits it, so the projection is a no-op
      // upsert and no second transition can fire. A `failed`/`blocked`
      // completion is NOT pinned while the same step is live again: the
      // recovery ladder's retry nudge explicitly asks the agent to call
      // board_complete_step when done, so the successful retry must supersede
      // the earlier failure (the projector upserts on (cardId, stepId)).
      // With no live step, the recorded outcome re-emits verbatim.
      const supersede = existing !== undefined && existing.outcome !== "succeeded" && liveMatch;
      const completion: BoardStepCompletion =
        existing !== undefined && !supersede
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
      // The card face's review summary rides the event (t3o-22, D7).
      //
      // It has to. The summary is a fold over the whole step-completion ledger,
      // and `boardShellStreamEvent` is a PURE function of one event — it can
      // see this completion but not the ones before it, so the column card
      // could not be updated live from the projector alone. The decider is the
      // one place that holds both the ledger and the card's own round
      // overrides, so it folds the post-event ledger here and the delta rides
      // out with the event.
      //
      // Absent for every non-review step, and for every event written before
      // t3o-22 — the projection recomputes from the ledger in that case, which
      // is what keeps a from-empty replay of an older log correct.
      // Never null in practice — the ledger provably holds this very review
      // step — but the fold is total over any ledger, so the null is coalesced
      // rather than asserted away.
      const reviewSummary =
        parseReviewStepId(completion.stepId) === null
          ? undefined
          : (deriveBoardCardReviewSummary({
              completions: [
                ...boardCardStepCompletions(board, command.cardId).filter(
                  (recorded) => recorded.stepId !== completion.stepId,
                ),
                completion,
              ],
              maxRounds: card.reviewOverrides?.rounds ?? null,
              stopAfterRound: card.reviewOverrides?.stopAfterRound ?? null,
            }) ?? undefined);
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
        },
      };
    }

    case "board.plans.propose": {
      yield* requireActiveBoardCard({ board, command });
      // An approved split freezes the plans (t3o-23, D7): they are the record
      // of what was materialised, and the work now lives on the child cards.
      // Only LIVE children freeze — a fully-archived round is gone and a
      // second round may re-plan (consistent with the re-approval guard).
      // Distinct from `locked` (t3o-12's file handover, below).
      if (boardCardChildren(board, command.cardId).some((child) => child.archivedAt === null)) {
        return yield* invariant(
          command,
          `Card '${command.cardId}' has materialised child cards; the plans are frozen. Work happens on the child cards now.`,
        );
      }
      // A locked plan means the card's plans are materialised to .plans/ at
      // Building entry (t3o-12); re-proposing over them would silently drop the
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
          createdAt: prior?.createdAt ?? command.createdAt,
          updatedAt: command.createdAt,
          body: plan.body,
        };
      });
      return {
        ...(yield* makeBoardEventBase({
          cardId: command.cardId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        })),
        type: "board.plans-proposed",
        payload: { cardId: command.cardId, plans },
      };
    }

    case "board.plan.write": {
      yield* requireActiveBoardCard({ board, command });
      // Frozen after approval, exactly as re-proposal is (t3o-23, D7) — and,
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
      // One source of truth at any moment (D12 handover): a locked plan lives
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
      // The human gate D12 promised (t3o-23): materialise the split. Two
      // kinds of event — the children's ordinary creations, and the approval
      // record the reactor keys the integration branch off.
      //
      // NOT a stage move (t3o-28, D1). Approving answers "is this the right
      // split", not "start building it"; the parent stays where the human
      // left it and walks forward on the ordinary button, and its arrival in
      // the build-role stage is what starts the sub-board (D3).
      const card = yield* requireActiveBoardCard({ board, command });
      if (card.parentCardId !== null) {
        return yield* invariant(
          command,
          `Card '${card.key}' is itself a sub-board plan card; splits do not nest (D12).`,
        );
      }
      // A parent with a BUILD run in flight cannot be split under it: the
      // live agent would keep writing the very branch the children are about
      // to fork from, and its completion would race the materialisation.
      // Finish or stop the run first — the split then cuts from a quiet card.
      //
      // The plan-role stage is carved out, because that is where a split
      // comes FROM. The planning interview is human-paced: its step stays
      // `running` until the human walks the card onward, and that move is the
      // only thing that settles it (`handleCardMoved` abandons it) — but
      // t3o-27 D2 refuses the move until the split is approved. Refusing here
      // too wedged every proposed split shut, with no client command to
      // settle a step by hand. Nothing races: a plan step writes plans, not
      // the branch, and approval no longer starts anything (t3o-28, D1) — the
      // children sit on the floor until the parent reaches build.
      {
        const state = boardCardStepState(board, command.cardId);
        const planStage = boardStageWithRole(board, "plan");
        const planning = planStage !== null && card.stage === planStage.stageId;
        if (state !== null && !isBoardTerminalStepStatus(state.status) && !planning) {
          return yield* invariant(
            command,
            // `boardRunLabel` is the shared rule (t3o-19, D4): the step's own
            // label, or the stage label when the step has none — so the gate
            // names the run the same way every other reader does.
            `Card '${card.key}' has a live step ('${boardRunLabel(
              state,
            )}', ${state.status}); finish or stop it before approving a split.`,
          );
        }
      }
      {
        // Only LIVE (non-archived) children block re-approval. An archived
        // child is finished-and-gone (the archived-is-gone principle, t3o-13
        // D1) — so a fully-wrapped first round does not wedge a SECOND-ROUND
        // split, the case the reclaimed-slice path in `resolveBoardCardBaseRef`
        // and `ensureIntegrationBranch` exists to serve. A Done-but-unarchived
        // child still counts: it is on the board and part of the live split.
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
          }; a split needs at least two — move the card onward instead.`,
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
      const floor = boardSubBoardFloorStage(board);
      if (floor === null) {
        return yield* invariant(
          command,
          `The board has no stage before '${buildStage.label}' to hold materialised plan cards; add one first.`,
        );
      }
      // The graph is agent-authored and therefore re-validated at the gate
      // (D12) — propose checked it on ingest, but the gate is where a human
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

      const crypto = yield* Crypto.Crypto;
      // Children share the parent's key sequence — its prefix, the project's
      // next numbers — exactly as if each had been created by hand.
      const lastDash = card.key.lastIndexOf("-");
      const keyPrefix = lastDash > 0 ? card.key.slice(0, lastDash) : DEFAULT_BOARD_KEY_PREFIX;
      let nextNumber = board.nextCardNumberByProject[card.projectId] ?? 1;
      // Appended at the bottom of the floor column in ordinal order; each key
      // feeds the next so siblings sort in plan order.
      const floorOrderKeys = board.cards
        .filter((existing) => existing.stage === floor.stageId && existing.archivedAt === null)
        .map((existing) => existing.orderKey);
      const childIdByPlan = new Map<BoardPlanId, BoardCardId>();
      for (const plan of plans) {
        childIdByPlan.set(plan.planId, BoardCardId.make(yield* crypto.randomUUIDv4));
      }
      const events: Array<PlannedOrchestrationEvent> = [];
      const childCardIds: Array<BoardCardId> = [];
      for (const plan of plans) {
        const childId = childIdByPlan.get(plan.planId)!;
        childCardIds.push(childId);
        const orderKey = boardAppendOrderKey(floorOrderKeys);
        floorOrderKeys.push(orderKey);
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
            // bodies never ride the read model (D8); the SQL projector copies
            // it inside the same transaction.
            briefFromPlanId: plan.planId,
            dependsOn: plan.dependsOn.map((dependency) => childIdByPlan.get(dependency)!),
            parentCardId: card.id,
            sourcePlanId: plan.planId,
            stage: floor.stageId,
            orderKey,
            createdAt: command.createdAt,
            updatedAt: command.createdAt,
          },
        });
      }
      // The parent is untouched but for its timestamp (t3o-28, D1): no stage
      // move, and `blocked` is left exactly as it stands — approval crosses no
      // build boundary, so it has no dependency verdict to record.
      const parentAfterApproval: BoardCard = {
        ...card,
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

    // ── Worktree lifecycle (t3o-09, D6) ──────────────────────────────
    // These are server-internal commands (BOARD_INTERNAL_COMMANDS): the
    // worktree lifecycle service dispatches them after the effectful git
    // work. The decider stays pure (D8) — it records the branch/worktree
    // state the service reports, and gates provisioning on the card already
    // being in Building (D6/D18: the worktree is created ON entry to
    // Building, which is the human "Begin build"; nothing here advances a
    // stage).

    case "board.card.provision-worktree": {
      const card = yield* requireActiveBoardCard({ board, command });
      // Which stages need a worktree is a settings question (any stage may
      // resolve to `mode: "build"` — the review stage always does), and the
      // pure decider cannot read settings (D8). The command is server-internal
      // (BOARD_INTERNAL_COMMANDS): the reactor is its only dispatcher and
      // gates on the stage's RESOLVED execution mode, so no stage-literal
      // invariant is re-imposed here — it would orphan real git worktrees for
      // build-mode stages that are not literally named 'building'.
      // Provisioning starts fresh, retries a failed attempt, or begins a NEW
      // ROUND on a card whose worktree was reclaimed at Done and which has been
      // dragged back out to be worked on again. A worktree that is already
      // provisioning or ready is never re-provisioned behind its own back.
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
      // Those two admitted states mean different things:
      //
      //  - `failed` is a RETRY of the provision already in flight, so `attempts`
      //    climbs and the repeated failure stays visible.
      //  - `reclaimed` is a fresh provision for a card that has been dragged
      //    back out of Done, so `attempts` restarts and keeps meaning "retries
      //    of THIS provision" rather than a lifetime tally across every round.
      //  - `branch-only` (t3o-23, D5) is a split parent reaching its own
      //    review: the integration branch exists, the worktree attaches to it
      //    now. A fresh provision, so `attempts` restarts here too.
      //
      // Neither touches the card's pull request. The ROUND boundary — retiring
      // a merged pull request and raising `pullRequestFloor` — belongs to the
      // move out of the done-role stage (see `board.card.move`), because that
      // is the one event every second round passes through. A card whose
      // worktree survived Done is never re-provisioned at all, so a boundary
      // hung here would simply not fire for it.
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
      // A split parent's integration branch now exists on disk (t3o-23, D5) —
      // the reactor created it off the plans-approved event and reports back,
      // same effect-then-record discipline as record-worktree. `branch-only`:
      // real branch, no worktree until the parent's own review entry.
      const card = yield* requireActiveBoardCard({ board, command });
      // `failed` is a retry; `reclaimed` is a second-round split whose old
      // branch was deleted at Done (t3o-23, D5). A live slice — branch-only,
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
      // The floor (see `BoardCard.pullRequestFloor`) refuses a pull request
      // belonging to a round the card has already finished. The card keeps the
      // same deterministic `board/<key>` branch across rounds, and the forge
      // lookup falls back to the newest pull request overall when none is open
      // — so the FINISHED round is exactly what a refresh hands back until the
      // new round opens one of its own. Adopting it would let branch cleanup
      // delete the branch of unmerged work, so the refusal lives here, in the
      // pure decider, where no caller can forget it.
      //
      // `open` is exempt, and the exemption is what keeps the floor from
      // stranding a card. Leaving Done retires whatever link the card held,
      // without consulting its cached state — a cache may not authorise an
      // irreversible deletion — so a pull request that was genuinely still open
      // gets retired too. It is nonetheless the branch's LIVE pull request:
      // round two's pushes go straight into it, and no new one can be opened
      // for a head that already has one. Refusing it would leave that card
      // unable to link, merge, or ever open a pull request again.
      //
      // Safe, because `state` here is a value the forge answered on THIS
      // lookup, not a cached one, and because only a non-open pull request can
      // authorise a deletion: `settleCardAtDone` gates on `merged`. A retired
      // pull request that is open now is adopted; the same one, found merged
      // later, is refused — and if it merged because round two's work went into
      // it, then round two IS merged and the branch really is spent.
      // The card's CURRENT link is exempt too, and this is what stops the
      // `open` exemption above from being a one-way door. The floor never
      // falls, so without this the pull request just re-adopted while open
      // could never record its own merge: the refresh would be refused, the
      // link would read `open` for ever, and the settle, the branch cleanup and
      // the boot sweep would all keep no-opping — the card would never get its
      // worktree or its branches back. The floor's job is to stop a FINISHED
      // round's pull request being ADOPTED, not to freeze the state of one the
      // card already holds. And a link the card holds can only have been
      // adopted while open, so a merge recorded through here is a merge that
      // carried the current round's work.
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
      // No-op guard at the decider, not just at the caller. The refresh
      // triggers fire on every step boundary, stage move and card open, and
      // the overwhelming majority of those lookups return exactly what the
      // card already holds — landing an event for each would bloat the log and
      // republish a shell delta per card open for no change at all. `checkedAt`
      // is deliberately EXCLUDED from the comparison: it moves on every single
      // lookup, so including it would defeat the guard entirely.
      if (boardCardPullRequestsEqual(previous, next)) {
        return yield* invariant(
          command,
          `Card '${command.cardId}' already records this pull request state; nothing to record.`,
        );
      }
      const transition: BoardCardPullRequestTransition =
        next === null
          ? "unlinked"
          : previous === null || previous.number !== next.number
            ? "linked"
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
          card: nextCard,
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
      // A `ready` or `reclaimed` worktree is not an attempt in flight: failing
      // one would rewrite a live (or already-released) checkout's state behind
      // its back. Everything else is failable — including a worktree that is
      // ALREADY failed, so a retry that fails the same way again records the
      // fresh reason rather than being rejected.
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
      // Pre-provision failure: the reactor can fail BEFORE it ever dispatches
      // `provision-worktree` — the project has no workspace folder, or the repo
      // offers no base branch to cut from — so there is no worktree record to
      // mark, and none should be invented (`baseRefName` would be a lie). The
      // event is decided anyway, purely to report: it carries the reason onto
      // the card's activity rail ("could not prepare the worktree: …") and
      // leaves `worktree` null, which is exactly the state a retry starts from.
      // Rejecting it instead swallowed the card's only failure signal into a
      // server-side warning and left the card silently wedged in its stage.
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
      // Reclaim runs at archive (D6/D15), so the card is usually archived —
      // requireBoardCard, not requireActiveBoardCard.
      const card = yield* requireBoardCard({ board, command });
      if (card.worktree === null) {
        return yield* invariant(command, `Card '${command.cardId}' has no worktree to reclaim.`);
      }
      // A reclaimed worktree is gone; neither a repeat `removed` nor a late
      // `blocked` re-flag should touch it (symmetric idempotency).
      if (card.worktree.status === "reclaimed") {
        return yield* invariant(command, `Card '${command.cardId}' worktree is already reclaimed.`);
      }
      // `removed`: the service deleted a clean-and-pushed tree — the worktree
      // is gone, path returns to null (reverse state, D6). `blocked`: the
      // service refused because deleting would lose work; the card keeps its
      // worktree and records why, never silently discarding uncommitted work.
      const reason = command.reason ?? null;
      const nextCard: BoardCard =
        command.outcome === "removed"
          ? {
              ...card,
              worktree: {
                ...card.worktree,
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
                reclaimBlockedReason: reason ?? "Worktree not clean and pushed.",
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
          reason:
            command.outcome === "removed" ? null : (reason ?? "Worktree not clean and pushed."),
          card: nextCard,
        },
      };
    }

    // ── Step lifecycle (t3o-10, D4/D8) ───────────────────────────────
    // Server-internal commands the supervisor reactor dispatches as it drives
    // a card's step. The decider stays pure (D8): it records the step state
    // the reactor's observations imply. Human-gating (D18) is untouched — none
    // of these moves a stage; the board-driven Building → Review advance rides
    // the ordinary `board.card.move` gate the reactor triggers on a successful
    // completion, exactly like the human "Begin build" gate before it.

    case "board.card.select-step": {
      yield* requireActiveBoardCard({ board, command });
      // One step at a time (D4): a new step cannot be selected while the card's
      // current step is still live. A terminal step is done and may be
      // superseded — that is how a re-entry starts after the last step settled.
      const current = boardCardStepState(board, command.cardId);
      if (current !== null && !isBoardTerminalStepStatus(current.status)) {
        return yield* invariant(
          command,
          `Card '${command.cardId}' already has a live step '${current.stepId}' (${current.status}); settle it before selecting another.`,
        );
      }
      // The reactor resolved and froze the stage's execution config (D12); the
      // decider stamps it onto the run row verbatim.
      const state: BoardCardStepState = {
        cardId: command.cardId,
        stepId: command.stepId,
        stepLabel: command.stepLabel,
        stageLabel: command.stageLabel,
        // `attempt` carries the stage entry's cumulative invocation count (D1/
        // D5): an intra-stage continuation (t3o-16's next review phase) passes
        // `priorInvocations` so the per-stage-entry ceiling survives the row
        // being replaced; a genuine stage entry omits it and resets to 1.
        attempt: (command.priorInvocations ?? 0) + 1,
        // A fresh step (t3o-17): no stalls yet and no nudge to measure progress
        // against — consecutive stalls are per-step, unlike the carried
        // invocation total above.
        stallCount: 0,
        lastNudgeAt: null,
        prompt: command.prompt,
        providerInstanceId: command.providerInstanceId,
        model: command.model,
        runtimeMode: command.runtimeMode,
        ...(command.modelOptions === undefined ? {} : { modelOptions: command.modelOptions }),
        mode: command.mode,
        humanInLoop: command.humanInLoop,
        maxAttempts: command.maxAttempts,
        timeoutMs: command.timeoutMs,
        // Measured or carried by the reactor (t3o-24, D1); stamped verbatim
        // like every other frozen field.
        baseTipAtRoundStart: command.baseTipAtRoundStart,
        threadId: null,
        // A fresh step has not stopped for any reason yet (t3o-30, D2).
        lastError: null,
        status: "pending",
        slotHeld: false,
        // A fresh step carries no cap override (t3o-33): forcing one step past
        // the ceiling never bleeds into the step after it.
        forceStart: false,
        startedAt: null,
        updatedAt: command.createdAt,
      };
      return {
        ...(yield* makeBoardEventBase({
          cardId: command.cardId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        })),
        type: "board.card-step-selected",
        payload: { cardId: command.cardId, state },
      };
    }

    case "board.card.start-stage-thread": {
      // On-demand kickoff (D7): validate the card is active and emit the
      // request event the supervisor reactor reacts to. The reactor decides
      // first-entry-vs-re-entry and whether the stage auto-executes.
      const card = yield* requireActiveBoardCard({ board, command });
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
            // Only a build-mode step holds a concurrency slot (D5); a plan-mode
            // step runs read-only with no worktree and no slot.
            slotHeld: current.mode === "build",
            // The override is spent the moment it lands (t3o-33): it named THIS
            // admission, and leaving it set would silently force the card's next
            // step past the cap too.
            forceStart: false,
            startedAt: command.createdAt,
            updatedAt: command.createdAt,
          }
        : {
            ...current,
            status: "queued",
            threadId: null,
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
      const state: BoardCardStepState = {
        ...current,
        status: "awaiting-input",
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

    // Start a queued step over the concurrency cap (t3o-33). The command names
    // no step — one live step row per card (D4) — so the card's own row is the
    // target and a client that rendered the card a moment ago cannot aim at a
    // stale one. Only a `queued` step is forceable: `pending` is not yet
    // withheld by anything (the governor has not reached it), and every other
    // status is already running or over.
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
      // Recovery reuses the held slot — a retry never releases and re-acquires,
      // which could starve the step behind a queue it was already at the front
      // of. Escalation (t3o-17, D3/D4) lands the step in the distinct `stalled`
      // status AND releases its slot (`slotHeld: false`; the reactor rides the
      // existing release machinery once); an ordinary retry returns it to
      // running and keeps its slot. `attempt` counts every invocation (D1, for
      // display and the D5 ceiling); `stallCount` counts CONSECUTIVE stalls and
      // resets to zero when the reactor observed progress since the last nudge.
      // `lastError` (t3o-30, D2) is REPLACED, never merged: a command that
      // carries a reason records it, and one that does not clears whatever was
      // there. A nudge that puts the step back to `running` must not leave the
      // card showing the error from the stop before it.
      const state: BoardCardStepState = {
        ...current,
        attempt: current.attempt + 1,
        stallCount: (command.progressed ? 0 : current.stallCount) + 1,
        status: command.escalateToHuman ? "stalled" : "running",
        slotHeld: command.escalateToHuman ? false : current.slotHeld,
        threadId: command.threadId,
        lastError: command.lastError ?? null,
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

    case "board.card.resume-step": {
      yield* requireActiveBoardCard({ board, command });
      const current = yield* requireLiveStepState({ board, command, stepId: command.stepId });
      if (current.status !== "stalled") {
        return yield* invariant(
          command,
          `Card '${command.cardId}' step '${command.stepId}' is '${current.status}', not stalled; nothing to resume.`,
        );
      }
      // A human sent a turn into the stalled step's thread (t3o-17, D3), so the step
      // is running again and supervised again — the same status an ordinary
      // recovery nudge returns it to, which is why it rides the same event.
      //
      // What it deliberately does NOT do:
      //  - `attempt` is untouched. It counts BOARD invocations (D1, and the D5
      //    stage-entry ceiling); a human's own turn is not one, and charging the
      //    ceiling for it would escalate the card again the moment their turn
      //    ended.
      //  - `stallCount` resets to zero rather than incrementing: the human
      //    intervening is progress, exactly as `progressed` is on a nudge, so
      //    the ladder starts its count over instead of re-escalating on the
      //    first quiet turn.
      //  - `slotHeld` stays false. Escalation released the slot (D4) and a
      //    resume does not re-acquire one: the governor caps runs the BOARD
      //    spawns, and a re-acquire that the cap refused would leave the card
      //    unable to resume at all — the worst outcome of the three.
      // `lastNudgeAt` moves to now so the timeout sweep measures from the
      // takeover, not from the stop the human just cleared.
      const state: BoardCardStepState = {
        ...current,
        status: "running",
        stallCount: 0,
        lastError: null,
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
      // Idempotency (D4 Release): a step already settled re-emits its recorded
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
      // Slot, worktree and thread are untouched (D5) — only the frozen
      // human-in-the-loop stance changes, so drop-monitoring and auto-advance
      // honour the new value.
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

    default: {
      command satisfies never;
      // Runtime backstop for undecoded input: fail loudly rather than let
      // the generator fall through and return `undefined` in place of an
      // event.
      const fallback = command as never as { readonly type: string };
      return yield* new OrchestrationCommandInvariantError({
        commandType: fallback.type,
        detail: `Unhandled board command type: ${fallback.type}`,
      });
    }
  }
});
