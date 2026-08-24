/**
 * How a supervised step gets its thread — the seam between the board and the
 * thread aggregate.
 *
 * The board dispatches straight into the orchestration engine. A
 * `thread.turn.start` carrying `bootstrap.createThread` does NOT create a
 * thread there: that block is unpacked by the WebSocket dispatch path
 * (`dispatchBootstrapTurnStart` in ws.ts), so an engine dispatch is decided as
 * an ordinary turn start and rejected — "thread does not exist". The board
 * shipped exactly that, and every auto-executing stage silently admitted a step
 * as `running` against a thread that was never created: no thread appeared on
 * the card, and the phantom live step then made the "+ → restart" menu a no-op
 * (one step at a time). These tests pin both halves — the spawn creates its own
 * thread, and a spawn that fails leaves the card recoverable.
 */
import { BoardCardId, BOARD_SEED_STAGE_IDS, boardCardStepState } from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import {
  buildingCard,
  cardMoved,
  codexStep,
  makeBoardCard,
  movedToBuilding,
  settingsWith,
  stepStatus,
  withGovernor,
} from "./supervisorHarness.testkit.ts";

const sprintCard = () => makeBoardCard({ id: "card-1", stage: "sprint", orderKey: "m" });
const cardId = BoardCardId.make("card-1");

/** Sprint → Planning, the human gate the detail modal's "Move to Planning" and a
    drag both settle as. */
const movedToPlanning = (sequence: number) =>
  cardMoved(
    makeBoardCard({ id: "card-1", stage: "planning", orderKey: "m" }),
    "sprint",
    "planning",
    sequence,
  );

it.effect("a card dropped into an auto-executing stage gets a thread of its own", () =>
  withGovernor(
    {
      board: { cards: [sprintCard()], nextCardNumberByProject: {} },
      settings: settingsWith({
        building: [codexStep],
        planning: codexStep,
        globalMaxConcurrent: 3,
      }),
    },
    ({ pumpDomain, board, commands }) =>
      Effect.gen(function* () {
        yield* pumpDomain(movedToPlanning(1));

        const state = boardCardStepState(yield* board, cardId);
        assert.strictEqual(state?.status, "running");
        assert.strictEqual(state?.stepId, String(BOARD_SEED_STAGE_IDS.planning));
        const threadId = state?.threadId ?? null;
        assert.isNotNull(threadId, "the admitted step names the thread it runs on");

        const dispatched = yield* commands;
        const create = dispatched.find(
          (command) => command.type === "thread.create" && command.threadId === threadId,
        );
        const turn = dispatched.find(
          (command) => command.type === "thread.turn.start" && command.threadId === threadId,
        );
        assert.isDefined(create, "the step's thread is created before its first turn");
        assert.isDefined(turn, "the step's prompt is sent as the thread's first turn");
        assert.isBelow(
          dispatched.indexOf(create!),
          dispatched.indexOf(turn!),
          "create precedes the turn",
        );
        // The link is what puts the thread on the card in the UI; it can only
        // land for a thread that exists.
        assert.isDefined(
          dispatched.find(
            (command) => command.type === "board.card.link-thread" && command.threadId === threadId,
          ),
          "the spawned thread is linked to the card",
        );
      }),
  ),
);

it.effect(
  "a spawn that cannot create its thread leaves the card stalled, not phantom-running",
  () =>
    withGovernor(
      {
        board: { cards: [sprintCard()], nextCardNumberByProject: {} },
        settings: settingsWith({
          building: [codexStep],
          planning: codexStep,
          globalMaxConcurrent: 3,
        }),
        rejectThreadCreate: true,
      },
      ({ pumpDomain, board, commands }) =>
        Effect.gen(function* () {
          yield* pumpDomain(movedToPlanning(1));

          // `stalled` is the loud, human-visible status an on-demand restart
          // supersedes — never `running` against a thread that does not exist,
          // which would read as a live run and wedge every later kickoff.
          assert.strictEqual(stepStatus(yield* board, cardId), "stalled");
          assert.isNull(boardCardStepState(yield* board, cardId)?.threadId ?? null);
          assert.isUndefined(
            (yield* commands).find(
              (command) => command.type === "board.card.admit-step" && command.admitted,
            ),
            "a step with no thread is never admitted",
          );
        }),
    ),
);

it.effect("a build-mode spawn failure gives the slot back, so the next card still runs", () =>
  withGovernor(
    {
      board: {
        cards: [buildingCard("card-a", "a"), buildingCard("card-b", "b")],
        nextCardNumberByProject: {},
      },
      // One slot for both cards: if the refused spawn kept it, card-b could
      // never start — a permanent under-capacity leak that no assertion
      // elsewhere would catch.
      settings: settingsWith({ building: [codexStep], globalMaxConcurrent: 1 }),
      rejectThreadCreate: true,
    },
    ({ slots, pumpDomain, board }) =>
      Effect.gen(function* () {
        yield* pumpDomain(movedToBuilding(buildingCard("card-a", "a"), 1));

        assert.strictEqual(stepStatus(yield* board, BoardCardId.make("card-a")), "stalled");
        assert.strictEqual(yield* slots.heldTotal, 0, "the acquired slot came back");

        // The ceiling is free again, so the second card is offered the slot and
        // fails the same way — it is never held behind a phantom run.
        yield* pumpDomain(movedToBuilding(buildingCard("card-b", "b"), 2));
        assert.strictEqual(stepStatus(yield* board, BoardCardId.make("card-b")), "stalled");
        assert.strictEqual(yield* slots.heldTotal, 0);
      }),
  ),
);
