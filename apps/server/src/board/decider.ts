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
  boardCardPlans,
  boardCardStepCompletions,
  boardCardStepState,
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
  EMPTY_BOARD_STATE,
  EventId,
  isBoardCommand,
  isBoardStageAtOrAfterBuild,
  isBoardTerminalStepStatus,
  pickNextBoardLabelColour,
  sortBoardCardThreadLinks,
  unmetBoardCardDependencies,
  type BoardCard,
  type BoardCardActivityEntry,
  type BoardCardId,
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
 * D5). The engine accepts either.
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

      // Initial dependencies (t3o-06): dedupe and require each to exist. A
      // cycle is impossible at create — a brand-new card has no dependents, so
      // no existing edge can reach it — which is why create needs only the
      // existence check while `board.card.update` also gates cycles.
      const dependsOn = command.dependsOn === undefined ? [] : [...new Set(command.dependsOn)];
      for (const dependencyId of dependsOn) {
        if (!board.cards.some((existing) => existing.id === dependencyId)) {
          return yield* invariant(command, `Dependency '${dependencyId}' does not exist.`);
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
      // Sub-board plan cards (D11) are materialised work, restricted to the
      // `build` role and beyond; no override reopens the earlier stages.
      if (card.parentCardId !== null && !isBoardStageAtOrAfterBuild(board, command.toStage)) {
        return yield* invariant(
          command,
          `Card '${command.cardId}' is a sub-board plan card and cannot enter '${command.toStage}'.`,
        );
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
      const doneStageId = boardStageWithRole(board, "done")?.stageId ?? null;
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
        command.humanInLoop === undefined
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

    case "board.card.archive": {
      const card = yield* requireBoardCard({ board, command });
      if (card.archivedAt !== null) {
        return yield* invariant(command, `Card '${command.cardId}' is already archived.`);
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
      // A new role-holder would break "exactly one stage per role"; the three
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
      if (stage.role !== null) {
        return yield* invariant(
          command,
          `Stage '${stage.label}' holds the '${stage.role}' role and cannot be deleted.`,
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

    case "board.card.report-progress": {
      // Existence + not-archived gate; the note itself needs no other state.
      yield* requireActiveBoardCard({ board, command });
      const entry: BoardCardActivityEntry = {
        activityId: command.activityId,
        cardId: command.cardId,
        kind: "progress",
        body: command.note,
        threadId: command.threadId,
        createdAt: command.createdAt,
      };
      return {
        ...(yield* makeBoardEventBase({
          cardId: command.cardId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        })),
        type: "board.card-progress-reported",
        payload: { cardId: command.cardId, entry },
      };
    }

    case "board.card.request-input": {
      yield* requireActiveBoardCard({ board, command });
      const entry: BoardCardActivityEntry = {
        activityId: command.activityId,
        cardId: command.cardId,
        kind: "input-requested",
        body: command.question,
        threadId: command.threadId,
        createdAt: command.createdAt,
      };
      return {
        ...(yield* makeBoardEventBase({
          cardId: command.cardId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        })),
        type: "board.card-input-requested",
        payload: { cardId: command.cardId, entry },
      };
    }

    case "board.card.complete-step": {
      yield* requireActiveBoardCard({ board, command });
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
      return {
        ...(yield* makeBoardEventBase({
          cardId: command.cardId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        })),
        type: "board.card-step-completed",
        payload: { cardId: command.cardId, completion },
      };
    }

    case "board.plans.propose": {
      yield* requireActiveBoardCard({ board, command });
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
      // Provisioning starts fresh, or retries a failed step. A worktree that
      // is already provisioning, ready or reclaimed is never re-provisioned
      // behind its own back.
      if (card.worktree !== null && card.worktree.status !== "failed") {
        return yield* invariant(
          command,
          `Card '${command.cardId}' worktree is '${card.worktree.status}'; only a failed worktree can be re-provisioned.`,
        );
      }
      const attempts = card.worktree === null ? 1 : card.worktree.attempts + 1;
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

    case "board.card.fail-worktree": {
      const card = yield* requireActiveBoardCard({ board, command });
      if (card.worktree === null || card.worktree.status !== "provisioning") {
        return yield* invariant(
          command,
          `Card '${command.cardId}' has no worktree in 'provisioning'; cannot fail it.`,
        );
      }
      const nextCard: BoardCard = {
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
        mode: command.mode,
        humanInLoop: command.humanInLoop,
        maxAttempts: command.maxAttempts,
        timeoutMs: command.timeoutMs,
        threadId: null,
        status: "pending",
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
      const state: BoardCardStepState = {
        ...current,
        attempt: current.attempt + 1,
        stallCount: (command.progressed ? 0 : current.stallCount) + 1,
        status: command.escalateToHuman ? "stalled" : "running",
        slotHeld: command.escalateToHuman ? false : current.slotHeld,
        threadId: command.threadId,
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
