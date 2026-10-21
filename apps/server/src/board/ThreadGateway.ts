/**
 * The board's one seam onto threads (T3O-58).
 *
 * Everything the board does to or learns about a thread or a project goes
 * through this service: spawning and steering threads, reading the few facts
 * the supervisor decides on, and the signals it reacts to. It is shaped around
 * what the BOARD needs, in board vocabulary, not around the thread engine
 * behind it.
 *
 * `ThreadGatewayV2` (orchestration-v2, T3O-59) is the only implementation, and
 * the only board module allowed to import upstream's orchestration, persistence
 * or provider code (`threadGatewayBoundary.test.ts` holds that line). Swapping
 * the thread engine means writing another implementation and re-running
 * `ThreadGatewayV2.contract.test.ts` against it — not touching the supervisor.
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
  /** A permission prompt someone can still answer (T3O-16). */
  readonly awaitingPermission: boolean;
  /** Work the agent left running after its turn ended (T3O-20). */
  readonly backgroundWork: "working" | "monitoring" | null;
  /** An active turn, or a pending question nobody's session has killed
      (t3o-10, D1): the supervisor's "still doing live work". */
  readonly alive: boolean;
  /** Between turns, needs no human, background work running (T3O-20). */
  readonly waitingOnBackground: boolean;
  /** The engine's own "can this be settled automatically" policy, evaluated
      now (t3o-13). */
  readonly autoSettleCandidate: boolean;
  readonly worktreePath: string | null;
  readonly modelSelection: ModelSelection | null;
  /** The latest run failed on a provider usage limit (T3O-59), or null. */
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
 * right now (T3O-63): neither alive nor dead. Never read as a thread that is
 * gone — a worker the board merely cannot see may well still be running it
 * (D22).
 */
export const UNKNOWN_THREAD_STATE = "unknown" as const;
export type UnknownThreadState = typeof UNKNOWN_THREAD_STATE;

/** The cheap per-thread facts the release sweep pre-filters on (t3o-13). */
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

/** How a turn ended (T3O-22, D9). */
export type BoardTurnOutcome = "completed" | "failed" | "interrupted" | "cancelled";

export interface BoardTodoItem {
  readonly step: string;
  readonly status: string;
}

/**
 * What the board hears from threads. Every signal names its thread.
 *
 * - `turn-ended` — a turn finished, however it finished. `turnRef` is the
 *   ended turn's own id when the provider stamps one; `outcome` is absent when
 *   the provider did not say.
 * - `turn-start-failed` — a requested turn never started (t3o-30, D2).
 * - `turn-requested` — someone asked for a turn. `byBoard` is the board's own
 *   origin rule (`server:board-…` command ids): false is a human.
 * - `limit-resumed` — the engine's usage-limit recovery resumed the thread
 *   once its window reopened. Not a human, and not the board.
 * - `interrupt-requested` — someone pressed Stop.
 * - `approval-responded` — a human answered a permission prompt.
 * - `input-requested` / `input-resolved` — a structured question raised, and
 *   closed; `answered` separates an answer from a cancellation.
 * - `session-started` — a provider session came up.
 * - `todos-changed` — the agent's todo list was replaced.
 * - `thread-deleted` — the thread is gone for good.
 */
export type ThreadSignal =
  | {
      readonly type: "turn-ended";
      readonly threadId: ThreadId;
      readonly turnRef: string | undefined;
      readonly outcome: BoardTurnOutcome | undefined;
      readonly errorMessage: string | null;
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
  | { readonly type: "input-resolved"; readonly threadId: ThreadId; readonly answered: boolean }
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
      (planning, D6); otherwise the thread runs in `worktreePath` on it. */
  readonly branch: string | null;
  readonly worktreePath: string;
  readonly text: string;
  readonly attachments: ReadonlyArray<ChatAttachment>;
  /** The worker to spawn on (T3O-63); absent means this server. */
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
}

export interface ThreadTargetInput {
  readonly commandId: CommandId;
  readonly threadId: ThreadId;
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
      reopens, whatever the user's global auto-resume setting (T3O-59). True
      when recovery is armed with auto-resume afterwards; false when the
      thread is not limited, or the provider named no reset time to wait for. */
  readonly armLimitRecovery: (
    input: ThreadTargetInput,
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
  /** When the thread last produced output — message or activity (T3O-12). */
  readonly lastSignalAt: (threadId: ThreadId) => Effect.Effect<string | null, ThreadReadError>;
  /** When a turn that has been requested but not started was asked for
      (T3O-18). */
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

// ── This server's own threads (T3O-63) ─────────────────────────────────

/** The signals one position of the thread log produced, in order. */
export interface ThreadSignalBatch {
  readonly sequence: number;
  readonly signals: ReadonlyArray<ThreadSignal>;
}

/**
 * The gateway onto THIS server's threads. On a central server `ThreadGateway`
 * is a router over this one and every worker's (T3O-63); a worker serves this
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
