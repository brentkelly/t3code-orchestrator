/**
 * A worker exposes its local thread gateway as `boardWorker.gateway.*`, and the central
 * server's `RemoteThreadGateway` proxies it. The MCP relay runs the other way on the same
 * connection, so the worker never dials out. Shapes mirror `board/ThreadGateway.ts`.
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
  PositiveInt,
  ProjectId,
  ThreadId,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";
import {
  BoardCapacityClaimInput,
  BoardCapacityClaimResult,
  BoardSyncCardsInput,
  BoardSyncCardsResult,
  BoardCardSetupProgress,
  BoardWorkerCapacitySnapshot,
  BoardWorkerCheckReadinessInput,
  BoardWorkerReadiness,
  BoardWorkerRunSetupInput,
  BoardWorkerSetupState,
} from "./boardCapacity.ts";
import { BoardStepReading, BoardWorkerActualsInput } from "./boardActuals.ts";
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

export const BoardGatewayTodoSignal = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("todos-changed"),
    threadId: ThreadId,
    todos: Schema.Array(Schema.Struct({ step: Schema.String, status: Schema.String })),
    at: Schema.String,
  }),
  Schema.Struct({ type: Schema.Literal("thread-deleted"), threadId: ThreadId }),
]);

/**
 * The counts of a provider turn's `TurnTokenUsage` the board prices, flat: the full union
 * nested here pushes the server's RPC group past the checker's instantiation depth.
 */
export const BoardGatewayTurnUsage = Schema.Struct({
  usageStatus: Schema.Literals(["complete", "partial", "unavailable"]),
  inputTokens: Schema.optional(NonNegativeInt),
  cachedInputTokens: Schema.optional(NonNegativeInt),
  cacheCreationTokens: Schema.optional(NonNegativeInt),
  outputTokens: Schema.optional(NonNegativeInt),
  reasoningTokens: Schema.optional(NonNegativeInt),
  otherUsage: Schema.optional(
    Schema.Struct({ inputTokens: NonNegativeInt, outputTokens: NonNegativeInt }),
  ),
});
export type BoardGatewayTurnUsage = typeof BoardGatewayTurnUsage.Type;

/**
 * One finished provider turn's usage, for the central board to price (T3O-77). Sent only
 * to a central that asked for it (`withUsage`), so an older central never sees a member
 * its union cannot decode.
 */
export const BoardGatewayUsageSignal = Schema.Struct({
  type: Schema.Literal("usage-recorded"),
  threadId: ThreadId,
  providerTurnId: TrimmedNonEmptyString,
  /** The provider driver, as the worker's provider thread names it. */
  driver: TrimmedNonEmptyString,
  model: Schema.NullOr(TrimmedNonEmptyString),
  /** The threads a `delegate_task` child descends from, nearest first, so the board can
      credit its spend to the nearest one linked to a card. */
  delegationChain: Schema.Array(ThreadId),
  /** Null when the provider reported no usage for the turn. */
  usage: Schema.NullOr(BoardGatewayTurnUsage),
});
export type BoardGatewayUsageSignal = typeof BoardGatewayUsageSignal.Type;

export const BoardGatewaySignal = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("turn-ended"),
    threadId: ThreadId,
    turnRef: Schema.optionalKey(Schema.String),
    // Retired, always null. Kept so a central on the previous protocol-1 build, which
    // required this key, still decodes turn ends from a newer worker.
    errorMessage: Schema.optionalKey(Schema.NullOr(Schema.String)),
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
    // Absent from older workers, which never answer for the board.
    byBoard: Schema.optionalKey(Schema.Boolean),
  }),
  Schema.Struct({ type: Schema.Literal("session-started"), threadId: ThreadId }),
  ...BoardGatewayTodoSignal.members,
  BoardGatewayUsageSignal,
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
  /** `steer` joins a running turn instead of queuing behind it. Older workers queue. */
  delivery: Schema.optional(Schema.Literals(["queue", "steer"])),
});
export type BoardGatewaySendInput = typeof BoardGatewaySendInput.Type;

export const BoardGatewayTargetInput = Schema.Struct({
  commandId: CommandId,
  threadId: ThreadId,
});
export type BoardGatewayTargetInput = typeof BoardGatewayTargetInput.Type;

export const BoardGatewayAnswerInput = Schema.Struct({
  ...BoardGatewayTargetInput.fields,
  text: Schema.String,
});
export type BoardGatewayAnswerInput = typeof BoardGatewayAnswerInput.Type;

export const BoardGatewaySettleInput = Schema.Struct({
  ...BoardGatewayTargetInput.fields,
  auto: Schema.Boolean,
});
export type BoardGatewaySettleInput = typeof BoardGatewaySettleInput.Type;

export const BoardGatewayPullRequestUnlinkInput = Schema.Struct({
  ...BoardGatewayTargetInput.fields,
  host: TrimmedNonEmptyString,
  repository: TrimmedNonEmptyString,
  number: PositiveInt,
});
export type BoardGatewayPullRequestUnlinkInput = typeof BoardGatewayPullRequestUnlinkInput.Type;

export const BoardGatewayPullRequestLinkInput = Schema.Struct({
  ...BoardGatewayPullRequestUnlinkInput.fields,
  url: TrimmedNonEmptyString,
});
export type BoardGatewayPullRequestLinkInput = typeof BoardGatewayPullRequestLinkInput.Type;

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
    /** A refusal's reason the supervisor acts on (T3O-74). Optional, so a peer
        on either side of the change reads the other as a plain refusal. */
    reason: Schema.optional(Schema.Literals(["provider-disabled", "agent-cap", "needs-update"])),
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
 * Two-phase so unchanged files never cross the wire: a hashes-only call answers which
 * files the worker lacks, the second carries just those. Unlisted files are removed.
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
  Schema.TaggedStruct("answerPendingInput", { input: BoardGatewayAnswerInput }),
  Schema.TaggedStruct("linkPullRequest", { input: BoardGatewayPullRequestLinkInput }),
  Schema.TaggedStruct("unlinkPullRequest", { input: BoardGatewayPullRequestUnlinkInput }),
  Schema.TaggedStruct("threadState", { threadId: ThreadId }),
  Schema.TaggedStruct("threadRecords", { threadIds: Schema.Array(ThreadId) }),
  Schema.TaggedStruct("threadsInWorktree", { worktreePath: Schema.String }),
  Schema.TaggedStruct("listLiveThreadIds", {}),
  Schema.TaggedStruct("latestAssistantMessage", { threadId: ThreadId }),
  Schema.TaggedStruct("lastSignalAt", { threadId: ThreadId }),
  Schema.TaggedStruct("pendingTurnStartAt", { threadId: ThreadId }),
  Schema.TaggedStruct("subagentAwaitingApproval", { threadId: ThreadId }),
  Schema.TaggedStruct("projects", {}),
  Schema.TaggedStruct("project", { projectId: ProjectId }),
  Schema.TaggedStruct("todoLogHead", {}),
  // T3o: worker-owned capacity (T3O-86). The board is the calling session's.
  Schema.TaggedStruct("claimCapacity", { input: BoardCapacityClaimInput }),
  Schema.TaggedStruct("syncCards", { input: BoardSyncCardsInput }),
  Schema.TaggedStruct("setupState", { worktreePath: Schema.String }),
  Schema.TaggedStruct("cancelSetup", { worktreePath: Schema.String }),
  Schema.TaggedStruct("readSetupLog", { worktreePath: Schema.String }),
  Schema.TaggedStruct("checkReadiness", { input: BoardWorkerCheckReadinessInput }),
  Schema.TaggedStruct("readinessOutput", {
    repositoryKey: Schema.NullOr(Schema.String),
    path: Schema.String,
  }),
  // T3o: a step's measured actuals (T3O-87). An older worker refuses the tag: not measured.
  Schema.TaggedStruct("actuals", { input: BoardWorkerActualsInput }),
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
  answerPendingInput: Schema.Boolean,
  linkPullRequest: Schema.Null,
  unlinkPullRequest: Schema.Null,
  threadState: Schema.NullOr(BoardGatewayThreadState),
  threadRecords: Schema.Array(BoardGatewayThreadRecord),
  threadsInWorktree: Schema.Array(BoardGatewayWorktreeThread),
  listLiveThreadIds: Schema.Array(ThreadId),
  latestAssistantMessage: Schema.NullOr(BoardGatewayAssistantMessage),
  lastSignalAt: Schema.NullOr(Schema.String),
  pendingTurnStartAt: Schema.NullOr(Schema.String),
  subagentAwaitingApproval: Schema.Boolean,
  projects: Schema.Array(BoardGatewayProject),
  project: Schema.NullOr(BoardGatewayProjectDetail),
  todoLogHead: NonNegativeInt,
  claimCapacity: BoardCapacityClaimResult,
  syncCards: BoardSyncCardsResult,
  setupState: BoardWorkerSetupState,
  cancelSetup: Schema.Null,
  readSetupLog: Schema.String,
  checkReadiness: BoardWorkerReadiness,
  readinessOutput: Schema.NullOr(Schema.String),
  actuals: Schema.NullOr(BoardStepReading),
} as const satisfies Record<BoardGatewayCall["_tag"], Schema.Top>;

/**
 * A CI pass run on the worker holding the card's worktree. The
 * shapes mirror `BoardCiStepDefinition` and `BoardCiPassStep` in `board.ts`,
 * which this file cannot import.
 */
export const BoardWorkerRunCiInput = Schema.Struct({
  runId: TrimmedNonEmptyString,
  worktreePath: TrimmedNonEmptyString,
  steps: Schema.Array(
    Schema.Struct({
      name: TrimmedNonEmptyString,
      command: TrimmedNonEmptyString,
      timeoutMinutes: Schema.Number,
      parallel: Schema.optionalKey(Schema.Boolean),
    }),
  ),
  /** The pass index of `steps[0]`, so a later segment's log files don't
      overwrite an earlier one's. */
  indexOffset: Schema.optionalKey(NonNegativeInt),
  /** False runs every step even after a failure. An older worker
      ignores it and stops at the first failure. */
  stopOnFailure: Schema.optionalKey(Schema.Boolean),
});
export type BoardWorkerRunCiInput = typeof BoardWorkerRunCiInput.Type;

/** `BoardCiStepResult`: what a step's result file reported. */
const WireCiStepResult = Schema.Struct({
  summary: Schema.NullOr(Schema.String),
  failures: Schema.Array(
    Schema.Struct({
      title: TrimmedNonEmptyString,
      detail: Schema.optionalKey(Schema.String),
      file: Schema.optionalKey(TrimmedNonEmptyString),
      line: Schema.optionalKey(PositiveInt),
      machine: Schema.optionalKey(Schema.Boolean),
    }),
  ),
});

/** `BoardCiHeadline` with loose strings: the board clamps them, so
    a worker's long reason can't fail the whole stream's decode. */
const WireCiHeadline = Schema.Struct({
  what: Schema.String,
  why: Schema.String,
  machine: Schema.Boolean,
  logLine: Schema.NullOr(Schema.Number),
  logOffset: Schema.NullOr(Schema.Number),
  source: Schema.String,
  hint: Schema.optionalKey(Schema.String),
});

/** One step's progress, then the pass's result. */
export const BoardWorkerCiProgress = Schema.Union([
  Schema.TaggedStruct("step", {
    index: NonNegativeInt,
    step: Schema.Struct({
      name: TrimmedNonEmptyString,
      command: TrimmedNonEmptyString,
      timeoutMinutes: Schema.Number,
      status: Schema.Literals(["pending", "running", "passed", "failed", "timed-out", "cancelled"]),
      startedAt: Schema.NullOr(Schema.String),
      finishedAt: Schema.NullOr(Schema.String),
      exitCode: Schema.NullOr(Schema.Int),
      tail: Schema.String,
      parallel: Schema.optionalKey(Schema.Boolean),
      result: Schema.optionalKey(WireCiStepResult),
      /** `BoardCiProgress`. */
      progress: Schema.optionalKey(
        Schema.Struct({
          message: Schema.NullOr(Schema.String),
          done: Schema.NullOr(NonNegativeInt),
          total: Schema.NullOr(NonNegativeInt),
          at: Schema.String,
        }),
      ),
      silentSince: Schema.optionalKey(Schema.String),
      headline: Schema.optionalKey(WireCiHeadline),
    }),
  }),
  Schema.TaggedStruct("done", {
    result: Schema.Literals(["passed", "failed", "unavailable"]),
    failedIndex: Schema.NullOr(NonNegativeInt),
    /** Why the pass could not run, when `result` is "unavailable". */
    detail: Schema.optional(Schema.String),
    /** Every step ran. Absent, from an older worker, reads false. */
    ranAll: Schema.optionalKey(Schema.Boolean),
    /** The pass could not run because of the worker's machine. */
    machine: Schema.optionalKey(Schema.Boolean),
    /** The failed step's exit code, when `result` is "failed". */
    exitCode: Schema.optionalKey(Schema.NullOr(Schema.Int)),
    /** The failed step's headline: a machine one holds the card. */
    headline: Schema.optionalKey(WireCiHeadline),
  }),
]);
export type BoardWorkerCiProgress = typeof BoardWorkerCiProgress.Type;

/** Most bytes one chunk of a CI log read carries. */
export const BOARD_CI_LOG_CHUNK_BYTES = 1024 * 1024;

/**
 * `offset`, `size` and `end` are bytes of `<n>.log`; `text` is UTF-8 decoded, so a
 * character split across reads arrives whole in the later chunk. `end` is needed because an
 * invalid byte decodes to U+FFFD and `text` cannot tell its length.
 */
export const BoardCiLogItem = Schema.Union([
  Schema.TaggedStruct("chunk", {
    offset: NonNegativeInt,
    end: NonNegativeInt,
    text: Schema.String,
  }),
  Schema.TaggedStruct("end", { size: NonNegativeInt }),
  Schema.TaggedStruct("missing", { reason: TrimmedNonEmptyString }),
]);
export type BoardCiLogItem = typeof BoardCiLogItem.Type;

/** A CI step log read on the worker holding the card's worktree.
    The worker resolves `<worktreePath>/.t3/ci/<runId>/<index>.log` itself. */
export const BoardWorkerReadCiLogInput = Schema.Struct({
  worktreePath: TrimmedNonEmptyString,
  runId: TrimmedNonEmptyString,
  index: NonNegativeInt,
  fromOffset: Schema.optionalKey(NonNegativeInt),
  follow: Schema.Boolean,
});
export type BoardWorkerReadCiLogInput = typeof BoardWorkerReadCiLogInput.Type;

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
  /** Run a card's CI steps in its worktree, streaming progress. */
  runCi: "boardWorker.gateway.runCi",
  /** Read, and optionally follow, one CI step's log. */
  readCiLog: "boardWorker.gateway.readCiLog",
  /** What the worker offers this board, then each meaningful change (T3O-86). */
  subscribeCapacity: "boardWorker.gateway.subscribeCapacity",
  /** Run a card's setup in its new worktree, streaming its four stages (T3O-86). */
  runSetup: "boardWorker.gateway.runSetup",
} as const;

const M = BOARD_WORKER_GATEWAY_WS_METHODS;
const failure = Schema.Union([BoardWorkerGatewayError, EnvironmentAuthorizationError]);

export const BOARD_WORKER_GATEWAY_RPCS = [
  Rpc.make(M.call, { payload: BoardGatewayCall, success: Schema.Unknown, error: failure }),
  Rpc.make(M.subscribeSignals, {
    /** Null starts at the log's head: only what happens from now on. */
    payload: Schema.Struct({
      afterSequence: Schema.NullOr(NonNegativeInt),
      /** Include `usage-recorded` signals. An older central never sends it, and an
          older worker ignores it and sends none. */
      withUsage: Schema.optionalKey(Schema.Boolean),
    }),
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
  Rpc.make(M.runCi, {
    payload: BoardWorkerRunCiInput,
    success: BoardWorkerCiProgress,
    error: failure,
    stream: true,
  }),
  Rpc.make(M.readCiLog, {
    payload: BoardWorkerReadCiLogInput,
    success: BoardCiLogItem,
    error: failure,
    stream: true,
  }),
  Rpc.make(M.runSetup, {
    payload: BoardWorkerRunSetupInput,
    success: BoardCardSetupProgress,
    error: failure,
    stream: true,
  }),
  Rpc.make(M.subscribeCapacity, {
    payload: Schema.Struct({}),
    success: BoardWorkerCapacitySnapshot,
    error: failure,
    stream: true,
  }),
] as const;

/** Thread reads stream at the thread-shell tier. Calls start, steer and read
    threads, so they sit at the operate tier with the relay and staging —
    scopes the board's own session already holds. */
export const BOARD_WORKER_GATEWAY_RPC_SCOPES = {
  [M.call]: AuthOrchestrationOperateScope,
  [M.subscribeSignals]: AuthOrchestrationReadScope,
  [M.readTodoLog]: AuthOrchestrationReadScope,
  [M.subscribeTodoLog]: AuthOrchestrationReadScope,
  // Answering a relayed call writes to the board on the agent's behalf.
  [M.subscribeMcpRelay]: AuthOrchestrationOperateScope,
  [M.mcpRelayRespond]: AuthOrchestrationOperateScope,
  [M.stageAttachments]: AuthOrchestrationOperateScope,
  // Runs the project's own commands in a worktree, like a build agent would.
  [M.runCi]: AuthOrchestrationOperateScope,
  // Reads a step's output, like the card's own CI log viewer does.
  [M.readCiLog]: AuthOrchestrationReadScope,
  // What the worker offers the board: a read of the worker's load.
  [M.subscribeCapacity]: AuthOrchestrationReadScope,
  // Runs the project's own setup script in a worktree, like a build agent would.
  [M.runSetup]: AuthOrchestrationOperateScope,
} as const;

/** How long a worker waits for the central server to answer a relayed call
    before telling the agent the board is unreachable. */
export const BOARD_MCP_RELAY_TIMEOUT_MS = 60_000;
