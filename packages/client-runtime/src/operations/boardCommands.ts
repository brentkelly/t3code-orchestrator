/**
 * T3o board commands — client operations (t3o-03 commands, t3o-04 helpers).
 *
 * Board commands ride the existing `orchestration.dispatchCommand` RPC (D2),
 * so this module is plain composition over the stock RPC client: no new
 * methods, no new transport. Each helper mirrors the upstream
 * `operations/commands.ts` shape — caller supplies the domain fields,
 * `commandId` / `createdAt` are generated when absent.
 *
 * `orderKey` values are computed client-side with the `threadSort.ts`
 * fractional helpers (see `planBoardCardReorder` in `state/board.ts`) — the
 * server stores what the client computed, following the `pinOrderKey`
 * precedent committed to on `BoardCard.orderKey`.
 */
import {
  BOARD_WS_METHODS,
  CommandId,
  ORCHESTRATION_WS_METHODS,
  type BoardCardId,
  type ClientOrchestrationCommand,
} from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";

import type { EnvironmentSupervisor } from "../connection/supervisor.ts";
import {
  type EnvironmentRpcFailure,
  type EnvironmentRpcSuccess,
  type EnvironmentRpcUnavailableError,
  request,
} from "../rpc/client.ts";

type CommandType = ClientOrchestrationCommand["type"];
type CommandOf<T extends CommandType> = Extract<ClientOrchestrationCommand, { readonly type: T }>;
type CommandInput<T extends CommandType> = Omit<
  CommandOf<T>,
  "type" | "commandId" | "createdAt"
> & {
  readonly commandId?: CommandId;
  readonly createdAt?: string;
};

export type CreateBoardCardInput = CommandInput<"board.card.create">;
export type MoveBoardCardInput = CommandInput<"board.card.move">;
export type ReorderBoardCardInput = CommandInput<"board.card.reorder">;
export type UpdateBoardCardInput = CommandInput<"board.card.update">;
export type LinkBoardCardThreadInput = CommandInput<"board.card.link-thread">;
export type UnlinkBoardCardThreadInput = CommandInput<"board.card.unlink-thread">;
export type ArchiveBoardCardInput = CommandInput<"board.card.archive">;
export type UnarchiveBoardCardInput = CommandInput<"board.card.unarchive">;
export type DeleteBoardCardInput = CommandInput<"board.card.delete">;
export type CreateBoardLabelInput = CommandInput<"board.label.create">;
export type UpdateBoardLabelInput = CommandInput<"board.label.update">;
export type DeleteBoardLabelInput = CommandInput<"board.label.delete">;
export type UndeleteBoardLabelInput = CommandInput<"board.label.undelete">;
export type CreateBoardStageInput = CommandInput<"board.stage.create">;
export type RenameBoardStageInput = CommandInput<"board.stage.rename">;
export type ReorderBoardStageInput = CommandInput<"board.stage.reorder">;
export type DeleteBoardStageInput = CommandInput<"board.stage.delete">;
export type StartBoardStageThreadInput = CommandInput<"board.card.start-stage-thread">;

type DispatchTag = typeof ORCHESTRATION_WS_METHODS.dispatchCommand;
type CommandEffect = Effect.Effect<
  EnvironmentRpcSuccess<DispatchTag>,
  EnvironmentRpcFailure<DispatchTag> | EnvironmentRpcUnavailableError,
  Crypto.Crypto | EnvironmentSupervisor
>;

const commandMetadata = (input: { readonly commandId?: CommandId; readonly createdAt?: string }) =>
  Effect.all({
    commandId:
      input.commandId === undefined
        ? Effect.flatMap(Crypto.Crypto, (crypto) =>
            crypto.randomUUIDv4.pipe(Effect.orDie, Effect.map(CommandId.make)),
          )
        : Effect.succeed(input.commandId),
    createdAt:
      input.createdAt === undefined
        ? DateTime.now.pipe(Effect.map(DateTime.formatIso))
        : Effect.succeed(input.createdAt),
  });

function dispatch(command: ClientOrchestrationCommand) {
  return request(ORCHESTRATION_WS_METHODS.dispatchCommand, command);
}

/**
 * The two card→pull-request ACTIONS (t3o card↔PR spec). Unlike everything else
 * in this module these do not ride `orchestration.dispatchCommand`: they are
 * board RPCs, because each returns a result the caller renders — and because a
 * refresh fires whenever a card is opened, which has no business writing to
 * the durable event log every time.
 */
export const refreshBoardCardPullRequest = (input: { readonly cardId: BoardCardId }) =>
  request(BOARD_WS_METHODS.refreshCardPullRequest, input);

export const mergeBoardCardPullRequest = (input: { readonly cardId: BoardCardId }) =>
  request(BOARD_WS_METHODS.mergeCardPullRequest, input);

export const createBoardCard: (input: CreateBoardCardInput) => CommandEffect = Effect.fn(
  "BoardCommands.createBoardCard",
)(function* (input) {
  const metadata = yield* commandMetadata(input);
  return yield* dispatch({
    ...input,
    type: "board.card.create",
    commandId: metadata.commandId,
    createdAt: metadata.createdAt,
  });
});

export const moveBoardCard: (input: MoveBoardCardInput) => CommandEffect = Effect.fn(
  "BoardCommands.moveBoardCard",
)(function* (input) {
  const metadata = yield* commandMetadata(input);
  return yield* dispatch({
    ...input,
    type: "board.card.move",
    commandId: metadata.commandId,
    createdAt: metadata.createdAt,
  });
});

export const reorderBoardCard: (input: ReorderBoardCardInput) => CommandEffect = Effect.fn(
  "BoardCommands.reorderBoardCard",
)(function* (input) {
  const metadata = yield* commandMetadata(input);
  return yield* dispatch({
    ...input,
    type: "board.card.reorder",
    commandId: metadata.commandId,
    createdAt: metadata.createdAt,
  });
});

export const updateBoardCard: (input: UpdateBoardCardInput) => CommandEffect = Effect.fn(
  "BoardCommands.updateBoardCard",
)(function* (input) {
  const metadata = yield* commandMetadata(input);
  return yield* dispatch({
    ...input,
    type: "board.card.update",
    commandId: metadata.commandId,
    createdAt: metadata.createdAt,
  });
});

export const linkBoardCardThread: (input: LinkBoardCardThreadInput) => CommandEffect = Effect.fn(
  "BoardCommands.linkBoardCardThread",
)(function* (input) {
  const metadata = yield* commandMetadata(input);
  return yield* dispatch({
    ...input,
    type: "board.card.link-thread",
    commandId: metadata.commandId,
    createdAt: metadata.createdAt,
  });
});

export const unlinkBoardCardThread: (input: UnlinkBoardCardThreadInput) => CommandEffect =
  Effect.fn("BoardCommands.unlinkBoardCardThread")(function* (input) {
    const metadata = yield* commandMetadata(input);
    return yield* dispatch({
      ...input,
      type: "board.card.unlink-thread",
      commandId: metadata.commandId,
      createdAt: metadata.createdAt,
    });
  });

export const archiveBoardCard: (input: ArchiveBoardCardInput) => CommandEffect = Effect.fn(
  "BoardCommands.archiveBoardCard",
)(function* (input) {
  const metadata = yield* commandMetadata(input);
  return yield* dispatch({
    ...input,
    type: "board.card.archive",
    commandId: metadata.commandId,
    createdAt: metadata.createdAt,
  });
});

export const unarchiveBoardCard: (input: UnarchiveBoardCardInput) => CommandEffect = Effect.fn(
  "BoardCommands.unarchiveBoardCard",
)(function* (input) {
  const metadata = yield* commandMetadata(input);
  return yield* dispatch({
    ...input,
    type: "board.card.unarchive",
    commandId: metadata.commandId,
    createdAt: metadata.createdAt,
  });
});

/** Purge a card — irreversible, and the caller is expected to have confirmed
    it with the user first (the server does not, and cannot, ask). */
export const deleteBoardCard: (input: DeleteBoardCardInput) => CommandEffect = Effect.fn(
  "BoardCommands.deleteBoardCard",
)(function* (input) {
  const metadata = yield* commandMetadata(input);
  return yield* dispatch({
    ...input,
    type: "board.card.delete",
    commandId: metadata.commandId,
    createdAt: metadata.createdAt,
  });
});

export const createBoardLabel: (input: CreateBoardLabelInput) => CommandEffect = Effect.fn(
  "BoardCommands.createBoardLabel",
)(function* (input) {
  const metadata = yield* commandMetadata(input);
  return yield* dispatch({
    ...input,
    type: "board.label.create",
    commandId: metadata.commandId,
    createdAt: metadata.createdAt,
  });
});

export const updateBoardLabel: (input: UpdateBoardLabelInput) => CommandEffect = Effect.fn(
  "BoardCommands.updateBoardLabel",
)(function* (input) {
  const metadata = yield* commandMetadata(input);
  return yield* dispatch({
    ...input,
    type: "board.label.update",
    commandId: metadata.commandId,
    createdAt: metadata.createdAt,
  });
});

export const deleteBoardLabel: (input: DeleteBoardLabelInput) => CommandEffect = Effect.fn(
  "BoardCommands.deleteBoardLabel",
)(function* (input) {
  const metadata = yield* commandMetadata(input);
  return yield* dispatch({
    ...input,
    type: "board.label.delete",
    commandId: metadata.commandId,
    createdAt: metadata.createdAt,
  });
});

export const undeleteBoardLabel: (input: UndeleteBoardLabelInput) => CommandEffect = Effect.fn(
  "BoardCommands.undeleteBoardLabel",
)(function* (input) {
  const metadata = yield* commandMetadata(input);
  return yield* dispatch({
    ...input,
    type: "board.label.undelete",
    commandId: metadata.commandId,
    createdAt: metadata.createdAt,
  });
});

export const createBoardStage: (input: CreateBoardStageInput) => CommandEffect = Effect.fn(
  "BoardCommands.createBoardStage",
)(function* (input) {
  const metadata = yield* commandMetadata(input);
  return yield* dispatch({
    ...input,
    type: "board.stage.create",
    commandId: metadata.commandId,
    createdAt: metadata.createdAt,
  });
});

export const renameBoardStage: (input: RenameBoardStageInput) => CommandEffect = Effect.fn(
  "BoardCommands.renameBoardStage",
)(function* (input) {
  const metadata = yield* commandMetadata(input);
  return yield* dispatch({
    ...input,
    type: "board.stage.rename",
    commandId: metadata.commandId,
    createdAt: metadata.createdAt,
  });
});

export const reorderBoardStage: (input: ReorderBoardStageInput) => CommandEffect = Effect.fn(
  "BoardCommands.reorderBoardStage",
)(function* (input) {
  const metadata = yield* commandMetadata(input);
  return yield* dispatch({
    ...input,
    type: "board.stage.reorder",
    commandId: metadata.commandId,
    createdAt: metadata.createdAt,
  });
});

export const deleteBoardStage: (input: DeleteBoardStageInput) => CommandEffect = Effect.fn(
  "BoardCommands.deleteBoardStage",
)(function* (input) {
  const metadata = yield* commandMetadata(input);
  return yield* dispatch({
    ...input,
    type: "board.stage.delete",
    commandId: metadata.commandId,
    createdAt: metadata.createdAt,
  });
});

export const startBoardStageThread: (input: StartBoardStageThreadInput) => CommandEffect =
  Effect.fn("BoardCommands.startBoardStageThread")(function* (input) {
    const metadata = yield* commandMetadata(input);
    return yield* dispatch({
      ...input,
      type: "board.card.start-stage-thread",
      commandId: metadata.commandId,
      createdAt: metadata.createdAt,
    });
  });
