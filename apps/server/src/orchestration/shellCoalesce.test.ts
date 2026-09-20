/**
 * Shell-stream coalescing (ws.ts). The load-bearing case is a board card that
 * moves into an auto-executing stage: the supervisor selects and admits its step
 * milliseconds later, so all three events land in one coalescing window on the
 * SAME aggregate. Board deltas are built from the event payload, not a refetch,
 * so collapsing them per aggregate silently dropped the move and the client's
 * board column never updated.
 */
import { ThreadId, type OrchestrationEvent } from "@t3tools/contracts";
import { assert, describe, it } from "@effect/vitest";

import {
  coalesceShellWindow,
  toShellWindowEvent,
  type ShellWindowEvent,
} from "./shellCoalesce.ts";

const event = (input: {
  readonly sequence: number;
  readonly type: string;
  readonly aggregateKind: string;
  readonly aggregateId: string;
}): ShellWindowEvent => toShellWindowEvent(input as unknown as OrchestrationEvent);

const cardEvent = (sequence: number, type: string, cardId = "card-1") =>
  event({ sequence, type, aggregateKind: "card", aggregateId: cardId });

describe("coalesceShellWindow", () => {
  it("keeps a card move that lands alongside its step selection and admission", () => {
    const survivors = coalesceShellWindow([
      cardEvent(1, "board.card-moved"),
      cardEvent(2, "board.card-step-selected"),
      cardEvent(3, "board.card-step-admitted"),
    ]);

    assert.deepStrictEqual(
      survivors.map((survivor) => survivor.type),
      ["board.card-moved", "board.card-step-selected", "board.card-step-admitted"],
    );
  });

  it("collapses repeats of one board event type on one card, keeping the last", () => {
    const survivors = coalesceShellWindow([
      cardEvent(1, "board.card-reordered"),
      cardEvent(2, "board.card-reordered"),
      cardEvent(3, "board.card-moved"),
    ]);

    assert.deepStrictEqual(
      survivors.map((survivor) => survivor.sequence),
      [2, 3],
    );
  });

  it("keeps board events of different cards apart", () => {
    const survivors = coalesceShellWindow([
      cardEvent(1, "board.card-moved", "card-1"),
      cardEvent(2, "board.card-moved", "card-2"),
    ]);

    assert.strictEqual(survivors.length, 2);
  });

  it("still collapses a thread's burst to its last event — those deltas refetch", () => {
    const survivors = coalesceShellWindow([
      event({
        sequence: 1,
        type: "thread.message-sent",
        aggregateKind: "thread",
        aggregateId: "thread-1",
      }),
      event({
        sequence: 2,
        type: "thread.turn-start-requested",
        aggregateKind: "thread",
        aggregateId: "thread-1",
      }),
      event({
        sequence: 3,
        type: "thread.message-sent",
        aggregateKind: "thread",
        aggregateId: "thread-1",
      }),
    ]);

    assert.deepStrictEqual(
      survivors.map((survivor) => survivor.sequence),
      [3],
    );
  });

  it("returns survivors in ascending sequence order", () => {
    const survivors = coalesceShellWindow([
      cardEvent(5, "board.card-moved", "card-2"),
      cardEvent(1, "board.card-moved", "card-1"),
      cardEvent(9, "board.card-updated", "card-1"),
    ]);

    assert.deepStrictEqual(
      survivors.map((survivor) => survivor.sequence),
      [1, 5, 9],
    );
  });
});

describe("toShellWindowEvent", () => {
  it("keeps a board event whole, because its delta is built from the payload", () => {
    const moved = {
      sequence: 7,
      type: "board.card-moved",
      aggregateKind: "card",
      aggregateId: "card-1",
      payload: { cardId: "card-1", toStage: "building" },
    } as unknown as OrchestrationEvent;

    assert.strictEqual<unknown>(toShellWindowEvent(moved), moved);
  });

  it("drops a thread event's body so a streaming burst holds no transcript", () => {
    const sent = {
      sequence: 8,
      type: "thread.message-sent",
      aggregateKind: "thread",
      aggregateId: "thread-1",
      payload: { threadId: "thread-1", text: "a very long assistant message" },
    } as unknown as OrchestrationEvent;

    assert.deepStrictEqual(toShellWindowEvent(sent), {
      sequence: 8,
      type: "thread.message-sent",
      aggregateKind: "thread",
      aggregateId: ThreadId.make("thread-1"),
      todosChanged: false,
    });
  });

  it("remembers that a plan update rewrote the thread's todo list", () => {
    const activity = (kind: string) =>
      ({
        sequence: 9,
        type: "thread.activity-appended",
        aggregateKind: "thread",
        aggregateId: "thread-1",
        payload: { threadId: "thread-1", activity: { kind } },
      }) as unknown as OrchestrationEvent;

    const planUpdated = toShellWindowEvent(activity("turn.plan.updated"));
    const toolCall = toShellWindowEvent(activity("tool.completed"));

    assert.strictEqual("todosChanged" in planUpdated && planUpdated.todosChanged, true);
    assert.strictEqual("todosChanged" in toolCall && toolCall.todosChanged, false);
  });
});
