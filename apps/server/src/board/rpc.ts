/**
 * T3o board RPC handlers (t3o-04).
 *
 * `boardRpcHandlers` is the injected factory the upstream ws.ts handler
 * object spreads (`...boardRpcHandlers({ currentSession, orchestrationEngine,
 * projectionSnapshotQuery }),`) — the same shape as
 * `boardSnapshotQueryMethods`. Adding a board RPC grows the returned record
 * here plus the contracts-side registries (`BOARD_WS_METHODS` / `BOARD_RPCS`
 * / `BOARD_RPC_SCOPES`) and touches zero upstream files.
 *
 * Authorization: upstream's `observeRpc*` wrappers only cover the handlers
 * written inline in ws.ts, so board handlers enforce their own scopes from
 * `BOARD_RPC_SCOPES` against the same authenticated session — identical
 * failure shape (`EnvironmentAuthorizationError`) to upstream's
 * `authorizeEffect`.
 *
 * Database access goes through the board-only methods riding the
 * `ProjectionSnapshotQuery` record (`boardSnapshotQueryMethodsOf`): brief
 * bodies live only in `board_card_bodies` (D8), and the snapshot-query
 * assembly is the one place the board already holds the `SqlClient` without
 * adding a requirement to the ws layer.
 */
import {
  BOARD_RPC_SCOPES,
  BOARD_WS_METHODS,
  BoardSubscribeCardError,
  EnvironmentAuthorizationError,
  isBoardCommand,
  isBoardEvent,
  ThreadId,
  type BoardCardDetail,
  type BoardCardDetailStreamItem,
  type BoardCardId,
  type BoardCardPullRequestActionInput,
  type BoardSubscribeCardInput,
  type OrchestrationCommand,
  type OrchestrationEvent,
  type OrchestrationShellStreamEvent,
  type ProjectId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";

import type { AuthenticatedSession } from "../auth/EnvironmentAuth.ts";
import { observeRpcEffect, observeRpcStreamEffect } from "../observability/RpcInstrumentation.ts";
import type { OrchestrationEngineShape } from "../orchestration/Services/OrchestrationEngine.ts";
import type { ProjectionSnapshotQueryShape } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import type { GitVcsDriver } from "../vcs/GitVcsDriver.ts";
import {
  BOARD_HUMAN_ACTOR_FALLBACK_NAME,
  boardHumanActor,
  stampBoardActivityActor,
} from "./activityActors.ts";
import { boardSnapshotQueryMethodsOf } from "./projection.ts";
import type { SupervisorReactorShape } from "./supervisorReactor.ts";

export interface BoardRpcHandlerDeps {
  readonly currentSession: AuthenticatedSession;
  readonly orchestrationEngine: OrchestrationEngineShape;
  readonly projectionSnapshotQuery: ProjectionSnapshotQueryShape;
  /** The supervisor reactor performs the card→PR actions: it owns the forge
      gateway and the step machinery a conflict fix needs. */
  readonly boardSupervisor: SupervisorReactorShape;
}

export function boardRpcHandlers(deps: BoardRpcHandlerDeps) {
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
  ): Effect.Effect<BoardCardDetail | null, BoardSubscribeCardError> => {
    const boardMethods = boardSnapshotQueryMethodsOf(deps.projectionSnapshotQuery);
    if (boardMethods === null) {
      // Only reachable when the snapshot query was built without the board
      // factory (upstream tests mocking the service); production assembly
      // always spreads it in.
      return Effect.fail(
        new BoardSubscribeCardError({
          message: "Board snapshot query methods are unavailable on this server.",
        }),
      );
    }
    return boardMethods.boardCardDetail(cardId).pipe(
      Effect.mapError(
        (cause) =>
          new BoardSubscribeCardError({
            message: `Failed to load board card ${cardId}.`,
            cause,
          }),
      ),
    );
  };

  const detailItem = (detail: BoardCardDetail): BoardCardDetailStreamItem => ({
    kind: "card-detail",
    detail,
  });

  return {
    /**
     * Re-resolve the card's pull request from the forge.
     *
     * Fire-and-forget from the client's point of view: it returns void, and
     * the refreshed link reaches the open card through the `subscribeCard`
     * stream that is already re-emitting on every board event. A failed
     * lookup is deliberately NOT an error here — the reactor keeps the last
     * known link and logs, because a rate limit must leave a card's PR badge
     * alone rather than blanking it or popping a toast at someone who only
     * opened a card.
     */
    [BOARD_WS_METHODS.refreshCardPullRequest]: (input: BoardCardPullRequestActionInput) =>
      observeRpcEffect(
        BOARD_WS_METHODS.refreshCardPullRequest,
        authorized(
          BOARD_WS_METHODS.refreshCardPullRequest,
          deps.boardSupervisor.refreshPullRequest(input.cardId),
        ),
      ),

    /**
     * Merge the card's pull request and advance it — the blue Merge button.
     *
     * Always human-initiated. The result is a value, not an error channel:
     * "the forge refused because a check is failing" is the system working
     * correctly, and the caller renders each outcome differently.
     */
    [BOARD_WS_METHODS.mergeCardPullRequest]: (input: BoardCardPullRequestActionInput) =>
      observeRpcEffect(
        BOARD_WS_METHODS.mergeCardPullRequest,
        authorized(
          BOARD_WS_METHODS.mergeCardPullRequest,
          deps.boardSupervisor.mergePullRequest(input.cardId),
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
              deps.orchestrationEngine.streamDomainEvents.pipe(
                // Wake on ANY board event, not only ones aggregated on the open
                // card: the detail embeds resolved dependencies/dependents with
                // live stage/archive state, and those change under events fired
                // on OTHER aggregate ids (a dependency moving to Done, another
                // card adopting this one into its dependsOn). One card's detail
                // re-read per coalesced burst (the sliding buffer above) is the
                // cost; a stale dependency chip until an unrelated local event
                // was the alternative.
                Stream.filter((event) => isBoardEvent(event)),
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
  readonly git: GitVcsDriver["Service"];
}): (command: OrchestrationCommand) => Effect.Effect<void> {
  const boardMethods = boardSnapshotQueryMethodsOf(deps.projectionSnapshotQuery);
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
    if (boardMethods === null) return BOARD_HUMAN_ACTOR_FALLBACK_NAME;
    let projectId = projectByCard.get(String(cardId));
    if (projectId === undefined) {
      const detail = yield* boardMethods
        .boardCardDetail(cardId)
        .pipe(Effect.catchCause(() => Effect.succeed(null)));
      if (detail === null) return BOARD_HUMAN_ACTOR_FALLBACK_NAME;
      // A card never changes project, so this mapping is cacheable forever.
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
      if (!isBoardCommand(command)) return;
      const cardId = (command as { readonly cardId?: BoardCardId }).cardId;
      if (cardId === undefined) return;
      stampBoardActivityActor(command.commandId, boardHumanActor(yield* resolveName(cardId)));
    }).pipe(Effect.catchCause(() => Effect.void));
}

// ── The card-threads shell delta (t3o-18, D3) ──────────────────────────

/**
 * The `card-threads` shell deltas an orchestration event implies, if any.
 *
 * Emitted from the SAME domain-event stream every other shell delta rides, with
 * the causing event's own `sequence`, so resume-by-sequence stays exact and a
 * client can never see a todo revision out of order with the card it belongs to.
 * Two triggers, and ONLY these two — the todo cache is the only thing the delta
 * carries, so a thread event that cannot have touched it emits nothing:
 *
 * - a `turn.plan.updated` activity append on a thread live-linked to a card
 *   (the only thread event the projector WRITES `board_thread_todos` on), so a
 *   burst of streaming message deltas on an active linked thread no longer
 *   triggers a per-event refetch of a list that did not change. The upstream
 *   coalescing window still collapses a burst of plan revisions to the latest;
 * - a `thread.deleted` on a live-linked thread, the one thread event the
 *   projector DROPS the cache row on (its link stays live until tombstoned, so
 *   no `board.card-thread-unlinked` fires for it) — without this the client's
 *   snapshot array keeps the dead thread's stale summary until an unrelated card
 *   event happens to refetch;
 * - a card's link set changing (`board.card-thread-linked` / `-unlinked`), since
 *   the set membership is what the delta carries.
 *
 * A card archive or delete needs none: `card-removed` already drops the card,
 * and the client drops its thread entries with it.
 *
 * Best-effort: every failure yields no delta rather than breaking the shell
 * stream, and the next snapshot repairs the view.
 */
export function boardCardThreadsShellEvents(deps: {
  readonly projectionSnapshotQuery: ProjectionSnapshotQueryShape;
}): (event: OrchestrationEvent) => Effect.Effect<ReadonlyArray<OrchestrationShellStreamEvent>> {
  const boardMethods = boardSnapshotQueryMethodsOf(deps.projectionSnapshotQuery);

  const forCard = (cardId: BoardCardId, sequence: number) =>
    boardMethods === null
      ? Effect.succeed([] as ReadonlyArray<OrchestrationShellStreamEvent>)
      : boardMethods.boardCardThreads(cardId).pipe(
          Effect.map(
            (threads): ReadonlyArray<OrchestrationShellStreamEvent> => [
              { kind: "card-threads" as const, sequence, cardId, threads },
            ],
          ),
          Effect.catchCause(() =>
            Effect.succeed([] as ReadonlyArray<OrchestrationShellStreamEvent>),
          ),
        );

  return (event) =>
    Effect.gen(function* () {
      if (boardMethods === null) return [];
      if (
        event.type === "board.card-thread-linked" ||
        event.type === "board.card-thread-unlinked"
      ) {
        return yield* forCard(event.payload.cardId, event.sequence);
      }
      // A deleted thread's cache row was just dropped by the projector, but its
      // link stays live until something tombstones it, so no
      // `board.card-thread-unlinked` fires. Refetch the card to push the now
      // todo-less link entry — otherwise the client keeps the dead thread's
      // stale summary. (Resolves via the still-live link.)
      if (event.type === "thread.deleted") {
        const cardId = yield* boardMethods
          .boardCardIdForThread(ThreadId.make(String(event.payload.threadId)))
          .pipe(Effect.catchCause(() => Effect.succeed(null)));
        return cardId === null ? [] : yield* forCard(cardId, event.sequence);
      }
      // Otherwise only a todo-changing thread event refetches. The projector
      // WRITES `board_thread_todos` on exactly one thread event — a
      // `turn.plan.updated` activity append — so every other thread event
      // (message deltas, session status, non-plan activities) would carry an
      // identical list and is skipped. This is the difference between one
      // refetch per plan revision and one per streamed message chunk on a live
      // linked thread.
      if (event.type !== "thread.activity-appended") return [];
      if (event.payload.activity.kind !== "turn.plan.updated") return [];
      const cardId = yield* boardMethods
        .boardCardIdForThread(ThreadId.make(String(event.payload.threadId)))
        .pipe(Effect.catchCause(() => Effect.succeed(null)));
      return cardId === null ? [] : yield* forCard(cardId, event.sequence);
    }).pipe(
      Effect.catchCause(() => Effect.succeed([] as ReadonlyArray<OrchestrationShellStreamEvent>)),
    );
}
