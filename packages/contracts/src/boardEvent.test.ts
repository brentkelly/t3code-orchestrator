import * as Schema from "effect/Schema";
import { describe, expect, it } from "@effect/vitest";

import { BOARD_EVENT_TYPES, BoardClientCommand, BoardShellStreamItem } from "./board.ts";
import { BoardEvent, BoardEventType } from "./boardEvent.ts";
import { OrchestrationV2Command, OrchestrationV2DomainEvent } from "./orchestrationV2.ts";

const decodeBoardEvent = Schema.decodeUnknownExit(BoardEvent);
const decodeBoardClientCommand = Schema.decodeUnknownExit(BoardClientCommand);
const decodeBoardItem = Schema.decodeUnknownExit(BoardShellStreamItem);
const decodeV2Command = Schema.decodeUnknownExit(OrchestrationV2Command);
const decodeV2Event = Schema.decodeUnknownExit(OrchestrationV2DomainEvent);

// T3O-56: board events and commands belong to the board's own engine, not to
// upstream's orchestration unions. T3O-57: clients send board commands over
// `board.dispatchCommand`, so upstream's wire union carries none either.
const cardCreated = {
  sequence: 1,
  eventId: "evt-1",
  aggregateKind: "card",
  aggregateId: "card-1",
  occurredAt: "2026-01-01T00:00:00.000Z",
  commandId: "cmd-1",
  causationEventId: null,
  correlationId: null,
  metadata: {},
  type: "board.card-created",
  payload: {
    cardId: "card-1",
    projectId: "project-1",
    key: "CARD-1",
    title: "First",
    orderKey: "m",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  },
};

describe("board events (T3O-56)", () => {
  it("decode as board events and not as orchestration events", () => {
    expect(decodeBoardEvent(cardCreated)._tag).toBe("Success");
    expect(decodeV2Event(cardCreated)._tag).toBe("Failure");
  });

  it("keep their own type registry", () => {
    expect([...BoardEventType.literals].toSorted()).toEqual([...BOARD_EVENT_TYPES].toSorted());
  });

  it("decode metadata a v1-era row carried", () => {
    const inherited = { ...cardCreated, metadata: { ingestedAt: "2026-01-01T00:00:00.000Z" } };
    expect(decodeBoardEvent(inherited)._tag).toBe("Success");
  });

  it("leave board commands off upstream's command union, onto the board's own", () => {
    const move = {
      type: "board.card.move",
      commandId: "cmd-move",
      cardId: "card-1",
      toStage: "sprint",
      createdAt: "2026-01-01T00:00:00.000Z",
    };
    expect(decodeBoardClientCommand(move)._tag).toBe("Success");
    expect(decodeV2Command(move)._tag).toBe("Failure");
  });
});

describe("the board's own stream (T3O-57)", () => {
  const labelUpserted = {
    kind: "label-upserted",
    sequence: 3,
    label: {
      labelId: "label-1",
      name: "Bug",
      colour: "#ef4444",
      deletedAt: null,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    },
  };

  it("carries board deltas", () => {
    expect(decodeBoardItem(labelUpserted)._tag).toBe("Success");
  });
});
