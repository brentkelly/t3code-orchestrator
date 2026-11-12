/**
 * Board RPC handlers, spread into upstream's ws.ts handler object. Upstream's
 * `RpcScopeAuthorization` already checks `BOARD_RPC_SCOPES`; the handlers re-check the
 * same session as a second line, with the same `EnvironmentAuthorizationError` shape.
 */
import {
  BOARD_RPC_SCOPES,
  BOARD_WS_METHODS,
  BoardDispatchCommandError,
  BoardSnapshotError,
  BoardSubscribeCardError,
  EnvironmentAuthorizationError,
  BoardCardAttachmentError,
  BoardCardAttachmentId,
  CommandId,
  type BoardAttachCardFileInput,
  type BoardDetachCardFileInput,
  type BoardCardDetail,
  type BoardCardDetailStreamItem,
  type BoardCardId,
  type BoardCardPullRequestActionInput,
  type BoardCiActionInput,
  type BoardReadCiLogInput,
  type BoardRequestReviewRoundInput,
  type BoardCardWorkerMoveAnswer,
  type BoardCardWorkerMoveRequest,
  // T3o: the refresh's own payload.
  type BoardRefreshCardPullRequestInput,
  type BoardLinkCardPullRequestInput,
  type BoardClientCommand,
  type BoardSubscribeBoardInput,
  type BoardSubscribeCardInput,
  // T3o: project config RPCs.
  type BoardProjectConfigInput,
  type BoardProjectImportCandidatesInput,
  type BoardProjectImportInput,
  type BoardSettingsClientCommand,
  OrchestrationClientOrigin,
  type ProjectId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

import type { AuthenticatedSession } from "../auth/EnvironmentAuth.ts";
import * as ServerConfig from "../config.ts";
import { parseCardPullRequestText } from "./cardPullRequestTarget.ts";
import { guardBoardHandlers } from "./tunnel/boardSubjectGuard.ts";
import {
  BoardAttachmentClaimError,
  claimBoardCardAttachment,
  deleteBoardCardAttachmentFile,
} from "./attachments.ts";
import {
  BOARD_HUMAN_ACTOR_FALLBACK_NAME,
  boardHumanActor,
  stampBoardActivityActor,
} from "./activityActors.ts";
import { BoardEngine, type BoardEngineShape } from "./BoardEngine.ts";
import { SourceControlDrivers } from "../sourceControl/builtInDrivers.ts";
import { boardProjectTokenStatus } from "./projectTokenStatus.ts";
import {
  make as makeBoardProjectConfigService,
  type BoardProjectConfigServiceShape,
} from "./projectConfig/BoardProjectConfigService.ts";
import { BoardQueries } from "./BoardQueries.ts";
import type { BoardQueriesShape } from "./projection.ts";
import { subscribeBoard } from "./boardSubscription.ts";
import { BoardThreadTail } from "./boardThreadTail.ts";
import { ThreadGateway, type ThreadGatewayShape } from "./ThreadGateway.ts";
import type { BoardCommand } from "./decider.ts";
import type { SupervisorReactorShape } from "./supervisorReactor.ts";
import { BoardCardMover, type BoardCardMoverShape } from "./workers/BoardCardMove.ts";
import { readBoardCiLog, type BoardCiLogDeps } from "./ci/ciLog.ts";
import { WorkerConnections } from "./workers/WorkerConnections.ts";
import { BoardUsageRecorder } from "./usage/BoardUsageRecorder.ts";
import { BoardWorkers } from "./workers/BoardWorkers.ts";
import { workerGatewayRpcHandlers } from "./workers/workerGatewayRpc.ts";
import { boardWorkerRpcHandlers } from "./workers/workerRpc.ts";
import { BoardWorkspaces, type BoardWorkspacesShape } from "./workspace/BoardWorkspace.ts";
import { boardWorkerGitCallRpcHandlers } from "./workspace/workerGitRpc.ts";

export interface BoardRpcHandlerDeps {
  readonly currentSession: AuthenticatedSession;
  /** The supervisor reactor performs the card→PR actions: it owns the forge
      gateway and the step machinery a conflict fix needs. */
  readonly boardSupervisor: SupervisorReactorShape;
  /** The connecting client's self-description (ws.ts `readClientAnalyticsProps`). Its
      surface and app version are stamped on every board event its commands make. */
  readonly clientAnalyticsProps: Readonly<Record<string, unknown>>;
}

const decodeClientOrigin = Schema.decodeUnknownOption(OrchestrationClientOrigin);
const isBoardAttachmentClaimError = Schema.is(BoardAttachmentClaimError);

/**
 * The origin a client's board commands carry: its surface and app version, each kept only
 * when valid, or undefined when it said nothing usable about itself.
 */
export const boardClientOrigin = (
  props: Readonly<Record<string, unknown>>,
): OrchestrationClientOrigin | undefined => {
  const surface = decodeClientOrigin({ surface: props.surface });
  const appVersion = decodeClientOrigin({ appVersion: props.appVersion });
  const origin: OrchestrationClientOrigin = {
    ...(surface._tag === "Some" ? surface.value : {}),
    ...(appVersion._tag === "Some" ? appVersion.value : {}),
  };
  return origin.surface === undefined && origin.appVersion === undefined ? undefined : origin;
};

export const boardRpcHandlers = Effect.fn("boardRpc.handlers")(function* (
  deps: BoardRpcHandlerDeps,
) {
  const boardEngine = yield* BoardEngine;
  const boardQueries = yield* BoardQueries;
  // Built once per connection, so the actor-name caches live as long as it does.
  const workspaces = yield* BoardWorkspaces;
  const threads = yield* ThreadGateway;
  const stampActor = boardActorStamp({ threads, boardQueries, workspaces });
  const projectActorName = boardProjectActorName({ threads, workspaces });
  // The subscription's services, provided here so the handler's stream needs
  // only the RPC scope.
  const baseSubscriptionContext = yield* Effect.context<
    BoardEngine | BoardQueries | BoardThreadTail | BoardWorkers
  >();
  // T3o: usage changes (T3O-77) reach the board stream and an open card. Optional, so
  // board-only harnesses need no recorder.
  const usageRecorder = yield* Effect.serviceOption(BoardUsageRecorder);
  const subscriptionContext = Option.isSome(usageRecorder)
    ? Context.add(baseSubscriptionContext, BoardUsageRecorder, usageRecorder.value)
    : baseSubscriptionContext;
  const workerConnections = yield* Effect.serviceOption(WorkerConnections);
  // Board RPCs on a worker trust only a board's own session (T3O-84).
  return guardBoardHandlers(deps.currentSession.subject, {
    ...makeBoardRpcHandlers(deps, {
      ciLogWorker: (workerId) =>
        Option.isNone(workerConnections)
          ? Effect.succeed(null)
          : workerConnections.value.get(workerId).pipe(
              Effect.map((rpc) => rpc.gateway.readCiLog),
              Effect.orElseSucceed(() => null),
            ),
      boardEngine,
      boardQueries,
      stampActor,
      projectActorName,
      projectConfig: yield* makeBoardProjectConfigService,
      mover: yield* BoardCardMover,
      subscriptionContext,
      usageChanges: Option.isSome(usageRecorder)
        ? usageRecorder.value.subscribeChanges
        : Effect.succeed(Stream.never),
      // Optional so board-only harnesses need no source control stack; ws.ts always has one.
      projectTokenStatus: boardProjectTokenStatus(
        threads,
        Option.getOrElse(yield* Effect.serviceOption(SourceControlDrivers), () => []),
      ),
    }),
    // Worker management, and the worker side's handshake.
    ...(yield* boardWorkerRpcHandlers(deps.currentSession)),
    // The worker side's thread gateway, MCP relay and staging.
    ...workerGatewayRpcHandlers(deps.currentSession),
    // The named git and forge operations, for a central server
    // whose cards run here.
    ...boardWorkerGitCallRpcHandlers(deps.currentSession, workspaces),
  });
});

function makeBoardRpcHandlers(
  deps: BoardRpcHandlerDeps,
  services: {
    readonly boardEngine: BoardEngineShape;
    readonly boardQueries: BoardQueriesShape;
    readonly stampActor: (command: BoardCommand) => Effect.Effect<void>;
    readonly projectActorName: (projectId: ProjectId) => Effect.Effect<string>;
    readonly projectConfig: BoardProjectConfigServiceShape;
    readonly mover: BoardCardMoverShape;
    readonly ciLogWorker: BoardCiLogDeps<unknown>["worker"];
    readonly projectTokenStatus: ReturnType<typeof boardProjectTokenStatus>;
    readonly subscriptionContext: Context.Context<
      BoardEngine | BoardQueries | BoardThreadTail | BoardWorkers
    >;
    /** Cards whose usage changed, so an open card re-reads its Usage section. */
    readonly usageChanges: Effect.Effect<Stream.Stream<BoardCardId>, never, Scope.Scope>;
  },
) {
  const { boardEngine, boardQueries } = services;
  const clientOrigin = boardClientOrigin(deps.clientAnalyticsProps);
  const authorized = <A, E, R>(
    method: keyof typeof BOARD_RPC_SCOPES,
    effect: Effect.Effect<A, E, R>,
  ): Effect.Effect<A, E | EnvironmentAuthorizationError, R> => {
    const requiredScope = BOARD_RPC_SCOPES[method];
    return deps.currentSession.scopes.includes(requiredScope)
      ? effect
      : Effect.fail(
          new EnvironmentAuthorizationError({
            message: `The authenticated token is missing required scope: ${requiredScope}.`,
            requiredScope,
          }),
        );
  };

  const readDetail = (
    cardId: BoardCardId,
  ): Effect.Effect<BoardCardDetail | null, BoardSubscribeCardError> =>
    boardQueries.boardCardDetail(cardId).pipe(
      Effect.mapError(
        (cause) =>
          new BoardSubscribeCardError({
            message: `Failed to load board card ${cardId}.`,
            cause,
          }),
      ),
    );

  /** The RPC promises `BoardCardAttachmentError` and nothing else: a storage
      failure the claim did not already name is reported as `internal`. */
  const isAttachmentError = Schema.is(BoardCardAttachmentError);
  const toAttachmentError = (error: unknown): BoardCardAttachmentError =>
    isAttachmentError(error)
      ? error
      : new BoardCardAttachmentError({
          code: "internal",
          message: error instanceof Error ? error.message : "Attachment operation failed.",
          cause: error,
        });

  const detailItem = (detail: BoardCardDetail): BoardCardDetailStreamItem => ({
    kind: "card-detail",
    detail,
  });

  return {
    /**
     * The board's bounded summary, then its live deltas —
     * see `boardSubscription.ts` for the resume rules.
     */
    [BOARD_WS_METHODS.subscribeBoard]: (input: BoardSubscribeBoardInput) =>
      Stream.unwrap(
        authorized(
          BOARD_WS_METHODS.subscribeBoard,
          subscribeBoard(input).pipe(Effect.provide(services.subscriptionContext)),
        ),
      ),

    /**
     * A client board command. The human actor is stamped first: this
     * RPC is the transport that knows a person is on the other end.
     */
    [BOARD_WS_METHODS.dispatchCommand]: (input: BoardClientCommand) => {
      // A person's move, whatever the client said; it resets the
      // card's CI round trips.
      const command: BoardClientCommand =
        input.type === "board.card.move" ? { ...input, cause: "human" } : input;
      return authorized(
        BOARD_WS_METHODS.dispatchCommand,
        services.stampActor(command).pipe(
          Effect.andThen(
            boardEngine.dispatch(
              command,
              clientOrigin === undefined ? undefined : { origin: clientOrigin },
            ),
          ),
          Effect.mapError(
            (cause) => new BoardDispatchCommandError({ message: cause.message, cause }),
          ),
        ),
      );
    },

    /**
     * Stage and project config commands, at the settings-write tier.
     * The actor is always this human, whatever the client sent.
     */
    [BOARD_WS_METHODS.dispatchSettingsCommand]: (command: BoardSettingsClientCommand) =>
      authorized(
        BOARD_WS_METHODS.dispatchSettingsCommand,
        Effect.gen(function* () {
          const name =
            "projectId" in command
              ? yield* services.projectActorName(command.projectId)
              : BOARD_HUMAN_ACTOR_FALLBACK_NAME;
          return yield* services.projectConfig.dispatch(command, boardHumanActor(name));
        }),
      ),

    [BOARD_WS_METHODS.getProjectConfig]: (input: BoardProjectConfigInput) =>
      authorized(
        BOARD_WS_METHODS.getProjectConfig,
        services.projectConfig.getConfig(input.projectId),
      ),

    [BOARD_WS_METHODS.projectImportCandidates]: (input: BoardProjectImportCandidatesInput) =>
      authorized(
        BOARD_WS_METHODS.projectImportCandidates,
        services.projectConfig.importCandidates(input),
      ),

    [BOARD_WS_METHODS.importProjectFile]: (input: BoardProjectImportInput) =>
      authorized(
        BOARD_WS_METHODS.importProjectFile,
        Effect.gen(function* () {
          const actor = boardHumanActor(yield* services.projectActorName(input.projectId));
          return yield* services.projectConfig.importFile(input, actor);
        }),
      ),

    [BOARD_WS_METHODS.exportProjectFile]: (input: BoardProjectConfigInput) =>
      authorized(
        BOARD_WS_METHODS.exportProjectFile,
        Effect.gen(function* () {
          const actor = boardHumanActor(yield* services.projectActorName(input.projectId));
          return yield* services.projectConfig.exportFile(input.projectId, actor);
        }),
      ),

    /** Each project's GitHub token source and check, when Settings asks. */
    [BOARD_WS_METHODS.projectTokenStatus]: (_input: Record<string, never>) =>
      authorized(BOARD_WS_METHODS.projectTokenStatus, services.projectTokenStatus),

    /** The archive page's cards, read when the page opens. */
    [BOARD_WS_METHODS.getArchivedCards]: (_input: Record<string, never>) =>
      authorized(
        BOARD_WS_METHODS.getArchivedCards,
        boardQueries.boardArchivedCards().pipe(
          Effect.map((cards) => ({ cards })),
          Effect.mapError(
            (cause) => new BoardSnapshotError({ message: "Failed to load archived cards.", cause }),
          ),
        ),
      ),

    /**
     * Re-resolve the card's pull request from the forge. A failed lookup is not an error: the
     * reactor keeps the last known link, so a rate limit never blanks a card's PR badge.
     * `force` (a human's "Check again") bypasses the lookup cache and its failure backoff, and
     * the answer tells "no pull request" apart from "the forge could not be asked".
     */
    [BOARD_WS_METHODS.refreshCardPullRequest]: (input: BoardRefreshCardPullRequestInput) =>
      authorized(
        BOARD_WS_METHODS.refreshCardPullRequest,
        deps.boardSupervisor.refreshPullRequest(
          input.cardId,
          input.force === true ? { force: true } : undefined,
        ),
      ),

    /**
     * "No PR linked · Link one" on the card detail. The input is sent
     * as typed; the server owns the parsing, so the card and the agent tools
     * accept exactly the same names for a pull request.
     */
    [BOARD_WS_METHODS.linkCardPullRequest]: (input: BoardLinkCardPullRequestInput) => {
      const target = parseCardPullRequestText(input.target);
      return authorized(
        BOARD_WS_METHODS.linkCardPullRequest,
        target === null
          ? Effect.succeed({
              outcome: "refused",
              detail: `'${input.target}' names no pull request. Enter its URL or #number.`,
            } as const)
          : deps.boardSupervisor.linkPullRequest(input.cardId, target),
      );
    },

    /**
     * Merge the card's pull request and advance it — the blue Merge button.
     *
     * Always human-initiated. The result is a value, not an error channel:
     * "the forge refused because a check is failing" is the system working
     * correctly, and the caller renders each outcome differently.
     */
    [BOARD_WS_METHODS.mergeCardPullRequest]: (input: BoardCardPullRequestActionInput) =>
      authorized(
        BOARD_WS_METHODS.mergeCardPullRequest,
        deps.boardSupervisor.mergePullRequest(input.cardId),
      ),

    /**
     * Open the card's pull request from Building and route it past Code review. The result is
     * a value rather than an error channel: each refusal is the system working, and the
     * caller renders each differently.
     */
    [BOARD_WS_METHODS.submitCardForMerge]: (input: BoardCardPullRequestActionInput) =>
      authorized(
        BOARD_WS_METHODS.submitCardForMerge,
        deps.boardSupervisor.submitForMerge(input.cardId),
      ),

    /**
     * Run one more review round on a settled loop. An RPC rather than a card command because
     * the `runThroughRound` override must be written before the card moves, or the executor
     * re-plans a converged loop and bounces it straight back.
     */
    [BOARD_WS_METHODS.requestReviewRound]: (input: BoardRequestReviewRoundInput) =>
      authorized(
        BOARD_WS_METHODS.requestReviewRound,
        deps.boardSupervisor.requestReviewRound(input.cardId, input.carry),
      ),

    /** Skip CI: a human's override, so what it records carries the
        human, like a drag. */
    [BOARD_WS_METHODS.skipCi]: (input: BoardCardPullRequestActionInput) =>
      authorized(
        BOARD_WS_METHODS.skipCi,
        deps.boardSupervisor.skipCi(input.cardId, services.stampActor),
      ),

    /** Retry CI, Stop CI and "Send back to review anyway":
        human-only, like Skip CI; no agent tool reaches them. */
    [BOARD_WS_METHODS.retryCi]: (input: BoardCiActionInput) =>
      authorized(
        BOARD_WS_METHODS.retryCi,
        deps.boardSupervisor.retryCi(input.cardId, input.action ?? "retry"),
      ),
    [BOARD_WS_METHODS.ciSendBack]: (input: BoardCardPullRequestActionInput) =>
      authorized(BOARD_WS_METHODS.ciSendBack, deps.boardSupervisor.ciSendBack(input.cardId)),

    /**
     * "Remove worktree" on a finished card that kept one. The
     * human confirmed at a dialog naming what is lost; the branch survives.
     */
    [BOARD_WS_METHODS.removeCardWorktree]: (input: BoardCardPullRequestActionInput) =>
      authorized(
        BOARD_WS_METHODS.removeCardWorktree,
        deps.boardSupervisor.forceRemoveWorktree(input.cardId),
      ),

    /** "Check again" on a card that kept its worktree: operate, like
        removal, because a durable checkout is removed by it. */
    [BOARD_WS_METHODS.checkCardWorktree]: (input: BoardCardPullRequestActionInput) =>
      authorized(
        BOARD_WS_METHODS.checkCardWorktree,
        deps.boardSupervisor.checkWorktree(input.cardId),
      ),

    /** The Move dialog: check, move, or ask the agent to push. A
        move is a human act, so each step it records carries the human. */
    [BOARD_WS_METHODS.cardWorkerMove]: (input: BoardCardWorkerMoveRequest) =>
      authorized(
        BOARD_WS_METHODS.cardWorkerMove,
        Effect.suspend((): Effect.Effect<BoardCardWorkerMoveAnswer> => {
          if (input.action === "ask-push") return services.mover.askAgentToPush(input.cardId);
          // A force-move off an offline or removed worker, and its
          // restart-from-base confirmation.
          const force = { force: input.force, restartFromBase: input.restartFromBase };
          if (input.action === "move") {
            return services.mover.move(
              input.cardId,
              input.toWorkerId ?? null,
              services.stampActor,
              force,
            );
          }
          if (input.toWorkerId === undefined) {
            return Effect.succeed({ outcome: "refused", detail: "Pick a worker to move to." });
          }
          return services.mover.check(input.cardId, input.toWorkerId, force);
        }),
      ),

    /**
     * Attach a pending upload to the card's brief (K2). Copy first,
     * record second: the file lands in the card's folder, then the internal
     * `board.card.attach` command is dispatched; a refused dispatch deletes
     * the copy again so disk and record never disagree.
     */
    [BOARD_WS_METHODS.attachCardFile]: (input: BoardAttachCardFileInput) =>
      authorized(
        BOARD_WS_METHODS.attachCardFile,
        Effect.gen(function* () {
          const config = yield* ServerConfig.ServerConfig;
          const crypto = yield* SecureRandom.SecureRandom;
          const detail = yield* readDetail(input.cardId).pipe(
            Effect.mapError(
              (cause) =>
                new BoardCardAttachmentError({
                  code: "internal",
                  message: cause.message,
                  cause,
                }),
            ),
          );
          if (detail === null) {
            return yield* new BoardCardAttachmentError({
              code: "rejected",
              message: `Card ${input.cardId} was not found.`,
            });
          }
          const createdAt = DateTime.formatIso(yield* DateTime.now);
          const attachment = yield* claimBoardCardAttachment({
            stateDir: config.stateDir,
            attachmentsDir: config.attachmentsDir,
            card: detail.card,
            pendingAttachmentId: input.pendingAttachmentId,
            attachmentId: BoardCardAttachmentId.make(yield* crypto.uuidV4()),
            name: input.name,
            type: input.type,
            mimeType: input.mimeType,
            sizeBytes: input.sizeBytes,
            addedAt: createdAt,
          }).pipe(
            Effect.mapError((error) =>
              isBoardAttachmentClaimError(error)
                ? new BoardCardAttachmentError({
                    code: error.failure.reason,
                    message: error.failure.message,
                    ...("cause" in error.failure && error.failure.cause !== undefined
                      ? { cause: error.failure.cause }
                      : {}),
                  })
                : new BoardCardAttachmentError({
                    code: "storage",
                    message: `Failed to store '${input.name}'.`,
                    cause: error,
                  }),
            ),
          );
          const uuid = yield* crypto.uuidV4();
          yield* boardEngine
            .dispatch({
              type: "board.card.attach",
              commandId: CommandId.make(`server:board-attach:${uuid}`),
              cardId: input.cardId,
              attachment,
              createdAt,
            })
            .pipe(
              Effect.tapError(() =>
                deleteBoardCardAttachmentFile({
                  stateDir: config.stateDir,
                  cardId: input.cardId,
                  name: attachment.name,
                }),
              ),
              Effect.mapError(
                (cause) =>
                  new BoardCardAttachmentError({
                    code: "rejected",
                    message: cause.message,
                    cause,
                  }),
              ),
            );
          return attachment;
        }).pipe(Effect.mapError(toAttachmentError)),
      ),

    /**
     * Drop a brief attachment: record first, then the file. A file
     * that fails to delete is logged and left for a manual tidy — the record
     * is gone, which is what the user asked for.
     */
    [BOARD_WS_METHODS.detachCardFile]: (input: BoardDetachCardFileInput) =>
      authorized(
        BOARD_WS_METHODS.detachCardFile,
        Effect.gen(function* () {
          const config = yield* ServerConfig.ServerConfig;
          const crypto = yield* SecureRandom.SecureRandom;
          const detail = yield* readDetail(input.cardId).pipe(
            Effect.mapError(
              (cause) =>
                new BoardCardAttachmentError({
                  code: "internal",
                  message: cause.message,
                  cause,
                }),
            ),
          );
          const attachment = detail?.card.attachments.find(
            (candidate) => candidate.id === input.attachmentId,
          );
          if (detail === null || attachment === undefined) {
            return yield* new BoardCardAttachmentError({
              code: "rejected",
              message: `Attachment ${input.attachmentId} is not on card ${input.cardId}.`,
            });
          }
          const uuid = yield* crypto.uuidV4();
          yield* boardEngine
            .dispatch({
              type: "board.card.detach",
              commandId: CommandId.make(`server:board-detach:${uuid}`),
              cardId: input.cardId,
              attachmentId: input.attachmentId,
              createdAt: DateTime.formatIso(yield* DateTime.now),
            })
            .pipe(
              Effect.mapError(
                (cause) =>
                  new BoardCardAttachmentError({
                    code: "rejected",
                    message: cause.message,
                    cause,
                  }),
              ),
            );
          yield* deleteBoardCardAttachmentFile({
            stateDir: config.stateDir,
            cardId: input.cardId,
            name: attachment.name,
          });
        }).pipe(Effect.mapError(toAttachmentError)),
      ),

    /** One CI step's log, followed while it runs: `ci/ciLog.ts`. */
    [BOARD_WS_METHODS.readCiLog]: (input: BoardReadCiLogInput) =>
      Stream.unwrap(
        authorized(
          BOARD_WS_METHODS.readCiLog,
          Effect.succeed(
            readBoardCiLog(
              {
                readDetail,
                subscribeChanges: boardEngine.subscribeBoardEvents,
                worker: services.ciLogWorker,
              },
              input,
            ),
          ),
        ),
      ),

    /**
     * One subscription per open card: emits the full detail on subscribe and re-emits it on
     * every board event, disposed with the stream's scope. One card's detail is small enough
     * that re-emitting it whole beats an event grammar and a client-side merge.
     */
    [BOARD_WS_METHODS.subscribeCard]: (input: BoardSubscribeCardInput) =>
      Stream.unwrap(
        authorized(
          BOARD_WS_METHODS.subscribeCard,
          Effect.gen(function* () {
            // Attach live delivery BEFORE the initial read, so an event committed during
            // it triggers a re-read. The payload-free buffer slides at capacity 1, so a burst
            // during a re-read collapses into one wake-up and one frame of the latest state.
            const liveBuffer = yield* Queue.sliding<void>(1);
            yield* Effect.forkScoped(
              // Wake on ANY board event: the detail embeds dependencies and dependents
              // whose stage and archive state change under events on other cards' ids.
              boardEngine.liveBoardEvents.pipe(
                Stream.runForEach(() => Queue.offer(liveBuffer, undefined)),
              ),
              { startImmediately: true },
            );
            // A finished turn on this card moves its usage rows, which no board event says.
            const usageChanges = yield* services.usageChanges;
            yield* Effect.forkScoped(
              usageChanges.pipe(
                Stream.filter((cardId) => cardId === input.cardId),
                Stream.runForEach(() => Queue.offer(liveBuffer, undefined)),
              ),
              { startImmediately: true },
            );

            const initial = yield* readDetail(input.cardId);
            if (initial === null) {
              return yield* new BoardSubscribeCardError({
                message: `Board card ${input.cardId} does not exist.`,
              });
            }

            return Stream.concat(
              Stream.make(detailItem(initial)),
              Stream.fromQueue(liveBuffer).pipe(
                Stream.mapEffect(() => readDetail(input.cardId)),
                // Null mid-stream: the card was deleted under an open viewer (an
                // archived card still resolves). Drop the frame rather than close the
                // stream, so other viewers keep the last frame.
                Stream.flatMap((detail) =>
                  detail === null ? Stream.empty : Stream.make(detailItem(detail)),
                ),
              ),
            );
          }),
        ),
      ),
  };
}

// ── The human dispatch boundary ──────────────────────────

/**
 * Stamp the human actor on a command from `board.dispatchCommand`, the only transport that
 * knows a person is on the other end. The name is the project's git `user.name` (read on
 * this server's checkout, else the card's worker), cached and frozen onto the row, falling
 * back to "You". Every failure degrades to the fallback; none can fail the dispatch.
 */
export function boardActorStamp(deps: {
  readonly threads: Pick<ThreadGatewayShape, "project">;
  readonly boardQueries: BoardQueriesShape;
  readonly workspaces: Pick<BoardWorkspacesShape, "localProject" | "forCard">;
}): (command: BoardCommand) => Effect.Effect<void> {
  const projectByCard = new Map<string, ProjectId>();
  const projectName = boardProjectActorName(deps);

  const resolveName = Effect.fn("board-activity-actor-name")(function* (cardId: BoardCardId) {
    let projectId = projectByCard.get(String(cardId));
    if (projectId === undefined) {
      const detail = yield* deps.boardQueries
        .boardCardDetail(cardId)
        .pipe(Effect.catchCause(() => Effect.succeed(null)));
      if (detail === null) return BOARD_HUMAN_ACTOR_FALLBACK_NAME;
      // Cacheable until the card MOVES project, which the stamp
      // below invalidates — it is the same call path, so the eviction cannot
      // be missed.
      projectId = detail.card.projectId;
      projectByCard.set(String(cardId), projectId);
    }
    return yield* projectName(projectId, cardId);
  });

  return (command) =>
    Effect.gen(function* () {
      const cardId = (command as { readonly cardId?: BoardCardId }).cardId;
      if (cardId === undefined) return;
      stampBoardActivityActor(command.commandId, boardHumanActor(yield* resolveName(cardId)));
      // A project change invalidates the cached card->project mapping. Evicted AFTER the stamp:
      // the command is not decided yet, so this row keeps the old project's identity and the
      // next command resolves against the new one.
      if (command.type === "board.card.set-project") projectByCard.delete(String(cardId));
    }).pipe(Effect.ignoreCause);
}

/**
 * A human's name for a project (extracted from `boardActorStamp`):
 * the project's git `user.name`, cached per project, falling back to "You".
 * Read from this server's checkout when it has one, else from `cardId`'s
 * worker; with neither, the fallback.
 */
function boardProjectActorName(deps: {
  readonly threads: Pick<ThreadGatewayShape, "project">;
  readonly workspaces: Pick<BoardWorkspacesShape, "localProject" | "forCard">;
}): (projectId: ProjectId, cardId?: BoardCardId) => Effect.Effect<string> {
  const nameByProject = new Map<string, string>();
  return Effect.fn("board-project-actor-name")(function* (projectId, cardId) {
    const cached = nameByProject.get(String(projectId));
    if (cached !== undefined) return cached;
    const project = yield* deps.threads
      .project(projectId)
      .pipe(Effect.catchCause(() => Effect.succeed(null)));
    const workspaceRoot = project?.workspaceRoot;
    const local = workspaceRoot !== undefined && workspaceRoot.length > 0;
    if (!local && cardId === undefined) return BOARD_HUMAN_ACTOR_FALLBACK_NAME;
    const workspace = local
      ? yield* deps.workspaces.localProject(projectId)
      : yield* deps.workspaces.forCard({ id: cardId!, projectId });
    const resolved = yield* workspace.gitUserName({}).pipe(
      Effect.map((result) => result.name),
      Effect.catchCause(() => Effect.succeed("")),
    );
    const name = resolved.length > 0 ? resolved : BOARD_HUMAN_ACTOR_FALLBACK_NAME;
    nameByProject.set(String(projectId), name);
    return name;
  });
}
