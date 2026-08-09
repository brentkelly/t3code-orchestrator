/**
 * T3o board decider — `decideBoardCommand`.
 *
 * Pure decision logic for board commands, delegated to from the upstream
 * decider behind the `isBoardCommand` predicate. Mirrors the upstream decider
 * contract exactly: read model in, planned event(s) out, `Crypto` as the only
 * requirement (D8 — the decider has no SQL client).
 */
import {
  EMPTY_BOARD_STATE,
  EventId,
  isBoardCommand,
  type BoardCardId,
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

type PlannedOrchestrationEvent = Omit<OrchestrationEvent, "sequence">;

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
  switch (command.type) {
    case "board.card.create": {
      yield* requireProject({
        readModel,
        command,
        projectId: command.projectId,
      });
      const board = readModel.board ?? EMPTY_BOARD_STATE;
      if (board.cards.some((card) => card.id === command.cardId)) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: `Card '${command.cardId}' already exists.`,
        });
      }

      const crypto = yield* Crypto.Crypto;
      const eventId = yield* crypto.randomUUIDv4;
      return {
        eventId: EventId.make(eventId),
        aggregateKind: "card",
        aggregateId: command.cardId,
        occurredAt: command.createdAt,
        commandId: command.commandId,
        causationEventId: null,
        correlationId: command.commandId,
        metadata: {},
        type: "board.card-created",
        payload: {
          cardId: command.cardId,
          projectId: command.projectId,
          title: command.title,
          createdAt: command.createdAt,
          updatedAt: command.createdAt,
        },
      };
    }

    default: {
      // Explicit terminal default: an unhandled board command fails loudly
      // with an invariant error rather than letting the generator fall through
      // and return `undefined` in place of an event. There is deliberately no
      // `command satisfies never` here yet: BoardCommand has one member, and a
      // single-member union does not narrow through the handled case, so the
      // guard would spuriously fail to compile. When t3o-03 gives the union a
      // second member, add `command satisfies never;` above this comment —
      // that guard is verified to fire (t3o-02a scratch check 2: a 2-member
      // union with an unhandled member failed the build at exactly that line).
      const fallback = command as { readonly type: string };
      return yield* new OrchestrationCommandInvariantError({
        commandType: fallback.type,
        detail: `Unhandled board command type: ${fallback.type}`,
      });
    }
  }
});
