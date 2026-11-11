/**
 * T3o: the seam between upstream's webhook scheduled tasks and board rules (T3O-78).
 * `ScheduledTaskService` calls these from one-line `T3o:` insertions; the board itself is
 * reached through a runner the board layer registers at startup, because the scheduled
 * task service sits below the board in the layer graph.
 */
import {
  BOARD_RULE_PROMPT,
  BoardWebhookAction,
  ScheduledTaskError,
  type ProjectId,
  type ScheduledTask,
  type ScheduledTaskId,
  type ScheduledTaskUpsertInput,
  type ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import type { WebhookRequest } from "../scheduledTasks/webhookTemplate.ts";

export class BoardWebhookRuleError extends Schema.TaggedError<BoardWebhookRuleError>()(
  "BoardWebhookRuleError",
  { message: Schema.String },
) {}

export interface BoardWebhookRunInput {
  readonly taskId: ScheduledTaskId;
  readonly taskTitle: string;
  readonly projectId: ProjectId;
  readonly deliveryId: string;
  readonly request: WebhookRequest;
  readonly action: BoardWebhookAction;
}

export interface BoardWebhookRunner {
  /** The one-line result for the delivery log. Every deterministic non-action is a
      `Skipped: …` success; only infrastructure failures fail. */
  readonly run: (input: BoardWebhookRunInput) => Effect.Effect<string, BoardWebhookRuleError>;
  /** Why the board refuses this rule for the project, or null. */
  readonly validate: (input: {
    readonly projectId: ProjectId;
    readonly action: BoardWebhookAction;
  }) => Effect.Effect<string | null, BoardWebhookRuleError>;
}

let registeredRunner: BoardWebhookRunner | null = null;

/** Registered by the board layer for its lifetime. */
export const registerBoardWebhookRunner = (runner: BoardWebhookRunner) =>
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

const ActionJson = Schema.fromJsonString(BoardWebhookAction);
const decodeActionJson = Schema.decodeUnknownOption(ActionJson);
const encodeActionJson = Schema.encodeSync(ActionJson);

const readActions = Effect.fn("BoardWebhookRules.readActions")(function* (
  sql: SqlClient.SqlClient,
  taskIds: ReadonlyArray<string>,
) {
  if (taskIds.length === 0) return new Map<string, BoardWebhookAction>();
  const rows = yield* sql<{ task_id: string; action_json: string }>`
    SELECT task_id, action_json FROM boards.scheduled_task_board_actions
    WHERE task_id IN ${sql.in(taskIds)}
  `;
  const actions = new Map<string, BoardWebhookAction>();
  for (const row of rows) {
    const decoded = decodeActionJson(row.action_json);
    if (decoded._tag === "Some") actions.set(row.task_id, decoded.value);
    else yield* Effect.logWarning("Skipping undecodable board rule", { taskId: row.task_id });
  }
  return actions;
});

const loadError = (cause: unknown) =>
  new ScheduledTaskError({ message: "Could not load board rules.", cause });

/** The tasks with their stored board rules attached. */
export const withBoardActions = (
  sql: SqlClient.SqlClient,
  tasks: ReadonlyArray<ScheduledTask>,
): Effect.Effect<ReadonlyArray<ScheduledTask>, ScheduledTaskError> =>
  readActions(
    sql,
    tasks.filter((task) => task.schedule.type === "webhook").map((task) => task.id),
  ).pipe(
    Effect.map((actions) =>
      tasks.map((task) => {
        const boardAction = actions.get(task.id);
        return boardAction === undefined ? task : { ...task, boardAction };
      }),
    ),
    Effect.mapError(loadError),
  );

export const withBoardAction = (sql: SqlClient.SqlClient, task: ScheduledTask) =>
  withBoardActions(sql, [task]).pipe(Effect.map((tasks) => tasks[0] ?? task));

/**
 * The board rule an upsert stores, and the prompt it stores with it. Omitted keeps the
 * stored rule, so an older or mobile client's save never strips it; leaving the webhook
 * trigger clears it. A rule needs a signing secret, since issue text comes from outside
 * parties, and no coalesce key, since merging deliveries would drop board events.
 */
export const resolveUpsertBoardAction = Effect.fn("BoardWebhookRules.resolveUpsert")(function* (
  sql: SqlClient.SqlClient,
  input: ScheduledTaskUpsertInput,
  context: {
    readonly taskId: ScheduledTaskId;
    readonly schedule: ScheduledTask["schedule"];
  },
) {
  const fail = (message: string) => new ScheduledTaskError({ message, taskId: context.taskId });
  const boardAction =
    context.schedule.type !== "webhook"
      ? null
      : input.boardAction === undefined
        ? ((yield* readActions(sql, [context.taskId]).pipe(Effect.mapError(loadError))).get(
            context.taskId,
          ) ?? null)
        : input.boardAction;
  if (boardAction === null) {
    if (input.prompt === BOARD_RULE_PROMPT) {
      return yield* fail("Write a prompt for this task, or turn its board rule back on.");
    }
    return { boardAction, prompt: input.prompt };
  }
  if (context.schedule.type !== "webhook")
    return yield* fail("Board rules need a webhook trigger.");
  // Runs before the upsert consumes a secretRef; the upsert refuses a signature with no secret.
  if (context.schedule.signature == null) {
    return yield* fail("A board rule needs a signature check with a signing secret.");
  }
  if (context.schedule.dedupe?.coalesceKey !== undefined) {
    return yield* fail("A board rule cannot coalesce deliveries. Remove the coalesce key.");
  }
  if (registeredRunner === null) return yield* fail(NOT_RUNNING);
  const refusal = yield* registeredRunner
    .validate({ projectId: input.projectId, action: boardAction })
    .pipe(Effect.mapError((error) => fail(error.message)));
  if (refusal !== null) return yield* fail(refusal);
  return { boardAction, prompt: BOARD_RULE_PROMPT };
});

/** Written inside the upsert's transaction; null deletes. */
export const saveBoardAction = (
  sql: SqlClient.SqlClient,
  taskId: ScheduledTaskId,
  boardAction: BoardWebhookAction | null,
) =>
  boardAction === null
    ? deleteBoardAction(sql, taskId)
    : sql`
        INSERT INTO boards.scheduled_task_board_actions (task_id, action_json)
        VALUES (${taskId}, ${encodeActionJson(boardAction)})
        ON CONFLICT (task_id) DO UPDATE SET action_json = excluded.action_json
      `.pipe(Effect.asVoid);

export const deleteBoardAction = (sql: SqlClient.SqlClient, taskId: ScheduledTaskId) =>
  sql`DELETE FROM boards.scheduled_task_board_actions WHERE task_id = ${taskId}`.pipe(
    Effect.asVoid,
  );

/** Before upstream deletes the thread's tasks, in the same transaction. */
export const deleteThreadBoardActions = (sql: SqlClient.SqlClient, threadId: ThreadId) =>
  sql`
    DELETE FROM boards.scheduled_task_board_actions
    WHERE task_id IN (SELECT task_id FROM scheduled_tasks WHERE thread_id = ${threadId})
  `.pipe(Effect.asVoid);

/**
 * A webhook delivery's board run, or null when the task is not a board rule. The result
 * line replaces the delivery's rendered prompt. A task carrying the sentinel prompt
 * without its rule fails rather than launch a thread.
 */
export function runBoardRuleDelivery(
  sql: SqlClient.SqlClient,
  task: ScheduledTask,
  webhook: { readonly deliveryId: string; readonly request: WebhookRequest },
): Effect.Effect<null, BoardWebhookRuleError> | null {
  if (task.prompt !== BOARD_RULE_PROMPT && task.boardAction === undefined) return null;
  return Effect.gen(function* () {
    const action = task.boardAction;
    if (action === undefined) {
      return yield* new BoardWebhookRuleError({ message: "Board rule is missing." });
    }
    const runner = registeredRunner;
    if (runner === null) return yield* new BoardWebhookRuleError({ message: NOT_RUNNING });
    const line = yield* runner.run({
      taskId: task.id,
      taskTitle: task.title,
      projectId: task.projectId,
      deliveryId: webhook.deliveryId,
      request: webhook.request,
      action,
    });
    yield* sql`
      UPDATE scheduled_task_webhook_deliveries SET rendered_prompt = ${line}
      WHERE delivery_id = ${webhook.deliveryId}
    `.pipe(
      Effect.mapError(
        (cause) =>
          new BoardWebhookRuleError({ message: `Could not record the result: ${String(cause)}` }),
      ),
    );
    return null;
  }).pipe(Effect.withSpan("BoardWebhookRules.runDelivery"));
}
