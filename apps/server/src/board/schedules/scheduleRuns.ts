/**
 * T3o: the seam between upstream's scheduled tasks and t3o.json schedules (T3O-117).
 * A task a board schedule links is only a timer: `ScheduledTaskService.runTask` hands its
 * run to the board's runner here instead of launching its own thread. The runner is
 * registered by the board layer, which sits above the scheduled task service.
 */
import type { ScheduledTask, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Schema from "effect/Schema";
import type * as SqlClient from "effect/sql/SqlClient";

export class BoardScheduleRunError extends Schema.TaggedError<BoardScheduleRunError>()(
  "BoardScheduleRunError",
  { message: Schema.String },
) {}

export interface BoardScheduleRunner {
  /** Must return fast: upstream runs due tasks one at a time. The thread is the run's
      own when it launched here, null when it went elsewhere; a skip is a failure. */
  readonly run: (task: ScheduledTask) => Effect.Effect<ThreadId | null, BoardScheduleRunError>;
}

let registeredRunner: BoardScheduleRunner | null = null;

/** Registered by the board layer for its lifetime. */
export const registerBoardScheduleRunner = (runner: BoardScheduleRunner) =>
  Effect.acquireRelease(
    Effect.sync(() => {
      registeredRunner = runner;
    }),
    () =>
      Effect.sync(() => {
        if (registeredRunner === runner) registeredRunner = null;
      }),
  );

const NOT_RUNNING = "Board is not running on this server.";

/**
 * The run of a task a board schedule links, else `threadRun` unchanged. A linked task
 * with no runner fails rather than launch locally, and so does one whose link can't be read.
 */
export const orThread = Effect.fn("BoardScheduleRuns.orThread")(function* (
  sql: SqlClient.SqlClient,
  task: ScheduledTask,
  threadRun: Effect.Effect<Exit.Exit<ThreadId, unknown>>,
): Effect.fn.Return<Exit.Exit<ThreadId | null, unknown>> {
  const linked = yield* sql<{ readonly task_id: string }>`
    SELECT task_id FROM boards.project_schedules WHERE task_id = ${task.id}
  `.pipe(
    Effect.map((rows) => rows.length > 0),
    Effect.catchCause((cause) =>
      Effect.logWarning("Couldn't read whether the board manages a scheduled task", {
        taskId: task.id,
        cause,
      }).pipe(Effect.as(null)),
    ),
  );
  if (linked === false) return yield* threadRun;
  if (linked === null) {
    return Exit.fail(
      new BoardScheduleRunError({ message: "Couldn't read whether the board manages this task." }),
    );
  }
  const runner = registeredRunner;
  if (runner === null) return Exit.fail(new BoardScheduleRunError({ message: NOT_RUNNING }));
  return yield* Effect.exit(runner.run(task));
});
