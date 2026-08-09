/**
 * T3o board decider — `decideBoardCommand`.
 *
 * Pure decision logic for board commands, delegated to from the head of the
 * orchestration decider's switch. Mirrors the upstream decider contract
 * exactly: read model in, planned event(s) out, `Crypto` as the only
 * requirement (D8 — the decider has no SQL client).
 */
import {
  EMPTY_BOARD_STATE,
  EventId,
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

type PlannedOrchestrationEvent = Omit<OrchestrationEvent, "sequence">;

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
      // and return `undefined` in place of an event. (Once BoardCommand has a
      // second member this default also becomes a compile-time exhaustiveness
      // guard — TS narrows a multi-member discriminant to `never` here.)
      const fallback = command as { readonly type: string };
      return yield* new OrchestrationCommandInvariantError({
        commandType: fallback.type,
        detail: `Unhandled board command type: ${fallback.type}`,
      });
    }
  }
});
