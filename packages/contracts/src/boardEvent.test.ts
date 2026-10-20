import * as Schema from "effect/Schema";
import { describe, expect, it } from "@effect/vitest";

import { BOARD_CLIENT_COMMANDS, BOARD_EVENT_TYPES } from "./board.ts";
import { BoardEvent, BoardEventType } from "./boardEvent.ts";
import {
  ClientOrchestrationCommand,
  OrchestrationCommand,
  OrchestrationEvent,
  OrchestrationEventType,
} from "./orchestration.ts";

const decodeBoardEvent = Schema.decodeUnknownExit(BoardEvent);
const decodeOrchestrationEvent = Schema.decodeUnknownExit(OrchestrationEvent);
const decodeClientCommand = Schema.decodeUnknownExit(ClientOrchestrationCommand);
const decodeServerCommand = Schema.decodeUnknownExit(OrchestrationCommand);

// T3O-56: board events and commands belong to the board's own engine, not to
// upstream's orchestration unions — except that clients still SEND board
// commands over `orchestration.dispatchCommand`, so the wire union keeps them.
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
    expect(decodeOrchestrationEvent(cardCreated)._tag).toBe("Failure");
  });

  it("keep their own type registry, disjoint from upstream's", () => {
    expect([...BoardEventType.literals].toSorted()).toEqual([...BOARD_EVENT_TYPES].toSorted());
    expect(OrchestrationEventType.literals.some((type) => type.startsWith("board."))).toBe(false);
  });

  it("leave board commands off the server-side command union but on the wire", () => {
    const move = {
      type: "board.card.move",
      commandId: "cmd-move",
      cardId: "card-1",
      toStage: "sprint",
      createdAt: "2026-01-01T00:00:00.000Z",
    };
    expect(decodeClientCommand(move)._tag).toBe("Success");
    expect(decodeServerCommand(move)._tag).toBe("Failure");
    expect(BOARD_CLIENT_COMMANDS.length).toBeGreaterThan(0);
  });
});
