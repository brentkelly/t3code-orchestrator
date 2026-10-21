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
  type OrchestrationV2ConversationMessage,
  type OrchestrationV2InternalCommand,
  type OrchestrationV2Run,
  type OrchestrationV2StoredEvent,
  type OrchestrationV2ThreadShell,
  type ThreadId,
} from "@t3tools/contracts";
import { boardThreadSessionStatus, boardThreadStateSource } from "@t3tools/shared/boardThreadState";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Duration from "effect/Duration";
import * as Path from "effect/Path";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";

import * as EventSink from "../orchestration-v2/EventSink.ts";
import type * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import { isAutoSettlementCandidate } from "../orchestration-v2/ThreadSettlementService.ts";
import { limitRecoveryCommand } from "../orchestration-v2/UsageLimitRecoveryWorker.ts";
import * as ProjectService from "../project/ProjectService.ts";
import {
  ThreadCommandFailedError,
  ThreadCommandRefusedError,
  deletedThreadState,
  LocalThreadGateway,
  ThreadGateway,
  type LocalThreadGatewayShape,
  ThreadReadError,
  type BoardSessionStatus,
  type BoardThreadRecord,
  type BoardThreadState,
  type BoardTodoItem,
  type BoardTurnOutcome,
  type ThreadGatewayShape,
  type ThreadSignal,
  type ThreadSignalBatch,
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

/** The shared adapter's session status, in the gateway's vocabulary. */
const sessionStatusOf = (shell: OrchestrationV2ThreadShell): BoardSessionStatus => {
  const status = boardThreadSessionStatus(shell);
  if (status === null) return "none";
  return status === "ready" ? "idle" : status;
};

const isoOrNull = (value: DateTime.Utc | null | undefined): string | null =>
  value == null ? null : DateTime.formatIso(value);

/**
 * Whether v2's recovery worker will ever act on this thread's usage limit with
 * auto-resume on — arm it, or resume an arm — read through the worker's own
 * policy. Asked as of the end of time, so a window that has not reopened yet
 * still counts. An archived or settled thread, one holding a question, or a
 * reset no later than the failure is never resumed by v2, so the board keeps it.
 */
const v2RecoversLimit = (shell: OrchestrationV2ThreadShell): boolean =>
  limitRecoveryCommand(shell, true, Number.POSITIVE_INFINITY) !== null;

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
            recovery.resetAt === resetAt &&
            v2RecoversLimit(shell),
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
const todoStatusOf = (status: string): string => (status === "running" ? "inProgress" : status);

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

/** Command-id prefixes the server mints for commands no person issued: v2's
    own (`command:`, `provider-continuation:`, `limit-resume:`), and every
    `server:` reactor, the board's included. A client's command id is a bare
    UUID. */
const SERVER_COMMAND_PREFIXES = [
  "command:",
  "provider-continuation:",
  "limit-resume:",
  "server:",
] as const;

/** Whether a person issued this command from a client, read from its id alone. */
const isHumanCommandId = (commandId: CommandId | null): boolean =>
  commandId !== null && !SERVER_COMMAND_PREFIXES.some((prefix) => commandId.startsWith(prefix));

/**
 * Who asked for a run, read from the command that created it, the run's own
 * wake fields and the author of the message it carries. `board` is a
 * board-minted command; `limit-resume` is v2's usage-limit recovery worker;
 * `human` is a message a person sent from a client; anything else is `engine`:
 * v2 carrying on work it already had (a wake, a restart continuation, a
 * delegated task's result or question, the follow-up a steer becomes).
 */
export const runOrigin = (
  commandId: CommandId | null,
  run: OrchestrationV2Run,
  message: Pick<OrchestrationV2ConversationMessage, "createdBy" | "creationSource">,
): "board" | "limit-resume" | "engine" | "human" => {
  if (isBoardMintedCommandId(commandId)) return "board";
  if (commandId?.startsWith("limit-resume:")) return "limit-resume";
  // `user` from `server` is never a person typing: it is the board's own
  // message (BOARD_AUTHOR), so a board turn re-dispatched as a steer follow-up
  // is not mistaken for a human's, or v2's async-answer run (Orchestrator's
  // `async-answer:` message), which carries a human's answer under their own
  // command id but is the engine carrying on: `input-resolved` already
  // un-parked the step, so it must not also read as a human turn.
  if (
    message.createdBy !== "user" ||
    message.creationSource === "server" ||
    run.workStartedAt !== undefined ||
    run.restartContinuationOfRunId !== undefined ||
    run.delegatedTaskId !== undefined ||
    run.delegatedCompletion !== undefined
  ) {
    return "engine";
  }
  return "human";
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
  const one = (signal: ThreadSignal | null): ReadonlyArray<ThreadSignal> =>
    signal === null ? [] : [signal];
  // The provider's own failure text, by run, until that run ends: v2 records it
  // as an `error` turn item ahead of the run's terminal update, and a refusal
  // that arrives only this way (Grok's quota sentence) is what the board's
  // usage-limit classifier reads off the turn end.
  const failures = new Map<string, string>();
  // Runs nobody on the board asked for, by their message, until that message
  // says who wrote it (`run.created` above).
  const awaitingMessage = new Map<
    string,
    { readonly run: OrchestrationV2Run; readonly commandId: CommandId | null }
  >();
  const noteFailure = (runId: string, message: string) => {
    failures.delete(runId);
    failures.set(runId, message);
    if (failures.size > SEEN_LIMIT) {
      const oldest = failures.keys().next().value;
      if (oldest !== undefined) failures.delete(oldest);
    }
  };

  return (stored: OrchestrationV2StoredEvent): ReadonlyArray<ThreadSignal> => {
    const event = stored.event;
    switch (event.type) {
      case "run.created": {
        // Every requested turn is a run. Only a turn someone ASKED for is a
        // request: v2 carrying on its own work is neither a human steering nor
        // a reason to wake a parked step, and its limit resume is told apart so
        // the board wakes only the usage-limit park it was holding. Who wrote
        // the run's message decides the rest; v2 commits that message right
        // after the run, in the same command, so the run waits for it.
        const run = event.payload;
        if (isBoardMintedCommandId(stored.commandId)) {
          return [
            {
              type: "turn-requested",
              threadId: event.threadId,
              byBoard: true,
              at: DateTime.formatIso(run.requestedAt),
            },
          ];
        }
        if (stored.commandId?.startsWith("limit-resume:")) {
          return [{ type: "limit-resumed", threadId: event.threadId }];
        }
        awaitingMessage.delete(String(run.userMessageId));
        awaitingMessage.set(String(run.userMessageId), { run, commandId: stored.commandId });
        if (awaitingMessage.size > SEEN_LIMIT) {
          const oldest = awaitingMessage.keys().next().value;
          if (oldest !== undefined) awaitingMessage.delete(oldest);
        }
        return [];
      }
      case "message.updated": {
        const message = event.payload;
        const pending = awaitingMessage.get(String(message.id));
        if (pending === undefined) return [];
        awaitingMessage.delete(String(message.id));
        if (runOrigin(pending.commandId, pending.run, message) !== "human") return [];
        return [
          {
            type: "turn-requested",
            threadId: event.threadId,
            byBoard: false,
            at: DateTime.formatIso(pending.run.requestedAt),
          },
        ];
      }
      case "run.updated": {
        const run = event.payload;
        const outcome = turnOutcomeOf(run.status);
        if (outcome === null || !firstTime(`run:${run.id}`)) return [];
        const failure = failures.get(String(run.id)) ?? null;
        failures.delete(String(run.id));
        // A run that failed without ever starting is a turn that never began
        // (t3o-30, D2) — workspace preparation, or the provider refusing it.
        if (outcome === "failed" && run.startedAt === null) {
          return [
            {
              type: "turn-start-failed",
              threadId: event.threadId,
              detail: "The turn failed before it started.",
            },
          ];
        }
        const ended: ThreadSignal = {
          type: "turn-ended",
          threadId: event.threadId,
          turnRef: String(run.id),
          outcome,
          errorMessage: outcome === "failed" ? failure : null,
        };
        // v2 records no interrupt request for a run its provider never
        // started, so a human's Stop during start-up arrives only as this end,
        // under the Stop's own command id.
        // Say it was a Stop first, as it would be for a running turn, or the
        // board reads it as an unexplained ending and nudges the card on.
        if (
          (run.status === "interrupted" || run.status === "cancelled") &&
          run.startedAt === null &&
          isHumanCommandId(stored.commandId) &&
          firstTime(`interrupt-run:${run.id}`)
        ) {
          return [{ type: "interrupt-requested", threadId: event.threadId }, ended];
        }
        return [ended];
      }
      case "turn-item.updated": {
        const item = event.payload;
        if (item.type === "error" && item.runId !== null) {
          noteFailure(String(item.runId), item.failure.message);
          return [];
        }
        if (item.type !== "run_interrupt_request" || !firstTime(`interrupt:${item.id}`)) return [];
        // The run's end then needs no Stop of its own (below).
        if (item.runId !== null) firstTime(`interrupt-run:${item.runId}`);
        return [{ type: "interrupt-requested", threadId: event.threadId }];
      }
      case "runtime-request.updated": {
        const request = event.payload;
        if (request.kind === "auth_refresh") return [];
        if (request.kind === "user_input") {
          if (request.status === "pending") {
            return firstTime(`input:${request.id}`)
              ? [{ type: "input-requested", threadId: event.threadId }]
              : [];
          }
          // Only an ANSWER resumes a parked step (t3o-34, D5): a question that
          // was cancelled or expired is still unanswered.
          return firstTime(`input-closed:${request.id}`)
            ? [
                {
                  type: "input-resolved",
                  threadId: event.threadId,
                  answered:
                    request.status === "resolved" && Object.keys(request.answers ?? {}).length > 0,
                },
              ]
            : [];
        }
        return request.status === "resolved" && firstTime(`approval:${request.id}`)
          ? [{ type: "approval-responded", threadId: event.threadId }]
          : [];
      }
      case "provider-session.attached":
        return [{ type: "session-started", threadId: event.threadId }];
      default:
        return one(todoSignal(stored));
    }
  };
};

const FOLLOW_RETRY = Schedule.exponential("1 second").pipe(
  Schedule.modifyDelay(({ duration }) =>
    Effect.succeed(Duration.min(duration, Duration.seconds(30))),
  ),
);

/**
 * The engine's stored events after `startAfter` (from now on when omitted), for
 * as long as the subscriber runs. A failed read (the log is read from SQLite
 * during catch-up) resubscribes after the last event delivered rather than
 * ending the stream, so a transient error neither drops nor repeats a signal.
 */
export const followStoredEvents = (
  sink: Pick<EventSink.EventSinkV2["Service"], "stream" | "latestSequence">,
  retrySchedule: Schedule.Schedule<unknown, unknown> = FOLLOW_RETRY,
  startAfter: number | null = null,
): Stream.Stream<OrchestrationV2StoredEvent> =>
  Stream.suspend(() => {
    let cursor: number | null = startAfter;
    const after = Effect.suspend(() =>
      cursor === null ? sink.latestSequence() : Effect.succeed(cursor),
    );
    return Stream.unwrap(
      Effect.map(after, (sequence) => {
        cursor = sequence;
        return sink.stream({ afterSequence: sequence });
      }),
    ).pipe(
      Stream.tap((stored) =>
        Effect.sync(() => {
          cursor = stored.sequence;
        }),
      ),
      Stream.tapError((error) =>
        Effect.logWarning("board thread gateway: event stream failed; resubscribing", error),
      ),
      Stream.retry(retrySchedule),
      Stream.catchCause((cause) =>
        Stream.fromEffectDrain(Effect.logError("board thread gateway: signal stream ended", cause)),
      ),
    );
  });

/** How far before a resume cursor `readSignalLog` starts reading, so the reader
    holds the same memory it would have had at the cursor. Matches the reader's
    own bound: nothing older than this is remembered anyway. */
export const SIGNAL_READER_WARMUP_EVENTS = 4096;

/**
 * The signals after `afterSequence` (from now on when null), batched by the log
 * position that produced them. The reader is stateful (a run's failure text, a
 * run awaiting its message, the dedupe set), so a resume replays the events
 * before the cursor through it with their signals discarded: a stream that
 * drops between an error item and its run's end still reports the failure.
 */
export const readSignalLog = (
  sink: Pick<EventSink.EventSinkV2["Service"], "stream" | "latestSequence">,
  afterSequence: number | null,
  retrySchedule: Schedule.Schedule<unknown, unknown> = FOLLOW_RETRY,
): Stream.Stream<ThreadSignalBatch> =>
  Stream.suspend(() => {
    const read = makeSignalReader();
    const startAfter =
      afterSequence === null ? null : Math.max(0, afterSequence - SIGNAL_READER_WARMUP_EVENTS);
    return followStoredEvents(sink, retrySchedule, startAfter).pipe(
      Stream.map((stored) => ({ sequence: stored.sequence, signals: read(stored) })),
      Stream.filter(
        (batch) =>
          batch.signals.length > 0 && (afterSequence === null || batch.sequence > afterSequence),
      ),
    );
  });

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
    if (typeof record.cause === "string") return record.cause;
    if (record.cause instanceof Error) return record.cause.message;
  }
  return error instanceof Error ? error.message : String(error);
};

/** The engine refuses a command whose thread or run is in the wrong state with
    an `OrchestratorDispatchError` carrying its reason as a sentence; one that
    wraps a real failure carries the failure. */
const isRefusal = (error: DispatchError): boolean =>
  REFUSAL_TAGS.has(error._tag) ||
  (error._tag === "OrchestratorDispatchError" && typeof error.cause === "string");

export const commandError = (command: string, threadId: ThreadId) => (error: DispatchError) =>
  isRefusal(error)
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
      Effect.catchTags({
        ThreadReadError: (error) =>
          Effect.fail(
            new ThreadCommandFailedError({
              command,
              threadId,
              detail: error.detail,
              cause: error,
            }),
          ),
      }),
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

  const gateway: LocalThreadGatewayShape = {
    // Upstream's `ThreadLaunchService.launch` is NOT used: its preparation runs
    // the project's setup script on every launch, including into an existing
    // worktree or the project root, so every review phase would re-run it and
    // planning would run it in the main checkout. The board provisions its own
    // worktrees and runs setup once (t3o-09); a spawn is `launch` minus
    // preparation — create, then start the first turn.
    spawn: (input) =>
      Effect.gen(function* () {
        // v2 does not hold a thread to an existing project; the board does.
        const project = yield* projectRows.get(input.projectId).pipe(
          Effect.mapError(
            (cause) =>
              new ThreadCommandFailedError({
                command: "thread.create",
                threadId: input.threadId,
                detail: describe(cause),
                cause,
              }),
          ),
        );
        if (Option.isNone(project)) {
          return yield* refused(
            "thread.create",
            input.threadId,
            `project ${input.projectId} does not exist`,
          );
        }
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
            yield* run({
              type: "thread.settle",
              commandId: input.commandId,
              threadId: input.threadId,
            });
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
        // An arm v2 would never act on leaves the resume to the board.
        if (!v2RecoversLimit(shell)) return false;
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
          Effect.gen(function* () {
            const shell = yield* projections.getThreadShell(row.threadId);
            const deleted = shell === null || shell.deletedAt !== null;
            // A detached session leaves the projection; one still attached and
            // not stopped is what a retire has to stop. The bound provider
            // thread outlives its session, so it says nothing either way.
            const sessions = deleted
              ? []
              : (yield* projections.getThreadRecords(row.threadId, ["providerSessions"]))
                  .providerSessions;
            return {
              threadId: row.threadId,
              deleted,
              sessionLive:
                !deleted &&
                (shell.activityRunStatus != null ||
                  sessions.some(
                    (session) => session.status !== "stopped" && session.status !== "error",
                  )),
            };
          }),
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
        // Read from the latest run only: a thread's whole assistant history is
        // unbounded, and anything older than the latest run predates the work
        // the caller is asking about.
        const shell = yield* shellOf(threadId);
        if (shell === null || shell.latestRunId === null) return null;
        const records = yield* projections.getThreadRecords(threadId, ["messages"], {
          messageRoles: ["assistant"],
          messageRunIds: [shell.latestRunId],
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
    // A turn requested but not yet running: the latest run is still being
    // prepared, queued behind another, or waiting for its provider to start.
    pendingTurnStartAt: (threadId) =>
      shellOf(threadId).pipe(
        Effect.map((shell) =>
          shell !== null &&
          (shell.status === "preparing" || shell.status === "queued" || shell.status === "starting")
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

    observe: Stream.suspend(() => {
      const read = makeSignalReader();
      return followStoredEvents(eventSink).pipe(
        Stream.flatMap((stored) => Stream.fromIterable(read(stored))),
      );
    }),
    signalLog: (afterSequence) => readSignalLog(eventSink, afterSequence),

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
    // Pinned at the head it reads now, so the caller's catch-up ends exactly
    // where this begins; a failed read resubscribes from the last entry.
    subscribeTodoLog: Effect.map(
      eventSink.latestSequence().pipe(Effect.orElseSucceed(() => 0)),
      (head) => followStoredEvents(eventSink, FOLLOW_RETRY, head).pipe(Stream.map(toTodoLogEntry)),
    ),
  };
  return gateway;
});

/** The gateway onto this server's own threads (T3O-63): what the router and
    the worker side build on. */
export const LocalThreadGatewayV2Live = Layer.effect(LocalThreadGateway, makeThreadGatewayV2);

/** One gateway as both the board's `ThreadGateway` and this server's own,
    for a board with no workers — the test stacks. */
export const ThreadGatewayV2Live = Layer.effect(
  ThreadGateway,
  Effect.map(LocalThreadGateway, (local): ThreadGatewayShape => local),
).pipe(Layer.provideMerge(LocalThreadGatewayV2Live));
