/**
 * T3O-76 — human-in-the-loop is the human's toggle and nothing else's.
 *
 * Two bugs, one rule. A human-in-the-loop step that reached
 * `board_complete_step` sat in its stage forever, because `advanceStage`
 * skipped every human-in-the-loop run; it now honours the stage's
 * `autoAdvance` exactly as an unattended run does. And a human messaging a
 * running board agent flipped the card to human-in-the-loop and paused it:
 * the queued message they steered in read as a Stop at the gateway, and a Stop
 * flipped the card. Both halves are covered here through the live reactor.
 */
import {
  BOARD_SEED_STAGE_IDS,
  BoardCardId,
  boardCardStepState,
  CommandId,
  EventId,
  MessageId,
  RunId,
  type BoardState,
  type OrchestrationV2StoredEvent,
  type ThreadId,
} from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";

import { makeSignalReader } from "./ThreadGatewayV2.ts";
import {
  buildingCard,
  cardMoved,
  cardStage,
  codexStep,
  makeBoardCard,
  movedToBuilding,
  settingsWith,
  stepCompleted,
  stepStatus,
  withGovernor,
} from "./supervisorHarness.testkit.ts";

const cardHumanInLoop = (board: BoardState, id: BoardCardId) =>
  board.cards.find((candidate) => candidate.id === id)?.humanInLoop;

// ── Bug 1: a finished human-in-the-loop step advances ─────────────────────

it.effect("a human-in-the-loop build that completes moves on to Code review", () =>
  withGovernor(
    {
      board: { cards: [buildingCard("hitl", "m", true)], nextCardNumberByProject: {} },
      settings: settingsWith({ building: [codexStep], globalMaxConcurrent: 3 }),
    },
    ({ pumpDomain, board }) =>
      Effect.gen(function* () {
        const id = BoardCardId.make("hitl");
        yield* pumpDomain(movedToBuilding(buildingCard("hitl", "m", true), 1));
        assert.isTrue(boardCardStepState(yield* board, id)?.humanInLoop);

        yield* pumpDomain(stepCompleted(id, "succeeded", 2));

        assert.strictEqual(cardStage(yield* board, id), BOARD_SEED_STAGE_IDS.review);
      }),
  ),
);

it.effect("a human-in-the-loop build stays put when Building's auto-advance is off", () =>
  withGovernor(
    {
      board: { cards: [buildingCard("held", "m", true)], nextCardNumberByProject: {} },
      settings: settingsWith({
        building: [codexStep],
        globalMaxConcurrent: 3,
        buildAutoAdvance: false,
      }),
    },
    ({ pumpDomain, board }) =>
      Effect.gen(function* () {
        const id = BoardCardId.make("held");
        yield* pumpDomain(movedToBuilding(buildingCard("held", "m", true), 1));
        yield* pumpDomain(stepCompleted(id, "succeeded", 2));

        const after = yield* board;
        assert.strictEqual(stepStatus(after, id), "succeeded");
        assert.strictEqual(cardStage(after, id), BOARD_SEED_STAGE_IDS.building);
      }),
  ),
);

const planningCard = () => makeBoardCard({ id: "plan", stage: "planning", orderKey: "m" });

const completePlanning = (planningAutoAdvance: boolean, expectedStage: string) =>
  withGovernor(
    {
      board: { cards: [planningCard()], nextCardNumberByProject: {} },
      settings: settingsWith({
        building: [codexStep],
        planning: codexStep,
        planningHumanInLoop: true,
        planningAutoAdvance,
        globalMaxConcurrent: 3,
      }),
    },
    ({ pumpDomain, board }) =>
      Effect.gen(function* () {
        const id = BoardCardId.make("plan");
        yield* pumpDomain(cardMoved(planningCard(), "sprint", "planning", 1));
        assert.isTrue(boardCardStepState(yield* board, id)?.humanInLoop);

        yield* pumpDomain(stepCompleted(id, "succeeded", 2, String(BOARD_SEED_STAGE_IDS.planning)));
        assert.strictEqual(cardStage(yield* board, id), expectedStage);
      }),
  );

it.effect("a human-in-the-loop planning step advances when Planning opts into it", () =>
  completePlanning(true, BOARD_SEED_STAGE_IDS.ready),
);

it.effect("a human-in-the-loop planning step waits for a human by default", () =>
  completePlanning(false, BOARD_SEED_STAGE_IDS.planning),
);

// ── Bug 2: messaging a running agent changes nothing on the card ──────────

const CLIENT_COMMAND_ID = "8c7f0f0e-6d2b-4a5e-9a1d-0f2b3c4d5e6f";
const t0 = DateTime.makeUnsafe("2026-10-20T00:00:00.000Z");
let sequence = 0;
const stored = (
  threadId: ThreadId,
  type: string,
  payload: object,
  commandId: string | null,
): OrchestrationV2StoredEvent =>
  ({
    sequence: (sequence += 1),
    commandId: commandId === null ? null : CommandId.make(commandId),
    event: { type, id: EventId.make(`evt-${sequence}`), threadId, occurredAt: t0, payload },
  }) as unknown as OrchestrationV2StoredEvent;

/** What v2 records when a human types into a busy thread and then promotes the
    queued message to a steer (or deletes it): the queued run and its message,
    then that run cancelled straight out of the queue under the human's command. */
const queuedThenSteered = (threadId: ThreadId) => {
  const messageId = MessageId.make("message-queued");
  const run = (status: string, queuePosition: number | null) => ({
    id: RunId.make("run-queued"),
    threadId,
    status,
    queuePosition,
    userMessageId: messageId,
    requestedAt: t0,
    startedAt: null,
  });
  return [
    stored(threadId, "run.created", run("queued", 1), CLIENT_COMMAND_ID),
    stored(
      threadId,
      "message.updated",
      { id: messageId, role: "user", createdBy: "user", creationSource: "web" },
      CLIENT_COMMAND_ID,
    ),
    stored(threadId, "run.updated", run("cancelled", null), "a1b2c3d4-0000-4000-8000-000000000000"),
  ];
};

it.effect("a message steered into a running unattended build leaves the card as it was", () =>
  withGovernor(
    {
      board: { cards: [buildingCard("steered", "m")], nextCardNumberByProject: {} },
      settings: settingsWith({ building: [codexStep], globalMaxConcurrent: 3 }),
    },
    ({ pumpDomain, board }) =>
      Effect.gen(function* () {
        const id = BoardCardId.make("steered");
        yield* pumpDomain(movedToBuilding(buildingCard("steered", "m"), 1));
        const running = boardCardStepState(yield* board, id);
        assert.strictEqual(running?.status, "running");
        assert.isFalse(running?.humanInLoop);

        // Through the real signal reader, so this covers the gateway's reading
        // of the cancelled queued run as well as the reactor's handling of it.
        const read = makeSignalReader();
        for (const event of queuedThenSteered(running!.threadId!)) {
          for (const signal of read(event)) yield* pumpDomain(signal);
        }

        const after = yield* board;
        assert.strictEqual(stepStatus(after, id), "running");
        assert.isNull(cardHumanInLoop(after, id));
        assert.isFalse(boardCardStepState(after, id)?.humanInLoop);
      }),
  ),
);
