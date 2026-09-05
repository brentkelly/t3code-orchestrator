/**
 * Blocked-agent detection (t3o-34): a human-in-the-loop step that ends a turn
 * without completing stops pretending to work.
 *
 * The defect this covers: `handleTurnCompleted`'s human-in-the-loop arm used to
 * return without doing anything, leaving the step `running` — so the shell's
 * `stepRunning` stayed true and the card pulsed its blue "being worked" dot
 * while the agent sat there waiting. Planning is where it bit hardest, because
 * a question with a paragraph of consequence per option is a poor fit for the
 * structured picker and agents write it in prose instead.
 *
 * Driven through the live reactor against the stateful engine double
 * (`withGovernor`), because the behaviour spans the turn-end handler, the
 * decider and the read model.
 */
import {
  BOARD_SEED_STAGE_IDS,
  BoardCardId,
  boardCardStepState,
  type OrchestrationEvent,
} from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import {
  cardMoved,
  codexStep,
  makeBoardCard,
  settingsWith,
  stepCompleted,
  turnCompleted,
  turnStarted,
  userInputRequested,
  userInputResolved,
  withGovernor,
  type Harness,
} from "./supervisorHarness.testkit.ts";

const planningCard = (id: string) => makeBoardCard({ id, stage: "planning", orderKey: "m" });

const movedToPlanning = (id: string, sequence: number): OrchestrationEvent =>
  cardMoved(planningCard(id), "sprint", "planning", sequence);

/** A human turn arriving on a thread — the event `handleTurnStartRequested`
    watches, and the signal that a parked step is being worked again. */
const turnStartRequested = (threadId: string, sequence: number): OrchestrationEvent =>
  ({
    type: "thread.turn-start-requested",
    sequence,
    payload: { threadId },
  }) as unknown as OrchestrationEvent;

/** The planning stage as it really runs: auto-executing and human-in-the-loop,
    because asking IS the job there. `messages` is handed to the harness by
    reference so a test can write the agent's final message once the harness has
    spawned the thread and told it the id. */
const planningBoard = (id: string, messages: Map<string, string>) => ({
  board: { cards: [planningCard(id)], nextCardNumberByProject: {} },
  settings: settingsWith({
    building: [codexStep],
    planning: codexStep,
    planningHumanInLoop: true,
    globalMaxConcurrent: 3,
  }),
  threadMessages: messages,
});

/** Drive the card into a running, human-in-the-loop planning step and hand back
    its thread id. Every test here starts from exactly this state. */
const startPlanning = (h: Pick<Harness, "pumpDomain" | "board">, id: string) =>
  Effect.gen(function* () {
    yield* h.pumpDomain(movedToPlanning(id, 1));
    const state = boardCardStepState(yield* h.board, BoardCardId.make(id));
    assert.strictEqual(state?.status, "running");
    assert.strictEqual(state?.humanInLoop, true);
    assert.isNotNull(state?.threadId);
    return state!.threadId!;
  });

it.effect("a turn that ends with a prose question parks the step as awaiting input", () => {
  const messages = new Map<string, string>();
  return withGovernor(planningBoard("ask", messages), ({ pumpDomain, pumpRuntime, board }) =>
    Effect.gen(function* () {
      const threadId = yield* startPlanning({ pumpDomain, board }, "ask");
      // The shape that defeats the structured picker: one question, then a
      // paragraph of consequence per option.
      messages.set(
        String(threadId),
        [
          "Before I write the plan I need one decision from you. Which way should the worktree be provisioned?",
          "",
          "**A. Per card.** Every card gets its own checkout, which isolates builds completely but costs a full install each time.",
          "",
          "**B. Shared.** One checkout per project, which is far cheaper but serialises anything that touches the lockfile.",
        ].join("\n"),
      );

      yield* pumpRuntime(turnCompleted(threadId));

      const parked = boardCardStepState(yield* board, BoardCardId.make("ask"));
      assert.strictEqual(parked?.status, "awaiting-input");
      assert.strictEqual(parked?.awaitingReason, "question");
      // No recovery ran: this is a healthy pause, not a stall.
      assert.strictEqual(parked?.attempt, 1);
      assert.strictEqual(parked?.stallCount, 0);
    }),
  );
});

it.effect("a turn that ends with no question parks the step as stopped", () => {
  const messages = new Map<string, string>();
  return withGovernor(planningBoard("quiet", messages), ({ pumpDomain, pumpRuntime, board }) =>
    Effect.gen(function* () {
      const threadId = yield* startPlanning({ pumpDomain, board }, "quiet");
      messages.set(
        String(threadId),
        "Wrote the plan to .plans/auth.md. It covers the token exchange, the refresh path and the migration.",
      );

      yield* pumpRuntime(turnCompleted(threadId));

      const parked = boardCardStepState(yield* board, BoardCardId.make("quiet"));
      assert.strictEqual(parked?.status, "awaiting-input");
      assert.strictEqual(parked?.awaitingReason, "stopped");
      assert.strictEqual(parked?.attempt, 1);
      assert.strictEqual(parked?.stallCount, 0);
    }),
  );
});

it.effect("a thread with no assistant message at all parks as stopped, never crashes", () => {
  const messages = new Map<string, string>();
  return withGovernor(planningBoard("silent", messages), ({ pumpDomain, pumpRuntime, board }) =>
    Effect.gen(function* () {
      const threadId = yield* startPlanning({ pumpDomain, board }, "silent");
      yield* pumpRuntime(turnCompleted(threadId));

      const parked = boardCardStepState(yield* board, BoardCardId.make("silent"));
      assert.strictEqual(parked?.status, "awaiting-input");
      assert.strictEqual(parked?.awaitingReason, "stopped");
    }),
  );
});

it.effect("a human turn on the parked thread puts the step back to running", () => {
  const messages = new Map<string, string>();
  return withGovernor(planningBoard("resume", messages), ({ pumpDomain, pumpRuntime, board }) =>
    Effect.gen(function* () {
      const threadId = yield* startPlanning({ pumpDomain, board }, "resume");
      messages.set(String(threadId), "Which auth library do you want?");
      yield* pumpRuntime(turnCompleted(threadId));
      assert.strictEqual(
        boardCardStepState(yield* board, BoardCardId.make("resume"))?.status,
        "awaiting-input",
      );

      // The human answers. Without this the card would keep asking for an
      // answer it already has.
      yield* pumpDomain(turnStartRequested(String(threadId), 2));

      const resumed = boardCardStepState(yield* board, BoardCardId.make("resume"));
      assert.strictEqual(resumed?.status, "running");
      // A human's own turn is not a board invocation, so it charges nothing.
      assert.strictEqual(resumed?.attempt, 1);
    }),
  );
});

it.effect("answering a STRUCTURED question resumes the step — no turn ever starts", () => {
  const messages = new Map<string, string>();
  return withGovernor(planningBoard("picker", messages), ({ pumpDomain, pumpRuntime, board }) =>
    Effect.gen(function* () {
      const threadId = yield* startPlanning({ pumpDomain, board }, "picker");
      yield* pumpRuntime(userInputRequested(threadId));
      assert.strictEqual(
        boardCardStepState(yield* board, BoardCardId.make("picker"))?.status,
        "awaiting-input",
      );

      // The subtle case. A structured question is raised from INSIDE a running
      // turn, and answering it only resolves the deferred that turn is blocked
      // on — the same turn carries on. So no turn starts, neither turn-start
      // signal fires, and `user-input.resolved` is the only thing the board
      // sees. Without it the card keeps a violet "Input needed" chip while the
      // agent visibly works.
      yield* pumpRuntime(userInputResolved(threadId));

      const resumed = boardCardStepState(yield* board, BoardCardId.make("picker"));
      assert.strictEqual(resumed?.status, "running");
      assert.strictEqual(resumed?.attempt, 1);
    }),
  );
});

it.effect("a turn-start domain event and a turn.started for the same turn resume once", () => {
  const messages = new Map<string, string>();
  return withGovernor(planningBoard("both", messages), ({ pumpDomain, pumpRuntime, board }) =>
    Effect.gen(function* () {
      const threadId = yield* startPlanning({ pumpDomain, board }, "both");
      messages.set(String(threadId), "Which one?");
      yield* pumpRuntime(turnCompleted(threadId));

      // A message send produces both signals. The second finds the step already
      // running and does nothing — no second resume, no rejected dispatch.
      yield* pumpDomain(turnStartRequested(String(threadId), 2));
      const once = boardCardStepState(yield* board, BoardCardId.make("both"));
      yield* pumpRuntime(turnStarted(threadId));
      const twice = boardCardStepState(yield* board, BoardCardId.make("both"));

      assert.strictEqual(twice?.status, "running");
      assert.strictEqual(twice?.updatedAt, once?.updatedAt);
    }),
  );
});

it.effect("a structured question still parks with reason question", () => {
  const messages = new Map<string, string>();
  return withGovernor(planningBoard("structured", messages), ({ pumpDomain, pumpRuntime, board }) =>
    Effect.gen(function* () {
      const threadId = yield* startPlanning({ pumpDomain, board }, "structured");
      // The runtime's own input request, with nothing in the transcript that
      // reads as a question — the reason must come from the request, not the
      // text.
      messages.set(String(threadId), "Here is where things stand so far.");

      yield* pumpRuntime(userInputRequested(threadId));

      const parked = boardCardStepState(yield* board, BoardCardId.make("structured"));
      assert.strictEqual(parked?.status, "awaiting-input");
      assert.strictEqual(parked?.awaitingReason, "question");
    }),
  );
});

it.effect("an agent that reports blocked parks with reason question", () => {
  const messages = new Map<string, string>();
  return withGovernor(planningBoard("blocked", messages), ({ pumpDomain, board }) =>
    Effect.gen(function* () {
      yield* startPlanning({ pumpDomain, board }, "blocked");
      yield* pumpDomain(
        stepCompleted(
          BoardCardId.make("blocked"),
          "blocked",
          2,
          String(BOARD_SEED_STAGE_IDS.planning),
        ),
      );

      const parked = boardCardStepState(yield* board, BoardCardId.make("blocked"));
      assert.strictEqual(parked?.status, "awaiting-input");
      assert.strictEqual(parked?.awaitingReason, "question");
    }),
  );
});

it.effect("re-entering the turn-end handler while already parked changes nothing", () => {
  const messages = new Map<string, string>();
  return withGovernor(planningBoard("idempotent", messages), ({ pumpDomain, pumpRuntime, board }) =>
    Effect.gen(function* () {
      const threadId = yield* startPlanning({ pumpDomain, board }, "idempotent");
      messages.set(String(threadId), "Which way do you want this to go?");
      yield* pumpRuntime(turnCompleted(threadId));
      const first = boardCardStepState(yield* board, BoardCardId.make("idempotent"));
      assert.strictEqual(first?.awaitingReason, "question");

      // A second turn.completed with the transcript now reading as a plain
      // report must not flip the reason under a human who is mid-answer.
      messages.set(String(threadId), "Still here.");
      yield* pumpRuntime(turnCompleted(threadId));

      const second = boardCardStepState(yield* board, BoardCardId.make("idempotent"));
      assert.strictEqual(second?.status, "awaiting-input");
      assert.strictEqual(second?.awaitingReason, "question");
      assert.strictEqual(second?.updatedAt, first?.updatedAt);
    }),
  );
});
