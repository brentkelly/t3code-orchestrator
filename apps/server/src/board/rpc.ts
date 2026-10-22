/**
 * T3o board RPC handlers (t3o-04).
 *
 * `boardRpcHandlers` is the injected factory the upstream ws.ts handler
 * object spreads (`...(yield* boardRpcHandlers({ currentSession, boardSupervisor }))`).
 * Adding a board RPC grows the returned record here plus the contracts-side
 * registries (`BOARD_WS_METHODS` / `BOARD_RPCS` / `BOARD_RPC_SCOPES`) and
 * touches zero upstream files.
 *
 * Authorization: upstream's `RpcScopeAuthorization` middleware already checks
 * `RPC_REQUIRED_SCOPES`, which spreads `BOARD_RPC_SCOPES`; the handlers keep
 * their own check against the same session as a second line, with the same
 * failure shape (`EnvironmentAuthorizationError`). Spans and request metrics
 * come from upstream's `RpcInstrumentation` middleware.
 *
 * Writes go through the board's own engine and reads through `BoardQueries`
 * (T3O-56); nothing here touches upstream's orchestration engine. The board's
 * client state rides its own subscription and dispatch RPCs (T3O-57).
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
  type BoardCardWorkerMoveAnswer,
  type BoardCardWorkerMoveRequest,
  // T3o: the refresh's own payload (T3O-48).
  type BoardRefreshCardPullRequestInput,
  type BoardLinkCardPullRequestInput,
  type BoardProviderLimitActionInput,
  type BoardProviderLimitResumeAtInput,
  type BoardClientCommand,
  type BoardSubscribeBoardInput,
  type BoardSubscribeCardInput,
  type OrchestrationClientOrigin,
  type ProjectId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import type { AuthenticatedSession } from "../auth/EnvironmentAuth.ts";
import * as ServerConfig from "../config.ts";
import { parseCardPullRequestText } from "./cardPullRequestTarget.ts";
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
import { BoardQueries } from "./BoardQueries.ts";
import type { BoardQueriesShape } from "./projection.ts";
import { subscribeBoard } from "./boardSubscription.ts";
import { BoardThreadTail } from "./boardThreadTail.ts";
import { ThreadGateway, type ThreadGatewayShape } from "./ThreadGateway.ts";
import type { BoardCommand } from "./decider.ts";
import type { SupervisorReactorShape } from "./supervisorReactor.ts";
import { BoardCardMover, type BoardCardMoverShape } from "./workers/BoardCardMove.ts";
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
  /** The connecting client, stamped on every board event its commands make. */
  readonly clientOrigin: OrchestrationClientOrigin;
}

/** A client that said nothing about itself has no origin worth stamping. */
const hasClientOrigin = (origin: OrchestrationClientOrigin): boolean =>
  origin.surface !== undefined || origin.appVersion !== undefined;

export const boardRpcHandlers = (deps: BoardRpcHandlerDeps) =>
  Effect.gen(function* () {
    const boardEngine = yield* BoardEngine;
    const boardQueries = yield* BoardQueries;
    // Built once per connection, so the actor-name caches live as long as it does.
    const workspaces = yield* BoardWorkspaces;
    const stampActor = boardActorStamp({
      threads: yield* ThreadGateway,
      boardQueries,
      workspaces,
    });
    // The subscription's services, provided here so the handler's stream needs
    // only the RPC scope.
    const subscriptionContext = yield* Effect.context<
      BoardEngine | BoardQueries | BoardThreadTail | BoardWorkers
    >();
    return {
      ...makeBoardRpcHandlers(deps, {
        boardEngine,
        boardQueries,
        stampActor,
        mover: yield* BoardCardMover,
        subscriptionContext,
      }),
      // T3O-62: worker management, and the worker side's handshake.
      ...(yield* boardWorkerRpcHandlers(deps.currentSession)),
      // T3O-63: the worker side's thread gateway, MCP relay and staging.
      ...workerGatewayRpcHandlers(deps.currentSession),
      // T3O-64: the named git and forge operations, for a central server
      // whose cards run here.
      ...boardWorkerGitCallRpcHandlers(deps.currentSession, workspaces),
    };
  });

function makeBoardRpcHandlers(
  deps: BoardRpcHandlerDeps,
  services: {
    readonly boardEngine: BoardEngineShape;
    readonly boardQueries: BoardQueriesShape;
    readonly stampActor: (command: BoardCommand) => Effect.Effect<void>;
    readonly mover: BoardCardMoverShape;
    readonly subscriptionContext: Context.Context<
      BoardEngine | BoardQueries | BoardThreadTail | BoardWorkers
    >;
  },
) {
  const { boardEngine, boardQueries } = services;
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
     * The board's bounded summary, then its live deltas (t3o-26 D4, T3O-57) —
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
     * A client board command (T3O-57). The human actor is stamped first: this
     * RPC is the transport that knows a person is on the other end (t3o-18).
     */
    [BOARD_WS_METHODS.dispatchCommand]: (command: BoardClientCommand) =>
      authorized(
        BOARD_WS_METHODS.dispatchCommand,
        services.stampActor(command).pipe(
          Effect.andThen(
            boardEngine.dispatch(
              command,
              hasClientOrigin(deps.clientOrigin) ? { origin: deps.clientOrigin } : undefined,
            ),
          ),
          Effect.mapError(
            (cause) => new BoardDispatchCommandError({ message: cause.message, cause }),
          ),
        ),
      ),

    /** The archive page's cards (t3o-13), read when the page opens. */
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
     * Re-resolve the card's pull request from the forge.
     *
     * The refreshed link reaches the open card through the `subscribeCard`
     * stream that is already re-emitting on every board event, so the automatic
     * callers (a card opening, View PR being clicked) ignore the answer
     * entirely. A failed lookup is deliberately NOT an error — the reactor
     * keeps the last known link and logs, because a rate limit must leave a
     * card's PR badge alone rather than blanking it or popping a toast at
     * someone who only opened a card.
     *
     * T3o (T3O-48): it does RETURN an answer now, and a human's "Check again"
     * passes `force` to bypass the two-minute lookup cache and its failure
     * backoff. A button whose result is silence cannot tell "this branch has no
     * pull request" from "the forge could not be asked", and that confusion is
     * what this card was filed about.
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
     * "No PR linked · Link one" on the card detail (T3O-18). The input is sent
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
    /**
     * "Resume now" on a limited provider (T3O-22, D14). One click, one prober —
     * the same single-card wake the reset time performs, because ten cards
     * arriving at once is exactly as bad whether a clock or a human chose the
     * moment.
     */
    [BOARD_WS_METHODS.probeProviderLimit]: (input: BoardProviderLimitActionInput) =>
      authorized(
        BOARD_WS_METHODS.probeProviderLimit,
        deps.boardSupervisor.probeProviderLimit(input.providerInstanceId),
      ),

    /**
     * "Set resume time" on a provider that named none (T3O-22, D14) — a human
     * reading the provider's own dashboard knows something the board's blind
     * poll does not. Null hands the schedule back to the poll.
     */
    [BOARD_WS_METHODS.setProviderLimitResumeAt]: (input: BoardProviderLimitResumeAtInput) =>
      authorized(
        BOARD_WS_METHODS.setProviderLimitResumeAt,
        deps.boardSupervisor.setProviderLimitResumeAt({
          providerInstanceId: input.providerInstanceId,
          resumeAt: input.resumeAt,
        }),
      ),

    [BOARD_WS_METHODS.mergeCardPullRequest]: (input: BoardCardPullRequestActionInput) =>
      authorized(
        BOARD_WS_METHODS.mergeCardPullRequest,
        deps.boardSupervisor.mergePullRequest(input.cardId),
      ),

    /**
     * Open the card's pull request from Building and route it past Code review
     * ("Submit for merge — no review", t3o-07). Always human-initiated, and
     * the result is a value rather than an error channel for the same reason
     * merging's is: "this card has no branch to push" is the system working,
     * and the caller renders each refusal differently.
     */
    [BOARD_WS_METHODS.submitCardForMerge]: (input: BoardCardPullRequestActionInput) =>
      authorized(
        BOARD_WS_METHODS.submitCardForMerge,
        deps.boardSupervisor.submitForMerge(input.cardId),
      ),

    /**
     * Run one more review round on a settled loop (T3O-39, D6) — "Another
     * review round", and "Request review" on a card that never had one. An
     * RPC rather than a card command because the ordering is load-bearing:
     * the `runThroughRound` override must be written before the card moves,
     * or the executor re-plans a converged loop and bounces it straight back.
     */
    [BOARD_WS_METHODS.requestReviewRound]: (input: BoardCardPullRequestActionInput) =>
      authorized(
        BOARD_WS_METHODS.requestReviewRound,
        deps.boardSupervisor.requestReviewRound(input.cardId),
      ),

    /**
     * "Remove worktree" on a finished card that kept one (T3O-52, D5). The
     * human confirmed at a dialog naming what is lost; the branch survives.
     */
    [BOARD_WS_METHODS.removeCardWorktree]: (input: BoardCardPullRequestActionInput) =>
      authorized(
        BOARD_WS_METHODS.removeCardWorktree,
        deps.boardSupervisor.forceRemoveWorktree(input.cardId),
      ),

    /** "Check again" on a card that kept its worktree (T3O-52): operate, like
        removal, because a durable checkout is removed by it. */
    [BOARD_WS_METHODS.checkCardWorktree]: (input: BoardCardPullRequestActionInput) =>
      authorized(
        BOARD_WS_METHODS.checkCardWorktree,
        deps.boardSupervisor.checkWorktree(input.cardId),
      ),

    /** The Move dialog (T3O-65): check, move, or ask the agent to push. A
        move is a human act (D18), so each step it records carries the human. */
    [BOARD_WS_METHODS.cardWorkerMove]: (input: BoardCardWorkerMoveRequest) =>
      authorized(
        BOARD_WS_METHODS.cardWorkerMove,
        Effect.suspend((): Effect.Effect<BoardCardWorkerMoveAnswer> => {
          if (input.action === "ask-push") return services.mover.askAgentToPush(input.cardId);
          // T3O-66: a force-move off an offline or removed worker, and its
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
     * Attach a pending upload to the card's brief (t3o-32, K2). Copy first,
     * record second: the file lands in the card's folder, then the internal
     * `board.card.attach` command is dispatched; a refused dispatch deletes
     * the copy again so disk and record never disagree.
     */
    [BOARD_WS_METHODS.attachCardFile]: (input: BoardAttachCardFileInput) =>
      authorized(
        BOARD_WS_METHODS.attachCardFile,
        Effect.gen(function* () {
          const config = yield* ServerConfig.ServerConfig;
          const crypto = yield* Crypto.Crypto;
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
            attachmentId: BoardCardAttachmentId.make(yield* crypto.randomUUIDv4()),
            name: input.name,
            type: input.type,
            mimeType: input.mimeType,
            sizeBytes: input.sizeBytes,
            addedAt: createdAt,
          }).pipe(
            Effect.mapError((error) =>
              error instanceof BoardAttachmentClaimError
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
          const uuid = yield* crypto.randomUUIDv4();
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
     * Drop a brief attachment (t3o-32): record first, then the file. A file
     * that fails to delete is logged and left for a manual tidy — the record
     * is gone, which is what the user asked for.
     */
    [BOARD_WS_METHODS.detachCardFile]: (input: BoardDetachCardFileInput) =>
      authorized(
        BOARD_WS_METHODS.detachCardFile,
        Effect.gen(function* () {
          const config = yield* ServerConfig.ServerConfig;
          const crypto = yield* Crypto.Crypto;
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
          const uuid = yield* crypto.randomUUIDv4();
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

    /**
     * One streaming subscription per open card, mirroring
     * `subscribeThread`'s lifecycle: emits the full detail on subscribe,
     * re-emits it on every board event for this card, and is disposed with
     * the stream's scope when the client closes the card. Detail is one
     * card's worth of data, so re-emitting whole is cheaper than an event
     * grammar and needs no client-side merge.
     */
    [BOARD_WS_METHODS.subscribeCard]: (input: BoardSubscribeCardInput) =>
      Stream.unwrap(
        authorized(
          BOARD_WS_METHODS.subscribeCard,
          Effect.gen(function* () {
            // Attach live delivery into a scope-bound buffer BEFORE the
            // initial read, exactly like subscribeShell/subscribeThread: an
            // event committed while the initial detail read is in flight
            // must trigger a re-read, not vanish. The buffer carries no
            // payload and slides at capacity 1: any burst that lands while
            // a re-read is in flight collapses into one queued wake-up, so
            // the follow-up read observes the latest projected state and
            // the stream emits one frame for the whole burst.
            const liveBuffer = yield* Queue.sliding<void>(1);
            yield* Effect.forkScoped(
              // Wake on ANY board event, not only ones aggregated on the open
              // card: the detail embeds resolved dependencies/dependents with
              // live stage/archive state, and those change under events fired
              // on OTHER aggregate ids (a dependency moving to Done, another
              // card adopting this one into its dependsOn). One card's detail
              // re-read per coalesced burst (the sliding buffer above) is the
              // cost; a stale dependency chip until an unrelated local event
              // was the alternative.
              boardEngine.liveBoardEvents.pipe(
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
                // A null mid-stream means the card was DELETED under an open
                // viewer — an archived card still resolves, so nothing else
                // produces one. The frame is dropped rather than closing the
                // stream: the client that issued the delete closes its own
                // modal, and another device's viewer keeps rendering the last
                // frame, which beats a dialog that vanishes mid-read.
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

// ── The human dispatch boundary (t3o-18, D11) ──────────────────────────

/**
 * Stamp the HUMAN actor on a board command arriving over `board.dispatchCommand`,
 * so the Activity rail can say "brent moved to Building" rather than
 * attributing every drag to the system.
 *
 * Called immediately before dispatch: that RPC is the transport that knows a
 * person is on the other end, and no other caller can claim to be one.
 * A non-board command, or one that names no card, is left alone.
 *
 * **The name** is the card's project git `user.name`, cached per project and
 * frozen onto the row at write time (so it stays correct after the git config
 * changes), falling back to `"You"`. There is no user identity anywhere in
 * t3code — it is a single-user local server — and for a dev tool the git identity
 * is the right one: it is already what lands on every commit the agent makes.
 *
 * Resolution is two point reads plus at most one `git config` per project for the
 * lifetime of the process, on a path a human drives by hand. Every failure
 * degrades to the fallback name; none can fail the dispatch.
 *
 * T3O-64: read from this server's own checkout of the project when it has
 * one, and otherwise from the card's worker, where the commits are made.
 */
export function boardActorStamp(deps: {
  readonly threads: Pick<ThreadGatewayShape, "project">;
  readonly boardQueries: BoardQueriesShape;
  readonly workspaces: Pick<BoardWorkspacesShape, "localProject" | "forCard">;
}): (command: BoardCommand) => Effect.Effect<void> {
  const projectByCard = new Map<string, ProjectId>();
  const nameByProject = new Map<string, string>();

  const resolveName = Effect.fn("board-activity-actor-name")(function* (cardId: BoardCardId) {
    let projectId = projectByCard.get(String(cardId));
    if (projectId === undefined) {
      const detail = yield* deps.boardQueries
        .boardCardDetail(cardId)
        .pipe(Effect.catchCause(() => Effect.succeed(null)));
      if (detail === null) return BOARD_HUMAN_ACTOR_FALLBACK_NAME;
      // Cacheable until the card MOVES project (T3O-33), which the stamp
      // below invalidates — it is the same call path, so the eviction cannot
      // be missed.
      projectId = detail.card.projectId;
      projectByCard.set(String(cardId), projectId);
    }
    const cached = nameByProject.get(String(projectId));
    if (cached !== undefined) return cached;
    const project = yield* deps.threads
      .project(projectId)
      .pipe(Effect.catchCause(() => Effect.succeed(null)));
    const workspaceRoot = project?.workspaceRoot;
    const workspace =
      workspaceRoot === undefined || workspaceRoot.length === 0
        ? yield* deps.workspaces.forCard({ id: cardId, projectId })
        : yield* deps.workspaces.localProject(projectId);
    const resolved = yield* workspace.gitUserName({}).pipe(
      Effect.map((result) => result.name),
      Effect.catchCause(() => Effect.succeed("")),
    );
    const name = resolved.length > 0 ? resolved : BOARD_HUMAN_ACTOR_FALLBACK_NAME;
    nameByProject.set(String(projectId), name);
    return name;
  });

  return (command) =>
    Effect.gen(function* () {
      const cardId = (command as { readonly cardId?: BoardCardId }).cardId;
      if (cardId === undefined) return;
      stampBoardActivityActor(command.commandId, boardHumanActor(yield* resolveName(cardId)));
      // A card changing project (T3O-33) invalidates the card->project mapping
      // above, which is otherwise held for the life of the process. Evicted
      // AFTER the stamp on purpose: the command has not been decided yet, so
      // re-reading now would only re-cache the project the card is leaving.
      // This row keeps the old project's identity — the human acted there — and
      // the next command on the card resolves against the new one.
      if (command.type === "board.card.set-project") projectByCard.delete(String(cardId));
    }).pipe(Effect.catchCause(() => Effect.void));
}
