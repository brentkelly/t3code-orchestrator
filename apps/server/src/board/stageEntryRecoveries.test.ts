/**
 * The runaway ceiling counts RECOVERIES, not planned work (T3O-12, D4/D5),
 * driven end to end through the live reactor.
 *
 * The card this exists for: a Code review loop hit its five-round cap without
 * converging, the user granted it two more rounds, and the loop resumed and ran
 * correctly — while the card went red saying recovery had given up. The ceiling
 * used to be read off `attempt`, which every PLANNED phase selection carried
 * forward: five rounds of three phases is 15 of the default 20 before a single
 * thing has gone wrong, and the observed card reached `attempt = 45` against a
 * `maxAttempts` of 5. Past roughly round 7 the ceiling was permanently blown,
 * so the first stall of any kind escalated instantly with no ladder at all.
 * Raising the round budget was what pushed a healthy loop over it.
 *
 * `recoveryDecision`'s own arithmetic is unit-tested in `supervisor.test.ts`
 * and the decider's stamping in `decider.step.test.ts`. What is only provable
 * here is the wiring: that the reactor carries the recovery total across a
 * phase boundary, resets it on a genuine stage entry, and does not charge the
 * loop's planned steps to it.
 */
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Duration from "effect/Duration";
import * as Ref from "effect/Ref";
import * as TestClock from "effect/testing/TestClock";

import {
  BOARD_SEED_STAGE_IDS,
  BoardCardId,
  boardCardStepState,
  boardStageEntryRecoveryCount,
  DEFAULT_BOARD_REVIEW_STAGE_EXECUTION,
  DEFAULT_TEXT_GENERATION_MODEL,
  ThreadId,
  type BoardReviewFinding,
  type BoardSettings,
  type BoardState,
  type OrchestrationEvent,
  type OrchestrationThreadShell,
} from "@t3tools/contracts";

import {
  cardMoved,
  codexStep,
  idleThreadShell,
  makeBoardCard,
  NOW,
  readyWorktree,
  settingsWith,
  turnCompleted,
  withGovernor,
} from "./supervisorHarness.testkit.ts";

const cardId = BoardCardId.make("card-1");

const reviewCard = () =>
  makeBoardCard({
    id: "card-1",
    stage: "review",
    orderKey: "m",
    worktree: readyWorktree("card-1"),
  });

/** Review settings that auto-run the loop on the build step's provider, so the
    phase model resolves without a fallback. */
const reviewSettings = (): BoardSettings => {
  const base = settingsWith({ building: [codexStep], globalMaxConcurrent: 3 });
  return {
    ...base,
    pipeline: {
      ...base.pipeline,
      [BOARD_SEED_STAGE_IDS.review]: {
        ...DEFAULT_BOARD_REVIEW_STAGE_EXECUTION,
        autoExecute: true,
        autoAdvance: true,
        model: { instanceId: codexStep.providerInstanceId, model: DEFAULT_TEXT_GENERATION_MODEL },
      },
    },
  };
};

/** The review stage with a deliberately tiny runaway ceiling, so a test can
    reach it in two events instead of twenty. */
const tightCeiling = (ceiling: number): BoardSettings => {
  const base = reviewSettings();
  return {
    ...base,
    pipeline: {
      ...base.pipeline,
      [BOARD_SEED_STAGE_IDS.review]: {
        ...base.pipeline[String(BOARD_SEED_STAGE_IDS.review)],
        maxInvocationsPerStageEntry: ceiling,
      },
    },
  } as BoardSettings;
};

/** A blocking finding, so the loop plans triage rather than converging. */
const critical: BoardReviewFinding = {
  id: "f1",
  severity: "critical",
  file: "src/x.ts",
  line: 1,
  title: "a real one",
  detail: "",
};

/** Each phase's payload has its own required shape, and a `succeeded`
    completion whose payload does not parse to it halts the loop (T3O-14) —
    which would silently end these tests one phase early. */
const phasePayload = (stepId: string): string => {
  if (stepId.startsWith("review@")) {
    return JSON.stringify({ reviewedSha: "sha-review", findings: [critical] });
  }
  if (stepId.startsWith("triage@")) {
    return JSON.stringify({
      fixedSha: "sha-fixed",
      dispositions: [{ findingId: critical.id, action: "fixed", note: "done" }],
    });
  }
  return JSON.stringify({
    verdicts: [{ findingId: critical.id, verdict: "fix-upheld", note: "" }],
  });
};

const reviewPhaseCompleted = (stepId: string, sequence: number): OrchestrationEvent =>
  ({
    type: "board.card-step-completed",
    sequence,
    payload: {
      cardId,
      completion: {
        cardId,
        stepId,
        outcome: "succeeded",
        summary: `did ${stepId}`,
        payload: phasePayload(stepId),
        threadId: null,
        completedAt: NOW,
      },
    },
  }) as unknown as OrchestrationEvent;

const liveStepId = (board: BoardState) => boardCardStepState(board, cardId)?.stepId ?? null;
const attemptOf = (board: BoardState) => boardCardStepState(board, cardId)?.attempt ?? -1;
const recoveriesOf = (board: BoardState) => boardStageEntryRecoveryCount(board, cardId);

/** The thread the card's live step is running on. */
const liveThread = (board: BoardState): ThreadId => {
  const threadId = boardCardStepState(board, cardId)?.threadId;
  assert.ok(threadId != null, "the live step has a thread");
  return threadId;
};

const shellsFor = (
  entries: ReadonlyArray<readonly [string, OrchestrationThreadShell]>,
): ReadonlyMap<string, OrchestrationThreadShell> => new Map(entries);

it.effect("T3O-12: the review loop's PLANNED phases spend no recovery budget", () =>
  withGovernor(
    { board: { cards: [reviewCard()], nextCardNumberByProject: {} }, settings: reviewSettings() },
    ({ pumpDomain, board }) =>
      Effect.gen(function* () {
        yield* pumpDomain(cardMoved(reviewCard(), "building", "review", 1));
        assert.strictEqual(liveStepId(yield* board), "review@1");
        assert.strictEqual(recoveriesOf(yield* board), 0);

        // Three healthy phase crossings — the shape that used to charge the
        // ceiling three times and, at ten rounds, thirty.
        yield* pumpDomain(reviewPhaseCompleted("review@1", 2));
        assert.strictEqual(liveStepId(yield* board), "triage@1");
        yield* pumpDomain(reviewPhaseCompleted("triage@1", 3));
        assert.strictEqual(liveStepId(yield* board), "adjudicate@1");

        // Nothing has gone wrong, so nothing has been spent — however many
        // rounds the loop legitimately runs for.
        assert.strictEqual(recoveriesOf(yield* board), 0);
        // And each phase counts its own attempts, so the card never displays
        // the "attempt 45 of 5" the old carry produced.
        assert.strictEqual(attemptOf(yield* board), 1);
      }),
  ),
);

it.effect("T3O-12: a recovery IS charged, and the total survives the next phase boundary", () =>
  withGovernor(
    { board: { cards: [reviewCard()], nextCardNumberByProject: {} }, settings: reviewSettings() },
    ({ pumpDomain, pumpRuntime, board, shells }) =>
      Effect.gen(function* () {
        yield* pumpDomain(cardMoved(reviewCard(), "building", "review", 1));
        const thread = liveThread(yield* board);

        // review@1's turn ends without the agent completing the step: the
        // death/stall test nudges it, which is a recovery.
        yield* Ref.set(shells, shellsFor([[String(thread), idleThreadShell(String(thread))]]));
        yield* pumpRuntime(turnCompleted(thread));
        assert.strictEqual(recoveriesOf(yield* board), 1);
        assert.strictEqual(attemptOf(yield* board), 2);

        // The phase then finishes and the loop moves on. The projector keeps
        // ONE step-state row per card, so without the carry the stage entry's
        // spend would silently reset here and the real bound would become
        // rounds × phases × ceiling.
        yield* pumpDomain(reviewPhaseCompleted("review@1", 2));
        assert.strictEqual(liveStepId(yield* board), "triage@1");
        assert.strictEqual(recoveriesOf(yield* board), 1);
        // `attempt` does NOT ride along: a new phase is a new step.
        assert.strictEqual(attemptOf(yield* board), 1);
      }),
  ),
);

it.effect("T3O-12: a genuine stage entry resets the recovery total", () =>
  withGovernor(
    { board: { cards: [reviewCard()], nextCardNumberByProject: {} }, settings: reviewSettings() },
    ({ pumpDomain, pumpRuntime, board, shells }) =>
      Effect.gen(function* () {
        yield* pumpDomain(cardMoved(reviewCard(), "building", "review", 1));
        const thread = liveThread(yield* board);
        yield* Ref.set(shells, shellsFor([[String(thread), idleThreadShell(String(thread))]]));
        yield* pumpRuntime(turnCompleted(thread));
        assert.strictEqual(recoveriesOf(yield* board), 1);

        // A human drags the card back to Building and forward again. That is a
        // new stage entry, and its budget starts over — the same rule `attempt`
        // has always followed.
        yield* pumpDomain(cardMoved(reviewCard(), "review", "building", 2));
        yield* pumpDomain(cardMoved(reviewCard(), "building", "review", 3));
        assert.strictEqual(liveStepId(yield* board), "review@1");
        assert.strictEqual(recoveriesOf(yield* board), 0);
      }),
  ),
);

it.effect(
  "T3O-12: the ceiling escalates on recoveries, and a long clean loop never reaches it",
  () =>
    withGovernor(
      {
        board: { cards: [reviewCard()], nextCardNumberByProject: {} },
        // A ceiling of 1, so ONE recovery is within budget and the second crosses
        // it. Driving twenty recoveries through the reactor would assert the same
        // thing twenty times more slowly.
        settings: tightCeiling(1),
      },
      ({ pumpDomain, pumpRuntime, board, shells, reactor }) =>
        Effect.gen(function* () {
          yield* pumpDomain(cardMoved(reviewCard(), "building", "review", 1));
          const thread = liveThread(yield* board);
          yield* Ref.set(shells, shellsFor([[String(thread), idleThreadShell(String(thread))]]));

          // First recovery: within budget, so the step is RETRIED. Since T3O-22
          // (D7) a retry waits its backoff rung, so both outcomes now wear the
          // `stalled` status and the REASON is what tells them apart — waiting
          // to retry, with a time, versus recovery having given up with none.
          yield* pumpRuntime(turnCompleted(thread));
          assert.strictEqual(recoveriesOf(yield* board), 1);
          const retrying = boardCardStepState(yield* board, cardId);
          assert.strictEqual(retrying?.stalledReason, "waiting-retry");
          assert.ok(retrying?.retryAt !== null, "a retry says when it will try again");

          // Second: crosses the ceiling. `maxAttempts` is nowhere near exhausted
          // (this is stall #2 of a default 5), so the ladder is not what stops it
          // — the runaway detector is, which is the job it keeps.
          // Wait the rung out and let the retry sweep put the step back to
          // work, which is the real path — the ladder is charged at the stop and
          // the nudge is delivered here.
          yield* TestClock.adjust(Duration.minutes(5));
          yield* reactor.fireRetries;
          yield* reactor.drain;
          assert.strictEqual(boardCardStepState(yield* board, cardId)?.status, "running");
          yield* pumpRuntime(turnCompleted(thread));
          const escalated = boardCardStepState(yield* board, cardId);
          assert.strictEqual(escalated?.status, "stalled");
          assert.strictEqual(escalated?.stalledReason, "gave-up");
          assert.strictEqual(escalated?.retryAt, null, "an escalation promises no retry");
          assert.isBelow(escalated?.stallCount ?? 99, 5);
        }),
    ),
);

it.effect(
  "T3O-12 regression: planned phases do not consume the ceiling, so the next stall is nudged and not escalated",
  () =>
    withGovernor(
      {
        board: { cards: [reviewCard()], nextCardNumberByProject: {} },
        // A ceiling of 2 stands in for the shipped 20 against a loop long
        // enough to have crossed it: two planned phase crossings is the same
        // shape as ten rounds against the default.
        settings: tightCeiling(2),
      },
      ({ pumpDomain, pumpRuntime, board, shells }) =>
        Effect.gen(function* () {
          yield* pumpDomain(cardMoved(reviewCard(), "building", "review", 1));
          // Two healthy crossings. Under the old ceiling these alone put the
          // stage entry's counted total at 3 — past the budget — with nothing
          // having gone wrong.
          yield* pumpDomain(reviewPhaseCompleted("review@1", 2));
          yield* pumpDomain(reviewPhaseCompleted("triage@1", 3));
          assert.strictEqual(liveStepId(yield* board), "adjudicate@1");

          // Now one ordinary stall: a turn that ended without completing the
          // step. The correct response is a nudge — this is stall #1 of a
          // default 5, and the stage has spent nothing on recovery.
          const thread = liveThread(yield* board);
          yield* Ref.set(shells, shellsFor([[String(thread), idleThreadShell(String(thread))]]));
          yield* pumpRuntime(turnCompleted(thread));

          // The bug: the old ceiling escalated here instantly, landing the card
          // red with "Recovery gave up after repeated attempts with no
          // progress. Nothing is running." on a card whose loop was healthy.
          assert.strictEqual(
            boardCardStepState(yield* board, cardId)?.stalledReason,
            "waiting-retry",
            "a healthy long loop's first stall is retried, not escalated",
          );
          assert.strictEqual(recoveriesOf(yield* board), 1);
        }),
    ),
);
