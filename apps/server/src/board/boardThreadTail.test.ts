/**
 * The board's read-only tail of upstream's log (T3O-56): where it resumes.
 *
 * The tail's cursor lives in `boards.sqlite` and counts sequences in
 * `state.sqlite`. Two files can drift apart — a backup restored for one and not
 * the other, or copies taken a moment apart — and a cursor AHEAD of upstream's
 * head would silently skip every new plan update until the log caught up with
 * it. Each case builds its own tail after arranging the cursor.
 */
import {
  BoardCardId,
  CommandId,
  EventId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { BoardQueries } from "./BoardQueries.ts";
import { boardStackEngine, makeBoardStackTestLayerWithoutTail } from "./boardStack.testkit.ts";
import {
  BOARD_THREAD_TAIL_PROJECTOR,
  BoardThreadTail,
  BoardThreadTailLive,
} from "./boardThreadTail.ts";

const t0 = "2026-01-01T00:00:00.000Z";
const instance = ProviderInstanceId.make("codex");

/** A project, a card, and a thread linked to it — named by `tag`. */
const seedLinkedThread = (tag: string) =>
  Effect.gen(function* () {
    const engine = yield* boardStackEngine;
    const projectId = ProjectId.make(`project-${tag}`);
    const cardId = BoardCardId.make(`card-${tag}`);
    const threadId = ThreadId.make(`thread-${tag}`);
    yield* engine.dispatch({
      type: "project.create",
      commandId: CommandId.make(`cmd-project-${tag}`),
      projectId,
      title: `Project ${tag}`,
      workspaceRoot: `/tmp/${tag}`,
      defaultModelSelection: { instanceId: instance, model: "gpt-5-codex" },
      createdAt: t0,
    });
    yield* engine.dispatch({
      type: "board.card.create",
      commandId: CommandId.make(`cmd-card-${tag}`),
      cardId,
      projectId,
      title: `Card ${tag}`,
      createdAt: t0,
    });
    yield* engine.dispatch({
      type: "thread.create",
      commandId: CommandId.make(`cmd-thread-${tag}`),
      threadId,
      projectId,
      title: `Thread ${tag}`,
      modelSelection: { instanceId: instance, model: "gpt-5-codex" },
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      createdAt: t0,
    });
    yield* engine.dispatch({
      type: "board.card.link-thread",
      commandId: CommandId.make(`cmd-link-${tag}`),
      cardId,
      threadId,
      role: "building",
      createdAt: t0,
    });
    return threadId;
  });

const appendPlan = (threadId: ThreadId, tag: string) =>
  Effect.gen(function* () {
    const engine = yield* boardStackEngine;
    yield* engine.dispatch({
      type: "thread.activity.append",
      commandId: CommandId.make(`cmd-plan-${tag}`),
      threadId,
      activity: {
        id: EventId.make(`activity-${tag}`),
        tone: "info",
        kind: "turn.plan.updated",
        summary: "Plan updated",
        payload: { plan: [{ step: "Only step", status: "inProgress" }] },
        turnId: null,
        createdAt: t0,
      },
      createdAt: t0,
    });
  });

/** Put the tail's cursor where a test wants it, before the tail starts. */
const setCursor = (sequence: number) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`
      INSERT INTO boards.projection_state (projector, last_applied_sequence, updated_at)
      VALUES (${BOARD_THREAD_TAIL_PROJECTOR}, ${sequence}, ${t0})
      ON CONFLICT (projector) DO UPDATE SET last_applied_sequence = excluded.last_applied_sequence`;
  });

/** A tail of its own, started now — as a server boot would start it. */
const withFreshTail = <A, E, R>(body: Effect.Effect<A, E, R>) =>
  body.pipe(Effect.provide(BoardThreadTailLive.pipe(Layer.fresh)));

it.layer(makeBoardStackTestLayerWithoutTail("t3o-board-thread-tail-"))(
  "board thread tail",
  (it) => {
    it.effect("resumes at upstream's head when its cursor has run ahead of the log", () =>
      Effect.gen(function* () {
        const engine = yield* boardStackEngine;
        const threadId = yield* seedLinkedThread("ahead");
        const head = yield* engine.latestSequence;
        yield* setCursor(head + 5);

        const todo = yield* withFreshTail(
          Effect.gen(function* () {
            const tail = yield* BoardThreadTail;
            // The plan lands at head + 1 — behind the stale cursor.
            yield* appendPlan(threadId, "ahead");
            yield* tail.drain;
            return yield* (yield* BoardQueries).boardThreadTodo(threadId);
          }),
        );
        assert.isNotNull(todo);
        assert.strictEqual(todo?.totalCount, 1);
      }),
    );

    it.effect("catches up on plan updates committed while it was not running", () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const engine = yield* boardStackEngine;
        const threadId = yield* seedLinkedThread("behind");
        const head = yield* engine.latestSequence;
        // A cursor from before the plan update, as a restart leaves it.
        yield* setCursor(head);
        yield* appendPlan(threadId, "behind");
        yield* sql`
        DELETE FROM boards.board_thread_todos WHERE thread_id = ${threadId}`;

        const todo = yield* withFreshTail(
          Effect.gen(function* () {
            yield* (yield* BoardThreadTail).drain;
            return yield* (yield* BoardQueries).boardThreadTodo(threadId);
          }),
        );
        assert.strictEqual(todo?.totalCount, 1);
      }),
    );
  },
);
