/**
 * A planning card moved on before its plan is written keeps its planning thread
 * (T3O-19). Before this change, the move unlinked the thread and interrupted its
 * turn, and moving the card back started a brand-new interview from scratch.
 */
import {
  BOARD_SEED_STAGE_IDS,
  BoardCardId,
  boardCardStepCompletions,
  boardCardStepState,
  CommandId,
  type OrchestrationEvent,
  ThreadId,
  type BoardCard,
  type BoardStageId,
  type BoardState,
} from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Ref from "effect/Ref";

import { boardDecidedEvents, decideBoardCommand } from "./decider.ts";
import {
  isKeptStepThread,
  keepsPlanningThreadOnExit,
  keptPlanningThreadId,
} from "./planningThreadKeep.ts";
import { projectBoardEvent } from "./projector.ts";
import { boardReleasedThreadIds } from "./threadRelease.ts";
import {
  aliveThreadShell,
  cardMoved,
  codexStep,
  idleThreadShell,
  makeBoardCard,
  NOW,
  readModel,
  settingsWith,
  turnCompleted,
  withGovernor,
  type Harness,
} from "./supervisorHarness.testkit.ts";

const PLANNING = BOARD_SEED_STAGE_IDS.planning;
const READY = BOARD_SEED_STAGE_IDS.ready;
const SPRINT = BOARD_SEED_STAGE_IDS.sprint;
const BUILDING = BOARD_SEED_STAGE_IDS.building;
const cardId = BoardCardId.make("card-1");

const settings = settingsWith({
  building: [codexStep],
  planning: codexStep,
  planningHumanInLoop: true,
  globalMaxConcurrent: 3,
});

/** Fold a move into the read model, then deliver it, as production does: the
    projection runs ahead of the reactor's domain stream. */
const move = (h: Harness, toStage: BoardStageId, sequence: number) =>
  Effect.gen(function* () {
    const card = (yield* h.board).cards.find((candidate) => candidate.id === cardId);
    assert.isDefined(card);
    const moved: BoardCard = { ...card!, stage: toStage, updatedAt: NOW };
    const event = cardMoved(moved, card!.stage, toStage, sequence);
    const next = yield* projectBoardEvent(
      yield* Ref.get(h.model),
      event as Parameters<typeof projectBoardEvent>[1],
    ).pipe(Effect.orDie);
    yield* Ref.set(h.model, next);
    yield* h.pumpDomain(event);
  });

const setShell = (h: Harness, threadId: ThreadId, shell: ReturnType<typeof idleThreadShell>) =>
  Ref.update(h.shells, (current) => new Map(current).set(String(threadId), shell));

/** The kept thread reports its step done, through the real decider, the way its
    `board_complete_step` call reaches the board. */
const completePlanning = (h: Harness, threadId: ThreadId, sequence: number) =>
  Effect.gen(function* () {
    const decided = yield* decideBoardCommand({
      command: {
        type: "board.card.complete-step",
        commandId: CommandId.make(`cmd-complete-${sequence}`),
        cardId,
        stepId: PLANNING,
        outcome: "succeeded",
        summary: "plan written",
        payload: null,
        threadId,
        createdAt: NOW,
      },
      readModel: yield* Ref.get(h.model),
    }).pipe(Effect.provide(NodeServices.layer), Effect.orDie);
    for (const planned of boardDecidedEvents(decided)) {
      const event = { ...planned, sequence } as unknown as OrchestrationEvent;
      const next = yield* projectBoardEvent(
        yield* Ref.get(h.model),
        event as Parameters<typeof projectBoardEvent>[1],
      ).pipe(Effect.orDie);
      yield* Ref.set(h.model, next);
      yield* h.pumpDomain(event);
    }
  });

const liveLinks = (board: BoardState) =>
  board.cards
    .find((candidate) => candidate.id === cardId)!
    .threadLinks.filter((link) => link.tombstonedAt === null);

/** Bring the card into Planning and return its spawned interview thread. */
const startPlanning = (h: Harness) =>
  Effect.gen(function* () {
    yield* move(h, PLANNING, 1);
    const state = boardCardStepState(yield* h.board, cardId);
    assert.strictEqual(state?.status, "running");
    const threadId = state!.threadId!;
    assert.isNotNull(threadId);
    return threadId;
  });

const sprintCard = () => makeBoardCard({ id: "card-1", stage: "sprint", orderKey: "m" });

const spawnedThreads = (commands: ReadonlyArray<{ readonly type: string }>) =>
  commands.filter((command) => command.type === "thread.create").length;

describe("leaving Planning before the plan is written", () => {
  it.effect("keeps the planning thread linked and lets its turn finish", () =>
    withGovernor({ board: { cards: [sprintCard()], nextCardNumberByProject: {} }, settings }, (h) =>
      Effect.gen(function* () {
        const threadId = yield* startPlanning(h);
        yield* setShell(h, threadId, aliveThreadShell(String(threadId)));

        yield* move(h, READY, 2);

        // The step is over (the card is not in Planning), but the thread stays
        // on the card and its running turn is not stopped.
        assert.strictEqual(boardCardStepState(yield* h.board, cardId)?.status, "abandoned");
        assert.deepStrictEqual(
          liveLinks(yield* h.board).map((link) => [link.threadId, link.role]),
          [[threadId, PLANNING]],
        );
        assert.isUndefined(
          (yield* h.commands).find(
            (command) => command.type === "thread.turn.interrupt" && command.threadId === threadId,
          ),
        );
      }),
    ),
  );

  it.effect("resumes the same thread on return, without restarting the interview", () =>
    withGovernor({ board: { cards: [sprintCard()], nextCardNumberByProject: {} }, settings }, (h) =>
      Effect.gen(function* () {
        const threadId = yield* startPlanning(h);
        yield* move(h, READY, 2);
        // The agent stopped while the card sat in Ready.
        yield* setShell(h, threadId, idleThreadShell(String(threadId)));
        const before = yield* h.commands;

        yield* move(h, PLANNING, 3);

        const state = boardCardStepState(yield* h.board, cardId);
        assert.strictEqual(state?.stepId, PLANNING);
        assert.strictEqual(state?.threadId, threadId);
        // Idle and human-in-the-loop: parked on the human rather than showing
        // a running step that nothing is running.
        assert.strictEqual(state?.status, "awaiting-input");
        const after = (yield* h.commands).slice(before.length);
        assert.strictEqual(spawnedThreads(after), 0, "no fresh interview thread");
        assert.isUndefined(
          after.find((command) => command.type === "thread.turn.start"),
          "the planning prompt is not sent again",
        );
        assert.deepStrictEqual(
          liveLinks(yield* h.board).map((link) => link.threadId),
          [threadId],
        );
      }),
    ),
  );

  // The interview is always human-in-the-loop, whatever the settings say
  // (`resolveBoardStageExecution` forces it), so an idle kept thread is parked
  // on the human rather than shown `running` until the timeout sweep.
  it.effect("an idle kept thread parks on the human even with Planning set unattended", () =>
    withGovernor(
      {
        board: { cards: [sprintCard()], nextCardNumberByProject: {} },
        settings: settingsWith({
          building: [codexStep],
          planning: codexStep,
          planningHumanInLoop: false,
          globalMaxConcurrent: 3,
        }),
      },
      (h) =>
        Effect.gen(function* () {
          const threadId = yield* startPlanning(h);
          yield* move(h, READY, 2);
          yield* setShell(h, threadId, idleThreadShell(String(threadId)));

          yield* move(h, PLANNING, 3);

          const state = boardCardStepState(yield* h.board, cardId);
          assert.strictEqual(state?.threadId, threadId);
          assert.isTrue(state?.humanInLoop);
          assert.strictEqual(state?.status, "awaiting-input");
        }),
    ),
  );

  it.effect("re-entered while the turn still runs, the step runs on and parks when it ends", () =>
    withGovernor({ board: { cards: [sprintCard()], nextCardNumberByProject: {} }, settings }, (h) =>
      Effect.gen(function* () {
        const threadId = yield* startPlanning(h);
        yield* setShell(h, threadId, aliveThreadShell(String(threadId)));
        yield* move(h, READY, 2);
        yield* move(h, PLANNING, 3);

        const running = boardCardStepState(yield* h.board, cardId);
        assert.strictEqual(running?.status, "running");
        assert.strictEqual(running?.threadId, threadId);

        yield* setShell(h, threadId, idleThreadShell(String(threadId)));
        yield* h.pumpRuntime(turnCompleted(threadId));
        assert.strictEqual(boardCardStepState(yield* h.board, cardId)?.status, "awaiting-input");
      }),
    ),
  );

  // A structured question keeps the thread alive, but no turn.completed comes
  // until the human answers it.
  it.effect("re-entered while the thread holds a question, the step parks on it", () =>
    withGovernor({ board: { cards: [sprintCard()], nextCardNumberByProject: {} }, settings }, (h) =>
      Effect.gen(function* () {
        const threadId = yield* startPlanning(h);
        yield* move(h, READY, 2);
        yield* setShell(h, threadId, {
          ...idleThreadShell(String(threadId)),
          hasPendingUserInput: true,
        });

        yield* move(h, PLANNING, 3);

        const state = boardCardStepState(yield* h.board, cardId);
        assert.strictEqual(state?.threadId, threadId);
        assert.strictEqual(state?.status, "awaiting-input");
        assert.strictEqual(state?.awaitingReason, "question");
      }),
    ),
  );

  // Planning ends with board_complete_step. An agent often writes the plan,
  // then asks the human to confirm it before reporting.
  it.effect("a plan written but not reported is resumed on return, and can report", () =>
    withGovernor({ board: { cards: [sprintCard()], nextCardNumberByProject: {} }, settings }, (h) =>
      Effect.gen(function* () {
        const threadId = yield* startPlanning(h);
        yield* move(h, READY, 2);
        yield* Ref.update(h.model, (model) => ({
          ...model,
          board: {
            ...model.board!,
            plans: [{ cardId, ordinal: 0 }] as unknown as BoardState["plans"],
          },
        }));
        assert.notInclude(boardReleasedThreadIds(yield* h.board), threadId);
        yield* setShell(h, threadId, idleThreadShell(String(threadId)));
        const before = yield* h.commands;

        yield* move(h, PLANNING, 3);

        const state = boardCardStepState(yield* h.board, cardId);
        assert.strictEqual(state?.threadId, threadId);
        assert.strictEqual(state?.status, "awaiting-input");
        assert.strictEqual(spawnedThreads((yield* h.commands).slice(before.length)), 0);

        yield* completePlanning(h, threadId, 4);
        const recorded = boardCardStepCompletions(yield* h.board, cardId).find(
          (completion) => completion.stepId === PLANNING,
        );
        assert.strictEqual(recorded?.outcome, "succeeded");
        assert.strictEqual(recorded?.threadId, threadId);
      }),
    ),
  );

  it.effect(
    "the kept thread finishing after the move records its plan, so return does not resume it",
    () =>
      withGovernor(
        { board: { cards: [sprintCard()], nextCardNumberByProject: {} }, settings },
        (h) =>
          Effect.gen(function* () {
            const threadId = yield* startPlanning(h);
            yield* setShell(h, threadId, aliveThreadShell(String(threadId)));
            yield* move(h, READY, 2);

            // The interview finishes while the card sits in Ready.
            yield* completePlanning(h, threadId, 3);
            const recorded = boardCardStepCompletions(yield* h.board, cardId).find(
              (completion) => completion.stepId === PLANNING,
            );
            assert.strictEqual(recorded?.outcome, "succeeded");
            assert.strictEqual(recorded?.threadId, threadId);

            yield* setShell(h, threadId, idleThreadShell(String(threadId)));
            const before = yield* h.commands;
            yield* move(h, PLANNING, 4);

            // A finished interview is left alone: no resume onto it, no fresh one.
            const state = boardCardStepState(yield* h.board, cardId);
            assert.strictEqual(state?.status, "abandoned");
            const after = (yield* h.commands).slice(before.length);
            assert.strictEqual(spawnedThreads(after), 0);
            assert.isUndefined(after.find((command) => command.type === "board.card.admit-step"));
          }),
      ),
  );

  // The card holds one step row, and the next stage's step replaces the
  // abandoned planning one. The kept thread is still the card's interview.
  it.effect("moved straight on to Building, the kept thread stays in the inbox and records", () =>
    withGovernor({ board: { cards: [sprintCard()], nextCardNumberByProject: {} }, settings }, (h) =>
      Effect.gen(function* () {
        const threadId = yield* startPlanning(h);
        yield* setShell(h, threadId, aliveThreadShell(String(threadId)));
        yield* move(h, BUILDING, 2);
        assert.strictEqual(boardCardStepState(yield* h.board, cardId)?.stepId, BUILDING);

        assert.notInclude(boardReleasedThreadIds(yield* h.board), threadId);
        yield* completePlanning(h, threadId, 3);
        const recorded = boardCardStepCompletions(yield* h.board, cardId).find(
          (completion) => completion.stepId === PLANNING,
        );
        assert.strictEqual(recorded?.threadId, threadId);
        // Finished: the sweep may settle it now.
        assert.include(boardReleasedThreadIds(yield* h.board), threadId);
      }),
    ),
  );

  it.effect("a kept thread deleted while the card was away is replaced on return", () =>
    withGovernor({ board: { cards: [sprintCard()], nextCardNumberByProject: {} }, settings }, (h) =>
      Effect.gen(function* () {
        const threadId = yield* startPlanning(h);
        yield* move(h, READY, 2);
        yield* Ref.update(h.shells, (current) => {
          const next = new Map(current);
          next.delete(String(threadId));
          return next;
        });

        yield* move(h, PLANNING, 3);

        const state = boardCardStepState(yield* h.board, cardId);
        assert.strictEqual(state?.stepId, PLANNING);
        assert.strictEqual(state?.status, "running");
        assert.notStrictEqual(state?.threadId, threadId);
        assert.deepStrictEqual(
          liveLinks(yield* h.board).map((link) => link.threadId),
          [state!.threadId],
        );
      }),
    ),
  );

  it.effect("a stalled interview is still dropped, so dragging back restarts it", () =>
    withGovernor({ board: { cards: [sprintCard()], nextCardNumberByProject: {} }, settings }, (h) =>
      Effect.gen(function* () {
        const threadId = yield* startPlanning(h);
        yield* Ref.update(h.model, (model) => ({
          ...model,
          board: {
            ...model.board!,
            stepStates: (model.board!.stepStates ?? []).map((state) =>
              state.cardId === cardId ? { ...state, status: "stalled" as const } : state,
            ),
          },
        }));

        yield* move(h, SPRINT, 2);
        assert.deepStrictEqual(liveLinks(yield* h.board), []);

        yield* move(h, PLANNING, 3);
        const state = boardCardStepState(yield* h.board, cardId);
        assert.strictEqual(state?.status, "running");
        assert.notStrictEqual(state?.threadId, threadId);
      }),
    ),
  );
});

describe("the planning-thread rules", () => {
  const board = (cards: ReadonlyArray<BoardCard>, extra: Partial<BoardState> = {}) =>
    ({ ...readModel({ cards, nextCardNumberByProject: {} }).board, ...extra }) as BoardState;
  const thread = ThreadId.make("thread-plan");
  const linked = (stage: BoardStageId) =>
    ({
      ...makeBoardCard({ id: "card-1", stage, orderKey: "m" }),
      threadLinks: [{ threadId: thread, role: PLANNING, linkedAt: NOW, tombstonedAt: null }],
    }) as BoardCard;

  it("keeps only a live planning step the card is leaving", () => {
    const b = board([]);
    assert.isTrue(keepsPlanningThreadOnExit(b, { stepId: PLANNING, status: "running" }, READY));
    assert.isTrue(
      keepsPlanningThreadOnExit(b, { stepId: PLANNING, status: "awaiting-input" }, SPRINT),
    );
    assert.isFalse(keepsPlanningThreadOnExit(b, { stepId: PLANNING, status: "stalled" }, READY));
    assert.isFalse(keepsPlanningThreadOnExit(b, { stepId: PLANNING, status: "running" }, PLANNING));
    assert.isFalse(
      keepsPlanningThreadOnExit(
        b,
        { stepId: String(BOARD_SEED_STAGE_IDS.building), status: "running" },
        READY,
      ),
    );
  });

  it("resumes a kept planning link, but not one that already finished the step", () => {
    const card = linked(PLANNING);
    assert.strictEqual(keptPlanningThreadId(board([card]), card), thread);
    assert.isNull(keptPlanningThreadId(board([card]), { ...card, stage: READY }));
    const finished = board([card], {
      stepCompletions: [
        {
          cardId,
          stepId: PLANNING,
          outcome: "succeeded",
          summary: "planned",
          payload: null,
          threadId: thread,
          completedAt: NOW,
        },
      ],
    } as Partial<BoardState>);
    assert.isNull(keptPlanningThreadId(finished, card));
    // A written plan alone is not: the thread has not reported yet.
    const planned = board([card], {
      plans: [{ cardId, ordinal: 0 }],
    } as unknown as Partial<BoardState>);
    assert.strictEqual(keptPlanningThreadId(planned, card), thread);
  });

  it("lets only the still-linked planning thread of a card that left record it", () => {
    const b = board([]);
    const card = linked(READY);
    assert.isTrue(isKeptStepThread(b, card, PLANNING, thread));
    // Whatever the card's step row says now: a later stage's step replaces it.
    assert.isTrue(isKeptStepThread(b, linked(BOARD_SEED_STAGE_IDS.building), PLANNING, thread));
    assert.isFalse(isKeptStepThread(b, card, PLANNING, ThreadId.make("thread-other")));
    assert.isFalse(isKeptStepThread(b, card, PLANNING, null));
    assert.isFalse(isKeptStepThread(b, card, String(BOARD_SEED_STAGE_IDS.building), thread));
    assert.isFalse(isKeptStepThread(b, { ...card, threadLinks: [] }, PLANNING, thread));
    // Back in Planning with the step live again, the live-step rule owns it...
    const stepRow = (status: "running" | "abandoned") =>
      board([], {
        stepStates: [{ cardId, stepId: PLANNING, threadId: thread, status }],
      } as unknown as Partial<BoardState>);
    assert.isFalse(isKeptStepThread(stepRow("running"), linked(PLANNING), PLANNING, thread));
    // ...but a card back in Planning whose step was not resumed still lets the
    // kept thread report.
    assert.isTrue(isKeptStepThread(stepRow("abandoned"), linked(PLANNING), PLANNING, thread));
    // Only a planning link: no other stage keeps its thread past the move.
    const building = String(BOARD_SEED_STAGE_IDS.building);
    const buildingCard = {
      ...card,
      threadLinks: [{ threadId: thread, role: building, linkedAt: NOW, tombstonedAt: null }],
    } as BoardCard;
    assert.isFalse(isKeptStepThread(b, buildingCard, building, thread));
  });
});
