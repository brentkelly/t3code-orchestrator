/**
 * Triage and adjudication never wait on a human, against the LIVE
 * reactor. A question from one of those steps is answered by the board once
 * per attempt; one it cannot answer, or a second, is interrupted and recovered
 * through the stall ladder — never parked `awaiting-input`.
 */
import {
  BOARD_SEED_STAGE_IDS,
  BoardCardId,
  ProviderInstanceId,
  ThreadId,
  boardCardStepState,
  type BoardCardStepState,
  type BoardStepCompletion,
} from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Ref from "effect/Ref";

import {
  NOW,
  codexStep,
  makeBoardCard,
  readyWorktree,
  settingsWith,
  turnCompleted,
  turnInterruptRequested,
  userInputRequested,
  withGovernor,
  type Harness,
} from "./supervisorHarness.testkit.ts";
import { fakeThreadState } from "./threadGateway.testkit.ts";

const cardId = BoardCardId.make("card-1");
const THREAD = ThreadId.make("thread-review-step");
const review = String(BOARD_SEED_STAGE_IDS.review);

const runningStep = (stepId: string): BoardCardStepState => ({
  cardId,
  stepId,
  stepLabel: stepId,
  stageLabel: "Code review",
  attempt: 1,
  stallCount: 0,
  stageEntryRecoveries: 0,
  humanTurnAt: null,
  lastNudgeAt: null,
  baseTipAtRoundStart: "main",
  lastError: null,
  awaitingReason: "stopped",
  stalledReason: "gave-up",
  retryAt: null,
  prompt: "Code review",
  providerInstanceId: ProviderInstanceId.make("codex"),
  model: "gpt-5-codex",
  mode: "build",
  runtimeMode: "auto",
  humanInLoop: false,
  maxAttempts: 5,
  timeoutMs: 30 * 60_000,
  threadId: THREAD,
  status: "running",
  slotHeld: true,
  forceStart: false,
  queuedBy: null,
  startedAt: NOW,
  updatedAt: NOW,
});

const reviewed: BoardStepCompletion = {
  cardId,
  stepId: "review@1",
  outcome: "succeeded",
  summary: "reviewed",
  payload: JSON.stringify({
    reviewedSha: "abc123",
    findings: [{ id: "f1", severity: "critical", file: "a.ts", line: 1, title: "T", detail: "" }],
  }),
  threadId: null,
  completedAt: NOW,
};

const shell = (awaitingUserInput: boolean) =>
  fakeThreadState(String(THREAD), {
    sessionStatus: "running",
    activeTurnRef: "turn-1",
    awaitingUserInput,
  });

const fixture = (stepId: string, options: { readonly pendingAtBoot?: boolean } = {}) => ({
  board: {
    cards: [
      makeBoardCard({
        id: "card-1",
        stage: review,
        orderKey: "m",
        worktree: readyWorktree("card-1"),
      }),
    ],
    stepStates: [runningStep(stepId)],
    stepCompletions: stepId === "review@1" ? [] : [reviewed],
    nextCardNumberByProject: {},
  },
  settings: settingsWith({ building: [codexStep], globalMaxConcurrent: 3 }),
  initialShells: new Map([[String(THREAD), shell(options.pendingAtBoot === true)]]),
});

const setAwaiting = (h: Pick<Harness, "shells">, awaiting: boolean) =>
  Ref.update(h.shells, (current) => new Map(current).set(String(THREAD), shell(awaiting)));

const stepOf = (h: Pick<Harness, "board">) =>
  Effect.map(h.board, (board) => boardCardStepState(board, cardId));

const commandsOfType = (h: Pick<Harness, "commands">, type: string) =>
  Effect.map(h.commands, (commands) => commands.filter((command) => command.type === type));

it.effect("answers a triage question once, and the step keeps running", () =>
  withGovernor(fixture("triage@1"), (h) =>
    Effect.gen(function* () {
      yield* h.reactor.drain;
      yield* setAwaiting(h, true);
      yield* h.pumpRuntime(userInputRequested(THREAD));
      const answers = yield* commandsOfType(h, "thread.answer-pending-input");
      assert.strictEqual(answers.length, 1);
      assert.include(JSON.stringify(answers[0]), "Decide it yourself");
      const step = yield* stepOf(h);
      assert.strictEqual(step?.status, "running");
      assert.strictEqual(step?.attempt, 1);
      // The turn ends while the projection still shows the answered question:
      // the attempt was answered, so nothing more happens.
      yield* setAwaiting(h, true);
      yield* h.pumpRuntime(turnCompleted(THREAD, "turn-1"));
      assert.strictEqual((yield* commandsOfType(h, "thread.answer-pending-input")).length, 1);
      assert.strictEqual((yield* stepOf(h))?.status, "running");
    }),
  ),
);

it.effect("recovers an unanswerable question as a stall, not a human Stop", () =>
  withGovernor(fixture("adjudicate@1"), (h) =>
    Effect.gen(function* () {
      yield* h.reactor.drain;
      // No pending question on the thread, so the answer cannot land.
      yield* h.pumpRuntime(userInputRequested(THREAD));
      assert.strictEqual((yield* commandsOfType(h, "thread.interrupt")).length, 1);
      const recovered = yield* stepOf(h);
      assert.strictEqual(recovered?.status, "stalled");
      assert.strictEqual(recovered?.stalledReason, "waiting-retry");
      assert.strictEqual(recovered?.attempt, 2);
      // The board's own interrupt is not read as a human pressing Stop, and the
      // interrupted turn's end does not recover the step a second time.
      yield* h.pumpRuntime(turnInterruptRequested(THREAD));
      yield* h.pumpRuntime(turnCompleted(THREAD, "turn-1"));
      const after = yield* stepOf(h);
      assert.strictEqual(after?.status, "stalled");
      assert.strictEqual(after?.stalledReason, "waiting-retry");
      assert.strictEqual(after?.attempt, 2);
    }),
  ),
);

it.effect("a second question in the same attempt is recovered", () =>
  withGovernor(fixture("retriage@1"), (h) =>
    Effect.gen(function* () {
      yield* h.reactor.drain;
      yield* setAwaiting(h, true);
      yield* h.pumpRuntime(userInputRequested(THREAD));
      assert.strictEqual((yield* stepOf(h))?.status, "running");
      yield* setAwaiting(h, true);
      yield* h.pumpRuntime(userInputRequested(THREAD));
      assert.strictEqual((yield* commandsOfType(h, "thread.answer-pending-input")).length, 1);
      assert.strictEqual((yield* stepOf(h))?.status, "stalled");
    }),
  ),
);

it.effect("a turn that ends on an unanswered question is answered", () =>
  withGovernor(fixture("triage@1"), (h) =>
    Effect.gen(function* () {
      yield* h.reactor.drain;
      yield* setAwaiting(h, true);
      yield* h.pumpRuntime(turnCompleted(THREAD, "turn-1"));
      assert.strictEqual((yield* commandsOfType(h, "thread.answer-pending-input")).length, 1);
      assert.strictEqual((yield* stepOf(h))?.status, "running");
    }),
  ),
);

it.effect("a question pending across a restart is answered at boot", () =>
  withGovernor(fixture("readjudicate@1", { pendingAtBoot: true }), (h) =>
    Effect.gen(function* () {
      yield* h.reactor.drain;
      assert.strictEqual((yield* commandsOfType(h, "thread.answer-pending-input")).length, 1);
      assert.strictEqual((yield* stepOf(h))?.status, "running");
    }),
  ),
);

it.effect("a reviewer's question still parks for a human", () =>
  withGovernor(fixture("review@1"), (h) =>
    Effect.gen(function* () {
      yield* h.reactor.drain;
      yield* setAwaiting(h, true);
      yield* h.pumpRuntime(userInputRequested(THREAD));
      assert.strictEqual((yield* commandsOfType(h, "thread.answer-pending-input")).length, 0);
      const parked = yield* stepOf(h);
      assert.strictEqual(parked?.status, "awaiting-input");
      assert.strictEqual(parked?.awaitingReason, "question");
    }),
  ),
);
