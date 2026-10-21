/**
 * T3o distributed board: the remote thread gateway and the MCP relay (T3O-63,
 * overview D3/D9/D19).
 *
 * A worker runs T3o, so the central server does not drive its threads through
 * upstream's client RPCs. Instead the worker exposes its own local thread
 * gateway 1:1 as `boardWorker.gateway.*`, and the central server's
 * `RemoteThreadGateway` is a thin proxy over them. Threads are still created
 * through upstream commands on the worker, so they stay ordinary threads.
 *
 * The MCP relay runs the other way over the same connection: a board tool an
 * agent calls on the worker, for a thread the central server placed there, is
 * handed to the central server on the stream it holds open
 * (`subscribeMcpRelay`) and answered with `mcpRelayRespond`. The worker never
 * dials out.
 *
 * The wire shapes mirror `apps/server/src/board/ThreadGateway.ts`; that file
 * stays the source of the board's own vocabulary.
 */
import * as Schema from "effect/Schema";
import * as Rpc from "effect/rpc/Rpc";

import {
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  EnvironmentAuthorizationError,
} from "./auth.ts";
import {
  CommandId,
  EnvironmentId,
  NonNegativeInt,
  ProjectId,
  ThreadId,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";
import { ChatAttachment } from "./chatAttachment.ts";
import { RepositoryIdentity } from "./environment.ts";
import { ModelSelection } from "./modelSelection.ts";
import { ProjectScript } from "./project.ts";
import { ProviderInstanceId } from "./providerInstance.ts";
import { ProviderInteractionMode, RuntimeMode } from "./providerPolicy.ts";

// ── Reads ──────────────────────────────────────────────────────────────

export const BoardGatewaySessionStatus = Schema.Literals([
  "starting",
  "running",
  "idle",
  "stopped",
  "error",
  "none",
]);

export const BoardGatewayThreadState = Schema.Struct({
  threadId: ThreadId,
  projectId: ProjectId,
  deleted: Schema.Boolean,
  archived: Schema.Boolean,
  settlementDecided: Schema.Boolean,
  sessionStatus: BoardGatewaySessionStatus,
  activeTurnRef: Schema.NullOr(Schema.String),
  awaitingUserInput: Schema.Boolean,
  awaitingPermission: Schema.Boolean,
  backgroundWork: Schema.NullOr(Schema.Literals(["working", "monitoring"])),
  alive: Schema.Boolean,
  waitingOnBackground: Schema.Boolean,
  autoSettleCandidate: Schema.Boolean,
  worktreePath: Schema.NullOr(Schema.String),
  modelSelection: Schema.NullOr(ModelSelection),
  usageLimit: Schema.NullOr(
    Schema.Struct({
      resetAt: Schema.NullOr(Schema.String),
      message: Schema.NullOr(Schema.String),
      resumeArmed: Schema.Boolean,
    }),
  ),
});
export type BoardGatewayThreadState = typeof BoardGatewayThreadState.Type;

export const BoardGatewayThreadRecord = Schema.Struct({
  threadId: ThreadId,
  deleted: Schema.Boolean,
  archived: Schema.Boolean,
  settlementDecided: Schema.Boolean,
});
export type BoardGatewayThreadRecord = typeof BoardGatewayThreadRecord.Type;

export const BoardGatewayWorktreeThread = Schema.Struct({
  threadId: ThreadId,
  deleted: Schema.Boolean,
  sessionLive: Schema.Boolean,
});
export type BoardGatewayWorktreeThread = typeof BoardGatewayWorktreeThread.Type;

export const BoardGatewayProject = Schema.Struct({
  id: ProjectId,
  title: Schema.String,
  workspaceRoot: Schema.String,
  deleted: Schema.Boolean,
  scripts: Schema.Array(ProjectScript),
});
export type BoardGatewayProject = typeof BoardGatewayProject.Type;

export const BoardGatewayProjectDetail = Schema.Struct({
  ...BoardGatewayProject.fields,
  repositoryIdentity: Schema.NullOr(RepositoryIdentity),
});
export type BoardGatewayProjectDetail = typeof BoardGatewayProjectDetail.Type;

export const BoardGatewayAssistantMessage = Schema.Struct({
  text: Schema.String,
  createdAt: Schema.String,
});

// ── Signals ────────────────────────────────────────────────────────────

const TurnOutcome = Schema.Literals(["completed", "failed", "interrupted", "cancelled"]);

export const BoardGatewayTodoSignal = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("todos-changed"),
    threadId: ThreadId,
    todos: Schema.Array(Schema.Struct({ step: Schema.String, status: Schema.String })),
    at: Schema.String,
  }),
  Schema.Struct({ type: Schema.Literal("thread-deleted"), threadId: ThreadId }),
]);

export const BoardGatewaySignal = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("turn-ended"),
    threadId: ThreadId,
    turnRef: Schema.optionalKey(Schema.String),
    outcome: Schema.optionalKey(TurnOutcome),
    errorMessage: Schema.NullOr(Schema.String),
  }),
  Schema.Struct({
    type: Schema.Literal("turn-start-failed"),
    threadId: ThreadId,
    detail: Schema.String,
  }),
  Schema.Struct({
    type: Schema.Literal("turn-requested"),
    threadId: ThreadId,
    byBoard: Schema.Boolean,
    at: Schema.String,
  }),
  Schema.Struct({ type: Schema.Literal("limit-resumed"), threadId: ThreadId }),
  Schema.Struct({ type: Schema.Literal("interrupt-requested"), threadId: ThreadId }),
  Schema.Struct({ type: Schema.Literal("approval-responded"), threadId: ThreadId }),
  Schema.Struct({ type: Schema.Literal("input-requested"), threadId: ThreadId }),
  Schema.Struct({
    type: Schema.Literal("input-resolved"),
    threadId: ThreadId,
    answered: Schema.Boolean,
  }),
  Schema.Struct({ type: Schema.Literal("session-started"), threadId: ThreadId }),
  ...BoardGatewayTodoSignal.members,
]);
export type BoardGatewaySignal = typeof BoardGatewaySignal.Type;

/**
 * The signals one position of the worker's thread log produced, in order.
 * One batch per position, so a reader's cursor never falls between two
 * signals of the same event; positions that produced nothing are not sent.
 */
export const BoardGatewaySignalBatch = Schema.Struct({
  sequence: NonNegativeInt,
  signals: Schema.Array(BoardGatewaySignal),
});
export type BoardGatewaySignalBatch = typeof BoardGatewaySignalBatch.Type;

export const BoardGatewayTodoLogEntry = Schema.Struct({
  cursor: NonNegativeInt,
  signal: Schema.NullOr(BoardGatewayTodoSignal),
});
export type BoardGatewayTodoLogEntry = typeof BoardGatewayTodoLogEntry.Type;

// ── Commands ───────────────────────────────────────────────────────────

export const BoardGatewaySpawnInput = Schema.Struct({
  commandId: CommandId,
  threadId: ThreadId,
  /** The WORKER's project id: the central server maps its own before calling. */
  projectId: ProjectId,
  title: Schema.String,
  modelSelection: ModelSelection,
  runtimeMode: RuntimeMode,
  interactionMode: ProviderInteractionMode,
  branch: Schema.NullOr(Schema.String),
  worktreePath: Schema.String,
  text: Schema.String,
  attachments: Schema.Array(ChatAttachment),
  /** The central server spawning it. The worker records the thread as
      relayed to that board, so its board tools forward there. */
  centralEnvironmentId: EnvironmentId,
});
export type BoardGatewaySpawnInput = typeof BoardGatewaySpawnInput.Type;

export const BoardGatewaySendInput = Schema.Struct({
  commandId: CommandId,
  threadId: ThreadId,
  text: Schema.String,
  attachments: Schema.Array(ChatAttachment),
  runtimeMode: RuntimeMode,
  interactionMode: ProviderInteractionMode,
});
export type BoardGatewaySendInput = typeof BoardGatewaySendInput.Type;

export const BoardGatewayTargetInput = Schema.Struct({
  commandId: CommandId,
  threadId: ThreadId,
});
export type BoardGatewayTargetInput = typeof BoardGatewayTargetInput.Type;

export const BoardGatewaySettleInput = Schema.Struct({
  ...BoardGatewayTargetInput.fields,
  auto: Schema.Boolean,
});
export type BoardGatewaySettleInput = typeof BoardGatewaySettleInput.Type;

/**
 * A gateway call the worker answered with a failure. `refused` and `failed`
 * mirror the gateway's command errors and `read` its read error, so the
 * central server hands the supervisor exactly what a local gateway would.
 */
export class BoardWorkerGatewayError extends Schema.TaggedError<BoardWorkerGatewayError>()(
  "BoardWorkerGatewayError",
  {
    kind: Schema.Literals(["refused", "failed", "read"]),
    operation: Schema.String,
    threadId: Schema.NullOr(Schema.String),
    detail: Schema.String,
  },
) {}

// ── MCP relay ──────────────────────────────────────────────────────────

/** A board tool call forwarded from a worker to the central server. */
export const BoardMcpRelayRequest = Schema.Struct({
  /** Unique per call, and the same on every redelivery of it: the central
      server applies a call once however often it arrives. */
  callId: TrimmedNonEmptyString,
  toolName: TrimmedNonEmptyString,
  params: Schema.Unknown,
  threadId: ThreadId,
  providerSessionId: Schema.String,
  providerInstanceId: ProviderInstanceId,
  /** The worker's state directory, where staged card attachments live. */
  stateDir: Schema.String,
});
export type BoardMcpRelayRequest = typeof BoardMcpRelayRequest.Type;

export const BoardMcpRelayOutcome = Schema.Union([
  Schema.TaggedStruct("success", { value: Schema.Unknown }),
  Schema.TaggedStruct("failure", {
    code: TrimmedNonEmptyString,
    message: TrimmedNonEmptyString,
  }),
]);
export type BoardMcpRelayOutcome = typeof BoardMcpRelayOutcome.Type;

export const BoardMcpRelayResponse = Schema.Struct({
  callId: TrimmedNonEmptyString,
  outcome: BoardMcpRelayOutcome,
});
export type BoardMcpRelayResponse = typeof BoardMcpRelayResponse.Type;

// ── Attachment staging ─────────────────────────────────────────────────

/**
 * Stage a card's brief attachments on a worker, under
 * `<stateDir>/board/attachments/<cardId>`. Two-phase so unchanged files never
 * cross the wire: a call with hashes only answers which files the worker
 * lacks, and a second carries just those. Files on the worker that the list
 * does not name are removed.
 */
export const BoardStageAttachmentsInput = Schema.Struct({
  cardId: TrimmedNonEmptyString,
  files: Schema.Array(
    Schema.Struct({
      name: TrimmedNonEmptyString,
      sha256: TrimmedNonEmptyString,
      contentBase64: Schema.optionalKey(Schema.String),
    }),
  ),
});
export type BoardStageAttachmentsInput = typeof BoardStageAttachmentsInput.Type;

export const BoardStageAttachmentsResult = Schema.Struct({
  /** Named files whose content differs on the worker and was not sent. */
  needed: Schema.Array(TrimmedNonEmptyString),
  /** Files written by this call. */
  written: NonNegativeInt,
  /** The worker's own state directory. */
  stateDir: Schema.String,
});
export type BoardStageAttachmentsResult = typeof BoardStageAttachmentsResult.Type;

// ── RPCs ───────────────────────────────────────────────────────────────

/**
 * One request/response gateway call. The gateway's request/response methods
 * travel as one tagged RPC rather than one each: the WebSocket RPC group is at
 * the edge of what the type checker will instantiate, and the board's own
 * session holds every scope these need anyway.
 */
export const BoardGatewayCall = Schema.Union([
  Schema.TaggedStruct("spawn", { input: BoardGatewaySpawnInput }),
  Schema.TaggedStruct("send", { input: BoardGatewaySendInput }),
  Schema.TaggedStruct("interrupt", { input: BoardGatewayTargetInput }),
  Schema.TaggedStruct("stopSession", { input: BoardGatewayTargetInput }),
  Schema.TaggedStruct("settle", { input: BoardGatewaySettleInput }),
  Schema.TaggedStruct("delete", { input: BoardGatewayTargetInput }),
  Schema.TaggedStruct("armLimitRecovery", { input: BoardGatewayTargetInput }),
  Schema.TaggedStruct("threadState", { threadId: ThreadId }),
  Schema.TaggedStruct("threadRecords", { threadIds: Schema.Array(ThreadId) }),
  Schema.TaggedStruct("threadsInWorktree", { worktreePath: Schema.String }),
  Schema.TaggedStruct("listLiveThreadIds", {}),
  Schema.TaggedStruct("latestAssistantMessage", { threadId: ThreadId }),
  Schema.TaggedStruct("lastSignalAt", { threadId: ThreadId }),
  Schema.TaggedStruct("pendingTurnStartAt", { threadId: ThreadId }),
  Schema.TaggedStruct("projects", {}),
  Schema.TaggedStruct("project", { projectId: ProjectId }),
  Schema.TaggedStruct("todoLogHead", {}),
]);
export type BoardGatewayCall = typeof BoardGatewayCall.Type;

/** What each call answers. The RPC carries it encoded; each end codes it with
    the schema its tag names. */
export const BOARD_GATEWAY_CALL_RESULTS = {
  spawn: Schema.Null,
  send: Schema.Null,
  interrupt: Schema.Null,
  stopSession: Schema.Null,
  settle: Schema.Null,
  delete: Schema.Null,
  armLimitRecovery: Schema.Boolean,
  threadState: Schema.NullOr(BoardGatewayThreadState),
  threadRecords: Schema.Array(BoardGatewayThreadRecord),
  threadsInWorktree: Schema.Array(BoardGatewayWorktreeThread),
  listLiveThreadIds: Schema.Array(ThreadId),
  latestAssistantMessage: Schema.NullOr(BoardGatewayAssistantMessage),
  lastSignalAt: Schema.NullOr(Schema.String),
  pendingTurnStartAt: Schema.NullOr(Schema.String),
  projects: Schema.Array(BoardGatewayProject),
  project: Schema.NullOr(BoardGatewayProjectDetail),
  todoLogHead: NonNegativeInt,
} as const satisfies Record<BoardGatewayCall["_tag"], Schema.Top>;

export const BOARD_WORKER_GATEWAY_WS_METHODS = {
  /** Every request/response gateway method (`BoardGatewayCall`). */
  call: "boardWorker.gateway.call",
  /** The worker's thread signals after a log position, live. */
  subscribeSignals: "boardWorker.gateway.subscribeSignals",
  readTodoLog: "boardWorker.gateway.readTodoLog",
  subscribeTodoLog: "boardWorker.gateway.subscribeTodoLog",
  /** Board tool calls relayed to the central server holding this stream. */
  subscribeMcpRelay: "boardWorker.subscribeMcpRelay",
  mcpRelayRespond: "boardWorker.mcpRelayRespond",
  stageAttachments: "boardWorker.stageAttachments",
} as const;

const M = BOARD_WORKER_GATEWAY_WS_METHODS;
const failure = Schema.Union([BoardWorkerGatewayError, EnvironmentAuthorizationError]);

export const BOARD_WORKER_GATEWAY_RPCS = [
  Rpc.make(M.call, { payload: BoardGatewayCall, success: Schema.Unknown, error: failure }),
  Rpc.make(M.subscribeSignals, {
    /** Null starts at the log's head: only what happens from now on. */
    payload: Schema.Struct({ afterSequence: Schema.NullOr(NonNegativeInt) }),
    success: BoardGatewaySignalBatch,
    error: failure,
    stream: true,
  }),
  Rpc.make(M.readTodoLog, {
    payload: Schema.Struct({ after: NonNegativeInt, upTo: NonNegativeInt }),
    success: BoardGatewayTodoLogEntry,
    error: failure,
    stream: true,
  }),
  Rpc.make(M.subscribeTodoLog, {
    payload: Schema.Struct({}),
    success: BoardGatewayTodoLogEntry,
    error: failure,
    stream: true,
  }),
  Rpc.make(M.subscribeMcpRelay, {
    payload: Schema.Struct({ centralEnvironmentId: EnvironmentId }),
    success: BoardMcpRelayRequest,
    error: failure,
    stream: true,
  }),
  Rpc.make(M.mcpRelayRespond, {
    payload: BoardMcpRelayResponse,
    success: Schema.Void,
    error: failure,
  }),
  Rpc.make(M.stageAttachments, {
    payload: BoardStageAttachmentsInput,
    success: BoardStageAttachmentsResult,
    error: failure,
  }),
] as const;

/** Thread reads stream at the thread-shell tier. Calls start, steer and read
    threads, so they sit at the operate tier with the relay and staging —
    scopes the board's own session already holds (D19). */
export const BOARD_WORKER_GATEWAY_RPC_SCOPES = {
  [M.call]: AuthOrchestrationOperateScope,
  [M.subscribeSignals]: AuthOrchestrationReadScope,
  [M.readTodoLog]: AuthOrchestrationReadScope,
  [M.subscribeTodoLog]: AuthOrchestrationReadScope,
  // Answering a relayed call writes to the board on the agent's behalf.
  [M.subscribeMcpRelay]: AuthOrchestrationOperateScope,
  [M.mcpRelayRespond]: AuthOrchestrationOperateScope,
  [M.stageAttachments]: AuthOrchestrationOperateScope,
} as const;

/** How long a worker waits for the central server to answer a relayed call
    before telling the agent the board is unreachable. */
export const BOARD_MCP_RELAY_TIMEOUT_MS = 60_000;
