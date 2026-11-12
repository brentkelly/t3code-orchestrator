/**
 * Who may call which board RPC (T3O-84). A worker answers board RPCs (`boardWorker.*`:
 * the handshake, the thread gateway, board git, the MCP relay, user sessions) only from
 * a session whose subject is `t3o-board:<id>`, a session it minted for a board itself,
 * and the board's identity comes from that subject, never from the request. Sessions a
 * worker minted for a board or its users are refused on everything else under `board.*`.
 * Scope checks still run inside each handler; this is the identity check beside them.
 */
import {
  BOARD_WORKER_GATEWAY_WS_METHODS,
  BOARD_WORKER_GIT_CALL_WS_METHODS,
  BOARD_WORKER_WS_METHODS,
  AuthOrchestrationReadScope,
  EnvironmentAuthorizationError,
  boardIdOfBoardSubject,
  isT3oBoardSubject,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";

/** Every method only a board's own session may call. T3O-71's calls join this list. */
export const BOARD_ONLY_METHODS: ReadonlySet<string> = new Set([
  ...Object.values(BOARD_WORKER_WS_METHODS),
  ...Object.values(BOARD_WORKER_GATEWAY_WS_METHODS),
  ...Object.values(BOARD_WORKER_GIT_CALL_WS_METHODS),
]);

/** The board-only methods that answer with a stream rather than one value. */
const STREAM_METHODS: ReadonlySet<string> = new Set([
  BOARD_WORKER_GATEWAY_WS_METHODS.subscribeSignals,
  BOARD_WORKER_GATEWAY_WS_METHODS.readTodoLog,
  BOARD_WORKER_GATEWAY_WS_METHODS.subscribeTodoLog,
  BOARD_WORKER_GATEWAY_WS_METHODS.subscribeMcpRelay,
  BOARD_WORKER_GATEWAY_WS_METHODS.runCi,
  BOARD_WORKER_GATEWAY_WS_METHODS.readCiLog,
]);

/** Null when the subject may call the method; otherwise why not. */
export function boardSubjectRefusal(method: string, subject: string): string | null {
  if (BOARD_ONLY_METHODS.has(method)) {
    return boardIdOfBoardSubject(subject) === null
      ? "Only a board's own session may call this on a worker."
      : null;
  }
  return method.startsWith("board.") && isT3oBoardSubject(subject)
    ? "A session a worker issued for a board can't manage this server's own board."
    : null;
}

const refusal = (message: string) =>
  new EnvironmentAuthorizationError({ message, requiredScope: AuthOrchestrationReadScope });

/** Wrap every handler in the board's record with the identity check. */
export function guardBoardHandlers<Handlers extends Record<string, unknown>>(
  subject: string,
  handlers: Handlers,
): Handlers {
  const guarded: Record<string, unknown> = {};
  for (const [method, handler] of Object.entries(handlers)) {
    const refused = boardSubjectRefusal(method, subject);
    if (refused === null || typeof handler !== "function") {
      guarded[method] = handler;
      continue;
    }
    guarded[method] = STREAM_METHODS.has(method)
      ? () => Stream.fail(refusal(refused))
      : () => Effect.fail(refusal(refused));
  }
  return guarded as Handlers;
}
