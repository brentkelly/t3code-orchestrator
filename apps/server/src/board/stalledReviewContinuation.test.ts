/**
 * A review loop whose next phase never started (T3O-5), against the LIVE
 * reactor.
 *
 * The halt this closes: `adjudicate@1` completed `succeeded` and the step
 * settled, but the continuation that should have selected `review@2` failed
 * (the disk was full, so the dispatch never landed). The ledger then says
 * round 2 is owed while the step row says the stage is finished with nothing
 * live. Nothing asked the executor again: an idempotent repeat of the
 * completion returned early, and boot reconcile only walks steps that are
 * still in flight. The card sat in Code review with no thread, for ever.
 *
 * Both ways back in are pinned here: the agent re-calling
 * `board_complete_step`, and a server restart.
 */
import {
  BoardCardId,
  BOARD_SEED_STAGE_IDS,
  DEFAULT_BOARD_REVIEW_STAGE_EXECUTION,
  ProviderInstanceId,
  type BoardCardStepState,
  type BoardStepCompletion,
  type OrchestrationEvent,
} from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import {
  codexStep,
  makeBoardCard,
  NOW,
  readyWorktree,
  settingsWith,
  withGovernor,
} from "./supervisorHarness.testkit.ts";

const cardId = BoardCardId.make("card-1");

const reviewCard = (stage: string = String(BOARD_SEED_STAGE_IDS.review)) =>
  makeBoardCard({
    id: "card-1",
    stage,
    orderKey: "m",
    worktree: readyWorktree("card-1"),
  });

const settledStep = (stepId: string, baseTipAtRoundStart = "main"): BoardCardStepState => ({
  cardId,
  stepId,
  stepLabel: stepId,
  stageLabel: "Code review",
  attempt: 1,
  stallCount: 0,
  stageEntryRecoveries: 0,
  humanTurnAt: null,
  lastNudgeAt: null,
  baseTipAtRoundStart,
  lastError: null,
  awaitingReason: "question",
  stalledReason: "gave-up",
  retryAt: null,
  prompt: "adjudicate it",
  providerInstanceId: ProviderInstanceId.make("codex"),
  model: "gpt-5-codex",
  mode: "build",
  runtimeMode: "auto",
  humanInLoop: false,
  maxAttempts: 3,
  timeoutMs: 600_000,
  threadId: null,
  status: "succeeded",
  slotHeld: false,
  forceStart: false,
  startedAt: null,
  updatedAt: NOW,
});

const completion = (stepId: string, payload: unknown): BoardStepCompletion => ({
  cardId,
  stepId,
  outcome: "succeeded",
  summary: `${stepId} done`,
  payload: JSON.stringify(payload),
  threadId: null,
  completedAt: NOW,
});

/** Round 1 with a blocking finding the adjudicator ruled not fixed: the loop
    owes round 2. */
const roundOne = [
  completion("review@1", {
    reviewedSha: "abc123",
    findings: [
      {
        id: "R1-1",
        severity: "improvement",
        file: "src/x.ts",
        line: 1,
        title: "Thing",
        detail: "",
      },
    ],
  }),
  completion("triage@1", {
    fixedSha: "def456",
    dispositions: [{ findingId: "R1-1", action: "fixed", note: "" }],
  }),
  completion("adjudicate@1", {
    verdicts: [{ findingId: "R1-1", verdict: "fix-incomplete", note: "still panics" }],
  }),
];

const halted = (stepCompletions: ReadonlyArray<BoardStepCompletion>, stepId: string) => ({
  board: {
    cards: [reviewCard()],
    stepStates: [settledStep(stepId)],
    stepCompletions: [...stepCompletions],
    nextCardNumberByProject: {},
  },
  settings: settingsWith({ building: [codexStep], globalMaxConcurrent: 3 }),
});

const withReviewAutoExecute = (autoExecute: boolean) => {
  const settings = settingsWith({ building: [codexStep], globalMaxConcurrent: 3 });
  return {
    ...settings,
    pipeline: {
      ...settings.pipeline,
      [BOARD_SEED_STAGE_IDS.review]: { ...DEFAULT_BOARD_REVIEW_STAGE_EXECUTION, autoExecute },
    },
  };
};

const repeatCompletion = (recorded: BoardStepCompletion): OrchestrationEvent =>
  ({
    type: "board.card-step-completed",
    sequence: 2,
    payload: { cardId, completion: recorded },
  }) as unknown as OrchestrationEvent;

const selectedStepIds = (events: ReadonlyArray<OrchestrationEvent>): ReadonlyArray<string> =>
  events.flatMap((event) =>
    event.type === "board.card-step-selected" && event.payload.state.cardId === cardId
      ? [event.payload.state.stepId]
      : [],
  );

it.effect("boot starts the round a settled review phase owes but never started", () =>
  withGovernor(halted(roundOne, "adjudicate@1"), ({ reactor, decided }) =>
    Effect.gen(function* () {
      yield* reactor.drain;
      assert.deepStrictEqual(selectedStepIds(yield* decided), ["review@2"]);
    }),
  ),
);

it.effect("a repeated completion of the settled phase starts the round it owes", () =>
  withGovernor(
    {
      ...halted(roundOne, "adjudicate@1"),
      // Boot heals this card on its own, so hold the stage manual while the
      // reactor boots and isolate what the repeat completion does by itself.
      settings: withReviewAutoExecute(false),
    },
    ({ reactor, pumpDomain, decided, setBoardSettings }) =>
      Effect.gen(function* () {
        yield* reactor.drain;
        assert.deepStrictEqual(selectedStepIds(yield* decided), []);
        setBoardSettings(withReviewAutoExecute(true));
        // What the adjudicator did on the halted card: call
        // board_complete_step again. The decider re-emits the pinned record.
        yield* pumpDomain(repeatCompletion(roundOne[2]!));
        assert.deepStrictEqual(selectedStepIds(yield* decided), ["review@2"]);
      }),
  ),
);

it.effect("a converged loop is left alone at boot", () =>
  withGovernor(
    halted([completion("review@1", { reviewedSha: "abc123", findings: [] })], "review@1"),
    ({ reactor, decided }) =>
      Effect.gen(function* () {
        yield* reactor.drain;
        assert.deepStrictEqual(selectedStepIds(yield* decided), []);
      }),
  ),
);

it.effect("a converged sub-board child with a moved base is not synced at boot", () =>
  withGovernor(
    {
      board: {
        cards: [
          makeBoardCard({ id: "card-parent", stage: "building", orderKey: "a" }),
          { ...reviewCard(), parentCardId: BoardCardId.make("card-parent") },
        ],
        // Recorded at a tip the stub no longer answers, so the base reads
        // stale. Staleness stays measured at the review→merge crossing and the
        // Merge click; a restart must not turn it into a rebase-and-force-push.
        stepStates: [settledStep("review@1", "sha-before-sibling-merged")],
        stepCompletions: [completion("review@1", { reviewedSha: "abc123", findings: [] })],
        nextCardNumberByProject: {},
      },
      settings: settingsWith({ building: [codexStep], globalMaxConcurrent: 3 }),
    },
    ({ reactor, decided }) =>
      Effect.gen(function* () {
        yield* reactor.drain;
        assert.deepStrictEqual(selectedStepIds(yield* decided), []);
      }),
  ),
);

/** A card dragged back from Code review to Building — a stage that DOES
    auto-execute — while its step row still names the settled review phase.
    A re-plan let through here would start a build step nobody asked for. */
const leftBehind = () => ({
  board: {
    cards: [reviewCard(String(BOARD_SEED_STAGE_IDS.building))],
    stepStates: [settledStep("adjudicate@1")],
    stepCompletions: [...roundOne],
    nextCardNumberByProject: {},
  },
  settings: settingsWith({ building: [codexStep], globalMaxConcurrent: 3 }),
});

it.effect("a review step left behind by a card that moved on is not re-planned at boot", () =>
  withGovernor(leftBehind(), ({ reactor, decided }) =>
    Effect.gen(function* () {
      yield* reactor.drain;
      assert.deepStrictEqual(selectedStepIds(yield* decided), []);
    }),
  ),
);

it.effect("a repeated review completion on a card that moved on is not re-planned", () =>
  withGovernor(leftBehind(), ({ reactor, pumpDomain, decided }) =>
    Effect.gen(function* () {
      yield* reactor.drain;
      yield* pumpDomain(repeatCompletion(roundOne[2]!));
      assert.deepStrictEqual(selectedStepIds(yield* decided), []);
    }),
  ),
);
