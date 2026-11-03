/**
 * Auto-planning through the live reactor (T3O-32, decisions 4 and 7).
 *
 * Auto-plan → Build ends planning, has the agent decide what is left, and
 * approves whatever plan arrives — decisions flagged unclear included, since
 * the decision log lives outside the read model and never gates a move. A
 * group with auto-plan on plans its children unattended and stops them at
 * Ready.
 */
import {
  BOARD_AUTO_PLAN_INSTRUCTION,
  BOARD_SEED_STAGE_IDS,
  BoardCardId,
  boardCardStepState,
  boardPlanId,
  type BoardCard,
  type BoardCardGroup,
  type BoardPlan,
  type BoardStepCompletion,
} from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import {
  cardMoved,
  cardStage,
  codexStep,
  makeBoardCard,
  NOW,
  settingsWith,
  stepCompleted,
  withGovernor,
} from "./supervisorHarness.testkit.ts";

const PLANNING = String(BOARD_SEED_STAGE_IDS.planning);
const settings = settingsWith({
  building: [codexStep],
  planning: codexStep,
  // The real planning interview is human-in-the-loop (t3o-34).
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

const pendingAutoPlan = (mode: "build" | "ready") => ({
  mode,
  requestedAt: NOW,
  endedAt: null,
});

const planningCard = (id: string, overrides?: Partial<BoardCard>): BoardCard => ({
  ...makeBoardCard({ id, stage: "planning", orderKey: "m" }),
  ...overrides,
});

const cardOf = (cards: ReadonlyArray<BoardCard>, id: string) =>
  cards.find((candidate) => candidate.id === BoardCardId.make(id));

const priorPlanning = (cardId: string): BoardStepCompletion => ({
  cardId: BoardCardId.make(cardId),
  stepId: PLANNING,
  outcome: "succeeded",
  summary: "planned once already",
  payload: null,
  threadId: null,
  completedAt: NOW,
});

it.effect(
  "Auto-plan → Build approves the plan, unclear decisions and all, and moves the card to Building",
  () => {
    const card = planningCard("auto", { autoPlan: pendingAutoPlan("build") });
    return withGovernor(
      {
        board: { cards: [card], plans: [plan("auto", "one", 0)], nextCardNumberByProject: {} },
        settings,
      },
      ({ pumpDomain, board, commands }) =>
        Effect.gen(function* () {
          const id = BoardCardId.make("auto");
          yield* pumpDomain(cardMoved(card, "sprint", "planning", 1));
          // Planning is forced human-in-the-loop, except for an auto-plan run.
          assert.isFalse(boardCardStepState(yield* board, id)?.humanInLoop);
          const spawn = (yield* commands).find((command) => command.type === "thread.spawn");
          assert.ok(spawn?.type === "thread.spawn");
          assert.include(spawn.text, BOARD_AUTO_PLAN_INSTRUCTION);

          yield* pumpDomain(stepCompleted(id, "succeeded", 2, PLANNING));

          const after = yield* board;
          assert.strictEqual(cardStage(after, id), BOARD_SEED_STAGE_IDS.building);
          // The request is spent by the move out of planning.
          assert.isString(cardOf(after.cards, "auto")?.autoPlan?.endedAt);
        }),
    );
  },
);

it.effect("steers a live planning thread and approves the plan it then proposes", () => {
  const card = planningCard("steer");
  return withGovernor(
    {
      board: { cards: [card], plans: [plan("steer", "one", 0)], nextCardNumberByProject: {} },
      settings,
    },
    ({ pumpDomain, board, commands, reactor }) =>
      Effect.gen(function* () {
        const id = BoardCardId.make("steer");
        yield* pumpDomain(cardMoved(card, "sprint", "planning", 1));
        const interview = boardCardStepState(yield* board, id);
        assert.isTrue(interview?.humanInLoop);
        assert.ok(interview?.threadId != null);

        const result = yield* reactor.autoPlanCard(id);
        assert.deepStrictEqual(result, { outcome: "steered" });

        const sent = (yield* commands).filter((command) => command.type === "thread.send");
        assert.ok(
          sent.some(
            (command) =>
              command.type === "thread.send" &&
              command.threadId === interview.threadId &&
              command.text === BOARD_AUTO_PLAN_INSTRUCTION,
          ),
        );
        const steered = yield* board;
        // Supervised as unattended from here on, on the same thread.
        assert.isFalse(boardCardStepState(steered, id)?.humanInLoop);
        assert.strictEqual(boardCardStepState(steered, id)?.threadId, interview.threadId);
        assert.strictEqual(cardOf(steered.cards, "steer")?.autoPlan?.mode, "build");

        yield* pumpDomain(stepCompleted(id, "succeeded", 2, PLANNING));
        assert.strictEqual(cardStage(yield* board, id), BOARD_SEED_STAGE_IDS.building);
      }),
  );
});

it.effect(
  "without a live thread starts a fresh unattended planning run, even on a card planned before",
  () => {
    const card = planningCard("fresh");
    return withGovernor(
      {
        board: {
          cards: [card],
          stepCompletions: [priorPlanning("fresh")],
          nextCardNumberByProject: {},
        },
        settings,
      },
      ({ pumpDomain, board, reactor }) =>
        Effect.gen(function* () {
          const id = BoardCardId.make("fresh");
          assert.strictEqual(boardCardStepState(yield* board, id), null);

          const result = yield* reactor.autoPlanCard(id);
          assert.deepStrictEqual(result, { outcome: "started" });

          // The harness does not loop the reactor's own events back into it,
          // so the start request it dispatched is delivered here.
          yield* pumpDomain({
            type: "board.card-stage-thread-requested",
            sequence: 1,
            payload: { cardId: id, stageId: BOARD_SEED_STAGE_IDS.planning },
          } as never);
          const state = boardCardStepState(yield* board, id);
          assert.isFalse(state?.humanInLoop);
          // A real planning prompt, not the empty re-entry conversation.
          assert.notStrictEqual(state?.prompt, "");
        }),
    );
  },
);

it.effect("refuses a card whose split is waiting for approval", () => {
  const card = planningCard("pending", {
    splitRationale: "Two parts that review separately and ship one at a time.",
  });
  return withGovernor(
    {
      board: {
        cards: [card],
        plans: [plan("pending", "a", 0), plan("pending", "b", 1)],
        nextCardNumberByProject: {},
      },
      settings,
    },
    ({ reactor }) =>
      Effect.gen(function* () {
        const result = yield* reactor.autoPlanCard(BoardCardId.make("pending"));
        assert.strictEqual(result.outcome, "refused");
      }),
  );
});

const splitCard = (id: string, autoBuild: boolean) =>
  planningCard(id, {
    autoPlan: pendingAutoPlan("build"),
    splitRationale: "Two parts that review separately and ship one at a time.",
    splitRecommendation: { autoBuild, mergeTarget: "own" },
  });

const splitPlans = (id: string) => [plan(id, "a", 0), plan(id, "b", 1)];

it.effect(
  "an auto-plan split is approved with the recommended settings, logged as important, and started",
  () => {
    const card = splitCard("split", true);
    return withGovernor(
      {
        board: { cards: [card], plans: splitPlans("split"), nextCardNumberByProject: {} },
        settings,
      },
      ({ pumpDomain, board, commands }) =>
        Effect.gen(function* () {
          const id = BoardCardId.make("split");
          yield* pumpDomain(cardMoved(card, "sprint", "planning", 1));
          yield* pumpDomain(stepCompleted(id, "succeeded", 2, PLANNING));

          const after = yield* board;
          const parent = cardOf(after.cards, "split");
          const children = after.cards.filter((candidate) => candidate.parentCardId === id);
          assert.strictEqual(children.length, 2);
          assert.strictEqual(parent?.group?.autoBuild, true);
          assert.strictEqual(parent?.group?.target, "own");
          // Started: the group was moved to the build stage, which is what
          // cascades its ready children whose dependencies are met.
          assert.isTrue(parent?.group?.started);

          const decided = (yield* commands).find(
            (command) => command.type === "board.card.record-decisions",
          );
          assert.ok(decided?.type === "board.card.record-decisions");
          assert.strictEqual(decided.decisions[0]?.flag, "important");
          assert.include(decided.decisions[0]?.decision ?? "", "Split into 2 cards");
        }),
    );
  },
);

it.effect("an auto-plan split with auto-build off starts nothing and stays in Planning", () => {
  const card = splitCard("epic", false);
  return withGovernor(
    {
      board: { cards: [card], plans: splitPlans("epic"), nextCardNumberByProject: {} },
      settings,
    },
    ({ pumpDomain, board }) =>
      Effect.gen(function* () {
        const id = BoardCardId.make("epic");
        yield* pumpDomain(cardMoved(card, "sprint", "planning", 1));
        yield* pumpDomain(stepCompleted(id, "succeeded", 2, PLANNING));

        const after = yield* board;
        const parent = cardOf(after.cards, "epic");
        assert.strictEqual(after.cards.filter((c) => c.parentCardId === id).length, 2);
        assert.strictEqual(parent?.group?.autoBuild, false);
        assert.isFalse(parent?.group?.started);
        assert.strictEqual(parent?.stage, BOARD_SEED_STAGE_IDS.planning);
      }),
  );
});

const autoPlanGroup: BoardCardGroup = {
  target: "inherit",
  autoBuild: false,
  autoMerge: false,
  autoPlan: true,
  started: false,
  placed: BOARD_SEED_STAGE_IDS.planning,
  prevStage: null,
  heading: true,
  integrated: false,
};

it.effect("a group with auto-plan plans a child unattended and stops it at Ready", () => {
  const group = planningCard("group", { group: autoPlanGroup });
  const child = planningCard("child", { parentCardId: BoardCardId.make("group") });
  return withGovernor(
    {
      board: {
        cards: [group, child],
        plans: [plan("child", "one", 0)],
        nextCardNumberByProject: {},
      },
      settings,
    },
    ({ pumpDomain, board }) =>
      Effect.gen(function* () {
        const id = BoardCardId.make("child");
        yield* pumpDomain(cardMoved(child, "sprint", "planning", 1));
        const marked = yield* board;
        assert.strictEqual(cardOf(marked.cards, "child")?.autoPlan?.mode, "ready");
        assert.isFalse(boardCardStepState(marked, id)?.humanInLoop);

        yield* pumpDomain(stepCompleted(id, "succeeded", 2, PLANNING));
        assert.strictEqual(cardStage(yield* board, id), BOARD_SEED_STAGE_IDS.ready);
      }),
  );
});

it.effect("a child of a group without auto-plan keeps the planning interview", () => {
  const group = planningCard("plain", { group: { ...autoPlanGroup, autoPlan: false } });
  const child = planningCard("kid", { parentCardId: BoardCardId.make("plain") });
  return withGovernor(
    { board: { cards: [group, child], nextCardNumberByProject: {} }, settings },
    ({ pumpDomain, board }) =>
      Effect.gen(function* () {
        yield* pumpDomain(cardMoved(child, "sprint", "planning", 1));
        const after = yield* board;
        assert.strictEqual(cardOf(after.cards, "kid")?.autoPlan, undefined);
        assert.isTrue(boardCardStepState(after, BoardCardId.make("kid"))?.humanInLoop);
      }),
  );
});

it.effect("an auto-plan run that proposed nothing approves nothing and says so", () => {
  const card = planningCard("empty", { autoPlan: pendingAutoPlan("build") });
  return withGovernor(
    { board: { cards: [card], nextCardNumberByProject: {} }, settings },
    ({ pumpDomain, board, commands }) =>
      Effect.gen(function* () {
        const id = BoardCardId.make("empty");
        yield* pumpDomain(cardMoved(card, "sprint", "planning", 1));
        yield* pumpDomain(stepCompleted(id, "succeeded", 2, PLANNING));
        assert.strictEqual(cardStage(yield* board, id), BOARD_SEED_STAGE_IDS.planning);
        const note = (yield* commands).find(
          (command) =>
            command.type === "board.card.record-note" && command.kind === "card-auto-planned",
        );
        assert.ok(note !== undefined);
      }),
  );
});
