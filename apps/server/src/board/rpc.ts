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
  isBoardEvent,
  type BoardCardDetail,
  type BoardCardDetailStreamItem,
  type BoardCardId,
  type BoardSubscribeCardInput,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";

import type { AuthenticatedSession } from "../auth/EnvironmentAuth.ts";
import type { OrchestrationEngineShape } from "../orchestration/Services/OrchestrationEngine.ts";
import type { ProjectionSnapshotQueryShape } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { boardSnapshotQueryMethodsOf } from "./projection.ts";

export interface BoardRpcHandlerDeps {
  readonly currentSession: AuthenticatedSession;
  readonly orchestrationEngine: OrchestrationEngineShape;
  readonly projectionSnapshotQuery: ProjectionSnapshotQueryShape;
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
            // payload — every wake-up re-reads the projected tables, so
            // bursts collapse to at-least-once freshness.
            const liveBuffer = yield* Queue.unbounded<void>();
            yield* Effect.forkScoped(
              deps.orchestrationEngine.streamDomainEvents.pipe(
                Stream.filter((event) => isBoardEvent(event) && event.aggregateId === input.cardId),
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
                // A null mid-stream cannot happen today (cards are never
                // deleted, only archived, and archived cards still
                // resolve); dropping the frame keeps the viewer open if
                // that changes.
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
