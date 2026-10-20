/**
 * Every read the board makes of UPSTREAM's tables, in one place (T3O-56).
 *
 * The board owns `boards.sqlite` and writes nothing else, but it still has to
 * know a few facts about threads and projects: whether a project or thread a
 * command names exists, what a thread last said, when it last signalled, whether
 * a turn is pending, and which threads are still live for the todo-cache sweep.
 * Until the `thread-gateway` card puts those behind a gateway they are plain SQL
 * against `main.*` on the shared connection (`boards.sqlite` is attached to it).
 *
 * Keep every such read HERE. A `main.` reference anywhere else in board code is
 * a dependency the gateway will not know to replace.
 */
import { IsoDateTime, ProjectId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";

import { toPersistenceSqlError, type ProjectionRepositoryError } from "../persistence/Errors.ts";
import type { BoardProjectRef, BoardThreadRef } from "./decider.ts";

export interface BoardUpstreamReads {
  /** Every project, deleted ones included — the decider's existence check. */
  readonly listProjects: () => Effect.Effect<
    ReadonlyArray<BoardProjectRef>,
    ProjectionRepositoryError
  >;
  /** One thread's existence, or null when there is no row for it. */
  readonly findThread: (
    threadId: ThreadId,
  ) => Effect.Effect<BoardThreadRef | null, ProjectionRepositoryError>;
  /** The newest assistant message on a thread (t3o-34, D2). */
  readonly latestAssistantMessage: (
    threadId: ThreadId,
  ) => Effect.Effect<
    { readonly text: string; readonly createdAt: string } | null,
    ProjectionRepositoryError
  >;
  /** When a thread last produced output — message or activity (T3O-12, D1). */
  readonly threadLastSignalAt: (
    threadId: ThreadId,
  ) => Effect.Effect<string | null, ProjectionRepositoryError>;
  /** When a requested turn that has not started was asked for (T3O-18). */
  readonly threadPendingTurnStartAt: (
    threadId: ThreadId,
  ) => Effect.Effect<string | null, ProjectionRepositoryError>;
  /** Drop cached todo rows whose link, card or thread is gone (t3o-18, AC 20). */
  readonly sweepOrphanThreadTodos: () => Effect.Effect<void, ProjectionRepositoryError>;
}

export function makeBoardUpstreamReads(sql: SqlClient.SqlClient): BoardUpstreamReads {
  const listProjectRows = SqlSchema.findAll({
    Request: Schema.Void,
    Result: Schema.Struct({
      id: ProjectId,
      title: Schema.String,
      deletedAt: Schema.NullOr(Schema.String),
    }),
    execute: () => sql`
      SELECT project_id AS "id", title, deleted_at AS "deletedAt"
      FROM main.projection_projects
      ORDER BY created_at ASC, project_id ASC
    `,
  });

  const findThreadRow = SqlSchema.findOneOption({
    Request: ThreadId,
    Result: Schema.Struct({ deletedAt: Schema.NullOr(Schema.String) }),
    execute: (threadId) => sql`
      SELECT deleted_at AS "deletedAt" FROM main.projection_threads WHERE thread_id = ${threadId}
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
  const findThreadLastSignalAt = SqlSchema.findOneOption({
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
  const findThreadPendingTurnStartAt = SqlSchema.findOneOption({
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

  /* The cache is a projection, so a leaked row is invisible until it resurfaces
     on a reused id; sweeping at boot is the cheap, total answer. The DELETE
     writes only `boards`; `main.projection_threads` is read. */
  const sweepOrphans = SqlSchema.void({
    Request: Schema.Void,
    execute: () => sql`
      DELETE FROM boards.board_thread_todos
      WHERE thread_id NOT IN (
              SELECT thread_id FROM boards.board_card_thread_links WHERE tombstoned_at IS NULL
            )
         OR card_id NOT IN (SELECT card_id FROM boards.board_cards WHERE archived_at IS NULL)
         OR thread_id NOT IN (
              SELECT thread_id FROM main.projection_threads WHERE deleted_at IS NULL
            )
    `,
  });

  return {
    listProjects: () =>
      listProjectRows(undefined).pipe(
        Effect.mapError(toPersistenceSqlError("BoardUpstreamReads.listProjects:query")),
      ),
    findThread: (threadId) =>
      findThreadRow(threadId).pipe(
        Effect.map(Option.getOrNull),
        Effect.mapError(toPersistenceSqlError("BoardUpstreamReads.findThread:query")),
      ),
    latestAssistantMessage: (threadId) =>
      findLatestAssistantMessage(threadId).pipe(
        Effect.map(Option.getOrNull),
        Effect.mapError(toPersistenceSqlError("BoardUpstreamReads.latestAssistantMessage:query")),
      ),
    threadLastSignalAt: (threadId) =>
      findThreadLastSignalAt(threadId).pipe(
        Effect.map(Option.match({ onNone: () => null, onSome: (row) => row.at })),
        Effect.mapError(toPersistenceSqlError("BoardUpstreamReads.threadLastSignal:query")),
      ),
    threadPendingTurnStartAt: (threadId) =>
      findThreadPendingTurnStartAt(threadId).pipe(
        Effect.map(Option.match({ onNone: () => null, onSome: (row) => row.requestedAt })),
        Effect.mapError(toPersistenceSqlError("BoardUpstreamReads.threadPendingTurnStart:query")),
      ),
    sweepOrphanThreadTodos: () =>
      sweepOrphans(undefined).pipe(
        Effect.mapError(toPersistenceSqlError("BoardUpstreamReads.threadTodoSweep:query")),
      ),
  };
}
