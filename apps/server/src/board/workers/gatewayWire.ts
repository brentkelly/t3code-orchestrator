/**
 * The remote thread gateway's wire, both ends. A signal's `turnRef` is absent on
 * the wire rather than `undefined`, and the gateway's three error classes travel
 * as one `BoardWorkerGatewayError` naming which it was.
 */
import {
  BOARD_GATEWAY_CALL_RESULTS,
  BoardWorkerGatewayError,
  type BoardGatewayCall,
  type BoardGatewaySendInput,
  type BoardGatewaySettleInput,
  type BoardGatewaySignal,
  type BoardGatewaySignalBatch,
  type BoardGatewaySpawnInput,
  type BoardGatewayTargetInput,
  type BoardGatewayAnswerInput,
  type BoardGatewayPullRequestLinkInput,
  type BoardGatewayPullRequestUnlinkInput,
  type BoardGatewayThreadState,
  type BoardMcpRelayRequest,
  type BoardMcpRelayResponse,
  type BoardStageAttachmentsInput,
  type BoardStageAttachmentsResult,
  type BoardWorkerCiProgress,
  type BoardWorkerRunCiInput,
  type BoardWorkerReadCiLogInput,
  type BoardCiLogItem,
  type BoardStepReading,
  type BoardWorkerActualsInput,
  type EnvironmentId,
  type ProjectId,
  type ThreadId,
  type BoardCapacityClaimInput,
  type BoardCapacityClaimResult,
  type BoardSyncCardsInput,
  type BoardSyncCardsResult,
  type BoardWorkerCapacitySnapshot,
  type BoardCardSetupProgress,
  type BoardWorkerCheckReadinessInput,
  type BoardWorkerReadiness,
  type BoardWorkerRunSetupInput,
  type BoardWorkerSetupState,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type * as Stream from "effect/Stream";

import {
  ThreadCommandFailedError,
  ThreadCommandRefusedError,
  ThreadReadError,
  type BoardAssistantMessage,
  type BoardProject,
  type BoardProjectDetail,
  type BoardThreadRecord,
  type BoardWorktreeThread,
  type ThreadCommandError,
  type ThreadSignal,
  type TodoSignal,
} from "../ThreadGateway.ts";
import type { WorkerRpcError } from "./WorkerTransport.ts";

/** A todo-log position as the wire carries it: todo signals only, never usage. */
export interface WireTodoLogEntry {
  readonly cursor: number;
  readonly signal: TodoSignal | null;
}

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
  readonly answerPendingInput: (input: BoardGatewayAnswerInput) => Effect.Effect<boolean, E>;
  readonly linkPullRequest: (input: BoardGatewayPullRequestLinkInput) => Effect.Effect<void, E>;
  readonly unlinkPullRequest: (input: BoardGatewayPullRequestUnlinkInput) => Effect.Effect<void, E>;
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
  readonly subagentAwaitingApproval: (threadId: ThreadId) => Effect.Effect<boolean, E>;
  readonly projects: Effect.Effect<ReadonlyArray<BoardProject>, E>;
  readonly project: (projectId: ProjectId) => Effect.Effect<BoardProjectDetail | null, E>;
  readonly subscribeSignals: (
    afterSequence: number | null,
    withUsage?: boolean,
  ) => Stream.Stream<BoardGatewaySignalBatch, E>;
  readonly todoLogHead: Effect.Effect<number, E>;
  readonly readTodoLog: (after: number, upTo: number) => Stream.Stream<WireTodoLogEntry, E>;
  readonly subscribeTodoLog: Stream.Stream<WireTodoLogEntry, E>;
  readonly subscribeMcpRelay: (
    centralEnvironmentId: EnvironmentId,
  ) => Stream.Stream<BoardMcpRelayRequest, E>;
  readonly mcpRelayRespond: (response: BoardMcpRelayResponse) => Effect.Effect<void, E>;
  readonly stageAttachments: (
    input: BoardStageAttachmentsInput,
  ) => Effect.Effect<BoardStageAttachmentsResult, E>;
  /** Run a card's CI steps in its worktree on the worker. */
  readonly runCi: (input: BoardWorkerRunCiInput) => Stream.Stream<BoardWorkerCiProgress, E>;
  /** Read, and optionally follow, one CI step's log on the worker. */
  readonly readCiLog: (input: BoardWorkerReadCiLogInput) => Stream.Stream<BoardCiLogItem, E>;
  /** T3o: claim capacity for a card, keep the worker's card records in step, and read what
      the worker offers this board (T3O-86). */
  readonly claimCapacity: (
    input: BoardCapacityClaimInput,
  ) => Effect.Effect<BoardCapacityClaimResult, E>;
  readonly syncCards: (input: BoardSyncCardsInput) => Effect.Effect<BoardSyncCardsResult, E>;
  readonly subscribeCapacity: Stream.Stream<BoardWorkerCapacitySnapshot, E>;
  /** T3o: a card's setup and a project's readiness on the worker (T3O-86, section 5). */
  readonly runSetup: (input: BoardWorkerRunSetupInput) => Stream.Stream<BoardCardSetupProgress, E>;
  readonly setupState: (worktreePath: string) => Effect.Effect<BoardWorkerSetupState, E>;
  readonly cancelSetup: (worktreePath: string) => Effect.Effect<void, E>;
  readonly readSetupLog: (worktreePath: string) => Effect.Effect<string, E>;
  readonly checkReadiness: (
    input: BoardWorkerCheckReadinessInput,
  ) => Effect.Effect<BoardWorkerReadiness, E>;
  readonly readinessOutput: (
    repositoryKey: string | null,
    path: string,
  ) => Effect.Effect<string | null, E>;
  /** T3o: a step's measured actuals on the worker (T3O-87). */
  readonly actuals: (input: BoardWorkerActualsInput) => Effect.Effect<BoardStepReading | null, E>;
}

export type WorkerGatewayRpc = WorkerGatewayRpcOf<WorkerGatewayCallError>;

// ── Call results ───────────────────────────────────────────────────────

type CallTag = BoardGatewayCall["_tag"];

/** What a gateway call of tag `T` answers. */
export type BoardGatewayCallResult<T extends CallTag> =
  (typeof BOARD_GATEWAY_CALL_RESULTS)[T]["Type"];

interface ResultCodec {
  readonly encode: (value: unknown) => Effect.Effect<unknown, Schema.SchemaError>;
  readonly decode: (encoded: unknown) => Effect.Effect<unknown, Schema.SchemaError>;
}

/** Every result schema is context-free; the union of their types is not
    something the checker can index, so each is read as the codec it is. */
const codecOf = (schema: Schema.Top): ResultCodec => {
  const codec = schema as unknown as Schema.Codec<unknown>;
  return { encode: Schema.encodeUnknownEffect(codec), decode: Schema.decodeUnknownEffect(codec) };
};

const RESULT_CODECS = Object.fromEntries(
  Object.entries(BOARD_GATEWAY_CALL_RESULTS).map(([tag, schema]) => [tag, codecOf(schema)]),
) as Record<CallTag, ResultCodec>;

/** A call's answer, encoded for the wire. */
export const encodeGatewayCallResult = (tag: CallTag, value: unknown) =>
  RESULT_CODECS[tag].encode(value);

/** A call's answer, decoded off the wire. */
export const decodeGatewayCallResult = <T extends CallTag>(tag: T, encoded: unknown) =>
  RESULT_CODECS[tag].decode(encoded) as Effect.Effect<
    BoardGatewayCallResult<T>,
    Schema.SchemaError
  >;

// ── Signals ────────────────────────────────────────────────────────────

export const toWireSignal = (signal: ThreadSignal): BoardGatewaySignal => {
  if (signal.type !== "turn-ended") return signal;
  return {
    type: signal.type,
    threadId: signal.threadId,
    ...(signal.turnRef === undefined ? {} : { turnRef: signal.turnRef }),
    errorMessage: null,
  };
};

export const fromWireSignal = (signal: BoardGatewaySignal): ThreadSignal => {
  if (signal.type !== "turn-ended") return signal;
  return {
    type: signal.type,
    threadId: signal.threadId,
    turnRef: signal.turnRef,
  };
};

// ── Errors ─────────────────────────────────────────────────────────────

const toWireCommandError = (error: ThreadCommandError): BoardWorkerGatewayError =>
  new BoardWorkerGatewayError({
    kind: error._tag === "ThreadCommandRefusedError" ? "refused" : "failed",
    operation: error.command,
    threadId: error.threadId,
    detail: error.detail,
    ...(error._tag === "ThreadCommandRefusedError" && error.reason !== undefined
      ? { reason: error.reason }
      : {}),
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
      ? new ThreadCommandRefusedError({
          command,
          threadId,
          detail: error.detail,
          ...(error.reason === undefined ? {} : { reason: error.reason }),
        })
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
