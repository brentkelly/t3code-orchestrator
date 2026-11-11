/**
 * The board's one seam onto threads and projects, in board vocabulary. Its
 * implementation is the only board module allowed to import upstream's
 * orchestration, persistence or provider code (`threadGatewayBoundary.test.ts`);
 * a new engine re-runs `ThreadGatewayV2.contract.test.ts`.
 */
import type {
  ChatAttachment,
  CommandId,
  EnvironmentId,
  ModelSelection,
  ProjectId,
  ProjectScript,
  ProviderInteractionMode,
  RepositoryIdentity,
  RuntimeMode,
  ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import type * as Stream from "effect/Stream";

// ── Errors ─────────────────────────────────────────────────────────────

/** The thread engine said no: the command does not apply to the thread as it
    stands — it does not exist, is busy, or already moved on. An expected
    answer for a speculative command, unlike `ThreadCommandFailedError`. */
export class ThreadCommandRefusedError extends Schema.TaggedError<ThreadCommandRefusedError>()(
  "ThreadCommandRefusedError",
  {
    command: Schema.String,
    threadId: Schema.String,
    detail: Schema.String,
  },
) {
  override get message(): string {
    return `Thread command '${this.command}' refused for ${this.threadId}: ${this.detail}`;
  }
}

/** A thread command failed for any reason other than a refusal — storage,
    a defect, a provider. */
export class ThreadCommandFailedError extends Schema.TaggedError<ThreadCommandFailedError>()(
  "ThreadCommandFailedError",
  {
    command: Schema.String,
    threadId: Schema.String,
    detail: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `Thread command '${this.command}' failed for ${this.threadId}: ${this.detail}`;
  }
}

export type ThreadCommandError = ThreadCommandRefusedError | ThreadCommandFailedError;

/** A thread or project read failed. */
export class ThreadReadError extends Schema.TaggedError<ThreadReadError>()("ThreadReadError", {
  operation: Schema.String,
  detail: Schema.String,
  cause: Schema.optional(Schema.Defect()),
}) {
  override get message(): string {
    return `Thread read '${this.operation}' failed: ${this.detail}`;
  }
}

// ── Reads ──────────────────────────────────────────────────────────────

/** How a provider session stands, as far as the board cares. */
export type BoardSessionStatus = "starting" | "running" | "idle" | "stopped" | "error" | "none";

/**
 * One thread as the supervisor decides on it. Read point-in-time; nothing here
 * is cached by the gateway.
 */
export interface BoardThreadState {
  readonly threadId: ThreadId;
  readonly projectId: ProjectId;
  readonly deleted: boolean;
  readonly archived: boolean;
  /** A settle decision is on record — settled, or a human un-settled it. */
  readonly settlementDecided: boolean;
  readonly sessionStatus: BoardSessionStatus;
  /** The live turn, or null. May still name a turn that just ended until the
      engine catches up — compare by identity, never by presence alone. */
  readonly activeTurnRef: string | null;
  /** A structured question is waiting on a human. */
  readonly awaitingUserInput: boolean;
  /** A permission prompt someone can still answer. */
  readonly awaitingPermission: boolean;
  /** Work the agent left running after its turn ended. */
  readonly backgroundWork: "working" | "monitoring" | null;
  /** An active turn, or a pending question nobody's session has killed:
      the supervisor's "still doing live work". */
  readonly alive: boolean;
  /** Between turns, needs no human, background work running. */
  readonly waitingOnBackground: boolean;
  /** The engine's own "can this be settled automatically" policy, evaluated
      now. */
  readonly autoSettleCandidate: boolean;
  readonly worktreePath: string | null;
  readonly modelSelection: ModelSelection | null;
  /** The latest run failed on a provider usage limit, or null. */
  readonly usageLimit: BoardThreadUsageLimit | null;
}

/** A thread whose latest run hit a provider usage limit. */
export interface BoardThreadUsageLimit {
  /** When the provider says the window reopens, or null when it did not say. */
  readonly resetAt: string | null;
  /** The provider's own failure text, when it gave one. */
  readonly message: string | null;
  /** The engine itself will resume this thread when the window reopens: its
      limit recovery is armed, with auto-resume, for this very failure. A step
      on such a thread is not dead and the board does not resume it. */
  readonly resumeArmed: boolean;
}

/** What `threadState` answers for a deleted thread: nothing about it is live
    any more, so every live fact reads as its resting value. */
export const deletedThreadState = (threadId: ThreadId, projectId: ProjectId): BoardThreadState => ({
  threadId,
  projectId,
  deleted: true,
  archived: false,
  settlementDecided: false,
  sessionStatus: "none",
  activeTurnRef: null,
  awaitingUserInput: false,
  awaitingPermission: false,
  backgroundWork: null,
  alive: false,
  waitingOnBackground: false,
  autoSettleCandidate: false,
  worktreePath: null,
  modelSelection: null,
  usageLimit: null,
});

/**
 * What `threadState` answers for a thread on a worker the board cannot reach
 * right now: neither alive nor dead. Never read as a thread that is
 * gone — a worker the board merely cannot see may well still be running it.
 */
export const UNKNOWN_THREAD_STATE = "unknown" as const;
export type UnknownThreadState = typeof UNKNOWN_THREAD_STATE;

/** The cheap per-thread facts the release sweep pre-filters on. */
export interface BoardThreadRecord {
  readonly threadId: ThreadId;
  readonly deleted: boolean;
  readonly archived: boolean;
  readonly settlementDecided: boolean;
}

/** A thread whose cwd is a given worktree — what retiring the worktree stops. */
export interface BoardWorktreeThread {
  readonly threadId: ThreadId;
  readonly deleted: boolean;
  /** A provider session that is not stopped. */
  readonly sessionLive: boolean;
}

export interface BoardProject {
  readonly id: ProjectId;
  readonly title: string;
  readonly workspaceRoot: string;
  readonly deleted: boolean;
  readonly scripts: ReadonlyArray<ProjectScript>;
}

/** A project with its repository identity — what a pull request is
    addressed by. */
export interface BoardProjectDetail extends BoardProject {
  readonly repositoryIdentity: RepositoryIdentity | null;
}

/** The newest assistant message on a thread. */
export interface BoardAssistantMessage {
  readonly text: string;
  readonly createdAt: string;
}

// ── Signals ────────────────────────────────────────────────────────────

export interface BoardTodoItem {
  readonly step: string;
  readonly status: string;
}

/**
 * What the board hears from threads. `byBoard` follows the board's origin rule
 * (`server:board-…` command ids): false is a human. `limit-resumed` is the
 * engine's usage-limit recovery, neither a human nor the board.
 */
export type ThreadSignal =
  | {
      readonly type: "turn-ended";
      readonly threadId: ThreadId;
      readonly turnRef: string | undefined;
    }
  | { readonly type: "turn-start-failed"; readonly threadId: ThreadId; readonly detail: string }
  | {
      readonly type: "turn-requested";
      readonly threadId: ThreadId;
      readonly byBoard: boolean;
      readonly at: string;
    }
  | { readonly type: "limit-resumed"; readonly threadId: ThreadId }
  | { readonly type: "interrupt-requested"; readonly threadId: ThreadId }
  | { readonly type: "approval-responded"; readonly threadId: ThreadId }
  | { readonly type: "input-requested"; readonly threadId: ThreadId }
  | {
      readonly type: "input-resolved";
      readonly threadId: ThreadId;
      readonly answered: boolean;
      readonly byBoard?: boolean;
    }
  | { readonly type: "session-started"; readonly threadId: ThreadId }
  | {
      readonly type: "todos-changed";
      readonly threadId: ThreadId;
      readonly todos: ReadonlyArray<BoardTodoItem>;
      readonly at: string;
    }
  | { readonly type: "thread-deleted"; readonly threadId: ThreadId };

export type TodoSignal = Extract<ThreadSignal, { type: "todos-changed" | "thread-deleted" }>;

/**
 * One position in the thread engine's durable log, with the todo signal it
 * carries if any. Positions with no signal still advance a reader's cursor, so
 * a reader can tell "caught up" from "nothing relevant happened".
 */
export interface TodoLogEntry {
  readonly cursor: number;
  readonly signal: TodoSignal | null;
}

// ── Commands ───────────────────────────────────────────────────────────

/** Every command takes a board-minted id (`server:board-<tag>:<uuid>`), so its
    effects can be told apart from a human's. */
export interface ThreadSpawnInput {
  readonly commandId: CommandId;
  readonly threadId: ThreadId;
  readonly projectId: ProjectId;
  readonly title: string;
  readonly modelSelection: ModelSelection;
  readonly runtimeMode: RuntimeMode;
  readonly interactionMode: ProviderInteractionMode;
  /** Null runs the thread in the project root with no worktree of its own
      (planning); otherwise the thread runs in `worktreePath` on it. */
  readonly branch: string | null;
  readonly worktreePath: string;
  readonly text: string;
  readonly attachments: ReadonlyArray<ChatAttachment>;
  /** The worker to spawn on; absent means this server. */
  readonly workerId?: EnvironmentId;
  /** A card's brief files to copy onto that worker before the thread starts,
      by name and path on this server. Ignored for a local spawn, whose
      thread reads them in place. */
  readonly stageAttachments?: {
    readonly cardId: string;
    readonly files: ReadonlyArray<{ readonly name: string; readonly path: string }>;
  };
}

export interface ThreadSendInput {
  readonly commandId: CommandId;
  readonly threadId: ThreadId;
  readonly text: string;
  readonly attachments: ReadonlyArray<ChatAttachment>;
  readonly runtimeMode: RuntimeMode;
  readonly interactionMode: ProviderInteractionMode;
  /** `steer` joins the thread's running turn, falling back to a queued turn when the provider
      can't take it; absent or `queue` waits for the running turn to end. */
  readonly delivery?: "queue" | "steer";
}

export interface ThreadTargetInput {
  readonly commandId: CommandId;
  readonly threadId: ThreadId;
}

export interface ThreadAnswerInput extends ThreadTargetInput {
  readonly text: string;
}

export interface ThreadSettleInput extends ThreadTargetInput {
  /** The automatic settle: re-checks `autoSettleCandidate` itself and refuses
      a thread that is not one, or that changed between that check and the
      settle, so a repeating sweep stays quiet and never settles stale state. */
  readonly auto: boolean;
}

// ── The service ────────────────────────────────────────────────────────

export interface ThreadGatewayShape {
  /** Create a thread and start its first turn. A thread whose first turn is
      refused is deleted again, so a failed spawn leaves nothing behind. */
  readonly spawn: (input: ThreadSpawnInput) => Effect.Effect<void, ThreadCommandError>;
  /** Start a turn on an existing thread. */
  readonly send: (input: ThreadSendInput) => Effect.Effect<void, ThreadCommandError>;
  readonly interrupt: (input: ThreadTargetInput) => Effect.Effect<void, ThreadCommandError>;
  readonly stopSession: (input: ThreadTargetInput) => Effect.Effect<void, ThreadCommandError>;
  readonly settle: (input: ThreadSettleInput) => Effect.Effect<void, ThreadCommandError>;
  readonly delete: (input: ThreadTargetInput) => Effect.Effect<void, ThreadCommandError>;
  /** Have the engine resume this thread itself once its usage-limit window
      reopens, whatever the user's global auto-resume setting. True
      when recovery is armed with auto-resume afterwards; false when the
      thread is not limited, or the provider named no reset time to wait for. */
  readonly armLimitRecovery: (
    input: ThreadTargetInput,
  ) => Effect.Effect<boolean, ThreadCommandError>;
  /** Answer every question of the thread's pending structured user-input
      request with `text`. False when nothing is pending, or the
      provider cannot take the answer — the caller then sends a turn instead. */
  readonly answerPendingInput: (
    input: ThreadAnswerInput,
  ) => Effect.Effect<boolean, ThreadCommandError>;

  /** One thread, deleted ones included, or null when it never existed —
      or `unknown` while the worker it lives on cannot be reached. */
  readonly threadState: (
    threadId: ThreadId,
  ) => Effect.Effect<BoardThreadState | UnknownThreadState | null, ThreadReadError>;
  /** The cheap facts for many threads at once; absent ids never existed. */
  readonly threadRecords: (
    threadIds: ReadonlyArray<ThreadId>,
  ) => Effect.Effect<ReadonlyMap<ThreadId, BoardThreadRecord>, ThreadReadError>;
  /** Threads whose cwd is this worktree. */
  readonly threadsInWorktree: (
    worktreePath: string,
  ) => Effect.Effect<ReadonlyArray<BoardWorktreeThread>, ThreadReadError>;
  /** Every thread that is not deleted — the todo cache's orphan sweep. */
  readonly listLiveThreadIds: () => Effect.Effect<ReadonlyArray<ThreadId>, ThreadReadError>;
  /** The newest assistant message of the thread's latest turn, or null. */
  readonly latestAssistantMessage: (
    threadId: ThreadId,
  ) => Effect.Effect<BoardAssistantMessage | null, ThreadReadError>;
  /** When the thread last produced output — message or activity. */
  readonly lastSignalAt: (threadId: ThreadId) => Effect.Effect<string | null, ThreadReadError>;
  /** When a turn that has been requested but not started was asked for. */
  readonly pendingTurnStartAt: (
    threadId: ThreadId,
  ) => Effect.Effect<string | null, ThreadReadError>;

  /** Every project, deleted ones included. */
  readonly projects: () => Effect.Effect<ReadonlyArray<BoardProject>, ThreadReadError>;
  readonly project: (
    projectId: ProjectId,
  ) => Effect.Effect<BoardProjectDetail | null, ThreadReadError>;

  /** Live signals for the supervisor. Each access is its own subscription. */
  readonly observe: Stream.Stream<ThreadSignal>;

  /** The durable todo signals, for the board's todo cache, which keeps its
      own cursor. `todoLogHead` is the newest position; `readTodoLog` replays
      `(after, upTo]`; `subscribeTodoLog` attaches a live tail when it returns,
      so subscribe-then-read-head loses nothing. */
  readonly todoLogHead: Effect.Effect<number>;
  readonly readTodoLog: (
    after: number,
    upTo: number,
  ) => Stream.Stream<TodoLogEntry, ThreadReadError>;
  readonly subscribeTodoLog: Effect.Effect<Stream.Stream<TodoLogEntry>, never, Scope.Scope>;
}

export class ThreadGateway extends Context.Service<ThreadGateway, ThreadGatewayShape>()(
  "t3/board/ThreadGateway",
) {}

// ── This server's own threads ─────────────────────────────────

/** The signals one position of the thread log produced, in order. */
export interface ThreadSignalBatch {
  readonly sequence: number;
  readonly signals: ReadonlyArray<ThreadSignal>;
}

/**
 * The gateway onto THIS server's threads. On a central server `ThreadGateway`
 * is a router over this one and every worker's; a worker serves this
 * one to the central server, never the router, so it only ever hands out its
 * own threads.
 */
export interface LocalThreadGatewayShape extends ThreadGatewayShape {
  /** This server's threads are always reachable, so never `unknown`. */
  readonly threadState: (
    threadId: ThreadId,
  ) => Effect.Effect<BoardThreadState | null, ThreadReadError>;
  /** Signals by log position, after `afterSequence` (from now on when null),
      for as long as the subscriber runs — what a central server resumes a
      worker's signals from after a dropped connection. Positions that produce
      no signal are skipped. */
  readonly signalLog: (afterSequence: number | null) => Stream.Stream<ThreadSignalBatch>;
}

export class LocalThreadGateway extends Context.Service<
  LocalThreadGateway,
  LocalThreadGatewayShape
>()("t3/board/ThreadGateway/LocalThreadGateway") {}
