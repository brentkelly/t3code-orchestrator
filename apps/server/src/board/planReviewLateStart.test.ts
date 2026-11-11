/**
 * Plan review in the supervisor: turned on after the plan was posted,
 * the review's instructions go to the planning thread as a turn, even on a
 * step the decider reopened or resumed for it. A rounds change
 * mid-review tells the thread the new total.
 */
import {
  BOARD_PLAN_REVIEW_LATE_START_LEAD,
  BOARD_PLAN_REVIEW_STOP_INSTRUCTION,
  BOARD_SEED_STAGE_IDS,
  boardPlanReviewRoundsChangedLead,
  BoardCardId,
  boardCardStepState,
  boardPlanId,
  type BoardCard,
  type BoardCardStepState,
  type BoardPlan,
  type BoardState,
  ThreadId,
} from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Ref from "effect/Ref";

import { fakeThreadState } from "./threadGateway.testkit.ts";

import {
  NOW,
  cardMoved,
  cardScheduleUpdated,
  codexStep,
  makeBoardCard,
  settingsWith,
  stepCompleted,
  turnCompleted,
  turnInterruptRequested,
  withGovernor,
  type HarnessCommand,
  type HarnessEvent,
} from "./supervisorHarness.testkit.ts";

/** One hour after the TestClock epoch: not yet due. */
const FUTURE = "1970-01-01T01:00:00.000Z";

const settings = settingsWith({
  building: [codexStep],
  planning: codexStep,
  planningHumanInLoop: true,
  globalMaxConcurrent: 3,
});

const planningCard = (id: string): BoardCard => ({
  ...makeBoardCard({ id, stage: "planning", orderKey: "m" }),
  planReview: { enabled: true, rounds: 2 },
});

const plan = (cardId: string): BoardPlan => ({
  planId: boardPlanId(BoardCardId.make(cardId), "one"),
  cardId: BoardCardId.make(cardId),
  title: "Plan",
  summary: "one",
  dependsOn: [],
  ordinal: 0,
  locked: false,
  createdAt: NOW,
  updatedAt: NOW,
});

const fixture = (id: string) => ({
  board: { cards: [planningCard(id)], plans: [plan(id)], nextCardNumberByProject: {} },
  settings,
});

const reviewStarted = (
  state: BoardCardStepState,
  sequence: number,
  turnedOnLate: boolean,
  startedAt: string = NOW,
): HarnessEvent =>
  ({
    type: "board.plan-review-started",
    sequence,
    payload: {
      cardId: state.cardId,
      state: { ...state, planReviewStartedAt: startedAt, planReviewRounds: 2 },
      ...(turnedOnLate ? { turnedOnLate: true } : {}),
    },
  }) as unknown as HarnessEvent;

const sends = (commands: ReadonlyArray<HarnessCommand>) =>
  commands.filter(
    (command): command is Extract<HarnessCommand, { type: "thread.send" }> =>
      command.type === "thread.send",
  );

it.effect("turned on after the plan was posted, the review instructions go to the thread", () =>
  withGovernor(fixture("late"), ({ pumpDomain, board, commands }) =>
    Effect.gen(function* () {
      const id = BoardCardId.make("late");
      yield* pumpDomain(cardMoved(planningCard("late"), "sprint", "planning", 1));
      const state = boardCardStepState(yield* board, id);
      assert.strictEqual(state?.stepId, String(BOARD_SEED_STAGE_IDS.planning));
      const before = sends(yield* commands).length;

      yield* pumpDomain(reviewStarted(state!, 2, true));

      const after = sends(yield* commands);
      assert.strictEqual(after.length, before + 1);
      assert.strictEqual(after.at(-1)?.threadId, state!.threadId);
      assert.isTrue(after.at(-1)?.text.startsWith(BOARD_PLAN_REVIEW_LATE_START_LEAD));
      assert.include(after.at(-1)?.text, "up to 2 rounds");
    }),
  ),
);

it.effect("a review started by a tool call sends nothing: the tool result carries it", () =>
  withGovernor(fixture("tool"), ({ pumpDomain, board, commands }) =>
    Effect.gen(function* () {
      yield* pumpDomain(cardMoved(planningCard("tool"), "sprint", "planning", 1));
      const state = boardCardStepState(yield* board, BoardCardId.make("tool"));
      const before = sends(yield* commands).length;

      yield* pumpDomain(reviewStarted(state!, 2, false));

      assert.strictEqual(sends(yield* commands).length, before);
    }),
  ),
);

it.effect("a paused step the toggle resumed is told", () =>
  withGovernor(fixture("paused"), ({ pumpDomain, board, commands }) =>
    Effect.gen(function* () {
      const id = BoardCardId.make("paused");
      yield* pumpDomain(cardMoved(planningCard("paused"), "sprint", "planning", 1));
      const state = boardCardStepState(yield* board, id);
      yield* pumpDomain(turnInterruptRequested(state!.threadId!, 2));
      const paused = boardCardStepState(yield* board, id);
      assert.strictEqual(paused?.status, "paused");
      const before = sends(yield* commands).length;

      // The decider resumes the step on the same event.
      yield* pumpDomain(reviewStarted({ ...paused!, status: "running" }, 3, true));

      const after = sends(yield* commands);
      assert.strictEqual(after.length, before + 1);
      assert.isTrue(after.at(-1)?.text.startsWith(BOARD_PLAN_REVIEW_LATE_START_LEAD));
      assert.strictEqual(boardCardStepState(yield* board, id)?.status, "running");
    }),
  ),
);

it.effect("a paused step the toggle resumed drops its scheduled start, as a resume does", () =>
  withGovernor(fixture("scheduled"), ({ pumpDomain, board }) =>
    Effect.gen(function* () {
      const id = BoardCardId.make("scheduled");
      yield* pumpDomain(cardMoved(planningCard("scheduled"), "sprint", "planning", 1));
      const state = boardCardStepState(yield* board, id);
      yield* pumpDomain(turnInterruptRequested(state!.threadId!, 2));
      yield* pumpDomain(cardScheduleUpdated(planningCard("scheduled"), FUTURE, 3));
      const paused = boardCardStepState(yield* board, id);
      assert.strictEqual(paused?.status, "paused");

      yield* pumpDomain(reviewStarted({ ...paused!, status: "running" }, 4, true));

      const card = (yield* board).cards.find((candidate) => candidate.id === id);
      assert.isNull(card?.scheduledStartAt ?? null);
    }),
  ),
);

it.effect("a finished planning step the toggle reopened is told, and settles again", () =>
  withGovernor(fixture("reopen"), ({ pumpDomain, board, commands }) =>
    Effect.gen(function* () {
      const id = BoardCardId.make("reopen");
      const planning = String(BOARD_SEED_STAGE_IDS.planning);
      yield* pumpDomain(cardMoved(planningCard("reopen"), "sprint", "planning", 1));
      yield* pumpDomain(stepCompleted(id, "succeeded", 2, planning));
      const settled = boardCardStepState(yield* board, id);
      assert.strictEqual(settled?.status, "succeeded");
      const before = sends(yield* commands).length;

      // The decider reopens the step on the same event.
      yield* pumpDomain(reviewStarted({ ...settled!, status: "running" }, 3, true));

      const after = sends(yield* commands);
      assert.strictEqual(after.length, before + 1);
      assert.strictEqual(after.at(-1)?.threadId, settled!.threadId);
      assert.isTrue(after.at(-1)?.text.startsWith(BOARD_PLAN_REVIEW_LATE_START_LEAD));

      // The review's own completion settles the step again, still in Planning
      // awaiting sign-off, as the first one did.
      yield* pumpDomain(stepCompleted(id, "succeeded", 4, planning));
      const resettled = yield* board;
      assert.strictEqual(boardCardStepState(resettled, id)?.status, "succeeded");
      assert.strictEqual(
        String(resettled.cards.find((card) => card.id === id)?.stage),
        String(BOARD_SEED_STAGE_IDS.planning),
      );
    }),
  ),
);

it.effect("a reopened review can still be turned off", () =>
  withGovernor(fixture("reopen-stop"), ({ pumpDomain, board, commands }) =>
    Effect.gen(function* () {
      const id = BoardCardId.make("reopen-stop");
      const planning = String(BOARD_SEED_STAGE_IDS.planning);
      yield* pumpDomain(cardMoved(planningCard("reopen-stop"), "sprint", "planning", 1));
      yield* pumpDomain(stepCompleted(id, "succeeded", 2, planning));
      const settled = boardCardStepState(yield* board, id);
      yield* pumpDomain(reviewStarted({ ...settled!, status: "running" }, 3, true));
      const reopened = boardCardStepState(yield* board, id)!;
      const before = sends(yield* commands).length;

      yield* pumpDomain({
        type: "board.plan-review-stopped",
        sequence: 4,
        payload: {
          cardId: id,
          stepId: reopened.stepId,
          threadId: reopened.threadId,
          state: reopened,
        },
      } as unknown as HarnessEvent);

      const after = sends(yield* commands);
      assert.strictEqual(after.length, before + 1);
      assert.strictEqual(after.at(-1)?.text, BOARD_PLAN_REVIEW_STOP_INSTRUCTION);
    }),
  ),
);

/** After the first finish (`NOW`), so the review's start supersedes that completion. */
const AFTER_FINISH = "2026-01-01T00:05:00.000Z";

/** A finished planning step that a late plan review reopened, its thread now idle. */
const reopenedByLateReview = (
  h: Parameters<Parameters<typeof withGovernor>[1]>[0],
  id: BoardCardId,
) =>
  Effect.gen(function* () {
    const planning = String(BOARD_SEED_STAGE_IDS.planning);
    yield* h.pumpDomain(cardMoved(planningCard(String(id)), "sprint", "planning", 1));
    yield* h.pumpDomain(stepCompleted(id, "succeeded", 2, planning));
    const settled = boardCardStepState(yield* h.board, id)!;
    yield* h.pumpDomain(reviewStarted({ ...settled, status: "running" }, 3, true, AFTER_FINISH));
    const threadId = settled.threadId!;
    yield* Ref.update(
      h.shells,
      (shells) => new Map([...shells, [threadId, fakeThreadState(threadId)]]),
    );
    return threadId;
  });

it.effect(
  "a reopened review whose turn ends without finishing is supervised, not left running",
  () =>
    withGovernor(fixture("review-turn"), (h) =>
      Effect.gen(function* () {
        const id = BoardCardId.make("review-turn");
        const threadId = yield* reopenedByLateReview(h, id);

        yield* h.pumpRuntime(turnCompleted(ThreadId.make(threadId), "turn-review"));

        // A human-in-the-loop planning run that stopped waits on the human.
        assert.strictEqual(boardCardStepState(yield* h.board, id)?.status, "awaiting-input");
      }),
    ),
);

it.effect("boot reconcile does not settle a reopened review as already succeeded", () =>
  Effect.gen(function* () {
    let seeded: { board: BoardState; threadId: string } | undefined;
    yield* withGovernor(fixture("review-boot"), (h) =>
      Effect.gen(function* () {
        const threadId = yield* reopenedByLateReview(h, BoardCardId.make("review-boot"));
        seeded = { board: yield* h.board, threadId };
      }),
    );
    const { board, threadId } = seeded!;
    yield* withGovernor(
      { board, settings, initialShells: new Map([[threadId, fakeThreadState(threadId)]]) },
      (h) =>
        Effect.gen(function* () {
          yield* h.reactor.drain;
          // Parked for the human, not settled `succeeded` on the superseded completion.
          assert.strictEqual(
            boardCardStepState(yield* h.board, BoardCardId.make("review-boot"))?.status,
            "awaiting-input",
          );
        }),
    );
  }),
);

const roundsChanged = (state: BoardCardStepState, rounds: number, sequence: number) =>
  ({
    type: "board.plan-review-rounds-changed",
    sequence,
    payload: { cardId: state.cardId, state: { ...state, planReviewRounds: rounds } },
  }) as unknown as HarnessEvent;

it.effect("a rounds change mid-review tells the thread the new total", () =>
  withGovernor(fixture("rounds"), ({ pumpDomain, board, commands }) =>
    Effect.gen(function* () {
      const id = BoardCardId.make("rounds");
      yield* pumpDomain(cardMoved(planningCard("rounds"), "sprint", "planning", 1));
      yield* pumpDomain(reviewStarted(boardCardStepState(yield* board, id)!, 2, false));
      const running = boardCardStepState(yield* board, id)!;
      const before = sends(yield* commands).length;

      yield* pumpDomain(roundsChanged(running, 4, 3));

      const after = sends(yield* commands);
      assert.strictEqual(after.length, before + 1);
      assert.strictEqual(after.at(-1)?.threadId, running.threadId);
      assert.isTrue(after.at(-1)?.text.startsWith(boardPlanReviewRoundsChangedLead(4)));
      assert.include(after.at(-1)?.text, "up to 4 rounds");
    }),
  ),
);

it.effect("a rounds change on a paused review is recorded but sends nothing", () =>
  withGovernor(fixture("rounds-paused"), ({ pumpDomain, board, commands }) =>
    Effect.gen(function* () {
      const id = BoardCardId.make("rounds-paused");
      yield* pumpDomain(cardMoved(planningCard("rounds-paused"), "sprint", "planning", 1));
      yield* pumpDomain(reviewStarted(boardCardStepState(yield* board, id)!, 2, false));
      yield* pumpDomain(turnInterruptRequested(boardCardStepState(yield* board, id)!.threadId!, 3));
      const paused = boardCardStepState(yield* board, id)!;
      assert.strictEqual(paused.status, "paused");
      const before = sends(yield* commands).length;

      yield* pumpDomain(roundsChanged(paused, 4, 4));

      assert.strictEqual(sends(yield* commands).length, before);
      const after = boardCardStepState(yield* board, id);
      assert.strictEqual(after?.status, "paused");
      assert.strictEqual(after?.planReviewRounds, 4);
    }),
  ),
);
