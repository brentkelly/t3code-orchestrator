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
 * Stage advancement is human-gated (D18): every event this module emits is
 * caused by a client-dispatched command, and no other module emits board
 * events in t3o-03 — so no board-driven path can move a card into
 * `building`. The command catalog test in decider.board.test.ts asserts
 * this over every member of `BoardCommand`.
 */
import {
  areBoardStagesAdjacent,
  BOARD_CARD_BRIEF_BODY_KIND,
  BOARD_CARD_LABELS_MAX,
  BOARD_CREATABLE_STAGES,
  boardCardPlans,
  boardCardStepCompletions,
  boardLabelCatalogue,
  boardPlanId,
  boardStageIndex,
  DEFAULT_BOARD_KEY_PREFIX,
  deriveBoardCardBlocked,
  EMPTY_BOARD_STATE,
  EventId,
  isBoardCommand,
  isBoardCreatableStage,
  isBoardStageBeforeReady,
  pickNextBoardLabelColour,
  sortBoardCardThreadLinks,
  unmetBoardCardDependencies,
  type BoardCard,
  type BoardCardActivityEntry,
  type BoardCardId,
  type BoardLabel,
  type BoardLabelId,
  type BoardPlan,
  type BoardPlanWithBody,
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

/** Card-aggregate commands — every board command except the label ones; the
    only commands that carry a `cardId`. */
type BoardCardCommand = Exclude<BoardCommand, BoardLabelCommand>;

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
  readonly aggregateKind: "card" | "label";
  readonly aggregateId: BoardCardId | BoardLabelId;
} {
  if (isBoardLabelCommand(command)) {
    return { aggregateKind: "label", aggregateId: command.labelId };
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

/** Live (non-tombstoned) labels — the picker's view, and the set a name
    uniqueness check runs against. */
function liveBoardLabels(board: BoardState): ReadonlyArray<BoardLabel> {
  return boardLabelCatalogue(board).filter((label) => label.deletedAt === null);
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

      // Cards may be created only into Backlog, Sprint or Planning (t3o-06a):
      // later stages describe work the board has already started shepherding.
      // Generalises t3o-03's "no create path may land a card in Building".
      const stage = command.stage ?? "backlog";
      if (!isBoardCreatableStage(stage)) {
        return yield* invariant(
          command,
          `Cards can be created only into ${BOARD_CREATABLE_STAGES.join(", ")}; '${stage}' is not a creation stage.`,
        );
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
      if (command.override !== true && !areBoardStagesAdjacent(card.stage, command.toStage)) {
        return yield* invariant(
          command,
          `Stage move '${card.stage}' -> '${command.toStage}' is not adjacent; a drag sends override to force it.`,
        );
      }
      // Sub-board plan cards (D12) live Ready-onward; no override reopens
      // the early stages for them.
      if (card.parentCardId !== null && isBoardStageBeforeReady(command.toStage)) {
        return yield* invariant(
          command,
          `Card '${command.cardId}' is a sub-board plan card and cannot enter '${command.toStage}'.`,
        );
      }
      // Unmet dependencies gate the CROSSING of the Ready boundary (D18,
      // t3o-05): a card may sit blocked in Ready, but never moves from
      // Ready-or-earlier into the stages beyond it. Moves that stay within
      // the past-Ready zone — dragging a card backwards from review to
      // building, say — are not a crossing and stay open, matching the
      // rule that dependencies gate the hand-off into build, not movement
      // in general. The message names the unmet dependencies so the client
      // can say why, not just snap back.
      if (
        boardStageIndex(card.stage) <= boardStageIndex("ready") &&
        boardStageIndex(command.toStage) > boardStageIndex("ready")
      ) {
        const unmet = unmetBoardCardDependencies({
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
          stage: command.toStage,
          dependsOn: card.dependsOn,
          cards: board.cards,
        }),
        updatedAt: command.createdAt,
      };
      return {
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
        command.externalRef === undefined
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
            : deriveBoardCardBlocked({ stage: card.stage, dependsOn, cards: board.cards }),
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
      // Idempotency (D4): a retried completion re-emits the FIRST recorded
      // outcome, so the projection is a no-op upsert and no second transition
      // can fire. The first call for a (cardId, stepId) wins; a later call's
      // outcome/summary/payload are deliberately ignored, exactly as a raced
      // duplicate reorder re-emits the same order key.
      const existing = boardCardStepCompletions(board, command.cardId).find(
        (completion) => completion.stepId === command.stepId,
      );
      const completion: BoardStepCompletion = existing ?? {
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
      if (card.stage !== "building") {
        return yield* invariant(
          command,
          `Card '${command.cardId}' must be in 'building' to provision a worktree (D6); it is in '${card.stage}'.`,
        );
      }
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
