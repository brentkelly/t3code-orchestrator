/**
 * Shell-stream coalescing (ws.ts). The load-bearing case is a board card that
 * moves into an auto-executing stage: the supervisor selects and admits its step
 * milliseconds later, so all three events land in one coalescing window on the
 * SAME aggregate. Board deltas are built from the event payload, not a refetch,
 * so collapsing them per aggregate silently dropped the move and the client's
 * board column never updated.
 */
import type { OrchestrationEvent } from "@t3tools/contracts";
import { describe, expect, it } from "vitest";

import { coalesceShellWindow } from "./shellCoalesce.ts";

const event = (input: {
  readonly sequence: number;
  readonly type: string;
  readonly aggregateKind: string;
  readonly aggregateId: string;
}): OrchestrationEvent => input as unknown as OrchestrationEvent;

const cardEvent = (sequence: number, type: string, cardId = "card-1") =>
  event({ sequence, type, aggregateKind: "card", aggregateId: cardId });

describe("coalesceShellWindow", () => {
  it("keeps a card move that lands alongside its step selection and admission", () => {
    const survivors = coalesceShellWindow([
      cardEvent(1, "board.card-moved"),
      cardEvent(2, "board.card-step-selected"),
      cardEvent(3, "board.card-step-admitted"),
    ]);

    expect(survivors.map((survivor) => survivor.type)).toEqual([
      "board.card-moved",
      "board.card-step-selected",
      "board.card-step-admitted",
    ]);
  });

  it("collapses repeats of one board event type on one card, keeping the last", () => {
    const survivors = coalesceShellWindow([
      cardEvent(1, "board.card-reordered"),
      cardEvent(2, "board.card-reordered"),
      cardEvent(3, "board.card-moved"),
    ]);

    expect(survivors.map((survivor) => survivor.sequence)).toEqual([2, 3]);
  });

  it("keeps board events of different cards apart", () => {
    const survivors = coalesceShellWindow([
      cardEvent(1, "board.card-moved", "card-1"),
      cardEvent(2, "board.card-moved", "card-2"),
    ]);

    expect(survivors).toHaveLength(2);
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

    expect(survivors.map((survivor) => survivor.sequence)).toEqual([3]);
  });

  it("returns survivors in ascending sequence order", () => {
    const survivors = coalesceShellWindow([
      cardEvent(5, "board.card-moved", "card-2"),
      cardEvent(1, "board.card-moved", "card-1"),
      cardEvent(9, "board.card-updated", "card-1"),
    ]);

    expect(survivors.map((survivor) => survivor.sequence)).toEqual([1, 5, 9]);
  });
});
