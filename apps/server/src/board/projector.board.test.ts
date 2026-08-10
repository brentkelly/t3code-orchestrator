/**
 * T3o board projector (t3o-03): legacy walking-skeleton payloads decode to
 * the documented defaults, archive keeps the card in the read model while
 * the shell drops it, tombstoned links survive projection, and the created
 * counter bump is monotonic.
 */
import {
  BOARD_SEED_LABEL_IDS,
  BoardCardId,
  boardCardShellFromCard,
  EventId,
  LEGACY_BOARD_CARD_KEY,
  LEGACY_BOARD_CARD_NUMBER,
  LEGACY_BOARD_CARD_ORDER_KEY,
  ProjectId,
  ThreadId,
  type BoardCard,
  type OrchestrationReadModel,
} from "@t3tools/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import { boardShellStreamEvent, projectBoardEvent, type BoardEvent } from "./projector.ts";

const NOW = "2026-01-01T00:00:00.000Z";
const projectId = ProjectId.make("project-1");
const cardId = BoardCardId.make("card-1");

function emptyModel(): OrchestrationReadModel {
  return {
    snapshotSequence: 0,
    projects: [],
    threads: [],
    updatedAt: NOW,
  };
}

function makeCard(overrides: Partial<BoardCard>): BoardCard {
  return {
    id: cardId,
    key: "CARD-1",
    cardNumber: 1,
    projectId,
    labels: [],
    stage: "backlog",
    orderKey: "m",
    title: "Card",
    briefRef: null,
    dependsOn: [],
    parentCardId: null,
    threadLinks: [],
    externalRef: null,
    recipeSnapshot: null,
    blocked: false,
    archivedAt: null,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

const eventBase = {
  sequence: 1,
  eventId: EventId.make("event-1"),
  aggregateKind: "card",
  aggregateId: cardId,
  occurredAt: NOW,
  commandId: null,
  causationEventId: null,
  correlationId: null,
  metadata: {},
} as const;

describe("board projector", () => {
  it.effect("replays a walking-skeleton created payload with the legacy defaults", () =>
    Effect.gen(function* () {
      // The exact five-field payload t3o-02 wrote to real event logs.
      const legacyEvent = {
        ...eventBase,
        type: "board.card-created",
        payload: {
          cardId,
          projectId,
          title: "Legacy card",
          createdAt: NOW,
          updatedAt: NOW,
        },
      } as unknown as BoardEvent;

      const model = yield* projectBoardEvent(emptyModel(), legacyEvent);
      const card = model.board?.cards[0];
      assert.isDefined(card);
      assert.strictEqual(card?.key, LEGACY_BOARD_CARD_KEY);
      assert.strictEqual(card?.cardNumber, LEGACY_BOARD_CARD_NUMBER);
      // A legacy payload with no cardType/labels maps to the feature seed label.
      assert.deepStrictEqual(card?.labels, [BOARD_SEED_LABEL_IDS.feature]);
      assert.strictEqual(card?.stage, "backlog");
      assert.strictEqual(card?.orderKey, LEGACY_BOARD_CARD_ORDER_KEY);
      // Legacy card 0 still reserves number 1 for the next create, matching
      // the MAX(card_number) + 1 rehydration.
      assert.deepStrictEqual(model.board?.nextCardNumberByProject, { [projectId]: 1 });
    }),
  );

  it.effect("bumps the project counter monotonically on create", () =>
    Effect.gen(function* () {
      const event = {
        ...eventBase,
        type: "board.card-created",
        payload: {
          cardId,
          projectId,
          title: "Card",
          key: "CARD-5",
          cardNumber: 5,
          cardType: "bug",
          stage: "backlog",
          orderKey: "m",
          createdAt: NOW,
          updatedAt: NOW,
        },
      } as unknown as BoardEvent;
      const model = yield* projectBoardEvent(emptyModel(), event);
      assert.deepStrictEqual(model.board?.nextCardNumberByProject, { [projectId]: 6 });
    }),
  );

  it.effect("keeps an archived card in the read model while the shell drops it", () =>
    Effect.gen(function* () {
      const archivedCard = makeCard({ archivedAt: NOW });
      const event: BoardEvent = {
        ...eventBase,
        type: "board.card-archived",
        payload: { cardId, archivedAt: NOW, card: archivedCard },
      };

      const model = yield* projectBoardEvent(
        {
          ...emptyModel(),
          board: { cards: [makeCard({})], labels: [], nextCardNumberByProject: { [projectId]: 2 } },
        },
        event,
      );
      // Still in the model — unarchive must be able to restore it on replay.
      assert.deepStrictEqual(model.board?.cards, [archivedCard]);

      // But the shell sees a removal.
      const delta = boardShellStreamEvent(event);
      assert.deepStrictEqual(Option.getOrNull(delta), {
        kind: "card-removed",
        sequence: 1,
        cardId,
      });

      // And unarchiving emits the card back onto the shell — as the bounded
      // shell (t3o-04), never the full aggregate.
      const restoredCard = makeCard({});
      const unarchived: BoardEvent = {
        ...eventBase,
        sequence: 2,
        type: "board.card-unarchived",
        payload: { cardId, card: restoredCard },
      };
      assert.deepStrictEqual(Option.getOrNull(boardShellStreamEvent(unarchived)), {
        kind: "card-upserted",
        sequence: 2,
        card: boardCardShellFromCard(restoredCard),
      });
    }),
  );

  it.effect("projects a tombstoned link as retained, not removed", () =>
    Effect.gen(function* () {
      const tombstonedCard = makeCard({
        threadLinks: [
          {
            threadId: ThreadId.make("thread-1"),
            role: "review:r1:triage",
            linkedAt: NOW,
            tombstonedAt: NOW,
          },
        ],
      });
      const event: BoardEvent = {
        ...eventBase,
        type: "board.card-thread-unlinked",
        payload: {
          cardId,
          threadId: ThreadId.make("thread-1"),
          tombstonedAt: NOW,
          card: tombstonedCard,
        },
      };
      const model = yield* projectBoardEvent(
        {
          ...emptyModel(),
          board: { cards: [makeCard({})], labels: [], nextCardNumberByProject: {} },
        },
        event,
      );
      assert.deepStrictEqual(model.board?.cards[0]?.threadLinks, tombstonedCard.threadLinks);
    }),
  );
});
