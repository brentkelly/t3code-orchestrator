/**
 * `boardCardThreadsShellEvents` (t3o-18): which orchestration events imply a
 * `card-threads` shell delta.
 *
 * The mapper is the live push path for todo summaries, so its TRIGGER set is
 * load-bearing: too broad and every streamed message chunk on a linked thread
 * refetches an unchanged list; too narrow and a dropped cache row (deleted
 * thread) leaves a stale strip on the client. This pins the exact set.
 */
import { ThreadId, type OrchestrationEvent } from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { boardCardThreadsShellEvents } from "./rpc.ts";

const cardId = "card-1";
const threadId = ThreadId.make("thread-1");

/** A snapshot-query double exposing just the board method set the mapper reads;
    `boardCardIdForThread` resolves the one live-linked thread to its card. */
const snapshotStub = {
  boardCardDetail: () => Effect.succeed(null),
  boardCardActivity: () => Effect.succeed([]),
  boardPlanBody: () => Effect.succeed(null),
  boardCardThreads: () => Effect.succeed([{ cardId, threadId }]),
  boardCardIdForThread: (id: ThreadId) =>
    Effect.succeed(String(id) === String(threadId) ? cardId : null),
  boardThreadTodo: () => Effect.succeed(null),
  boardSweepThreadTodos: () => Effect.void,
} as never;

const mapper = boardCardThreadsShellEvents({ projectionSnapshotQuery: snapshotStub });

/** Run the mapper on an event and collect its deltas — a plain Effect, yielded
    inside each `it.effect` (no manual runtime). */
const run = (event: unknown) =>
  mapper(event as OrchestrationEvent).pipe(Effect.map((deltas) => [...deltas]));

const planUpdate = (kind: string): OrchestrationEvent =>
  ({
    type: "thread.activity-appended",
    aggregateKind: "thread",
    aggregateId: threadId,
    sequence: 5,
    payload: { threadId, activity: { kind } },
  }) as unknown as OrchestrationEvent;

it.effect("emits a card-threads delta for a turn.plan.updated activity append", () =>
  Effect.gen(function* () {
    const deltas = yield* run(planUpdate("turn.plan.updated"));
    assert.strictEqual(deltas.length, 1);
    assert.strictEqual(deltas[0]?.kind, "card-threads");
    assert.strictEqual(deltas[0]?.sequence, 5);
  }),
);

it.effect("emits nothing for a non-plan activity append (e.g. a streamed message)", () =>
  Effect.gen(function* () {
    assert.deepStrictEqual(yield* run(planUpdate("message")), []);
  }),
);

it.effect("emits nothing for a bare thread event with no todo-relevant payload", () =>
  Effect.gen(function* () {
    const sessionEvent = {
      type: "thread.session.updated",
      aggregateKind: "thread",
      aggregateId: threadId,
      sequence: 7,
      payload: { threadId },
    };
    assert.deepStrictEqual(yield* run(sessionEvent), []);
  }),
);

it.effect("emits a card-threads delta on thread.deleted (the cache row was dropped)", () =>
  Effect.gen(function* () {
    const deleted = {
      type: "thread.deleted",
      aggregateKind: "thread",
      aggregateId: threadId,
      sequence: 9,
      payload: { threadId },
    };
    const deltas = yield* run(deleted);
    assert.strictEqual(deltas.length, 1);
    assert.strictEqual(deltas[0]?.kind, "card-threads");
  }),
);

it.effect("emits a card-threads delta on a link-set change", () =>
  Effect.gen(function* () {
    const linked = {
      type: "board.card-thread-linked",
      aggregateKind: "card",
      aggregateId: cardId,
      sequence: 11,
      payload: { cardId, threadId },
    };
    const deltas = yield* run(linked);
    assert.strictEqual(deltas.length, 1);
    assert.strictEqual(deltas[0]?.kind, "card-threads");
  }),
);
