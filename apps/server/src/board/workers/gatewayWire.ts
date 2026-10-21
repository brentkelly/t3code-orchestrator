/**
 * T3o (T3O-63): the remote thread gateway's wire, both ends.
 *
 * `WorkerGatewayRpc` is what the central server calls on a worker: one method
 * per `ThreadGatewayShape` method, plus the signal stream, the MCP relay and
 * attachment staging. The live transport implements it over `boardWorker.*`
 * RPCs; a test transport implements it with the worker's own host in process.
 *
 * The converters translate between the board's gateway vocabulary and the
 * wire's: a signal's `turnRef`/`outcome` are absent on the wire rather than
 * `undefined`, and the gateway's three error classes travel as one
 * `BoardWorkerGatewayError` that names which it was.
 */
import {
  BoardWorkerGatewayError,
  type BoardGatewaySendInput,
  type BoardGatewaySettleInput,
  type BoardGatewaySignal,
  type BoardGatewaySignalBatch,
  type BoardGatewaySpawnInput,
  type BoardGatewayTargetInput,
  type BoardGatewayThreadState,
  type BoardMcpRelayRequest,
  type BoardMcpRelayResponse,
  type BoardStageAttachmentsInput,
  type BoardStageAttachmentsResult,
  type EnvironmentId,
  type ProjectId,
  type ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import type * as Stream from "effect/Stream";

import {
  ThreadCommandFailedError,
  ThreadCommandRefusedError,
  ThreadReadError,
  type BoardAssistantMessage,
  type BoardProject,
  type BoardProjectDetail,
  type BoardThreadRecord,
  type BoardThreadState,
  type BoardWorktreeThread,
  type ThreadCommandError,
  type ThreadSignal,
  type TodoLogEntry,
} from "../ThreadGateway.ts";
import type { WorkerRpcError } from "./WorkerTransport.ts";

/** A gateway call failed: on the wire, or on the worker. */
export type WorkerGatewayCallError = WorkerRpcError | BoardWorkerGatewayError;

/** The gateway surface, failing with `E`: the wire's errors on the central
    side, the worker's own error on the worker's side of it. */
export interface WorkerGatewayRpcOf<E> {
  readonly spawn: (input: BoardGatewaySpawnInput) => Effect.Effect<void, E>;
  readonly send: (input: BoardGatewaySendInput) => Effect.Effect<void, E>;
  readonly interrupt: (input: BoardGatewayTargetInput) => Effect.Effect<void, E>;
  readonly stopSession: (input: BoardGatewayTargetInput) => Effect.Effect<void, E>;
  readonly settle: (input: BoardGatewaySettleInput) => Effect.Effect<void, E>;
  readonly delete: (input: BoardGatewayTargetInput) => Effect.Effect<void, E>;
  readonly armLimitRecovery: (input: BoardGatewayTargetInput) => Effect.Effect<boolean, E>;
  readonly threadState: (threadId: ThreadId) => Effect.Effect<BoardGatewayThreadState | null, E>;
  readonly threadRecords: (
    threadIds: ReadonlyArray<ThreadId>,
  ) => Effect.Effect<ReadonlyArray<BoardThreadRecord>, E>;
  readonly threadsInWorktree: (
    worktreePath: string,
  ) => Effect.Effect<ReadonlyArray<BoardWorktreeThread>, E>;
  readonly listLiveThreadIds: Effect.Effect<ReadonlyArray<ThreadId>, E>;
  readonly latestAssistantMessage: (
    threadId: ThreadId,
  ) => Effect.Effect<BoardAssistantMessage | null, E>;
  readonly lastSignalAt: (threadId: ThreadId) => Effect.Effect<string | null, E>;
  readonly pendingTurnStartAt: (threadId: ThreadId) => Effect.Effect<string | null, E>;
  readonly projects: Effect.Effect<ReadonlyArray<BoardProject>, E>;
  readonly project: (projectId: ProjectId) => Effect.Effect<BoardProjectDetail | null, E>;
  readonly subscribeSignals: (
    afterSequence: number | null,
  ) => Stream.Stream<BoardGatewaySignalBatch, E>;
  readonly todoLogHead: Effect.Effect<number, E>;
  readonly readTodoLog: (after: number, upTo: number) => Stream.Stream<TodoLogEntry, E>;
  readonly subscribeTodoLog: Stream.Stream<TodoLogEntry, E>;
  readonly subscribeMcpRelay: (
    centralEnvironmentId: EnvironmentId,
  ) => Stream.Stream<BoardMcpRelayRequest, E>;
  readonly mcpRelayRespond: (response: BoardMcpRelayResponse) => Effect.Effect<void, E>;
  readonly stageAttachments: (
    input: BoardStageAttachmentsInput,
  ) => Effect.Effect<BoardStageAttachmentsResult, E>;
}

export type WorkerGatewayRpc = WorkerGatewayRpcOf<WorkerGatewayCallError>;

// ── Signals ────────────────────────────────────────────────────────────

export const toWireSignal = (signal: ThreadSignal): BoardGatewaySignal => {
  if (signal.type !== "turn-ended") return signal;
  return {
    type: signal.type,
    threadId: signal.threadId,
    errorMessage: signal.errorMessage,
    ...(signal.turnRef === undefined ? {} : { turnRef: signal.turnRef }),
    ...(signal.outcome === undefined ? {} : { outcome: signal.outcome }),
  };
};

export const fromWireSignal = (signal: BoardGatewaySignal): ThreadSignal => {
  if (signal.type !== "turn-ended") return signal;
  return {
    type: signal.type,
    threadId: signal.threadId,
    errorMessage: signal.errorMessage,
    turnRef: signal.turnRef,
    outcome: signal.outcome,
  };
};

/** The wire state is the board's own shape; only the error is translated. */
export const fromWireThreadState = (state: BoardGatewayThreadState): BoardThreadState => state;

// ── Errors ─────────────────────────────────────────────────────────────

export const toWireCommandError = (error: ThreadCommandError): BoardWorkerGatewayError =>
  new BoardWorkerGatewayError({
    kind: error._tag === "ThreadCommandRefusedError" ? "refused" : "failed",
    operation: error.command,
    threadId: error.threadId,
    detail: error.detail,
  });

export const toWireReadError = (error: ThreadReadError): BoardWorkerGatewayError =>
  new BoardWorkerGatewayError({
    kind: "read",
    operation: error.operation,
    threadId: null,
    detail: error.detail,
  });

const describeCallError = (error: WorkerGatewayCallError): string =>
  error._tag === "WorkerRpcError" ? error.message : error.detail;

/** A command's failure as the supervisor expects it from any gateway. A
    connection that went mid-command is a failure, never a refusal: the
    command may well have landed. */
export const fromWireCommandError =
  (command: string, threadId: ThreadId) =>
  (error: WorkerGatewayCallError): ThreadCommandError =>
    error._tag === "BoardWorkerGatewayError" && error.kind === "refused"
      ? new ThreadCommandRefusedError({ command, threadId, detail: error.detail })
      : new ThreadCommandFailedError({
          command,
          threadId,
          detail: describeCallError(error),
          cause: error,
        });

export const fromWireReadError =
  (operation: string) =>
  (error: WorkerGatewayCallError): ThreadReadError =>
    new ThreadReadError({ operation, detail: describeCallError(error), cause: error });

/** Run a gateway command for the wire. */
export const wireCommand = <A>(effect: Effect.Effect<A, ThreadCommandError>) =>
  effect.pipe(Effect.mapError(toWireCommandError));

/** Run a gateway read for the wire. */
export const wireRead = <A>(effect: Effect.Effect<A, ThreadReadError>) =>
  effect.pipe(Effect.mapError(toWireReadError));
