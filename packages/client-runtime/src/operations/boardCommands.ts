/**
 * T3o board commands — client operations (t3o-03 commands, t3o-04 helpers).
 *
 * Board commands ride the board's own `board.dispatchCommand` RPC (T3O-57),
 * decided by the board's engine. Each helper mirrors the upstream
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
  type BoardAttachCardFileInput,
  type BoardCardId,
  type BoardDetachCardFileInput,
  type BoardClientCommand,
  type BoardCardWorkerMoveRequest,
  type BoardProjectImportCandidatesInput,
  type BoardProjectImportInput,
  type BoardSettingsClientCommand,
  type ProjectId,
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

type CommandType = BoardClientCommand["type"];
type CommandOf<T extends CommandType> = Extract<BoardClientCommand, { readonly type: T }>;
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
export type MoveBoardCardsInput = CommandInput<"board.card.move-cards">;
export type SetBoardCardGroupSettingsInput = CommandInput<"board.card.set-group-settings">;
export type SetBoardCardAutomationInput = CommandInput<"board.card.set-automation">;
export type CancelBoardCardWorkInput = CommandInput<"board.card.cancel-work">;
export type UpdateBoardCardInput = CommandInput<"board.card.update">;
export type SetBoardCardProjectInput = CommandInput<"board.card.set-project">;
export type PinBoardCardWorkerInput = CommandInput<"board.card.pin-worker">;
export type ForceStartBoardCardStepInput = CommandInput<"board.card.force-start-step">;
export type RequeueBoardCardStepInput = CommandInput<"board.card.requeue-step">;
export type ReopenBoardCardStepInput = CommandInput<"board.card.reopen-step">;
export type LinkBoardCardThreadInput = CommandInput<"board.card.link-thread">;
export type UnlinkBoardCardThreadInput = CommandInput<"board.card.unlink-thread">;
export type ArchiveBoardCardInput = CommandInput<"board.card.archive">;
export type UnarchiveBoardCardInput = CommandInput<"board.card.unarchive">;
export type DeleteBoardCardInput = CommandInput<"board.card.delete">;
export type CreateBoardLabelInput = CommandInput<"board.label.create">;
export type UpdateBoardLabelInput = CommandInput<"board.label.update">;
export type DeleteBoardLabelInput = CommandInput<"board.label.delete">;
export type UndeleteBoardLabelInput = CommandInput<"board.label.undelete">;
type SettingsCommandType = BoardSettingsClientCommand["type"];
type SettingsCommandInput<T extends SettingsCommandType> = Omit<
  Extract<BoardSettingsClientCommand, { readonly type: T }>,
  "type" | "commandId" | "createdAt" | "actor"
> & {
  readonly commandId?: CommandId;
  readonly createdAt?: string;
};

export type CreateBoardStageInput = SettingsCommandInput<"board.stage.create">;
export type RenameBoardStageInput = SettingsCommandInput<"board.stage.rename">;
export type ReorderBoardStageInput = SettingsCommandInput<"board.stage.reorder">;
export type DeleteBoardStageInput = SettingsCommandInput<"board.stage.delete">;
export type SetBoardStageDefaultInput =
  SettingsCommandInput<"board.stage.set-default-for-projects">;
export type SetBoardProjectStageSwitchInput =
  SettingsCommandInput<"board.project.set-stage-switch">;
export type SetBoardProjectStageOverrideInput =
  SettingsCommandInput<"board.project.set-stage-override">;
export type SetBoardProjectCiStepsInput = SettingsCommandInput<"board.project.set-ci-steps">;
export type SetBoardProjectCiEnabledInput = SettingsCommandInput<"board.project.set-ci-enabled">;
export type ResetBoardProjectInput = SettingsCommandInput<"board.project.reset">;
export type DismissBoardProjectImportInput = SettingsCommandInput<"board.project.dismiss-import">;
export type StartBoardStageThreadInput = CommandInput<"board.card.start-stage-thread">;
export type ApproveBoardPlansInput = CommandInput<"board.plans.approve">;

type DispatchTag = typeof BOARD_WS_METHODS.dispatchCommand;
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
            crypto.randomUUIDv4().pipe(Effect.orDie, Effect.map(CommandId.make)),
          )
        : Effect.succeed(input.commandId),
    createdAt:
      input.createdAt === undefined
        ? DateTime.now.pipe(Effect.map(DateTime.formatIso))
        : Effect.succeed(input.createdAt),
  });

function dispatch(command: BoardClientCommand) {
  return request(BOARD_WS_METHODS.dispatchCommand, command);
}

/**
 * The two card→pull-request ACTIONS (t3o card↔PR spec). Unlike everything else
 * in this module these are not board commands: they are their own board RPCs,
 * because each returns a result the caller renders — and because a
 * refresh fires whenever a card is opened, which has no business writing to
 * the durable event log every time.
 */
export const refreshBoardCardPullRequest = (input: {
  readonly cardId: BoardCardId;
  /** T3o (T3O-48): a human's "Check again". Omitted by the automatic triggers,
      which keep the cached lookup. */
  readonly force?: boolean;
}) => request(BOARD_WS_METHODS.refreshCardPullRequest, input);

/** "Link one" on a card with no pull request (T3O-18). The target goes as
    typed — a URL, `#312` — and the server parses it, checks it with the forge,
    and answers `linked` or the refusal to show. */
export const linkBoardCardPullRequest = (input: {
  readonly cardId: BoardCardId;
  readonly target: string;
}) => request(BOARD_WS_METHODS.linkCardPullRequest, input);

export const mergeBoardCardPullRequest = (input: { readonly cardId: BoardCardId }) =>
  request(BOARD_WS_METHODS.mergeCardPullRequest, input);

/** Open the card's pull request from Building and route it past Code review
    (t3o-07). Same input shape as the merge action, and the same reason for
    being an RPC: the caller renders the outcome. */
export const submitBoardCardForMerge = (input: { readonly cardId: BoardCardId }) =>
  request(BOARD_WS_METHODS.submitCardForMerge, input);

/** Run one more review round on a card whose loop has already settled
    (T3O-39) — "Another review round", and "Request review" on a card that
    never had one. An RPC for the ordering: the override has to be written
    before the card moves, and the server owns that order. */
export const requestBoardReviewRound = (input: { readonly cardId: BoardCardId }) =>
  request(BOARD_WS_METHODS.requestReviewRound, input);

/** "Skip CI" (T3O-44): stop the card's CI run and move it to the stage after
    CI. The server records the skip under the caller's name. */
export const skipBoardCardCi = (input: { readonly cardId: BoardCardId }) =>
  request(BOARD_WS_METHODS.skipCi, input);

/** Retry CI and "Send back to review anyway" (T3O-49). */
export const retryBoardCardCi = (input: { readonly cardId: BoardCardId }) =>
  request(BOARD_WS_METHODS.retryCi, input);

export const sendBackBoardCardCi = (input: { readonly cardId: BoardCardId }) =>
  request(BOARD_WS_METHODS.ciSendBack, input);

/** "Remove worktree" on a finished card that kept one (T3O-52): removes it
    past the safety rule. The branch is kept. */
export const removeBoardCardWorktree = (input: { readonly cardId: BoardCardId }) =>
  request(BOARD_WS_METHODS.removeCardWorktree, input);

/** Re-run a kept worktree's cleanup (T3O-52), answering what it did. */
export const checkBoardCardWorktree = (input: { readonly cardId: BoardCardId }) =>
  request(BOARD_WS_METHODS.checkCardWorktree, input);

/** The Move dialog (T3O-65): check a move, start it, or ask the card's agent
    to push. Answers what the action gives. */
export const boardCardWorkerMove = (input: BoardCardWorkerMoveRequest) =>
  request(BOARD_WS_METHODS.cardWorkerMove, input);

/** Claim a pending upload onto a card's brief (t3o-32): the server copies the
    file into the card's folder and records it, in that order. */
export const attachBoardCardFile = (input: BoardAttachCardFileInput) =>
  request(BOARD_WS_METHODS.attachCardFile, input);

export const detachBoardCardFile = (input: BoardDetachCardFileInput) =>
  request(BOARD_WS_METHODS.detachCardFile, input);

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

/** Start a card's queued step now, over the agent cap (t3o-33). Names no step:
    the server resolves the card's live one. */
export const forceStartBoardCardStep: (input: ForceStartBoardCardStepInput) => CommandEffect =
  Effect.fn("BoardCommands.forceStartBoardCardStep")(function* (input) {
    const metadata = yield* commandMetadata(input);
    return yield* dispatch({
      ...input,
      type: "board.card.force-start-step",
      commandId: metadata.commandId,
      createdAt: metadata.createdAt,
    });
  });

/** Send a card's parked step back to the build queue (T3O-23) — the Resume
    button on a paused card. Names no step: the server resolves the card's live
    one, and the governor admits it when a slot frees. */
export const requeueBoardCardStep: (input: RequeueBoardCardStepInput) => CommandEffect = Effect.fn(
  "BoardCommands.requeueBoardCardStep",
)(function* (input) {
  const metadata = yield* commandMetadata(input);
  return yield* dispatch({
    ...input,
    type: "board.card.requeue-step",
    commandId: metadata.commandId,
    createdAt: metadata.createdAt,
  });
});

/** Repair a settled step whose recorded payload cannot be read (T3O-14), so
    the review loop plans its round again. Refused on a readable record. */
export const reopenBoardCardStep: (input: ReopenBoardCardStepInput) => CommandEffect = Effect.fn(
  "BoardCommands.reopenBoardCardStep",
)(function* (input) {
  const metadata = yield* commandMetadata(input);
  return yield* dispatch({
    ...input,
    type: "board.card.reopen-step",
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

/** Move a card to another project (T3O-33), reissuing its key against that
    project's prefix and counter and clearing its base-branch pin. Refused by
    the decider once the card has ever been built. `keyPrefix` is resolved
    client-side, exactly as `createBoardCard` resolves it. */
export const setBoardCardProject: (input: SetBoardCardProjectInput) => CommandEffect = Effect.fn(
  "BoardCommands.setBoardCardProject",
)(function* (input) {
  const metadata = yield* commandMetadata(input);
  return yield* dispatch({
    ...input,
    type: "board.card.set-project",
    commandId: metadata.commandId,
    createdAt: metadata.createdAt,
  });
});

/** Pin a card to a worker, or null to follow the default (T3O-65). Refused by
    the decider for a card whose worktree is on another worker — that is a
    move (`boardCardWorkerMove`). */
export const pinBoardCardWorker: (input: PinBoardCardWorkerInput) => CommandEffect = Effect.fn(
  "BoardCommands.pinBoardCardWorker",
)(function* (input) {
  const metadata = yield* commandMetadata(input);
  return yield* dispatch({
    ...input,
    type: "board.card.pin-worker",
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

/** Regroup cards (T3O-27): into a group, out of one, or within one. */
export const moveBoardCards: (input: MoveBoardCardsInput) => CommandEffect = Effect.fn(
  "BoardCommands.moveBoardCards",
)(function* (input) {
  const metadata = yield* commandMetadata(input);
  return yield* dispatch({
    ...input,
    type: "board.card.move-cards",
    commandId: metadata.commandId,
    createdAt: metadata.createdAt,
  });
});

/** A group's merge target, auto-build, auto-merge and auto-plan (T3O-29). */
export const setBoardCardGroupSettings: (input: SetBoardCardGroupSettingsInput) => CommandEffect =
  Effect.fn("BoardCommands.setBoardCardGroupSettings")(function* (input) {
    const metadata = yield* commandMetadata(input);
    return yield* dispatch({
      ...input,
      type: "board.card.set-group-settings",
      commandId: metadata.commandId,
      createdAt: metadata.createdAt,
    });
  });

/** A card's own Automation toggles (T3O-38): true / false, or null to
    inherit from the parent group. */
export const setBoardCardAutomation: (input: SetBoardCardAutomationInput) => CommandEffect =
  Effect.fn("BoardCommands.setBoardCardAutomation")(function* (input) {
    const metadata = yield* commandMetadata(input);
    return yield* dispatch({
      ...input,
      type: "board.card.set-automation",
      commandId: metadata.commandId,
      createdAt: metadata.createdAt,
    });
  });

/** Cancel a started leaf's work so it can become a group (T3O-28). The
    caller has confirmed it by the card's typed key. */
export const cancelBoardCardWork: (input: CancelBoardCardWorkInput) => CommandEffect = Effect.fn(
  "BoardCommands.cancelBoardCardWork",
)(function* (input) {
  const metadata = yield* commandMetadata(input);
  return yield* dispatch({
    ...input,
    type: "board.card.cancel-work",
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

/** Approve a card's proposed split (t3o-23): materialise its plans as child
    cards and start the sub-board. Human-only — no MCP tool dispatches this. */
export const approveBoardPlans: (input: ApproveBoardPlansInput) => CommandEffect = Effect.fn(
  "BoardCommands.approveBoardPlans",
)(function* (input) {
  const metadata = yield* commandMetadata(input);
  return yield* dispatch({
    ...input,
    type: "board.plans.approve",
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

/**
 * T3O-49: stage and project config commands ride their own settings-tier RPC,
 * never `board.dispatchCommand`. The server stamps the actor.
 */
const dispatchSettings = <T extends SettingsCommandType>(type: T, name: string) =>
  Effect.fn(`BoardCommands.${name}`)(function* (input: SettingsCommandInput<T>) {
    const metadata = yield* commandMetadata(input);
    return yield* request(BOARD_WS_METHODS.dispatchSettingsCommand, {
      ...input,
      type,
      commandId: metadata.commandId,
      createdAt: metadata.createdAt,
    } as unknown as BoardSettingsClientCommand);
  });

export const createBoardStage = dispatchSettings("board.stage.create", "createBoardStage");
export const renameBoardStage = dispatchSettings("board.stage.rename", "renameBoardStage");
export const reorderBoardStage = dispatchSettings("board.stage.reorder", "reorderBoardStage");
export const deleteBoardStage = dispatchSettings("board.stage.delete", "deleteBoardStage");
export const setBoardStageDefault = dispatchSettings(
  "board.stage.set-default-for-projects",
  "setBoardStageDefault",
);
export const setBoardProjectStageSwitch = dispatchSettings(
  "board.project.set-stage-switch",
  "setBoardProjectStageSwitch",
);
export const setBoardProjectStageOverride = dispatchSettings(
  "board.project.set-stage-override",
  "setBoardProjectStageOverride",
);
export const setBoardProjectCiSteps = dispatchSettings(
  "board.project.set-ci-steps",
  "setBoardProjectCiSteps",
);
export const setBoardProjectCiEnabled = dispatchSettings(
  "board.project.set-ci-enabled",
  "setBoardProjectCiEnabled",
);
export const resetBoardProject = dispatchSettings("board.project.reset", "resetBoardProject");
export const dismissBoardProjectImport = dispatchSettings(
  "board.project.dismiss-import",
  "dismissBoardProjectImport",
);

/** A project's full delta, with the prompts the shell leaves out. */
export const getBoardProjectConfig = (input: { readonly projectId: ProjectId }) =>
  request(BOARD_WS_METHODS.getProjectConfig, input);

export const getBoardProjectImportCandidates = (input: BoardProjectImportCandidatesInput) =>
  request(BOARD_WS_METHODS.projectImportCandidates, input);

export const importBoardProjectFile = (input: BoardProjectImportInput) =>
  request(BOARD_WS_METHODS.importProjectFile, input);

export const exportBoardProjectFile = (input: { readonly projectId: ProjectId }) =>
  request(BOARD_WS_METHODS.exportProjectFile, input);

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
