/**
 * The three ways out of a review loop whose phase died before it started
 * (T3O-13), against the LIVE reactor.
 *
 * The reported card: `triage@1` (here) settled `succeeded`, the board selected
 * `adjudicate@1`, and its spawn failed — the disk was full — so the step
 * escalated to `stalled` with no thread at all. The card then offers
 * Continue, Restart and Move to the next stage. Each one must leave the loop
 * able to carry on as normal: the owed phase runs on a real thread, and its
 * completion plans the next phase, rather than the card sitting in Code review
 * with a step nobody is running.
 */
import {
  BOARD_SEED_STAGE_IDS,
  BoardCardId,
  ProviderInstanceId,
  boardCardStepState,
  type BoardCardStepState,
  type BoardStepCompletion,
  type OrchestrationEvent,
} from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import {
  NOW,
  cardMoved,
  codexStep,
  makeBoardCard,
  readyWorktree,
  settingsWith,
  stepRequeued,
  withGovernor,
} from "./supervisorHarness.testkit.ts";

const cardId = BoardCardId.make("card-1");
const review = String(BOARD_SEED_STAGE_IDS.review);
const merge = String(BOARD_SEED_STAGE_IDS.merge);

const reviewCard = () =>
  makeBoardCard({ id: "card-1", stage: review, orderKey: "m", worktree: readyWorktree("card-1") });

const ADJUDICATE_PROMPT = "Code review, Adjudicate phase, round 1 of up to 5.";

/** The step row the failed spawn left: escalated, holding no slot, no thread. */
const stalledAdjudicate: BoardCardStepState = {
  cardId,
  stepId: "adjudicate@1",
  stepLabel: "Adjudicate · round 1",
  stageLabel: "Code review",
  attempt: 2,
  stallCount: 1,
  stageEntryRecoveries: 1,
  humanTurnAt: null,
  lastNudgeAt: NOW,
  baseTipAtRoundStart: "main",
  lastError: null,
  awaitingReason: "question",
  stalledReason: "gave-up",
  retryAt: null,
  prompt: ADJUDICATE_PROMPT,
  providerInstanceId: ProviderInstanceId.make("codex"),
  model: "gpt-5-codex",
  mode: "build",
  runtimeMode: "auto",
  humanInLoop: false,
  maxAttempts: 5,
  timeoutMs: 600_000,
  threadId: null,
  status: "stalled",
  slotHeld: false,
  forceStart: false,
  startedAt: null,
  updatedAt: NOW,
};

const completion = (stepId: string, payload: unknown): BoardStepCompletion => ({
  cardId,
  stepId,
  outcome: "succeeded",
  summary: `${stepId} done`,
  payload: JSON.stringify(payload),
  threadId: null,
  completedAt: NOW,
});

/** Round 1 raised a blocking finding and triage fixed it: adjudication is owed. */
const throughTriage = [
  completion("review@1", {
    reviewedSha: "abc123",
    findings: [
      { id: "R1-1", severity: "improvement", file: "src/x.ts", line: 1, title: "T", detail: "" },
    ],
  }),
  completion("triage@1", {
    fixedSha: "def456",
    dispositions: [{ findingId: "R1-1", action: "fixed", note: "" }],
  }),
];

const adjudicated = (sequence: number): OrchestrationEvent =>
  ({
    type: "board.card-step-completed",
    sequence,
    payload: {
      cardId,
      completion: completion("adjudicate@1", {
        verdicts: [{ findingId: "R1-1", verdict: "fix-incomplete", note: "still panics" }],
      }),
    },
  }) as unknown as OrchestrationEvent;

const stageThreadRequested = (sequence: number): OrchestrationEvent =>
  ({
    type: "board.card-stage-thread-requested",
    sequence,
    payload: { cardId, stageId: review },
  }) as unknown as OrchestrationEvent;

const selectedStepIds = (events: ReadonlyArray<OrchestrationEvent>): ReadonlyArray<string> =>
  events.flatMap((event) =>
    event.type === "board.card-step-selected" && event.payload.state.cardId === cardId
      ? [event.payload.state.stepId]
      : [],
  );

const stuck = () => ({
  board: {
    cards: [reviewCard()],
    stepStates: [stalledAdjudicate],
    stepCompletions: [...throughTriage],
    nextCardNumberByProject: {},
  },
  settings: settingsWith({ building: [codexStep], globalMaxConcurrent: 3 }),
});

it.effect("boot leaves a stalled review phase parked for a human", () =>
  withGovernor(stuck(), ({ reactor, board, decided }) =>
    Effect.gen(function* () {
      yield* reactor.drain;
      assert.deepStrictEqual(selectedStepIds(yield* decided), []);
      assert.strictEqual(boardCardStepState(yield* board, cardId)?.status, "stalled");
    }),
  ),
);

it.effect("Continue runs the owed phase on a new thread, and the loop carries on", () =>
  withGovernor(stuck(), ({ pumpDomain, board, commands, decided }) =>
    Effect.gen(function* () {
      yield* pumpDomain(stepRequeued(stalledAdjudicate, 2));

      // The step had no thread to nudge, so admission spawned one with the
      // phase's own prompt: the adjudicator starts from its full instructions.
      const running = boardCardStepState(yield* board, cardId);
      assert.strictEqual(running?.stepId, "adjudicate@1");
      assert.strictEqual(running?.status, "running");
      assert.isNotNull(running?.threadId ?? null);
      const created = (yield* commands).find((command) => command.type === "thread.create");
      assert.isDefined(created, "a thread is spawned for the owed phase");
      const turn = (yield* commands).find(
        (command) => command.type === "thread.turn.start" && command.threadId === running?.threadId,
      );
      assert.include(
        turn?.type === "thread.turn.start" ? turn.message.text : "",
        ADJUDICATE_PROMPT,
        "the new thread is given the phase's prompt",
      );

      // …and when it finishes, the loop plans the next round as normal.
      yield* pumpDomain(adjudicated(3));
      assert.deepStrictEqual(selectedStepIds(yield* decided), ["review@2"]);
    }),
  ),
);

it.effect("Restart supersedes the stalled phase with a fresh unattended run of it", () =>
  withGovernor(stuck(), ({ pumpDomain, board, decided }) =>
    Effect.gen(function* () {
      yield* pumpDomain(stageThreadRequested(2));

      // The loop re-plans from its record: the owed phase, with its prompt and
      // unattended, not an empty human-in-the-loop conversation that would end
      // without reporting the phase.
      const selected = (yield* decided).find(
        (event) => event.type === "board.card-step-selected",
      ) as Extract<OrchestrationEvent, { type: "board.card-step-selected" }> | undefined;
      assert.strictEqual(selected?.payload.state.stepId, "adjudicate@1");
      assert.isFalse(selected?.payload.state.humanInLoop);
      assert.include(selected?.payload.state.prompt ?? "", "Adjudicate phase, round 1");

      const running = boardCardStepState(yield* board, cardId);
      assert.strictEqual(running?.status, "running");
      assert.isNotNull(running?.threadId ?? null);

      yield* pumpDomain(adjudicated(3));
      assert.deepStrictEqual(selectedStepIds(yield* decided), ["adjudicate@1", "review@2"]);
    }),
  ),
);

it.effect("Moving to the next stage settles the stalled phase and runs no more review", () =>
  withGovernor(stuck(), ({ pumpDomain, board, decided }) =>
    Effect.gen(function* () {
      const moved = { ...reviewCard(), stage: BOARD_SEED_STAGE_IDS.merge };
      yield* pumpDomain(cardMoved(moved, review, merge, 2));

      const state = boardCardStepState(yield* board, cardId);
      assert.strictEqual(state?.stepId, "adjudicate@1");
      assert.strictEqual(state?.status, "abandoned");
      assert.deepStrictEqual(selectedStepIds(yield* decided), []);
    }),
  ),
);
