/**
 * T3o board commands — client operations.
 *
 * Board commands ride the existing `orchestration.dispatchCommand` RPC (D2),
 * so this module is plain composition over the stock RPC client: no new
 * methods, no new transport.
 */
import {
  CommandId,
  ORCHESTRATION_WS_METHODS,
  type BoardCardId,
  type ProjectId,
} from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";

import { request } from "../rpc/client.ts";

export interface CreateBoardCardInput {
  readonly cardId: BoardCardId;
  readonly projectId: ProjectId;
  readonly title: string;
  readonly commandId?: CommandId;
  readonly createdAt?: string;
}

export const createBoardCard = Effect.fn("BoardCommands.createBoardCard")(function* (
  input: CreateBoardCardInput,
) {
  const crypto = yield* Crypto.Crypto;
  const commandId =
    input.commandId ?? (yield* crypto.randomUUIDv4.pipe(Effect.orDie, Effect.map(CommandId.make)));
  const createdAt = input.createdAt ?? (yield* DateTime.now.pipe(Effect.map(DateTime.formatIso)));
  return yield* request(ORCHESTRATION_WS_METHODS.dispatchCommand, {
    type: "board.card.create",
    commandId,
    cardId: input.cardId,
    projectId: input.projectId,
    title: input.title,
    createdAt,
  });
});
