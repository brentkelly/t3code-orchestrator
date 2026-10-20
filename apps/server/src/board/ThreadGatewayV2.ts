/**
 * The thread gateway over orchestration-v2 (T3O-59).
 *
 * Every call the board makes into upstream's thread engine, in board
 * vocabulary. This is the ONLY board module that may import upstream
 * orchestration, persistence or provider code (`threadGatewayBoundary.test.ts`);
 * everything v2-shaped the board touches lives here.
 *
 * Commands go through `ThreadManagementService.dispatch`, upstream's own
 * enablement chokepoint. Signals and the todo log read the engine's stored
 * event log (`EventSinkV2`), unbounded: the supervisor must never have its
 * subscription dropped under load the way a bounded RPC subscriber may.
 */
import {
  type ChatAttachment,
  CommandId,
  deriveBoardCardThreadState,
  isBoardMintedCommandId,
  isThreadAwaitingPermission,
  MessageId,
  type OrchestrationV2Command,
  type OrchestrationV2InternalCommand,
  type OrchestrationV2Run,
  type OrchestrationV2StoredEvent,
  type OrchestrationV2ThreadShell,
  type ThreadId,
} from "@t3tools/contracts";
import { boardThreadStateSource } from "@t3tools/shared/boardThreadState";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Stream from "effect/Stream";

import * as EventSink from "../orchestration-v2/EventSink.ts";
import type * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import { isAutoSettlementCandidate } from "../orchestration-v2/ThreadSettlementService.ts";
import * as ProjectService from "../project/ProjectService.ts";
import {
  ThreadCommandFailedError,
  ThreadCommandRefusedError,
  deletedThreadState,
  ThreadGateway,
  ThreadReadError,
  type BoardSessionStatus,
  type BoardThreadRecord,
  type BoardThreadState,
  type BoardTodoItem,
  type BoardTurnOutcome,
  type ThreadGatewayShape,
  type ThreadSignal,
  type TodoLogEntry,
  type TodoSignal,
} from "./ThreadGateway.ts";

type ServerCommand = OrchestrationV2Command | OrchestrationV2InternalCommand;
type DispatchError =
  | Orchestrator.OrchestratorV2Error
  | ThreadManagement.ThreadManagementProviderInstanceDisabledError;

/** The message the board's own turns carry as their author. The board stands
    in for the human who set the card up, exactly as v2's own usage-limit
    resume does (`limit-resume:`), so the transcript reads as a user prompt. */
const BOARD_AUTHOR = { createdBy: "user", creationSource: "server" } as const;

// ── Thread state ───────────────────────────────────────────────────────

/** v2 has no per-thread session status; the live run's activity stands in. */
const sessionStatusOf = (shell: OrchestrationV2ThreadShell): BoardSessionStatus => {
  switch (shell.activityRunStatus) {
    case "preparing":
    case "starting":
      return "starting";
    case "running":
      return "running";
    default:
      break;
  }
  if (shell.status === "failed") return "error";
  if (shell.latestRunId === null && shell.activeProviderThreadId === null) return "none";
  return "idle";
};

const isoOrNull = (value: DateTime.Utc | null | undefined): string | null =>
  value == null ? null : DateTime.formatIso(value);

export const boardThreadStateFromShell = (
  shell: OrchestrationV2ThreadShell,
  nowMs: number,
): BoardThreadState => {
  const source = boardThreadStateSource(shell);
  const usageLimited = shell.status === "failed" && shell.lastErrorClass === "usage_limit";
  const resetAt = shell.usageLimitResetAt ?? null;
  const recovery = shell.limitRecovery ?? null;
  return {
    threadId: shell.id,
    projectId: shell.projectId,
    deleted: shell.deletedAt !== null,
    archived: shell.archivedAt !== null,
    settlementDecided: shell.settledOverride !== null,
    sessionStatus: sessionStatusOf(shell),
    // `activeRunId` covers preparing, starting and running; a run in `waiting`
    // has finished its provider turn and only awaits its checkpoint.
    activeTurnRef: shell.activeRunId,
    awaitingUserInput: source.hasPendingUserInput,
    awaitingPermission: isThreadAwaitingPermission(source),
    backgroundWork: source.backgroundLiveness ?? null,
    // An active run, or a question someone can still answer (t3o-10, D1). A
    // failed latest run is dead whatever else the shell still says.
    alive: shell.status !== "failed" && (shell.activeRunId !== null || source.hasPendingUserInput),
    waitingOnBackground: deriveBoardCardThreadState(source).waitingOnBackground,
    autoSettleCandidate: isAutoSettlementCandidate(shell, nowMs),
    worktreePath: shell.worktreePath,
    modelSelection: shell.modelSelection,
    usageLimit: usageLimited
      ? {
          resetAt,
          message: shell.lastError ?? null,
          resumeArmed:
            recovery !== null &&
            recovery.autoResume &&
            recovery.runId === shell.latestRunId &&
            recovery.resetAt === resetAt,
        }
      : null,
  };
};

// ── Signals ────────────────────────────────────────────────────────────

const turnOutcomeOf = (status: OrchestrationV2Run["status"]): BoardTurnOutcome | null => {
  switch (status) {
    // A provider turn that finished persists as `waiting` until its checkpoint
    // lands, then `completed`; the board's turn ended at the first of the two.
    case "waiting":
    case "completed":
      return "completed";
    case "failed":
      return "failed";
    case "interrupted":
      return "interrupted";
    case "cancelled":
    case "rolled_back":
      return "cancelled";
    default:
      return null;
  }
};

/** v2's plan step statuses in the board's todo vocabulary (v1's names). */
const todoStatusOf = (status: string): string =>
  status === "running" ? "inProgress" : status;

/** The todo signal one stored event carries, if any. */
export const todoSignal = (stored: OrchestrationV2StoredEvent): TodoSignal | null => {
  const event = stored.event;
  if (event.type === "plan.updated" && event.payload.kind === "todo_list") {
    const todos: ReadonlyArray<BoardTodoItem> = event.payload.steps.map((step) => ({
      step: step.text,
      status: todoStatusOf(step.status),
    }));
    return {
      type: "todos-changed",
      threadId: event.threadId,
      todos,
      at: DateTime.formatIso(event.occurredAt),
    };
  }
  if (event.type === "thread.deleted") {
    return { type: "thread-deleted", threadId: event.threadId };
  }
  return null;
};

/**
 * Turns one stored event into the supervisor's signals. Stateful only to
 * report each run end, interrupt request and question ONCE: v2 rewrites a run,
 * a turn item or a runtime request in place, so the same fact arrives as
 * several `*.updated` events. The memory is bounded; anything older than it has
 * long since been acted on.
 */
export const makeSignalReader = () => {
  const seen = new Set<string>();
  const SEEN_LIMIT = 4096;
  const firstTime = (key: string): boolean => {
    if (seen.has(key)) return false;
    seen.add(key);
    if (seen.size > SEEN_LIMIT) {
      const oldest = seen.values().next().value;
      if (oldest !== undefined) seen.delete(oldest);
    }
    return true;
  };

  return (stored: OrchestrationV2StoredEvent): ThreadSignal | null => {
    const event = stored.event;
    switch (event.type) {
      case "run.created":
        // Every requested turn is a run. Its command says whose it was: a
        // board-minted id is the board's own; anything else is a human, or the
        // engine acting for one (a usage-limit resume).
        return {
          type: "turn-requested",
          threadId: event.threadId,
          byBoard: isBoardMintedCommandId(stored.commandId),
          at: DateTime.formatIso(event.payload.requestedAt),
        };
      case "run.updated": {
        const run = event.payload;
        const outcome = turnOutcomeOf(run.status);
        if (outcome === null || !firstTime(`run:${run.id}`)) return null;
        // A run that failed without ever starting is a turn that never began
        // (t3o-30, D2) — workspace preparation, or the provider refusing it.
        if (outcome === "failed" && run.startedAt === null) {
          return {
            type: "turn-start-failed",
            threadId: event.threadId,
            detail: "The turn failed before it started.",
          };
        }
        return {
          type: "turn-ended",
          threadId: event.threadId,
          turnRef: String(run.id),
          outcome,
          errorMessage: null,
        };
      }
      case "turn-item.updated":
        return event.payload.type === "run_interrupt_request" &&
          firstTime(`interrupt:${event.payload.id}`)
          ? { type: "interrupt-requested", threadId: event.threadId }
          : null;
      case "runtime-request.updated": {
        const request = event.payload;
        if (request.kind === "auth_refresh") return null;
        if (request.kind === "user_input") {
          if (request.status === "pending") {
            return firstTime(`input:${request.id}`)
              ? { type: "input-requested", threadId: event.threadId }
              : null;
          }
          // Only an ANSWER resumes a parked step (t3o-34, D5): a question that
          // was cancelled or expired is still unanswered.
          return firstTime(`input-closed:${request.id}`)
            ? {
                type: "input-resolved",
                threadId: event.threadId,
                answered:
                  request.status === "resolved" && Object.keys(request.answers ?? {}).length > 0,
              }
            : null;
        }
        return request.status === "resolved" && firstTime(`approval:${request.id}`)
          ? { type: "approval-responded", threadId: event.threadId }
          : null;
      }
      case "provider-session.attached":
        return { type: "session-started", threadId: event.threadId };
      default:
        return todoSignal(stored);
    }
  };
};

const toTodoLogEntry = (stored: OrchestrationV2StoredEvent): TodoLogEntry => ({
  cursor: stored.sequence,
  signal: todoSignal(stored),
});

// ── Errors ─────────────────────────────────────────────────────────────

const REFUSAL_TAGS = new Set<string>([
  "OrchestratorCommandRejectedError",
  "OrchestratorCommandPreviouslyRejectedError",
  "OrchestratorSubagentThreadReadOnlyError",
  "OrchestratorThreadAboveModeLimitError",
  "ThreadManagementProviderInstanceDisabledError",
]);

const describe = (error: unknown): string => {
  if (error !== null && typeof error === "object") {
    const record = error as { readonly detail?: unknown; readonly cause?: unknown };
    if (typeof record.detail === "string") return record.detail;
    if (record.cause instanceof Error) return record.cause.message;
  }
  return error instanceof Error ? error.message : String(error);
};

const commandError = (command: string, threadId: ThreadId) => (error: DispatchError) =>
  REFUSAL_TAGS.has(error._tag)
    ? new ThreadCommandRefusedError({ command, threadId, detail: describe(error) })
    : new ThreadCommandFailedError({ command, threadId, detail: describe(error), cause: error });

const readError = (operation: string) => (cause: unknown) =>
  new ThreadReadError({ operation, detail: describe(cause), cause });

// ── The gateway ────────────────────────────────────────────────────────

export const makeThreadGatewayV2 = Effect.gen(function* () {
  const threads = yield* ThreadManagement.ThreadManagementService;
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const projectRows = yield* ProjectStore.ProjectStoreV2;
  const projectService = yield* ProjectService.ProjectService;
  const eventSink = yield* EventSink.EventSinkV2;
  const crypto = yield* Crypto.Crypto;
  const path = yield* Path.Path;
  const nowMs = Effect.map(DateTime.now, DateTime.toEpochMillis);
  const freshMessageId = crypto.randomUUIDv4().pipe(
    Effect.map((uuid) => MessageId.make(`msg-${uuid}`)),
    Effect.orDie,
  );

  const run = (command: ServerCommand & { readonly threadId: ThreadId }) =>
    threads
      .dispatch(command)
      .pipe(Effect.mapError(commandError(command.type, command.threadId)), Effect.asVoid);

  const refused = (command: string, threadId: ThreadId, detail: string) =>
    new ThreadCommandRefusedError({ command, threadId, detail });

  const shellOf = (threadId: ThreadId) =>
    projections.getThreadShell(threadId).pipe(Effect.mapError(readError("threadShell")));

  /** A thread the command needs to exist, live. */
  const liveShell = (command: string, threadId: ThreadId) =>
    Effect.flatMap(shellOf(threadId), (shell) =>
      shell === null || shell.deletedAt !== null
        ? Effect.fail(refused(command, threadId, `thread ${threadId} does not exist`))
        : Effect.succeed(shell),
    ).pipe(
      Effect.catchTag("ThreadReadError", (error) =>
        Effect.fail(
          new ThreadCommandFailedError({
            command,
            threadId,
            detail: error.detail,
            cause: error,
          }),
        ),
      ),
    );

  /** A deleted thread drops out of the shell read; its row still says it existed. */
  const deletedRecord = (threadId: ThreadId) =>
    projections.getThread(threadId).pipe(
      Effect.map((thread) => (thread.deletedAt === null ? null : thread)),
      Effect.orElseSucceed(() => null),
    );

  const startTurn = (input: {
    readonly commandId: CommandId;
    readonly threadId: ThreadId;
    readonly text: string;
    readonly attachments: ReadonlyArray<ChatAttachment>;
  }) =>
    Effect.gen(function* () {
      yield* run({
        type: "message.dispatch",
        commandId: input.commandId,
        threadId: input.threadId,
        messageId: yield* freshMessageId,
        text: input.text,
        attachments: input.attachments,
        dispatchMode: { type: "start_immediately" },
        ...BOARD_AUTHOR,
      });
    });

  const gateway: ThreadGatewayShape = {
    // Upstream's `ThreadLaunchService.launch` is NOT used: its preparation runs
    // the project's setup script on every launch, including into an existing
    // worktree or the project root, so every review phase would re-run it and
    // planning would run it in the main checkout. The board provisions its own
    // worktrees and runs setup once (t3o-09); a spawn is `launch` minus
    // preparation — create, then start the first turn.
    spawn: (input) =>
      Effect.gen(function* () {
        const inWorktree = input.branch !== null;
        yield* run({
          type: "thread.create",
          commandId: input.commandId,
          threadId: input.threadId,
          projectId: input.projectId,
          title: input.title,
          modelSelection: input.modelSelection,
          runtimeMode: input.runtimeMode,
          interactionMode: input.interactionMode,
          branch: inWorktree ? input.branch : null,
          worktreePath: inWorktree ? input.worktreePath : null,
          ...BOARD_AUTHOR,
        });
        yield* startTurn({
          commandId: CommandId.make(`${input.commandId}:turn`),
          threadId: input.threadId,
          text: input.text,
          attachments: input.attachments,
        }).pipe(
          // A thread whose first turn never started is deleted again rather
          // than left empty in the sidebar.
          Effect.tapError(() =>
            run({
              type: "thread.delete",
              commandId: CommandId.make(`${input.commandId}:cleanup`),
              threadId: input.threadId,
            }).pipe(Effect.ignore),
          ),
        );
      }),
    send: (input) =>
      Effect.gen(function* () {
        const shell = yield* liveShell("message.dispatch", input.threadId);
        // Modes are thread settings in v2, not per-turn fields; a stage that
        // runs this turn differently sets them first.
        if (shell.runtimeMode !== input.runtimeMode) {
          yield* run({
            type: "thread.runtime-mode.set",
            commandId: CommandId.make(`${input.commandId}:runtime-mode`),
            threadId: input.threadId,
            runtimeMode: input.runtimeMode,
          });
        }
        if (shell.interactionMode !== input.interactionMode) {
          yield* run({
            type: "thread.interaction-mode.set",
            commandId: CommandId.make(`${input.commandId}:interaction-mode`),
            threadId: input.threadId,
            interactionMode: input.interactionMode,
          });
        }
        yield* startTurn(input);
      }),
    interrupt: (input) =>
      Effect.gen(function* () {
        const shell = yield* liveShell("run.interrupt", input.threadId);
        if (shell.activeRunId === null) {
          return yield* refused("run.interrupt", input.threadId, "no run is active");
        }
        yield* run({
          type: "run.interrupt",
          commandId: input.commandId,
          threadId: input.threadId,
          runId: shell.activeRunId,
        });
      }),
    stopSession: (input) =>
      run({ type: "thread.stop", commandId: input.commandId, threadId: input.threadId }),
    // The automatic settle re-reads candidacy itself and stamps the read time
    // as `snapshotAt`: the engine refuses the command when the thread changed
    // after it, so a thread that moved between the check and the dispatch is
    // never settled — the same guard upstream's own sweep relies on.
    settle: (input) =>
      input.auto
        ? Effect.gen(function* () {
            const snapshotAt = yield* DateTime.now;
            const shell = yield* liveShell("thread.auto-settle", input.threadId);
            if (!isAutoSettlementCandidate(shell, DateTime.toEpochMillis(snapshotAt))) {
              return yield* refused(
                "thread.auto-settle",
                input.threadId,
                `thread ${input.threadId} is not a candidate for automatic settlement`,
              );
            }
            yield* run({
              type: "thread.auto-settle",
              commandId: input.commandId,
              threadId: input.threadId,
              snapshotAt,
            });
          })
        : Effect.gen(function* () {
            const shell = yield* liveShell("thread.settle", input.threadId);
            // A thread still running its turn cannot be settled under it.
            if (shell.activeRunId !== null || shell.status === "queued") {
              return yield* refused("thread.settle", input.threadId, "the thread is still running");
            }
            yield* run({ type: "thread.settle", commandId: input.commandId, threadId: input.threadId });
          }),
    delete: (input) =>
      run({ type: "thread.delete", commandId: input.commandId, threadId: input.threadId }),
    armLimitRecovery: (input) =>
      Effect.gen(function* () {
        const shell = yield* liveShell("thread.metadata.update", input.threadId);
        const state = boardThreadStateFromShell(shell, yield* nowMs);
        const limit = state.usageLimit;
        if (limit === null || limit.resetAt === null || shell.latestRunId === null) return false;
        if (limit.resumeArmed) return true;
        yield* run({
          type: "thread.metadata.update",
          commandId: input.commandId,
          threadId: input.threadId,
          limitRecovery: { runId: shell.latestRunId, resetAt: limit.resetAt, autoResume: true },
        });
        return true;
      }),

    threadState: (threadId) =>
      Effect.gen(function* () {
        const shell = yield* shellOf(threadId);
        if (shell !== null && shell.deletedAt === null) {
          return boardThreadStateFromShell(shell, yield* nowMs);
        }
        const deleted = shell ?? (yield* deletedRecord(threadId));
        return deleted === null ? null : deletedThreadState(threadId, deleted.projectId);
      }).pipe(Effect.mapError(readError("threadState"))),
    threadRecords: (threadIds) =>
      Effect.gen(function* () {
        const records = new Map<ThreadId, BoardThreadRecord>();
        for (const threadId of threadIds) {
          const shell = yield* shellOf(threadId);
          if (shell !== null) {
            records.set(threadId, {
              threadId,
              deleted: shell.deletedAt !== null,
              archived: shell.archivedAt !== null,
              settlementDecided: shell.settledOverride !== null,
            });
            continue;
          }
          if ((yield* deletedRecord(threadId)) !== null) {
            records.set(threadId, {
              threadId,
              deleted: true,
              archived: false,
              settlementDecided: false,
            });
          }
        }
        return records as ReadonlyMap<ThreadId, BoardThreadRecord>;
      }).pipe(Effect.mapError(readError("threadRecords"))),
    threadsInWorktree: (worktreePath) =>
      Effect.gen(function* () {
        const resolved = path.resolve(worktreePath);
        const rows = yield* projections.getThreadWorktreePaths();
        const matching = rows.filter((row) => path.resolve(row.worktreePath) === resolved);
        return yield* Effect.forEach(matching, (row) =>
          Effect.map(projections.getThreadShell(row.threadId), (shell) => ({
            threadId: row.threadId,
            deleted: shell === null || shell.deletedAt !== null,
            // v2 attaches a provider session per run; a thread with a live run
            // or a provider thread bound may still hold one.
            sessionLive:
              shell !== null &&
              (shell.activityRunStatus != null || shell.activeProviderThreadId !== null),
          })),
        );
      }).pipe(Effect.mapError(readError("threadsInWorktree"))),
    listLiveThreadIds: () =>
      projections.getShellSnapshot({}).pipe(
        Effect.flatMap((active) =>
          Effect.map(projections.getShellSnapshot({ location: "archive" }), (archive) => [
            ...active.threads.map((thread) => thread.id),
            ...archive.archivedThreads.map((thread) => thread.id),
          ]),
        ),
        Effect.mapError(readError("listLiveThreadIds")),
      ),
    latestAssistantMessage: (threadId) =>
      Effect.gen(function* () {
        const shell = yield* shellOf(threadId);
        const latest = shell?.latestVisibleMessage;
        if (latest != null && latest.role === "assistant") {
          return { text: latest.text, createdAt: DateTime.formatIso(latest.updatedAt) };
        }
        const records = yield* projections.getThreadRecords(threadId, ["messages"], {
          messageRoles: ["assistant"],
        });
        const newest = records.messages.at(-1);
        return newest === undefined
          ? null
          : { text: newest.text, createdAt: DateTime.formatIso(newest.createdAt) };
      }).pipe(Effect.mapError(readError("latestAssistantMessage"))),
    // The timeout sweep's life sign: the thread's own update time moves with
    // every message, turn item and run change the engine records.
    lastSignalAt: (threadId) =>
      shellOf(threadId).pipe(Effect.map((shell) => isoOrNull(shell?.updatedAt))),
    // A turn requested but not yet running: still preparing or queued.
    pendingTurnStartAt: (threadId) =>
      shellOf(threadId).pipe(
        Effect.map((shell) =>
          shell !== null &&
          (shell.status === "preparing" || shell.status === "queued") &&
          shell.activeRunId === null
            ? isoOrNull(shell.latestRunRequestedAt)
            : shell !== null && shell.activityRunStatus === "preparing"
              ? isoOrNull(shell.latestRunRequestedAt)
              : null,
        ),
      ),

    projects: () =>
      projectRows.list({ includeDeleted: true }).pipe(
        Effect.map((rows) =>
          rows.map((row) => ({
            id: row.projectId,
            title: row.title,
            workspaceRoot: row.workspaceRoot,
            deleted: row.deletedAt !== null,
            scripts: row.scripts,
          })),
        ),
        Effect.mapError(readError("projects")),
      ),
    project: (projectId) =>
      projectService.getById(projectId).pipe(
        Effect.map(
          Option.match({
            onNone: () => null,
            onSome: (project) => ({
              id: project.id,
              title: project.title,
              workspaceRoot: project.workspaceRoot,
              deleted: project.deletedAt !== null,
              scripts: project.scripts,
              repositoryIdentity: project.repositoryIdentity ?? null,
            }),
          }),
        ),
        Effect.mapError(readError("project")),
      ),

    observe: Stream.unwrap(
      Effect.map(eventSink.latestSequence(), (head) => {
        const read = makeSignalReader();
        return eventSink.stream({ afterSequence: head }).pipe(
          Stream.map(read),
          Stream.filter((signal): signal is ThreadSignal => signal !== null),
        );
      }),
    ).pipe(
      Stream.catchCause((cause) =>
        Stream.fromEffectDrain(Effect.logError("board thread gateway: signal stream ended", cause)),
      ),
    ),

    todoLogHead: eventSink.latestSequence().pipe(Effect.orElseSucceed(() => 0)),
    readTodoLog: (after, upTo) =>
      after >= upTo
        ? Stream.empty
        : eventSink.stream({ afterSequence: after }).pipe(
            Stream.takeUntil((stored) => stored.sequence >= upTo),
            Stream.filter((stored) => stored.sequence <= upTo),
            Stream.map(toTodoLogEntry),
            Stream.mapError(readError("readTodoLog")),
          ),
    subscribeTodoLog: Effect.map(
      eventSink.latestSequence().pipe(Effect.orElseSucceed(() => 0)),
      (head) =>
        eventSink.stream({ afterSequence: head }).pipe(
          Stream.map(toTodoLogEntry),
          Stream.catchCause(() => Stream.empty),
        ),
    ),
  };
  return gateway;
});

export const ThreadGatewayV2Live = Layer.effect(ThreadGateway, makeThreadGatewayV2);
