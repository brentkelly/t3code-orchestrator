/**
 * The thread gateway over orchestration v1 (T3O-58).
 *
 * Wraps, one for one, every call the board used to make into upstream's v1
 * engine, projections and provider service, so moving the board behind the
 * gateway changed no behaviour. This is the ONLY board module that may import
 * upstream orchestration, persistence or provider code
 * (`threadGatewayBoundary.test.ts`); everything v1-shaped the board touches
 * lives here.
 *
 * The SQL reads are plain reads of upstream's projection tables on the shared
 * connection. They write nothing.
 */
import {
  CommandId,
  isBoardMintedCommandId,
  IsoDateTime,
  MessageId,
  ProjectId,
  ProjectScript,
  ThreadId,
  type OrchestrationCommand,
  type OrchestrationEvent,
  type OrchestrationSessionStatus,
  type OrchestrationThreadShell,
  type ProviderRuntimeEvent,
} from "@t3tools/contracts";
import { isThreadAwaitingPermission, deriveBoardCardThreadState } from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";
import * as SqlSchema from "effect/sql/SqlSchema";

import type { OrchestrationDispatchError } from "../orchestration/Errors.ts";
import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { isAutoSettlementCandidate } from "../orchestration/ThreadSettlementPolicy.ts";
import { ProviderService } from "../provider/Services/ProviderService.ts";
import {
  ThreadCommandFailedError,
  ThreadCommandRefusedError,
  deletedThreadState,
  ThreadGateway,
  ThreadReadError,
  type BoardSessionStatus,
  type BoardThreadState,
  type BoardTodoItem,
  type ThreadGatewayShape,
  type ThreadSignal,
  type TodoLogEntry,
  type TodoSignal,
} from "./ThreadGateway.ts";

/** The plan steps carried by a `turn.plan.updated` activity, or null when the
    payload is not a plan. Activity payloads are provider-shaped (`unknown`),
    so this reads leniently, exactly as the in-chat plan chip does: an entry
    without a string `step` is skipped, and any unrecognised status is
    `pending`. A malformed payload must never fail the todo cache. */
export function readTurnPlanSteps(payload: unknown): ReadonlyArray<BoardTodoItem> | null {
  const record =
    payload !== null && typeof payload === "object" ? (payload as Record<string, unknown>) : null;
  const rawPlan = record?.plan;
  if (!Array.isArray(rawPlan)) return null;
  const steps: Array<BoardTodoItem> = [];
  for (const entry of rawPlan) {
    if (entry === null || typeof entry !== "object") continue;
    const item = entry as Record<string, unknown>;
    if (typeof item.step !== "string" || item.step.trim().length === 0) continue;
    steps.push({
      step: item.step,
      status: typeof item.status === "string" ? item.status : "pending",
    });
  }
  return steps;
}

/** The `detail` string off a `provider.*.failed` activity payload, typed
    `unknown` (t3o-30, D2). Anything else reads as an empty detail rather than
    throwing — a malformed payload must not stop the board landing the step. */
function providerFailureDetail(payload: unknown): string {
  if (payload === null || typeof payload !== "object") return "";
  const detail = (payload as { readonly detail?: unknown }).detail;
  return typeof detail === "string" ? detail : "";
}

/** v1's session statuses in board vocabulary. Every resting state is `idle`. */
const sessionStatusOf = (status: OrchestrationSessionStatus | undefined): BoardSessionStatus => {
  switch (status) {
    case undefined:
      return "none";
    case "starting":
    case "running":
    case "stopped":
    case "error":
      return status;
    case "idle":
    case "ready":
    case "interrupted":
      return "idle";
  }
};

/** Whether a thread is still doing live work — an active turn or a pending
    question a human can still answer (t3o-10, D1). A session upstream marked
    `error` is dead whatever else the shell still says: a restart leaves the
    killed turn's id lingering on the projection, so `activeTurnId` alone reads
    a corpse as mid-turn. The same rule the thread list reads to show `Failed`. */
const threadIsAlive = (shell: OrchestrationThreadShell): boolean => {
  if (shell.session?.status === "error") return false;
  return (
    shell.hasPendingUserInput || (shell.session !== null && shell.session.activeTurnId !== null)
  );
};

export const boardThreadStateFromShell = (
  shell: OrchestrationThreadShell,
  now: string,
): BoardThreadState => ({
  threadId: shell.id,
  projectId: shell.projectId,
  deleted: false,
  archived: shell.archivedAt !== null,
  settlementDecided: shell.settledOverride !== null,
  sessionStatus: sessionStatusOf(shell.session?.status),
  activeTurnRef: shell.session?.activeTurnId ?? null,
  awaitingUserInput: shell.hasPendingUserInput,
  awaitingPermission: isThreadAwaitingPermission(shell),
  backgroundWork: shell.backgroundLiveness ?? null,
  alive: threadIsAlive(shell),
  waitingOnBackground: deriveBoardCardThreadState(shell).waitingOnBackground,
  autoSettleCandidate: isAutoSettlementCandidate(shell, now),
  worktreePath: shell.worktreePath ?? null,
  modelSelection: shell.modelSelection ?? null,
});

/** The live signal one upstream domain event carries for the supervisor. */
export const domainSignal = (event: OrchestrationEvent): ThreadSignal | null => {
  switch (event.type) {
    case "thread.turn-start-requested":
      return {
        type: "turn-requested",
        threadId: event.payload.threadId,
        byBoard: isBoardMintedCommandId(event.commandId),
        at: event.payload.createdAt,
      };
    case "thread.turn-interrupt-requested":
      return { type: "interrupt-requested", threadId: event.payload.threadId };
    case "thread.approval-response-requested":
      return { type: "approval-responded", threadId: event.payload.threadId };
    case "thread.activity-appended":
      return event.payload.activity.kind === "provider.turn.start.failed"
        ? {
            type: "turn-start-failed",
            threadId: event.payload.threadId,
            detail: providerFailureDetail(event.payload.activity.payload),
          }
        : null;
    default:
      return null;
  }
};

/** The live signal one provider runtime event carries for the supervisor. */
export const runtimeSignal = (event: ProviderRuntimeEvent): ThreadSignal | null => {
  const threadId = ThreadId.make(String(event.threadId));
  switch (event.type) {
    case "turn.completed":
      return {
        type: "turn-ended",
        threadId,
        turnRef: event.turnId === undefined ? undefined : String(event.turnId),
        outcome: event.payload.state,
        errorMessage: event.payload.errorMessage ?? null,
      };
    case "user-input.requested":
      return { type: "input-requested", threadId };
    case "user-input.resolved":
      // Only an actual ANSWER counts (t3o-34, D5): a cancelled question is
      // still unanswered.
      return {
        type: "input-resolved",
        threadId,
        answered: Object.keys(event.payload.answers).length > 0,
      };
    case "session.started":
      return { type: "session-started", threadId };
    default:
      return null;
  }
};

/** The todo signal one upstream domain event carries, if any. */
export const todoSignal = (event: OrchestrationEvent): TodoSignal | null => {
  if (event.type === "thread.activity-appended") {
    const activity = event.payload.activity;
    if (activity.kind !== "turn.plan.updated") return null;
    const todos = readTurnPlanSteps(activity.payload);
    if (todos === null) return null;
    return {
      type: "todos-changed",
      threadId: event.payload.threadId,
      todos,
      at: activity.createdAt,
    };
  }
  if (event.type === "thread.deleted") {
    return { type: "thread-deleted", threadId: event.payload.threadId };
  }
  return null;
};

const toTodoLogEntry = (event: OrchestrationEvent): TodoLogEntry => ({
  cursor: event.sequence,
  signal: todoSignal(event),
});

/** A refusal is the engine answering "not for this thread as it stands". */
const isRefusal = (error: OrchestrationDispatchError): boolean =>
  error._tag === "OrchestrationCommandInvariantError" ||
  error._tag === "OrchestrationThreadSettleBlockedError";

const refusalDetail = (error: OrchestrationDispatchError): string =>
  "detail" in error && typeof error.detail === "string" ? error.detail : error.message;

const readError = (operation: string) => (cause: unknown) =>
  new ThreadReadError({
    operation,
    detail: cause instanceof Error ? cause.message : String(cause),
    cause,
  });

export const makeThreadGatewayV1 = Effect.gen(function* () {
  const engine = yield* OrchestrationEngineService;
  const snapshotQuery = yield* ProjectionSnapshotQuery;
  const providerService = yield* ProviderService;
  const sql = yield* SqlClient.SqlClient;
  const crypto = yield* Crypto.Crypto;
  const path = yield* Path.Path;
  const nowIso = Effect.map(DateTime.now, DateTime.formatIso);
  const freshMessageId = crypto.randomUUIDv4.pipe(
    Effect.map((uuid) => MessageId.make(`msg-${uuid}`)),
    Effect.orDie,
  );

  const run = (command: OrchestrationCommand & { readonly threadId: ThreadId }) =>
    engine.dispatch(command).pipe(
      Effect.mapError((error) =>
        isRefusal(error)
          ? new ThreadCommandRefusedError({
              command: command.type,
              threadId: command.threadId,
              detail: refusalDetail(error),
            })
          : new ThreadCommandFailedError({
              command: command.type,
              threadId: command.threadId,
              detail: error.message,
              cause: error,
            }),
      ),
      Effect.asVoid,
    );

  // ── SQL reads of upstream's projection tables ──────────────────────

  const findThreadRow = SqlSchema.findOneOption({
    Request: ThreadId,
    Result: Schema.Struct({ projectId: ProjectId, deletedAt: Schema.NullOr(Schema.String) }),
    execute: (threadId) => sql`
      SELECT project_id AS "projectId", deleted_at AS "deletedAt"
      FROM main.projection_threads WHERE thread_id = ${threadId}
    `,
  });

  const listThreadRecordRows = SqlSchema.findAll({
    Request: Schema.String,
    Result: Schema.Struct({
      threadId: ThreadId,
      deletedAt: Schema.NullOr(Schema.String),
      archivedAt: Schema.NullOr(Schema.String),
      settledOverride: Schema.NullOr(Schema.String),
    }),
    execute: (threadIdsJson) => sql`
      SELECT thread_id AS "threadId", deleted_at AS "deletedAt",
             archived_at AS "archivedAt", settled_override AS "settledOverride"
      FROM main.projection_threads
      WHERE thread_id IN (SELECT value FROM json_each(${threadIdsJson}))
    `,
  });

  /* Every project, deleted ones included, without hydrating the read model:
     the decider asks for these on every project-bearing card command. */
  const listProjectRows = SqlSchema.findAll({
    Request: Schema.Void,
    Result: Schema.Struct({
      id: ProjectId,
      title: Schema.String,
      workspaceRoot: Schema.String,
      deletedAt: Schema.NullOr(Schema.String),
      scripts: Schema.fromJsonString(Schema.Array(ProjectScript)),
    }),
    execute: () => sql`
      SELECT project_id AS "id", title, workspace_root AS "workspaceRoot",
             deleted_at AS "deletedAt", scripts_json AS "scripts"
      FROM main.projection_projects
      ORDER BY created_at ASC, project_id ASC
    `,
  });

  const listLiveThreadRows = SqlSchema.findAll({
    Request: Schema.Void,
    Result: Schema.Struct({ threadId: ThreadId }),
    execute: () => sql`
      SELECT thread_id AS "threadId" FROM main.projection_threads WHERE deleted_at IS NULL
    `,
  });

  /* The most recent ASSISTANT message on a thread, one row, served by upstream
     migration 029's `(thread_id, created_at, message_id)` index. `createdAt`
     rides along so the caller can tell the newest message from a RECENT one: a
     turn that ends having said nothing leaves the previous turn's text newest. */
  const findLatestAssistantMessage = SqlSchema.findOneOption({
    Request: ThreadId,
    Result: Schema.Struct({ text: Schema.String, createdAt: IsoDateTime }),
    execute: (threadId) => sql`
      SELECT text, created_at AS "createdAt"
      FROM main.projection_thread_messages
      WHERE thread_id = ${threadId}
        AND role = 'assistant'
      ORDER BY created_at DESC, message_id DESC
      LIMIT 1
    `,
  });

  /* The timeout sweep's life sign: the newest `created_at` across a thread's
     assistant messages and activity rows. Activity rows are the strong half —
     every tool call writes one — so a phase deep in reads is observably alive
     without writing prose. Both arms are index-served. */
  const findLastSignalAt = SqlSchema.findOneOption({
    Request: ThreadId,
    Result: Schema.Struct({ at: Schema.NullOr(Schema.String) }),
    execute: (threadId) => sql`
      SELECT MAX(at) AS "at" FROM (
        SELECT MAX(created_at) AS at FROM main.projection_thread_messages
         WHERE thread_id = ${threadId} AND role = 'assistant'
        UNION ALL
        SELECT MAX(created_at) AS at FROM main.projection_thread_activities
         WHERE thread_id = ${threadId}
      )
    `,
  });

  /* Upstream's pending turn-start row — the same predicate as its own
     `getPendingTurnStartByThreadId` — as a scalar: the only question is when it
     was asked for. A turn requested but not started is invisible to every other
     "is this thread busy" signal. */
  const findPendingTurnStartAt = SqlSchema.findOneOption({
    Request: ThreadId,
    Result: Schema.Struct({ requestedAt: Schema.String }),
    execute: (threadId) => sql`
      SELECT requested_at AS "requestedAt"
      FROM main.projection_turns
      WHERE thread_id = ${threadId}
        AND turn_id IS NULL
        AND state = 'pending'
        AND pending_message_id IS NOT NULL
        AND checkpoint_turn_count IS NULL
      ORDER BY requested_at DESC
      LIMIT 1
    `,
  });

  const samePath = (left: string, right: string) => path.resolve(left) === path.resolve(right);

  const gateway: ThreadGatewayShape = {
    // The thread is created with its OWN command first. `thread.turn.start`
    // carries a `bootstrap.createThread` block, but that block is interpreted
    // by the WebSocket dispatch path (`dispatchBootstrapTurnStart` in ws.ts),
    // NOT by the engine — a server-side dispatch straight into the engine is
    // decided as an ordinary turn start and rejected: "thread does not exist".
    spawn: (input) =>
      Effect.gen(function* () {
        const createdAt = yield* nowIso;
        yield* run({
          type: "thread.create",
          commandId: input.commandId,
          threadId: input.threadId,
          projectId: input.projectId,
          title: input.title,
          modelSelection: input.modelSelection,
          runtimeMode: input.runtimeMode,
          interactionMode: input.interactionMode,
          branch: input.branch,
          worktreePath: input.worktreePath,
          createdAt,
        });
        yield* run({
          type: "thread.turn.start",
          commandId: CommandId.make(`${input.commandId}:turn`),
          threadId: input.threadId,
          message: {
            messageId: yield* freshMessageId,
            role: "user",
            text: input.text,
            attachments: input.attachments,
          },
          runtimeMode: input.runtimeMode,
          interactionMode: input.interactionMode,
          createdAt,
        }).pipe(
          // The thread exists but will never run a turn. Delete it rather than
          // leave an empty thread in the sidebar for a run that never started —
          // the same cleanup the WS bootstrap path performs. An interrupt is a
          // teardown, not a refusal, so it does not compensate.
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
        yield* run({
          type: "thread.turn.start",
          commandId: input.commandId,
          threadId: input.threadId,
          message: {
            messageId: yield* freshMessageId,
            role: "user",
            text: input.text,
            attachments: input.attachments,
          },
          runtimeMode: input.runtimeMode,
          interactionMode: input.interactionMode,
          createdAt: yield* nowIso,
        });
      }),
    interrupt: (input) =>
      Effect.gen(function* () {
        yield* run({
          type: "thread.turn.interrupt",
          commandId: input.commandId,
          threadId: input.threadId,
          createdAt: yield* nowIso,
        });
      }),
    stopSession: (input) =>
      Effect.gen(function* () {
        yield* run({
          type: "thread.session.stop",
          commandId: input.commandId,
          threadId: input.threadId,
          createdAt: yield* nowIso,
        });
      }),
    // The automatic settle re-reads candidacy itself, against a projection
    // sequence captured BEFORE that read: the engine refuses the command when
    // the thread logged any event after it, so a thread that changed between
    // the check and the dispatch is never settled — the same guard upstream's
    // own inactivity sweep relies on.
    settle: (input) =>
      input.auto
        ? Effect.gen(function* () {
            const commandFailed = (cause: unknown) =>
              new ThreadCommandFailedError({
                command: "thread.auto-settle",
                threadId: input.threadId,
                detail: cause instanceof Error ? cause.message : String(cause),
                cause,
              });
            const { snapshotSequence } = yield* snapshotQuery
              .getSnapshotSequence()
              .pipe(Effect.mapError(commandFailed));
            const shell = yield* snapshotQuery
              .getThreadShellById(input.threadId)
              .pipe(Effect.mapError(commandFailed));
            const settledAt = yield* nowIso;
            if (Option.isNone(shell) || !isAutoSettlementCandidate(shell.value, settledAt)) {
              return yield* new ThreadCommandRefusedError({
                command: "thread.auto-settle",
                threadId: input.threadId,
                detail: `thread ${input.threadId} is not a candidate for automatic settlement`,
              });
            }
            yield* run({
              type: "thread.auto-settle",
              commandId: input.commandId,
              threadId: input.threadId,
              snapshotSequence,
              settledAt,
            });
          })
        : run({ type: "thread.settle", commandId: input.commandId, threadId: input.threadId }),
    delete: (input) =>
      run({ type: "thread.delete", commandId: input.commandId, threadId: input.threadId }),

    threadState: (threadId) =>
      Effect.gen(function* () {
        const shell = yield* snapshotQuery.getThreadShellById(threadId);
        if (Option.isSome(shell)) return boardThreadStateFromShell(shell.value, yield* nowIso);
        // The shell read hides deleted threads; the row says whether this one
        // was deleted or never existed.
        const row = yield* findThreadRow(threadId);
        if (Option.isNone(row) || row.value.deletedAt === null) return null;
        return deletedThreadState(threadId, row.value.projectId);
      }).pipe(Effect.mapError(readError("threadState"))),
    threadRecords: (threadIds) =>
      listThreadRecordRows(JSON.stringify(threadIds)).pipe(
        Effect.map(
          (rows) =>
            new Map(
              rows.map((row) => [
                row.threadId,
                {
                  threadId: row.threadId,
                  deleted: row.deletedAt !== null,
                  archived: row.archivedAt !== null,
                  settlementDecided: row.settledOverride !== null,
                },
              ]),
            ),
        ),
        Effect.mapError(readError("threadRecords")),
      ),
    threadsInWorktree: (worktreePath) =>
      snapshotQuery.getCommandReadModel().pipe(
        Effect.map((model) =>
          model.threads
            .filter(
              (thread) =>
                thread.worktreePath !== null && samePath(thread.worktreePath, worktreePath),
            )
            .map((thread) => ({
              threadId: thread.id,
              deleted: thread.deletedAt !== null,
              sessionLive: thread.session !== null && thread.session.status !== "stopped",
            })),
        ),
        Effect.mapError(readError("threadsInWorktree")),
      ),
    listLiveThreadIds: () =>
      listLiveThreadRows(undefined).pipe(
        Effect.map((rows) => rows.map((row) => row.threadId)),
        Effect.mapError(readError("listLiveThreadIds")),
      ),
    latestAssistantMessage: (threadId) =>
      findLatestAssistantMessage(threadId).pipe(
        Effect.map(Option.getOrNull),
        Effect.mapError(readError("latestAssistantMessage")),
      ),
    lastSignalAt: (threadId) =>
      findLastSignalAt(threadId).pipe(
        Effect.map(Option.match({ onNone: () => null, onSome: (row) => row.at })),
        Effect.mapError(readError("lastSignalAt")),
      ),
    pendingTurnStartAt: (threadId) =>
      findPendingTurnStartAt(threadId).pipe(
        Effect.map(Option.match({ onNone: () => null, onSome: (row) => row.requestedAt })),
        Effect.mapError(readError("pendingTurnStartAt")),
      ),

    projects: () =>
      listProjectRows(undefined).pipe(
        Effect.map((rows) =>
          rows.map((row) => ({
            id: row.id,
            title: row.title,
            workspaceRoot: row.workspaceRoot,
            deleted: row.deletedAt !== null,
            scripts: row.scripts,
          })),
        ),
        Effect.mapError(readError("projects")),
      ),
    project: (projectId) =>
      snapshotQuery.getProjectShellById(projectId).pipe(
        Effect.map(
          Option.match({
            onNone: () => null,
            onSome: (project) => ({
              id: project.id,
              title: project.title,
              workspaceRoot: project.workspaceRoot,
              deleted: false,
              scripts: project.scripts,
              repositoryIdentity: project.repositoryIdentity ?? null,
            }),
          }),
        ),
        Effect.mapError(readError("project")),
      ),

    // Thread activity is by far the highest-volume domain event, and the board
    // cares about one kind of it (t3o-30, D2), so it is filtered here and the
    // supervisor never sees the tool calls, reasoning and output of every
    // thread on the box.
    observe: Stream.merge(
      Stream.map(engine.streamDomainEvents, domainSignal),
      Stream.map(providerService.streamEvents, runtimeSignal),
    ).pipe(Stream.filter((signal): signal is ThreadSignal => signal !== null)),

    todoLogHead: engine.latestSequence,
    readTodoLog: (after, upTo) =>
      engine
        .readEvents(after, Math.max(0, upTo - after))
        .pipe(Stream.map(toTodoLogEntry), Stream.mapError(readError("readTodoLog"))),
    subscribeTodoLog: engine.subscribeDomainEvents.pipe(
      Effect.map((events) => Stream.map(events, toTodoLogEntry)),
    ),
  };
  return gateway;
});

export const ThreadGatewayV1Live = Layer.effect(ThreadGateway, makeThreadGatewayV1);
