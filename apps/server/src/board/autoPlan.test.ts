/**
 * Auto-planning through the live reactor (T3O-32, T3O-38).
 *
 * Auto-plan has the agent decide what is left. Alone, its plan waits at the
 * human gate; with Auto-build too it is approved — decisions flagged unclear
 * included, since the decision log lives outside the read model and never
 * gates a move — and built. A group's toggles reach its children unless they
 * set their own. The card's current planning thread is steered, never
 * replaced.
 */
import {
  BOARD_AUTO_PLAN_INSTRUCTION,
  BOARD_AUTO_PLAN_OFF_INSTRUCTION,
  boardAutoPlanInstruction,
  BOARD_SEED_STAGE_IDS,
  BoardCardId,
  boardCardStepState,
  boardPlanId,
  type BoardCard,
  type BoardCardGroup,
  type BoardCardStepState,
  type BoardPlan,
  type BoardStepCompletion,
} from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Ref from "effect/Ref";

import { ThreadCommandRefusedError } from "./ThreadGateway.ts";
import { aliveThread } from "./threadGateway.testkit.ts";

import {
  cardMoved,
  cardStage,
  codexStep,
  makeBoardCard,
  NOW,
  setAutomation,
  settingsWith,
  stepCompleted,
  turnCompleted,
  turnInterruptRequested,
  userInputRequested,
  withGovernor,
  type Harness,
  type HarnessEvent,
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

/** Both toggles on: the plan is approved and built when it arrives. */
const autoPlanBuild = { autoPlanSetting: true, autoBuildSetting: true } as const;

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
  "Auto-plan + Auto-build approves the plan, unclear decisions and all, and moves the card to Building",
  () => {
    const card = planningCard("auto", autoPlanBuild);
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
          assert.include(spawn.text, boardAutoPlanInstruction(true));

          yield* pumpDomain(stepCompleted(id, "succeeded", 2, PLANNING));

          const after = yield* board;
          assert.strictEqual(cardStage(after, id), BOARD_SEED_STAGE_IDS.building);
          // The run record is spent by the move out of planning.
          assert.isString(cardOf(after.cards, "auto")?.autoPlan?.endedAt);
        }),
    );
  },
);

it.effect("Auto-plan alone plans unattended and leaves the plan at the approval gate", () => {
  const card = planningCard("gated", { autoPlanSetting: true });
  return withGovernor(
    {
      board: { cards: [card], plans: [plan("gated", "one", 0)], nextCardNumberByProject: {} },
      settings,
    },
    (h) =>
      Effect.gen(function* () {
        const id = BoardCardId.make("gated");
        yield* h.pumpDomain(cardMoved(card, "sprint", "planning", 1));
        assert.isFalse(boardCardStepState(yield* h.board, id)?.humanInLoop);
        const spawn = (yield* h.commands).find((command) => command.type === "thread.spawn");
        assert.ok(spawn?.type === "thread.spawn");
        assert.include(spawn.text, boardAutoPlanInstruction(false));

        yield* h.pumpDomain(stepCompleted(id, "succeeded", 2, PLANNING));
        const after = yield* h.board;
        // Not approved, and not D8-advanced either: the plan waits for a human.
        assert.strictEqual(cardStage(after, id), BOARD_SEED_STAGE_IDS.planning);
        assert.strictEqual(cardOf(after.cards, "gated")?.autoPlan?.endedAt, null);

        // Turning Auto-build on now counts as the approval.
        yield* setAutomation(h, id, { autoBuild: true }, 3);
        assert.strictEqual(cardStage(yield* h.board, id), BOARD_SEED_STAGE_IDS.building);
      }),
  );
});

it.effect("a planning run that was not unattended is never auto-approved", () => {
  const card = planningCard("attended");
  return withGovernor(
    {
      board: { cards: [card], plans: [plan("attended", "one", 0)], nextCardNumberByProject: {} },
      settings,
    },
    (h) =>
      Effect.gen(function* () {
        const id = BoardCardId.make("attended");
        yield* h.pumpDomain(cardMoved(card, "sprint", "planning", 1));
        yield* h.pumpDomain(stepCompleted(id, "succeeded", 2, PLANNING));
        // Planning is finished, so turning both on afterwards approves nothing.
        yield* setAutomation(h, id, { autoPlan: true, autoBuild: true }, 3);
        assert.strictEqual(cardStage(yield* h.board, id), BOARD_SEED_STAGE_IDS.planning);
      }),
  );
});

it.effect("steers a live planning thread and approves the plan it then proposes", () => {
  const card = planningCard("steer");
  return withGovernor(
    {
      board: { cards: [card], plans: [plan("steer", "one", 0)], nextCardNumberByProject: {} },
      settings,
    },
    (h) =>
      Effect.gen(function* () {
        const { pumpDomain, board, commands } = h;
        const id = BoardCardId.make("steer");
        yield* pumpDomain(cardMoved(card, "sprint", "planning", 1));
        const interview = boardCardStepState(yield* board, id);
        assert.isTrue(interview?.humanInLoop);
        assert.ok(interview?.threadId != null);

        yield* setAutomation(h, id, { autoPlan: true, autoBuild: true }, 2);

        const sent = (yield* commands).filter((command) => command.type === "thread.send");
        assert.ok(
          sent.some(
            (command) =>
              command.type === "thread.send" &&
              command.threadId === interview.threadId &&
              command.text === boardAutoPlanInstruction(true),
          ),
        );
        const steered = yield* board;
        // Supervised as unattended from here on, on the same thread.
        assert.isFalse(boardCardStepState(steered, id)?.humanInLoop);
        assert.strictEqual(boardCardStepState(steered, id)?.threadId, interview.threadId);
        assert.strictEqual(cardOf(steered.cards, "steer")?.autoPlan?.endedAt, null);

        yield* pumpDomain(stepCompleted(id, "succeeded", 3, PLANNING));
        assert.strictEqual(cardStage(yield* board, id), BOARD_SEED_STAGE_IDS.building);
      }),
  );
});

it.effect(
  "turning Auto-plan off mid-run hands planning back to the user on the same thread",
  () => {
    const card = planningCard("back", { autoPlanSetting: true });
    return withGovernor({ board: { cards: [card], nextCardNumberByProject: {} }, settings }, (h) =>
      Effect.gen(function* () {
        const id = BoardCardId.make("back");
        yield* h.pumpDomain(cardMoved(card, "sprint", "planning", 1));
        const run = boardCardStepState(yield* h.board, id);
        assert.isFalse(run?.humanInLoop);

        yield* setAutomation(h, id, { autoPlan: false }, 2);
        const after = yield* h.board;
        assert.isTrue(boardCardStepState(after, id)?.humanInLoop);
        assert.strictEqual(boardCardStepState(after, id)?.threadId, run?.threadId);
        assert.isString(cardOf(after.cards, "back")?.autoPlan?.endedAt);
        assert.ok(
          (yield* h.commands).some(
            (command) =>
              command.type === "thread.send" && command.text === BOARD_AUTO_PLAN_OFF_INSTRUCTION,
          ),
        );
      }),
    );
  },
);

it.effect("a human pressing Stop on an unattended planning run turns Auto-plan off", () => {
  const card = planningCard("stopped", { autoPlanSetting: true });
  return withGovernor({ board: { cards: [card], nextCardNumberByProject: {} }, settings }, (h) =>
    Effect.gen(function* () {
      const id = BoardCardId.make("stopped");
      yield* h.pumpDomain(cardMoved(card, "sprint", "planning", 1));
      const threadId = boardCardStepState(yield* h.board, id)!.threadId!;
      yield* h.pumpRuntime(turnInterruptRequested(threadId));
      const after = yield* h.board;
      assert.strictEqual(boardCardStepState(after, id)?.status, "paused");
      assert.isFalse(cardOf(after.cards, "stopped")?.autoPlanSetting);
      assert.isString(cardOf(after.cards, "stopped")?.autoPlan?.endedAt);
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
      (h) =>
        Effect.gen(function* () {
          const { pumpDomain, board } = h;
          const id = BoardCardId.make("fresh");
          assert.strictEqual(boardCardStepState(yield* board, id), null);

          yield* setAutomation(h, id, { autoPlan: true }, 1);
          assert.ok(
            (yield* h.commands).some((command) => command.type === "board.card.start-stage-thread"),
          );

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

it.effect("leaves a card whose split is waiting for approval alone", () => {
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
    (h) =>
      Effect.gen(function* () {
        yield* setAutomation(h, BoardCardId.make("pending"), { autoPlan: true }, 1);
        const after = yield* h.board;
        // Nothing is marked or steered: the split is the human's to approve.
        assert.strictEqual(cardOf(after.cards, "pending")?.autoPlan, undefined);
        assert.isFalse((yield* h.commands).some((command) => command.type === "thread.send"));
      }),
  );
});

/** A split card whose unattended run was stamped before it proposed — the
    fixture holds the plans from the start, and a pending split is never
    stamped afresh. */
const splitCard = (id: string, autoBuild: boolean) =>
  planningCard(id, {
    autoPlan: { requestedAt: NOW, endedAt: null },
    autoPlanSetting: true,
    autoBuildSetting: autoBuild ? true : null,
    splitRationale: "Two parts that review separately and ship one at a time.",
    // The agent recommends Auto-build off: the card's own toggle overrides it.
    splitRecommendation: { autoBuild: false, mergeTarget: "own" },
  });

const splitPlans = (id: string) => [plan(id, "a", 0), plan(id, "b", 1)];

it.effect(
  "an auto-plan + auto-build split is approved with the card's toggles, logged as important, and started",
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

it.effect("an auto-plan-only split waits at the gate, unapproved", () => {
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
        assert.strictEqual(after.cards.filter((c) => c.parentCardId === id).length, 0);
        assert.strictEqual(parent?.group, null);
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

it.effect("a group with auto-plan plans a child unattended and its plan waits for approval", () => {
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
        assert.strictEqual(cardOf(marked.cards, "child")?.autoPlan?.endedAt, null);
        assert.isFalse(boardCardStepState(marked, id)?.humanInLoop);

        yield* pumpDomain(stepCompleted(id, "succeeded", 2, PLANNING));
        assert.strictEqual(cardStage(yield* board, id), BOARD_SEED_STAGE_IDS.planning);
      }),
  );
});

it.effect(
  "a child outdented from an auto-plan group mid-run goes back to planning with you",
  () => {
    const group = planningCard("group", { group: autoPlanGroup });
    const child = planningCard("child", { parentCardId: BoardCardId.make("group") });
    return withGovernor(
      { board: { cards: [group, child], nextCardNumberByProject: {} }, settings },
      ({ pumpDomain, board, model }) =>
        Effect.gen(function* () {
          const id = BoardCardId.make("child");
          yield* pumpDomain(cardMoved(child, "sprint", "planning", 1));
          assert.strictEqual(cardOf((yield* board).cards, "child")?.autoPlan?.endedAt, null);

          let outdented: BoardCard | undefined;
          yield* Ref.update(model, (current) => ({
            ...current,
            board: {
              ...current.board!,
              cards: current.board!.cards.map((card) => {
                if (card.id !== id) return card;
                outdented = { ...card, parentCardId: null };
                return outdented;
              }),
            },
          }));
          yield* pumpDomain({
            type: "board.card-updated",
            sequence: 2,
            payload: { cardId: id, card: outdented, regrouped: true },
          } as unknown as HarnessEvent);

          const after = yield* board;
          assert.isString(cardOf(after.cards, "child")?.autoPlan?.endedAt);
          assert.isTrue(boardCardStepState(after, id)?.humanInLoop);
        }),
    );
  },
);

it.effect("a group's start approves and builds a child plan that waited for it", () => {
  const group = planningCard("group", { group: { ...autoPlanGroup, autoBuild: true } });
  const child = planningCard("child", { parentCardId: BoardCardId.make("group") });
  const sibling = makeBoardCard({
    id: "sibling",
    stage: "ready",
    orderKey: "z",
    parentCardId: "group",
  });
  return withGovernor(
    {
      board: {
        cards: [group, child, sibling],
        plans: [plan("child", "one", 0)],
        nextCardNumberByProject: {},
      },
      settings,
    },
    ({ pumpDomain, board, model }) =>
      Effect.gen(function* () {
        const id = BoardCardId.make("child");
        yield* pumpDomain(cardMoved(child, "sprint", "planning", 1));
        yield* pumpDomain(stepCompleted(id, "succeeded", 2, PLANNING));
        // Inherited Auto-build waits for the group to begin, so the plan waits.
        assert.strictEqual(cardStage(yield* board, id), BOARD_SEED_STAGE_IDS.planning);

        // A human starts a sibling, which begins the group.
        let moved: BoardCard | undefined;
        yield* Ref.update(model, (current) => ({
          ...current,
          board: {
            ...current.board!,
            cards: current.board!.cards.map((card) => {
              if (card.id === BoardCardId.make("group")) {
                return { ...card, group: { ...card.group!, started: true } };
              }
              if (card.id !== BoardCardId.make("sibling")) return card;
              moved = { ...card, stage: BOARD_SEED_STAGE_IDS.building };
              return moved;
            }),
          },
        }));
        yield* pumpDomain(cardMoved(moved!, "ready", "building", 3));

        assert.strictEqual(cardStage(yield* board, id), BOARD_SEED_STAGE_IDS.building);
      }),
  );
});

it.effect("a child created straight into an auto-plan group's Planning is auto-planned", () => {
  const group = planningCard("group", { group: autoPlanGroup });
  const child = planningCard("child", { parentCardId: BoardCardId.make("group") });
  return withGovernor(
    { board: { cards: [group, child], nextCardNumberByProject: {} }, settings },
    ({ pumpDomain, board }) =>
      Effect.gen(function* () {
        // The reactor re-reads the card, so the payload needs only its id.
        yield* pumpDomain({
          type: "board.card-created",
          sequence: 1,
          payload: { cardId: child.id },
        } as unknown as HarnessEvent);
        const after = yield* board;
        assert.strictEqual(cardOf(after.cards, "child")?.autoPlan?.endedAt, null);
        assert.isFalse(boardCardStepState(after, BoardCardId.make("child"))?.humanInLoop);
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
  const card = planningCard("empty", autoPlanBuild);
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

/** The step event the decider emits once the reactor parks or settles a step;
    the harness does not loop it back, so a test delivers it with the live row. */
const stepEvent = (
  type: "board.card-step-awaiting-input",
  state: BoardCardStepState,
  sequence: number,
) => ({ type, sequence, payload: { cardId: state.cardId, state } }) as never;

it.effect(
  "an auto-plan run parked on a human ends the run record, so planning is gated again",
  () => {
    const card = planningCard("parked", autoPlanBuild);
    return withGovernor(
      {
        board: { cards: [card], plans: [plan("parked", "one", 0)], nextCardNumberByProject: {} },
        settings,
      },
      (h) =>
        Effect.gen(function* () {
          const { pumpDomain, board } = h;
          const id = BoardCardId.make("parked");
          yield* pumpDomain(cardMoved(card, "sprint", "planning", 1));
          yield* pumpDomain(stepCompleted(id, "blocked", 2, PLANNING));
          const parked = boardCardStepState(yield* board, id);
          assert.strictEqual(parked?.status, "awaiting-input");
          yield* pumpDomain(stepEvent("board.card-step-awaiting-input", parked!, 3));

          const after = yield* board;
          assert.isString(cardOf(after.cards, "parked")?.autoPlan?.endedAt);
          // A machine stop leaves the toggle on; re-asserting it steers the same thread.
          assert.isTrue(cardOf(after.cards, "parked")?.autoPlanSetting);
          yield* setAutomation(h, id, { autoPlan: true }, 4);
          const again = yield* board;
          assert.strictEqual(cardOf(again.cards, "parked")?.autoPlan?.endedAt, null);
          assert.strictEqual(boardCardStepState(again, id)?.threadId, parked?.threadId);
          assert.strictEqual(boardCardStepState(again, id)?.status, "running");
        }),
    );
  },
);

/** Park the live planning step as `status`, the way a question, a Stop or an
    escalation leaves it. */
const parkStep = (
  model: Harness["model"],
  cardId: BoardCardId,
  status: "awaiting-input" | "paused" | "stalled",
) =>
  Ref.update(model, (current) => ({
    ...current,
    board: {
      ...current.board!,
      stepStates: (current.board!.stepStates ?? []).map((state) =>
        state.cardId === cardId
          ? {
              ...state,
              status,
              slotHeld: false,
              ...(status === "stalled" ? { stalledReason: "gave-up" as const, retryAt: null } : {}),
            }
          : state,
      ),
    },
  }));

it.effect.each(["awaiting-input", "paused", "stalled"] as const)(
  "a planning step that is %s is steered in place, never replaced",
  (status) => {
    const card = planningCard(`parked-${status}`);
    return withGovernor({ board: { cards: [card], nextCardNumberByProject: {} }, settings }, (h) =>
      Effect.gen(function* () {
        const { pumpDomain, board, commands, model } = h;
        const id = BoardCardId.make(`parked-${status}`);
        yield* pumpDomain(cardMoved(card, "sprint", "planning", 1));
        const interview = boardCardStepState(yield* board, id);
        assert.ok(interview?.threadId != null);
        const threadId = interview.threadId;
        yield* parkStep(model, id, status);
        assert.strictEqual(boardCardStepState(yield* board, id)?.status, status);

        yield* setAutomation(h, id, { autoPlan: true }, 2);

        const calls = yield* commands;
        assert.isFalse(
          calls.some((command) => command.type === "board.card.start-stage-thread"),
          "no replacement planning run is started",
        );
        assert.isTrue(
          calls.some(
            (command) =>
              (command.type === "thread.send" || command.type === "thread.answer-pending-input") &&
              command.threadId === threadId &&
              command.text.includes(BOARD_AUTO_PLAN_INSTRUCTION),
          ),
          "the instruction goes to the current planning thread",
        );
        const after = yield* board;
        const link = cardOf(after.cards, `parked-${status}`)?.threadLinks.find(
          (candidate) => candidate.threadId === threadId,
        );
        assert.ok(link !== undefined);
        assert.strictEqual(link.tombstonedAt, null);
        const state = boardCardStepState(after, id);
        assert.strictEqual(state?.threadId, threadId);
        assert.strictEqual(state?.status, "running");
        assert.isFalse(state?.humanInLoop);
      }),
    );
  },
);

it.effect("a pending question is answered with the instruction instead of a new turn", () => {
  const card = planningCard("question");
  return withGovernor({ board: { cards: [card], nextCardNumberByProject: {} }, settings }, (h) =>
    Effect.gen(function* () {
      const { pumpDomain, board, commands, model, shells } = h;
      const id = BoardCardId.make("question");
      yield* pumpDomain(cardMoved(card, "sprint", "planning", 1));
      const threadId = boardCardStepState(yield* board, id)!.threadId!;
      yield* parkStep(model, id, "awaiting-input");
      yield* Ref.update(shells, (map) =>
        new Map(map).set(
          String(threadId),
          aliveThread(String(threadId), { awaitingUserInput: true }),
        ),
      );

      yield* setAutomation(h, id, { autoPlan: true }, 2);
      const calls = yield* commands;
      const answered = calls.find((command) => command.type === "thread.answer-pending-input");
      assert.ok(answered?.type === "thread.answer-pending-input");
      assert.strictEqual(answered.text, boardAutoPlanInstruction(false));
      assert.isFalse(
        calls.some(
          (command) =>
            command.type === "thread.send" && command.text.includes(BOARD_AUTO_PLAN_INSTRUCTION),
        ),
        "the answer is the instruction; no second turn is queued behind it",
      );
      assert.strictEqual(boardCardStepState(yield* board, id)?.status, "running");
    }),
  );
});

it.effect("a steering turn that does not land ends the request and starts no new thread", () => {
  const card = planningCard("deaf");
  return withGovernor(
    {
      board: { cards: [card], nextCardNumberByProject: {} },
      settings,
      gateway: (local) => ({
        ...local,
        send: (input) =>
          input.text.includes(BOARD_AUTO_PLAN_INSTRUCTION)
            ? Effect.fail(
                new ThreadCommandRefusedError({
                  command: "send",
                  threadId: input.threadId,
                  detail: "The session is gone.",
                }),
              )
            : local.send(input),
      }),
    },
    (h) =>
      Effect.gen(function* () {
        const { pumpDomain, board, commands } = h;
        const id = BoardCardId.make("deaf");
        yield* pumpDomain(cardMoved(card, "sprint", "planning", 1));
        const interview = boardCardStepState(yield* board, id);
        assert.strictEqual(interview?.status, "running");

        yield* setAutomation(h, id, { autoPlan: true }, 2);
        const calls = yield* commands;
        assert.isFalse(calls.some((command) => command.type === "board.card.start-stage-thread"));
        assert.strictEqual(
          calls.filter((command) => command.type === "thread.spawn").length,
          1,
          "only the original interview thread was ever spawned",
        );
        const after = yield* board;
        assert.isString(cardOf(after.cards, "deaf")?.autoPlan?.endedAt);
        // A machine failure: the toggle stays on.
        assert.isTrue(cardOf(after.cards, "deaf")?.autoPlanSetting);
        // The interview's stance is restored: nobody is driving it unattended.
        assert.isTrue(boardCardStepState(after, id)?.humanInLoop);
        assert.ok(
          calls.some(
            (command) =>
              command.type === "board.card.record-note" && command.kind === "card-auto-planned",
          ),
        );
      }),
  );
});

it.effect("a refused auto-approval ends the request, so planning is gated again", () => {
  const card = splitCard("refused", true);
  // A live child already on the board: the split approve refuses ("approved once").
  const stray = {
    ...makeBoardCard({ id: "stray", stage: "done", orderKey: "n" }),
    parentCardId: BoardCardId.make("refused"),
  };
  return withGovernor(
    {
      board: {
        cards: [card, stray],
        plans: splitPlans("refused"),
        nextCardNumberByProject: {},
      },
      settings,
    },
    ({ pumpDomain, board }) =>
      Effect.gen(function* () {
        const id = BoardCardId.make("refused");
        yield* pumpDomain(cardMoved(card, "sprint", "planning", 1));
        yield* pumpDomain(stepCompleted(id, "succeeded", 2, PLANNING));

        const after = yield* board;
        assert.strictEqual(cardStage(after, id), BOARD_SEED_STAGE_IDS.planning);
        assert.isString(cardOf(after.cards, "refused")?.autoPlan?.endedAt);
      }),
  );
});

it.effect(
  "steering interrupts the in-flight interview turn, so its question does not end the request",
  () => {
    const card = planningCard("midturn");
    return withGovernor({ board: { cards: [card], nextCardNumberByProject: {} }, settings }, (h) =>
      Effect.gen(function* () {
        const { pumpDomain, pumpRuntime, board, commands, shells } = h;
        const id = BoardCardId.make("midturn");
        yield* pumpDomain(cardMoved(card, "sprint", "planning", 1));
        const interview = boardCardStepState(yield* board, id);
        assert.ok(interview?.threadId != null);
        const threadId = interview.threadId;
        yield* Ref.update(shells, (map) =>
          new Map(map).set(
            String(threadId),
            aliveThread(String(threadId), { activeTurnRef: "turn-interview" }),
          ),
        );

        yield* setAutomation(h, id, { autoPlan: true }, 2);
        const calls = yield* commands;
        const interrupted = calls.findIndex(
          (command) => command.type === "thread.interrupt" && command.threadId === threadId,
        );
        const steered = calls.findIndex(
          (command) =>
            command.type === "thread.send" && command.text.includes(BOARD_AUTO_PLAN_INSTRUCTION),
        );
        assert.isAtLeast(interrupted, 0);
        assert.isAbove(steered, interrupted);

        // The interrupted turn's own question, its interrupt and its end.
        yield* pumpRuntime(userInputRequested(threadId));
        yield* pumpRuntime(turnInterruptRequested(threadId));
        yield* Ref.update(shells, (map) =>
          new Map(map).set(
            String(threadId),
            aliveThread(String(threadId), { activeTurnRef: "turn-interview" }),
          ),
        );
        yield* pumpRuntime(turnCompleted(threadId, "turn-interview"));

        const after = yield* board;
        assert.strictEqual(boardCardStepState(after, id)?.status, "running");
        assert.isFalse(boardCardStepState(after, id)?.humanInLoop);
        assert.strictEqual(cardOf(after.cards, "midturn")?.autoPlan?.endedAt, null);
      }),
    );
  },
);

it.effect(
  "a steer behind an interview run that had already ended still parks on the steer turn's own question",
  () => {
    const card = planningCard("staleturn");
    return withGovernor({ board: { cards: [card], nextCardNumberByProject: {} }, settings }, (h) =>
      Effect.gen(function* () {
        const { pumpDomain, pumpRuntime, board, shells } = h;
        const id = BoardCardId.make("staleturn");
        yield* pumpDomain(cardMoved(card, "sprint", "planning", 1));
        const interview = boardCardStepState(yield* board, id);
        assert.ok(interview?.threadId != null);
        const threadId = interview.threadId;
        const showRun = (activeTurnRef: string | null) =>
          Ref.update(shells, (map) =>
            new Map(map).set(String(threadId), aliveThread(String(threadId), { activeTurnRef })),
          );
        // The interview run has ended, and its end has been read, but the
        // projection still names it when auto-plan looks.
        yield* showRun("turn-interview");
        yield* setAutomation(h, id, { autoPlan: true }, 2);

        // The steer turn runs and asks a question: that is a real park.
        yield* showRun("turn-steer");
        yield* pumpRuntime(userInputRequested(threadId));
        assert.strictEqual(boardCardStepState(yield* board, id)?.status, "awaiting-input");
      }),
    );
  },
);

it.effect(
  "the steer turn's own end is read, even when the interrupted run's end never arrives",
  () => {
    const card = planningCard("steerend");
    return withGovernor({ board: { cards: [card], nextCardNumberByProject: {} }, settings }, (h) =>
      Effect.gen(function* () {
        const { pumpDomain, pumpRuntime, board, shells } = h;
        const id = BoardCardId.make("steerend");
        yield* pumpDomain(cardMoved(card, "sprint", "planning", 1));
        const interview = boardCardStepState(yield* board, id);
        assert.ok(interview?.threadId != null);
        const threadId = interview.threadId;
        yield* Ref.update(shells, (map) =>
          new Map(map).set(
            String(threadId),
            aliveThread(String(threadId), { activeTurnRef: "turn-interview" }),
          ),
        );
        yield* setAutomation(h, id, { autoPlan: true }, 2);

        // The steer turn ends without completing the step: death detection runs.
        yield* Ref.update(shells, (map) =>
          new Map(map).set(
            String(threadId),
            aliveThread(String(threadId), { activeTurnRef: null }),
          ),
        );
        yield* pumpRuntime(turnCompleted(threadId, "turn-steer"));
        const after = boardCardStepState(yield* board, id);
        assert.strictEqual(after?.status, "stalled");
        assert.strictEqual(after?.stallCount, 1);
      }),
    );
  },
);
