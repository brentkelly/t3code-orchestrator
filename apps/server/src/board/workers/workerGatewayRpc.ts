/**
 * T3o (T3O-63): the worker side's `boardWorker.gateway.*`, the MCP relay and
 * attachment staging, spread into the board's RPC handler record. Each is a
 * thin call into `WorkerGatewayHost`, read per call like the T3O-62 worker
 * handlers, so building the record needs no service.
 */
import {
  BOARD_WORKER_GATEWAY_RPC_SCOPES,
  type AuthSessionId,
  BOARD_WORKER_GATEWAY_WS_METHODS as M,
  BoardWorkerGatewayError,
  EnvironmentAuthorizationError,
  type BoardGatewayCall,
  type BoardMcpRelayResponse,
  type BoardStageAttachmentsInput,
  type EnvironmentId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";

import type { AuthenticatedSession } from "../../auth/EnvironmentAuth.ts";
import { encodeGatewayCallResult } from "./gatewayWire.ts";
import { WorkerGatewayHost, type WorkerGatewayHostShape } from "./WorkerGatewayHost.ts";

type Method = keyof typeof BOARD_WORKER_GATEWAY_RPC_SCOPES;

/** Run one gateway call on the host, its answer untyped for the wire. */
export const runGatewayCall = (
  host: WorkerGatewayHostShape,
  call: BoardGatewayCall,
  caller: AuthSessionId,
): Effect.Effect<unknown, BoardWorkerGatewayError> => {
  const answer = (): Effect.Effect<unknown, BoardWorkerGatewayError> => {
    switch (call._tag) {
      case "spawn":
        return host.spawn(call.input, caller).pipe(Effect.as(null));
      case "send":
        return host.send(call.input).pipe(Effect.as(null));
      case "interrupt":
        return host.interrupt(call.input).pipe(Effect.as(null));
      case "stopSession":
        return host.stopSession(call.input).pipe(Effect.as(null));
      case "settle":
        return host.settle(call.input).pipe(Effect.as(null));
      case "delete":
        return host.delete(call.input).pipe(Effect.as(null));
      case "armLimitRecovery":
        return host.armLimitRecovery(call.input);
      case "threadState":
        return host.threadState(call.threadId);
      case "threadRecords":
        return host.threadRecords(call.threadIds);
      case "threadsInWorktree":
        return host.threadsInWorktree(call.worktreePath);
      case "listLiveThreadIds":
        return host.listLiveThreadIds;
      case "latestAssistantMessage":
        return host.latestAssistantMessage(call.threadId);
      case "lastSignalAt":
        return host.lastSignalAt(call.threadId);
      case "pendingTurnStartAt":
        return host.pendingTurnStartAt(call.threadId);
      case "projects":
        return host.projects;
      case "project":
        return host.project(call.projectId);
      case "todoLogHead":
        return host.todoLogHead;
    }
  };
  return answer().pipe(
    Effect.flatMap((value) => encodeGatewayCallResult(call._tag, value)),
    Effect.catchTags({
      SchemaError: (error) =>
        Effect.fail(
          new BoardWorkerGatewayError({
            kind: "failed",
            operation: call._tag,
            threadId: null,
            detail: `The worker's answer did not encode: ${error.message}`,
          }),
        ),
    }),
  );
};

export const workerGatewayRpcHandlers = (currentSession: AuthenticatedSession) => {
  const denied = (method: Method) => {
    const requiredScope = BOARD_WORKER_GATEWAY_RPC_SCOPES[method];
    return currentSession.scopes.includes(requiredScope)
      ? null
      : new EnvironmentAuthorizationError({
          message: `The authenticated token is missing required scope: ${requiredScope}.`,
          requiredScope,
        });
  };
  const call =
    <I, A, E>(
      method: Method,
      run: (host: WorkerGatewayHostShape, input: I) => Effect.Effect<A, E>,
    ) =>
    (input: I): Effect.Effect<A, E | EnvironmentAuthorizationError, WorkerGatewayHost> => {
      const error = denied(method);
      return error === null
        ? Effect.flatMap(WorkerGatewayHost, (host) => run(host, input))
        : Effect.fail(error);
    };
  const stream =
    <I, A, E>(
      method: Method,
      run: (host: WorkerGatewayHostShape, input: I) => Stream.Stream<A, E>,
    ) =>
    (input: I): Stream.Stream<A, E | EnvironmentAuthorizationError, WorkerGatewayHost> => {
      const error = denied(method);
      return error === null
        ? Stream.unwrap(Effect.map(WorkerGatewayHost, (host) => run(host, input)))
        : Stream.fail(error);
    };

  return {
    // The caller is the authenticated session, never anything the request
    // says about itself: it is what binds a board's relay (`McpRelayHost`).
    [M.call]: call(M.call, (host, input: BoardGatewayCall) =>
      runGatewayCall(host, input, currentSession.sessionId),
    ),
    [M.subscribeSignals]: stream(
      M.subscribeSignals,
      (host, input: { readonly afterSequence: number | null }) =>
        host.subscribeSignals(input.afterSequence),
    ),
    [M.readTodoLog]: stream(
      M.readTodoLog,
      (host, input: { readonly after: number; readonly upTo: number }) =>
        host.readTodoLog(input.after, input.upTo),
    ),
    [M.subscribeTodoLog]: stream(
      M.subscribeTodoLog,
      (host, _input: Record<string, never>) => host.subscribeTodoLog,
    ),
    [M.subscribeMcpRelay]: stream(
      M.subscribeMcpRelay,
      (host, input: { readonly centralEnvironmentId: EnvironmentId }) =>
        host.subscribeMcpRelay(input.centralEnvironmentId, currentSession.sessionId),
    ),
    [M.mcpRelayRespond]: call(M.mcpRelayRespond, (host, input: BoardMcpRelayResponse) =>
      host.mcpRelayRespond(input, currentSession.sessionId),
    ),
    [M.stageAttachments]: call(M.stageAttachments, (host, input: BoardStageAttachmentsInput) =>
      host.stageAttachments(input),
    ),
  };
};
