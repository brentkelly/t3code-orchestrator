/**
 * T3o board RPC handlers (t3o-04).
 *
 * `boardRpcHandlers` is the injected factory the upstream ws.ts handler
 * object spreads (`...(yield* boardRpcHandlers({ currentSession, boardSupervisor }))`).
 * Adding a board RPC grows the returned record here plus the contracts-side
 * registries (`BOARD_WS_METHODS` / `BOARD_RPCS` / `BOARD_RPC_SCOPES`) and
 * touches zero upstream files.
 *
 * Authorization: upstream's `observeRpc*` wrappers only cover the handlers
 * written inline in ws.ts, so board handlers enforce their own scopes from
 * `BOARD_RPC_SCOPES` against the same authenticated session — identical
 * failure shape (`EnvironmentAuthorizationError`) to upstream's
 * `authorizeEffect`.
 *
 * Writes go through the board's own engine and reads through `BoardQueries`
 * (T3O-56); nothing here touches upstream's orchestration engine.
 */
import {
  BOARD_RPC_SCOPES,
  BOARD_WS_METHODS,
  BoardSubscribeCardError,
  EnvironmentAuthorizationError,
  isBoardCommand,
  BoardCardAttachmentError,
  BoardCardAttachmentId,
  CommandId,
  type BoardAttachCardFileInput,
  type BoardDetachCardFileInput,
  ThreadId,
  type BoardCardDetail,
  type BoardCardDetailStreamItem,
  type BoardCardId,
  type BoardCardPullRequestActionInput,
  // T3o: the refresh's own payload (T3O-48).
  type BoardRefreshCardPullRequestInput,
  type BoardLinkCardPullRequestInput,
  type BoardProviderLimitActionInput,
  type BoardProviderLimitResumeAtInput,
  type BoardSubscribeCardInput,
  type ClientOrchestrationCommand,
  type OrchestrationClientOrigin,
  OrchestrationDispatchCommandError,
  type OrchestrationShellStreamEvent,
  type ProjectId,
} from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
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
import { observeRpcEffect, observeRpcStreamEffect } from "../observability/RpcInstrumentation.ts";
import type { ProjectionSnapshotQueryShape } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import type { GitVcsDriver } from "../vcs/GitVcsDriver.ts";
import {
  BOARD_HUMAN_ACTOR_FALLBACK_NAME,
  boardHumanActor,
  stampBoardActivityActor,
} from "./activityActors.ts";
import { BoardEngine, type BoardEngineShape } from "./BoardEngine.ts";
import { BoardQueries } from "./BoardQueries.ts";
import type { BoardQueriesShape } from "./projection.ts";
import { BoardThreadTail } from "./boardThreadTail.ts";
import type { BoardCommand } from "./decider.ts";
import { boardShellStreamEvent, type BoardEvent } from "./projector.ts";
import type { SupervisorReactorShape } from "./supervisorReactor.ts";

// Re-exported so ws.ts routes board commands with the import it already has.
export { isBoardCommand };

export interface BoardRpcHandlerDeps {
  readonly currentSession: AuthenticatedSession;
  /** The supervisor reactor performs the card→PR actions: it owns the forge
      gateway and the step machinery a conflict fix needs. */
  readonly boardSupervisor: SupervisorReactorShape;
}

export const boardRpcHandlers = (deps: BoardRpcHandlerDeps) =>
  Effect.gen(function* () {
    const boardEngine = yield* BoardEngine;
    const boardQueries = yield* BoardQueries;
    return makeBoardRpcHandlers(deps, boardEngine, boardQueries);
  });

function makeBoardRpcHandlers(
  deps: BoardRpcHandlerDeps,
  boardEngine: BoardEngineShape,
  boardQueries: BoardQueriesShape,
) {
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
      observeRpcEffect(
        BOARD_WS_METHODS.refreshCardPullRequest,
        authorized(
          BOARD_WS_METHODS.refreshCardPullRequest,
          deps.boardSupervisor.refreshPullRequest(
            input.cardId,
            input.force === true ? { force: true } : undefined,
          ),
        ),
      ),

    /**
     * "No PR linked · Link one" on the card detail (T3O-18). The input is sent
     * as typed; the server owns the parsing, so the card and the agent tools
     * accept exactly the same names for a pull request.
     */
    [BOARD_WS_METHODS.linkCardPullRequest]: (input: BoardLinkCardPullRequestInput) => {
      const target = parseCardPullRequestText(input.target);
      return observeRpcEffect(
        BOARD_WS_METHODS.linkCardPullRequest,
        authorized(
          BOARD_WS_METHODS.linkCardPullRequest,
          target === null
            ? Effect.succeed({
                outcome: "refused",
                detail: `'${input.target}' names no pull request. Enter its URL or #number.`,
              } as const)
            : deps.boardSupervisor.linkPullRequest(input.cardId, target),
        ),
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
      observeRpcEffect(
        BOARD_WS_METHODS.probeProviderLimit,
        authorized(
          BOARD_WS_METHODS.probeProviderLimit,
          deps.boardSupervisor.probeProviderLimit(input.providerInstanceId),
        ),
      ),

    /**
     * "Set resume time" on a provider that named none (T3O-22, D14) — a human
     * reading the provider's own dashboard knows something the board's blind
     * poll does not. Null hands the schedule back to the poll.
     */
    [BOARD_WS_METHODS.setProviderLimitResumeAt]: (input: BoardProviderLimitResumeAtInput) =>
      observeRpcEffect(
        BOARD_WS_METHODS.setProviderLimitResumeAt,
        authorized(
          BOARD_WS_METHODS.setProviderLimitResumeAt,
          deps.boardSupervisor.setProviderLimitResumeAt({
            providerInstanceId: input.providerInstanceId,
            resumeAt: input.resumeAt,
          }),
        ),
      ),

    [BOARD_WS_METHODS.mergeCardPullRequest]: (input: BoardCardPullRequestActionInput) =>
      observeRpcEffect(
        BOARD_WS_METHODS.mergeCardPullRequest,
        authorized(
          BOARD_WS_METHODS.mergeCardPullRequest,
          deps.boardSupervisor.mergePullRequest(input.cardId),
        ),
      ),

    /**
     * Open the card's pull request from Building and route it past Code review
     * ("Submit for merge — no review", t3o-07). Always human-initiated, and
     * the result is a value rather than an error channel for the same reason
     * merging's is: "this card has no branch to push" is the system working,
     * and the caller renders each refusal differently.
     */
    [BOARD_WS_METHODS.submitCardForMerge]: (input: BoardCardPullRequestActionInput) =>
      observeRpcEffect(
        BOARD_WS_METHODS.submitCardForMerge,
        authorized(
          BOARD_WS_METHODS.submitCardForMerge,
          deps.boardSupervisor.submitForMerge(input.cardId),
        ),
      ),

    /**
     * Run one more review round on a settled loop (T3O-39, D6) — "Another
     * review round", and "Request review" on a card that never had one. An
     * RPC rather than a card command because the ordering is load-bearing:
     * the `runThroughRound` override must be written before the card moves,
     * or the executor re-plans a converged loop and bounces it straight back.
     */
    [BOARD_WS_METHODS.requestReviewRound]: (input: BoardCardPullRequestActionInput) =>
      observeRpcEffect(
        BOARD_WS_METHODS.requestReviewRound,
        authorized(
          BOARD_WS_METHODS.requestReviewRound,
          deps.boardSupervisor.requestReviewRound(input.cardId),
        ),
      ),

    /**
     * "Remove worktree" on a finished card that kept one (T3O-52, D5). The
     * human confirmed at a dialog naming what is lost; the branch survives.
     */
    [BOARD_WS_METHODS.removeCardWorktree]: (input: BoardCardPullRequestActionInput) =>
      observeRpcEffect(
        BOARD_WS_METHODS.removeCardWorktree,
        authorized(
          BOARD_WS_METHODS.removeCardWorktree,
          deps.boardSupervisor.forceRemoveWorktree(input.cardId),
        ),
      ),

    /** "Check again" on a card that kept its worktree (T3O-52): operate, like
        removal, because a durable checkout is removed by it. */
    [BOARD_WS_METHODS.checkCardWorktree]: (input: BoardCardPullRequestActionInput) =>
      observeRpcEffect(
        BOARD_WS_METHODS.checkCardWorktree,
        authorized(
          BOARD_WS_METHODS.checkCardWorktree,
          deps.boardSupervisor.checkWorktree(input.cardId),
        ),
      ),

    /**
     * Attach a pending upload to the card's brief (t3o-32, K2). Copy first,
     * record second: the file lands in the card's folder, then the internal
     * `board.card.attach` command is dispatched; a refused dispatch deletes
     * the copy again so disk and record never disagree.
     */
    [BOARD_WS_METHODS.attachCardFile]: (input: BoardAttachCardFileInput) =>
      observeRpcEffect(
        BOARD_WS_METHODS.attachCardFile,
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
              attachmentId: BoardCardAttachmentId.make(yield* crypto.randomUUIDv4),
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
            const uuid = yield* crypto.randomUUIDv4;
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
      ),

    /**
     * Drop a brief attachment (t3o-32): record first, then the file. A file
     * that fails to delete is logged and left for a manual tidy — the record
     * is gone, which is what the user asked for.
     */
    [BOARD_WS_METHODS.detachCardFile]: (input: BoardDetachCardFileInput) =>
      observeRpcEffect(
        BOARD_WS_METHODS.detachCardFile,
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
            const uuid = yield* crypto.randomUUIDv4;
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
      // Same metrics/tracing wrapper as the ws.ts inline handlers — board
      // RPCs must not be dark spots in RPC observability.
      observeRpcStreamEffect(
        BOARD_WS_METHODS.subscribeCard,
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
        { "rpc.aggregate": "board" },
      ),
  };
}

// ── The human dispatch boundary (t3o-18, D11) ──────────────────────────

/**
 * Stamp the HUMAN actor on a board command arriving over the web client's
 * `orchestration.dispatchCommand` RPC, so the Activity rail can say "brent moved
 * to Building" rather than attributing every drag to the system.
 *
 * Called from ws.ts immediately before dispatch: that RPC is the transport that
 * knows a person is on the other end, and no other caller can claim to be one.
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
 */
export function boardActorStamp(deps: {
  readonly projectionSnapshotQuery: ProjectionSnapshotQueryShape;
  readonly boardQueries: BoardQueriesShape;
  readonly git: GitVcsDriver["Service"];
}): (command: BoardCommand) => Effect.Effect<void> {
  const projectByCard = new Map<string, ProjectId>();
  const nameByProject = new Map<string, string>();

  const gitUserName = (workspaceRoot: string) =>
    deps.git
      .execute({
        operation: "board.activityActor.userName",
        cwd: workspaceRoot,
        args: ["config", "user.name"],
        allowNonZeroExit: true,
      })
      .pipe(
        Effect.map((result) => result.stdout.trim()),
        Effect.catchCause(() => Effect.succeed("")),
      );

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
    const project = yield* deps.projectionSnapshotQuery.getProjectShellById(projectId).pipe(
      Effect.map(Option.getOrUndefined),
      Effect.catchCause(() => Effect.succeed(undefined)),
    );
    const workspaceRoot = project?.workspaceRoot;
    const resolved =
      workspaceRoot === undefined || workspaceRoot.length === 0
        ? ""
        : yield* gitUserName(workspaceRoot);
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

// ── The client's board connection (T3O-56) ─────────────────────────

/**
 * What one client connection needs from the board, built once per socket so
 * the actor-name caches live as long as it does. ws.ts calls each member in one
 * line:
 *
 * - `dispatch` takes a board command off `orchestration.dispatchCommand`,
 *   stamps the human actor and hands it to the board engine. Board commands
 *   never reach upstream's engine.
 * - `shellDeltas` attaches the board's half of the shell stream: card, label,
 *   stage and provider-limit deltas from the board engine, and `card-threads`
 *   deltas from link changes and the todo tail. Attached when the effect
 *   returns, so nothing committed during the snapshot read is lost.
 * - `shellNeedsSnapshot` answers whether a resuming shell must take a full
 *   snapshot: the board's deltas are not in upstream's log, so a resume replay
 *   cannot carry them, and any board history at all means the client's cached
 *   board may be stale.
 *
 * Board deltas carry the BOARD's sequence. The client applies them without the
 * shell's sequence guard and without advancing `snapshotSequence` (see
 * `client-runtime/state/board.ts`), so the two sequence spaces never mix.
 */
export const boardClientConnection = (deps: {
  readonly projectionSnapshotQuery: ProjectionSnapshotQueryShape;
  readonly git: GitVcsDriver["Service"];
  readonly origin: OrchestrationClientOrigin | undefined;
}) =>
  Effect.gen(function* () {
    const boardEngine = yield* BoardEngine;
    const boardQueries = yield* BoardQueries;
    const threadTail = yield* BoardThreadTail;
    const stampActor = boardActorStamp({
      projectionSnapshotQuery: deps.projectionSnapshotQuery,
      boardQueries,
      git: deps.git,
    });

    const dispatch = (command: Extract<ClientOrchestrationCommand, BoardCommand>) =>
      stampActor(command).pipe(
        Effect.andThen(
          boardEngine.dispatch(
            command,
            deps.origin === undefined ? undefined : { origin: deps.origin },
          ),
        ),
        Effect.mapError(
          (cause) => new OrchestrationDispatchCommandError({ message: cause.message, cause }),
        ),
      );

    const cardThreads = (cardId: BoardCardId, sequence: number) =>
      boardQueries.boardCardThreads(cardId).pipe(
        Effect.map((threads): ReadonlyArray<OrchestrationShellStreamEvent> => [
          { kind: "card-threads" as const, sequence, cardId, threads },
        ]),
        Effect.catchCause(() => Effect.succeed([] as ReadonlyArray<OrchestrationShellStreamEvent>)),
      );

    const fromBoardEvent = (event: BoardEvent) =>
      Effect.gen(function* () {
        const primary = boardShellStreamEvent(event);
        const deltas = Option.isSome(primary) ? [primary.value] : [];
        // A card's link set changing is what the `card-threads` delta carries.
        if (
          event.type === "board.card-thread-linked" ||
          event.type === "board.card-thread-unlinked"
        ) {
          return [...deltas, ...(yield* cardThreads(event.payload.cardId, event.sequence))];
        }
        return deltas;
      });

    // A todo list changed (or its thread was deleted, which drops the row while
    // the link stays live): refetch the card's thread summaries. Stamped with the
    // board head — the delta is applied unguarded, so any board sequence will do.
    const fromTodoChange = (threadId: ThreadId) =>
      Effect.gen(function* () {
        const cardId = yield* boardQueries
          .boardCardIdForThread(threadId)
          .pipe(Effect.catchCause(() => Effect.succeed(null)));
        if (cardId === null) return [] as ReadonlyArray<OrchestrationShellStreamEvent>;
        return yield* cardThreads(cardId, yield* boardEngine.latestSequence);
      });

    const shellDeltas = Effect.gen(function* () {
      const boardEvents = yield* boardEngine.subscribeBoardEvents;
      const todoChanges = yield* threadTail.subscribeTodoChanges;
      return Stream.merge(
        boardEvents.pipe(Stream.mapEffect(fromBoardEvent)),
        todoChanges.pipe(Stream.mapEffect(fromTodoChange)),
      ).pipe(Stream.flatMap((deltas) => Stream.fromIterable(deltas)));
    });

    const shellNeedsSnapshot = Effect.map(boardEngine.latestSequence, (sequence) => sequence > 0);

    return { dispatch, shellDeltas, shellNeedsSnapshot };
  });
