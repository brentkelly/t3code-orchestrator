/**
 * T3o: the automation gates fire from state, not only from events (T3O-115). Each case changes
 * the board without delivering the event that would have acted on it, then runs one production
 * tick (or the boot pass) and asserts the gate fired, once.
 */
import {
  BOARD_AUTO_ANSWER_LIMIT,
  BOARD_AUTO_ANSWER_TEXT,
  BOARD_SEED_STAGE_IDS,
  BoardCardId,
  boardCardStepState,
  boardPlanId,
  ProviderInstanceId,
  ThreadId,
  type BoardCard,
  type BoardCardGroup,
  type BoardCardStepState,
  type BoardPlan,
  type BoardSettings,
} from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Ref from "effect/Ref";

import { aliveThread } from "./threadGateway.testkit.ts";
import {
  cardStage,
  codexStep,
  makeBoardCard,
  NOW,
  settingsWith,
  withGovernor,
  type Harness,
  type HarnessCommand,
} from "./supervisorHarness.testkit.ts";

const PLANNING = String(BOARD_SEED_STAGE_IDS.planning);
const ENTERED = "2026-01-02T00:00:00.000Z";
const EARLIER = "2026-01-01T12:00:00.000Z";
const settings = settingsWith({
  building: [codexStep],
  planning: codexStep,
  planningHumanInLoop: true,
  globalMaxConcurrent: 3,
});

const plan = (cardId: string, key: string, ordinal: number): BoardPlan => ({
  planId: boardPlanId(BoardCardId.make(cardId), key),
  cardId: BoardCardId.make(cardId),
  title: `Plan ${key}`,
  summary: key,
  dependsOn: [],
  ordinal,
  locked: false,
  createdAt: NOW,
  updatedAt: NOW,
});

const card = (id: string, stage: string, overrides?: Partial<BoardCard>): BoardCard => ({
  ...makeBoardCard({ id, stage, orderKey: "m" }),
  stageEnteredAt: ENTERED,
  ...overrides,
});

/** The card's planning step, settled for the stay that began at `ENTERED`. */
const planningStep = (
  cardId: string,
  overrides?: Partial<BoardCardStepState>,
): BoardCardStepState => ({
  cardId: BoardCardId.make(cardId),
  stepId: PLANNING,
  stepLabel: null,
  stageLabel: "Planning",
  attempt: 1,
  stallCount: 0,
  stageEntryRecoveries: 0,
  humanTurnAt: null,
  lastNudgeAt: null,
  baseTipAtRoundStart: null,
  lastError: null,
  awaitingReason: "question",
  stalledReason: "gave-up",
  retryAt: null,
  prompt: "Plan it.",
  providerInstanceId: ProviderInstanceId.make("codex"),
  model: "gpt-5-codex",
  mode: "plan",
  runtimeMode: "auto",
  humanInLoop: false,
  maxAttempts: 3,
  timeoutMs: 600_000,
  threadId: ThreadId.make(`thread-${cardId}`),
  status: "succeeded",
  slotHeld: false,
  forceStart: false,
  queuedBy: null,
  queuedDetail: null,
  startedAt: ENTERED,
  updatedAt: ENTERED,
  stageEnteredAt: ENTERED,
  ...overrides,
});

const ofType = (commands: ReadonlyArray<HarnessCommand>, type: HarnessCommand["type"]) =>
  commands.filter((command) => command.type === type);

const cardOf = (h: Harness, id: string) =>
  Effect.map(h.board, (board) => board.cards.find((c) => c.id === BoardCardId.make(id)));

it.effect("plan: a card left in Planning with Auto-plan on is started by the tick, once", () =>
  withGovernor(
    {
      board: {
        cards: [card("plan", "planning", { autoPlanSetting: true })],
        nextCardNumberByProject: {},
      },
      settings,
    },
    (h) =>
      Effect.gen(function* () {
        yield* h.reactor.tick;
        const id = BoardCardId.make("plan");
        const state = boardCardStepState(yield* h.board, id);
        assert.strictEqual(state?.stepId, PLANNING);
        assert.strictEqual(state?.stageEnteredAt, ENTERED);
        // The run is unattended: Auto-plan's marker was set before the stage started.
        assert.strictEqual((yield* cardOf(h, "plan"))?.autoPlan?.endedAt, null);
        yield* h.reactor.tick;
        assert.lengthOf(ofType(yield* h.commands, "board.card.select-step"), 1);
      }),
  ),
);

it.effect("plan: a planning step that failed with no rung left is not restarted by ticks", () =>
  withGovernor(
    {
      board: {
        cards: [card("failed", "planning", { autoPlanSetting: true })],
        stepStates: [planningStep("failed", { status: "failed" })],
        nextCardNumberByProject: {},
      },
      settings,
    },
    (h) =>
      Effect.gen(function* () {
        yield* h.reactor.tick;
        yield* h.reactor.tick;
        yield* h.reactor.tick;
        assert.lengthOf(ofType(yield* h.commands, "board.card.select-step"), 0);
        assert.isTrue((yield* cardOf(h, "failed"))?.autoPlanSetting);
      }),
  ),
);

const signOffBoard = (id: string, overrides?: Partial<BoardCard>) => ({
  cards: [card(id, "planning", { autoSignOffSetting: true, ...overrides })],
  plans: [plan(id, "one", 0)],
  stepStates: [planningStep(id)],
  nextCardNumberByProject: {},
});

it.effect("sign-off: a finished single plan moves to Ready on the tick, whoever planned", () =>
  withGovernor({ board: signOffBoard("signed"), settings }, (h) =>
    Effect.gen(function* () {
      yield* h.reactor.tick;
      assert.strictEqual(
        cardStage(yield* h.board, BoardCardId.make("signed")),
        BOARD_SEED_STAGE_IDS.ready,
      );
      yield* h.reactor.tick;
      assert.lengthOf(ofType(yield* h.commands, "board.card.move"), 1);
    }),
  ),
);

it.effect("sign-off: a plan finished just before a restart is approved by the boot pass", () =>
  withGovernor({ board: signOffBoard("restarted"), settings }, (h) =>
    Effect.gen(function* () {
      yield* h.reactor.reconcile;
      assert.strictEqual(
        cardStage(yield* h.board, BoardCardId.make("restarted")),
        BOARD_SEED_STAGE_IDS.ready,
      );
    }),
  ),
);

it.effect("stay: a card dragged back into Planning is not signed off from its old step", () =>
  withGovernor(
    {
      board: {
        ...signOffBoard("dragged"),
        stepStates: [planningStep("dragged", { stageEnteredAt: EARLIER })],
      },
      settings,
    },
    (h) =>
      Effect.gen(function* () {
        yield* h.reactor.tick;
        assert.strictEqual(
          cardStage(yield* h.board, BoardCardId.make("dragged")),
          BOARD_SEED_STAGE_IDS.planning,
        );
        assert.lengthOf(ofType(yield* h.commands, "board.card.move"), 0);
      }),
  ),
);

it.effect("stay: with Auto-plan on, the tick re-plans a card dragged back into Planning", () =>
  withGovernor(
    {
      board: {
        ...signOffBoard("replan", { autoPlanSetting: true }),
        plans: [],
        stepStates: [planningStep("replan", { stageEnteredAt: EARLIER })],
      },
      settings,
    },
    (h) =>
      Effect.gen(function* () {
        yield* h.reactor.tick;
        const state = boardCardStepState(yield* h.board, BoardCardId.make("replan"));
        assert.strictEqual(state?.stageEnteredAt, ENTERED);
        assert.notStrictEqual(state?.status, "succeeded");
      }),
  ),
);

it.effect("sign-off: a refused move is recorded once however many ticks retry it", () =>
  withGovernor(
    {
      board: signOffBoard("refused"),
      settings,
      onDispatch: (command) =>
        command.type === "board.card.move" ? Effect.die("the move is refused") : Effect.void,
    },
    (h) =>
      Effect.gen(function* () {
        yield* h.reactor.tick;
        yield* h.reactor.tick;
        yield* h.reactor.tick;
        assert.deepInclude((yield* cardOf(h, "refused"))?.gateBlock, {
          gate: "sign-off",
          reason: "fault",
        });
        const blocks = ofType(yield* h.commands, "board.card.update").filter(
          (command) => command.type === "board.card.update" && command.gateBlock != null,
        );
        assert.lengthOf(blocks, 1);
      }),
  ),
);

it.effect("a recorded block is cleared once its gate is no longer due", () =>
  withGovernor(
    {
      board: signOffBoard("unblocked", {
        autoSignOffSetting: false,
        gateBlock: { gate: "sign-off", reason: "fault", detail: null },
      }),
      settings,
    },
    (h) =>
      Effect.gen(function* () {
        yield* h.reactor.tick;
        assert.isUndefined((yield* cardOf(h, "unblocked"))?.gateBlock);
        yield* h.reactor.tick;
        const clears = ofType(yield* h.commands, "board.card.update").filter(
          (command) => command.type === "board.card.update" && command.gateBlock === null,
        );
        assert.lengthOf(clears, 1);
      }),
  ),
);

it.effect("split: an approval recorded during review fires on the tick once planning is done", () =>
  withGovernor(
    {
      board: {
        cards: [
          card("approved", "planning", {
            pendingSplitApproval: {
              autoBuild: false,
              mergeTarget: "own",
              fingerprint: "fp",
              approvedAt: NOW,
            },
          }),
        ],
        plans: [plan("approved", "a", 0), plan("approved", "b", 1)],
        stepStates: [planningStep("approved")],
        nextCardNumberByProject: {},
      },
      settings,
    },
    (h) =>
      Effect.gen(function* () {
        yield* h.reactor.tick;
        const board = yield* h.board;
        const id = BoardCardId.make("approved");
        assert.lengthOf(
          board.cards.filter((c) => c.parentCardId === id),
          2,
        );
        assert.strictEqual(cardStage(board, id), BOARD_SEED_STAGE_IDS.ready);
      }),
  ),
);

const unstartedGroup: BoardCardGroup = {
  target: "inherit",
  autoBuild: true,
  autoMerge: false,
  autoPlan: false,
  autoSignOff: false,
  started: false,
  placed: BOARD_SEED_STAGE_IDS.ready,
  prevStage: null,
  heading: true,
  integrated: false,
};

it.effect("build: a child inheriting an unstarted group's Auto-build builds on the tick", () =>
  withGovernor(
    {
      board: {
        cards: [
          card("group", "ready", { group: unstartedGroup }),
          card("child", "ready", { parentCardId: BoardCardId.make("group") }),
        ],
        nextCardNumberByProject: {},
      },
      settings,
    },
    (h) =>
      Effect.gen(function* () {
        yield* h.reactor.tick;
        assert.strictEqual(
          cardStage(yield* h.board, BoardCardId.make("child")),
          BOARD_SEED_STAGE_IDS.building,
        );
      }),
  ),
);

it.effect("review-start: a review enabled only by the Settings default starts on the tick", () => {
  const pipeline = settings.pipeline as Record<string, Record<string, unknown>>;
  const reviewing = {
    ...settings,
    pipeline: {
      ...pipeline,
      [PLANNING]: {
        ...pipeline[PLANNING],
        planReview: { enabledByDefault: true, defaultRounds: 1, prompt: null },
      },
    },
  } as unknown as BoardSettings;
  return withGovernor(
    {
      board: {
        cards: [card("review", "planning", { autoPlanSetting: true })],
        plans: [plan("review", "one", 0)],
        stepStates: [planningStep("review")],
        nextCardNumberByProject: {},
      },
      settings: reviewing,
    },
    (h) =>
      Effect.gen(function* () {
        yield* h.reactor.tick;
        const commands = yield* h.commands;
        assert.lengthOf(ofType(commands, "board.plan-review.start"), 1);
        const state = boardCardStepState(yield* h.board, BoardCardId.make("review"));
        assert.isString(state?.planReviewStartedAt);
        assert.strictEqual((yield* cardOf(h, "review"))?.planReview?.enabled, true);
      }),
  );
});

const askingBoard = (autoAnswers?: number) => ({
  cards: [card("asking", "planning", { autoPlanSetting: true })],
  stepStates: [
    planningStep("asking", {
      status: "awaiting-input",
      ...(autoAnswers === undefined ? {} : { autoAnswers }),
    }),
  ],
  nextCardNumberByProject: {},
});

const answersSent = (commands: ReadonlyArray<HarnessCommand>) =>
  commands.filter(
    (command) =>
      (command.type === "thread.send" || command.type === "thread.answer-pending-input") &&
      command.text === BOARD_AUTO_ANSWER_TEXT,
  );

it.effect("answer: a question on an unattended planning run is answered once per wait", () =>
  withGovernor({ board: askingBoard(), settings }, (h) =>
    Effect.gen(function* () {
      yield* Ref.update(
        h.shells,
        (shells) => new Map([...shells, ["thread-asking", aliveThread("thread-asking")]]),
      );
      yield* h.reactor.tick;
      yield* h.reactor.tick;
      // No provider request survived to answer, so it went as a new turn, and only once.
      const sent = answersSent(yield* h.commands);
      assert.lengthOf(
        sent.filter((command) => command.type === "thread.send"),
        1,
      );
      const state = boardCardStepState(yield* h.board, BoardCardId.make("asking"));
      assert.strictEqual(state?.autoAnswers, 1);
    }),
  ),
);

it.effect("answer: past the limit the question waits for a person", () =>
  withGovernor({ board: askingBoard(BOARD_AUTO_ANSWER_LIMIT), settings }, (h) =>
    Effect.gen(function* () {
      yield* h.reactor.tick;
      assert.lengthOf(answersSent(yield* h.commands), 0);
      const state = boardCardStepState(yield* h.board, BoardCardId.make("asking"));
      assert.strictEqual(state?.status, "awaiting-input");
    }),
  ),
);

it.effect("a lost spawn: a pending row with no thread is started by the tick's schedule", () =>
  withGovernor(
    {
      board: {
        cards: [card("lost", "planning", { autoPlanSetting: true })],
        stepStates: [planningStep("lost", { status: "pending", threadId: null, startedAt: null })],
        nextCardNumberByProject: {},
      },
      settings,
    },
    (h) =>
      Effect.gen(function* () {
        yield* h.reactor.tick;
        const state = boardCardStepState(yield* h.board, BoardCardId.make("lost"));
        assert.strictEqual(state?.status, "running");
        assert.isNotNull(state?.threadId);
      }),
  ),
);
