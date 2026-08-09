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
  boardStageIndex,
  DEFAULT_BOARD_KEY_PREFIX,
  deriveBoardCardBlocked,
  EMPTY_BOARD_STATE,
  EventId,
  isBoardCommand,
  isBoardStageBeforeReady,
  sortBoardCardThreadLinks,
  unmetBoardCardDependencies,
  type BoardCard,
  type BoardCardId,
  type BoardState,
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

// Re-exported so upstream seams import predicate + delegate on one line.
export { isBoardCommand };

// Distributive so the planned event stays a discriminated union — a plain
// `Omit` over the union flattens `type` and `payload` into independent
// unions and callers could no longer narrow payloads by event type.
type DistributiveOmit<T, K extends keyof T> = T extends unknown ? Omit<T, K> : never;
type PlannedOrchestrationEvent = DistributiveOmit<OrchestrationEvent, "sequence">;

/**
 * Aggregate ref for a board command — every board command aggregates on its
 * card (D9). Called from `commandToAggregateRef` in the upstream engine
 * behind the `isBoardCommand` predicate.
 */
export function boardCommandAggregateRef(command: BoardCommand): {
  readonly aggregateKind: "card";
  readonly aggregateId: BoardCardId;
} {
  return {
    aggregateKind: "card",
    aggregateId: command.cardId,
  };
}

const invariant = (command: BoardCommand, detail: string) =>
  new OrchestrationCommandInvariantError({ commandType: command.type, detail });

function requireBoardCard(input: {
  readonly board: BoardState;
  readonly command: BoardCommand;
}): Effect.Effect<BoardCard, OrchestrationCommandInvariantError> {
  const card = input.board.cards.find((candidate) => candidate.id === input.command.cardId);
  return card === undefined
    ? Effect.fail(invariant(input.command, `Card '${input.command.cardId}' does not exist.`))
    : Effect.succeed(card);
}

function requireActiveBoardCard(input: {
  readonly board: BoardState;
  readonly command: BoardCommand;
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

export const decideBoardCommand = Effect.fn("decideBoardCommand")(function* ({
  command,
  readModel,
}: {
  readonly command: BoardCommand;
  readonly readModel: OrchestrationReadModel;
}): Effect.fn.Return<
  PlannedOrchestrationEvent,
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
          cardType: command.cardType,
          stage: "backlog",
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
      // Ready is as far as unmet dependencies allow (D18, t3o-05): a card may
      // sit blocked in Ready, but never crosses it. The message names the
      // unmet dependencies so the client can say why, not just snap back.
      if (boardStageIndex(command.toStage) > boardStageIndex("ready")) {
        const unmet = unmetBoardCardDependencies({
          dependsOn: card.dependsOn,
          cards: board.cards,
        });
        if (unmet.length > 0) {
          const names = unmet.map((dependencyId) => {
            const dependency = board.cards.find((existing) => existing.id === dependencyId);
            return dependency === undefined
              ? `an archived or deleted card ('${dependencyId}')`
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
        command.cardType === undefined &&
        command.dependsOn === undefined &&
        command.externalRef === undefined
      ) {
        return yield* invariant(command, `Update for card '${command.cardId}' carries no changes.`);
      }

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
        type: command.cardType ?? card.type,
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
      return {
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
      return {
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
