/**
 * The card auto-settles finished threads, and the settle must actually LAND: an agent
 * completes its step from inside its own turn, so the first settle is refused. Assertions
 * read `settledThreads` (what the decider accepted), not `commands` (what was asked).
 */
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Ref from "effect/Ref";

import {
  BoardCardId,
  BOARD_SEED_STAGE_IDS,
  DEFAULT_BOARD_REVIEW_STAGE_EXECUTION,
  DEFAULT_TEXT_GENERATION_MODEL,
  ThreadId,
  type BoardReviewFinding,
  type BoardSettings,
} from "@t3tools/contracts";

import {
  aliveThreadShell,
  cardMoved,
  codexStep,
  idleThreadShell,
  makeBoardCard,
  NOW,
  readyWorktree,
  settingsWith,
  turnCompleted,
  withGovernor,
  type HarnessEvent,
} from "./supervisorHarness.testkit.ts";
import type { BoardThreadState } from "./ThreadGateway.ts";
import { fakeThreadState } from "./threadGateway.testkit.ts";

// Review settings that auto-run the loop: the review stage entry auto-executes
// its phases and auto-advances on convergence, on the same provider the build
// step uses so the phase model resolves without a fallback.
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

const nitpick: BoardReviewFinding = {
  id: "f1",
  severity: "nitpick",
  file: "src/x.ts",
  line: 1,
  title: "a nit",
  detail: "",
};

// A review-phase completion carrying its structured payload — `stepCompleted`
// hardcodes the Building step id and a null payload, so the review loop needs
// its own builder to record findings the executor reads.
const reviewPhaseCompleted = (
  cardId: BoardCardId,
  stepId: string,
  findings: ReadonlyArray<BoardReviewFinding>,
  sequence: number,
): HarnessEvent =>
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
        payload: JSON.stringify({ reviewedSha: "sha-review", findings }),
        threadId: null,
        completedAt: NOW,
      },
    },
  }) as unknown as HarnessEvent;

const link = (threadId: string, role: string) => ({
  threadId: ThreadId.make(threadId),
  role,
  linkedAt: NOW,
  tombstonedAt: null,
});

const shellsFor = (
  entries: ReadonlyArray<readonly [string, BoardThreadState]>,
): ReadonlyMap<string, BoardThreadState> => new Map(entries);

// A settle refused mid-turn is retried: review@1's agent reported from inside its turn, so
// the decider refuses until the turn ends and the release is asked again.
it.effect("a phase's thread settles once its turn ends, not while its agent is mid-turn", () =>
  withGovernor(
    {
      board: {
        cards: [
          makeBoardCard({
            id: "card-1",
            stage: "review",
            orderKey: "m",
            worktree: readyWorktree("card-1"),
          }),
        ],
        nextCardNumberByProject: {},
      },
      settings: reviewSettings(),
    },
    ({ pumpDomain, pumpRuntime, board, shells, settledThreads }) =>
      Effect.gen(function* () {
        const id = BoardCardId.make("card-1");
        // Enter Code review — the loop auto-spawns review@1.
        yield* pumpDomain(
          cardMoved(
            makeBoardCard({
              id: "card-1",
              stage: "review",
              orderKey: "m",
              worktree: readyWorktree("card-1"),
            }),
            "building",
            "review",
            1,
          ),
        );
        const review1 = (yield* board).cards
          .find((card) => card.id === id)
          ?.threadLinks.find((entry) => entry.role === "review@1" && entry.tombstonedAt === null);
        assert.ok(review1, "review@1 spawned a thread");
        const review1Thread = String(review1.threadId);

        // The agent is mid-turn: it is calling `board_complete_step` right now.
        yield* Ref.set(shells, shellsFor([[review1Thread, aliveThreadShell(review1Thread)]]));
        yield* pumpDomain(reviewPhaseCompleted(id, "review@1", [nitpick], 2));

        // The loop genuinely moved on — the card is finished with review@1 —
        // and yet the thread is NOT settled, because its agent is still working.
        assert.ok(
          (yield* board).cards
            .find((card) => card.id === id)
            ?.threadLinks.some((entry) => entry.role === "triage@1" && entry.tombstonedAt === null),
          "triage@1 was spawned as the next phase",
        );
        assert.ok(
          !(yield* settledThreads).has(review1Thread),
          "a thread mid-turn is not settled out from under its agent",
        );

        // The turn ends. THIS is the retry the old code never had.
        yield* Ref.set(shells, shellsFor([[review1Thread, idleThreadShell(review1Thread)]]));
        yield* pumpRuntime(turnCompleted(ThreadId.make(review1Thread)));
        assert.ok(
          (yield* settledThreads).has(review1Thread),
          "review@1's thread settled once its turn ended",
        );
      }),
  ),
);

// A `turn.completed` can be missed, so the 30-second sweep must land the settle on its own.
it.effect("the periodic release sweep lands a settle that was refused earlier", () =>
  withGovernor(
    {
      board: {
        cards: [
          {
            ...makeBoardCard({ id: "card-1", stage: "merge", orderKey: "m" }),
            threadLinks: [link("thread-build-1", String(BOARD_SEED_STAGE_IDS.building))],
          },
        ],
        nextCardNumberByProject: {},
      },
      settings: settingsWith({ building: [codexStep], globalMaxConcurrent: 3 }),
      initialShells: shellsFor([["thread-build-1", aliveThreadShell("thread-build-1")]]),
    },
    ({ reactor, shells, settledThreads }) =>
      Effect.gen(function* () {
        yield* reactor.releaseThreads;
        assert.ok(!(yield* settledThreads).has("thread-build-1"), "the busy thread was left alone");
        yield* Ref.set(shells, shellsFor([["thread-build-1", idleThreadShell("thread-build-1")]]));
        yield* reactor.releaseThreads;
        assert.ok((yield* settledThreads).has("thread-build-1"), "the next sweep settled it");
      }),
  ),
);

// `turn.completed` arrives for every thread on the machine, and only a finished thread's
// OWN turn ending can unblock its settle, so a stranger's turn must not trigger a sweep.
it.effect("a turn ending on a thread the board does not own runs no release sweep", () =>
  withGovernor(
    {
      board: {
        cards: [
          {
            ...makeBoardCard({ id: "card-1", stage: "merge", orderKey: "m" }),
            threadLinks: [link("thread-build-1", String(BOARD_SEED_STAGE_IDS.building))],
          },
        ],
        nextCardNumberByProject: {},
      },
      settings: settingsWith({ building: [codexStep], globalMaxConcurrent: 3 }),
      // Mid-turn at boot, so the reconcile sweep refuses it and the settle is
      // still outstanding when the stranger's turn ends.
      initialShells: shellsFor([["thread-build-1", aliveThreadShell("thread-build-1")]]),
    },
    ({ pumpRuntime, reactor, shells, settledThreads }) =>
      Effect.gen(function* () {
        // Let boot reconcile run first, against the busy shell, so the settle it
        // asks for is refused and the only sweep left is the one under test.
        yield* reactor.drain;
        // Now settleable: idle, released, and nothing else refuses it. The only
        // thing standing between it and a settle is whether the sweep runs.
        yield* Ref.set(
          shells,
          shellsFor([
            ["thread-build-1", idleThreadShell("thread-build-1")],
            ["thread-stranger", idleThreadShell("thread-stranger")],
          ]),
        );
        yield* pumpRuntime(turnCompleted(ThreadId.make("thread-stranger")));
        assert.ok(
          !(yield* settledThreads).has("thread-build-1"),
          "a stranger's turn ending did not trigger the board's release sweep",
        );
        // And the fixture really was one sweep away from settling, so the
        // assertion above is about the gate and not about an unsettleable thread.
        yield* reactor.releaseThreads;
        assert.ok(
          (yield* settledThreads).has("thread-build-1"),
          "the board's own sweep still settles it",
        );
      }),
  ),
);

// The decider refuses to settle a thread with an unanswered approval, possibly for days, so
// the sweep skips it via upstream's `isAutoSettlementCandidate` rather than re-asking.
it.effect("a released thread with an unanswered approval is left alone", () =>
  withGovernor(
    {
      board: {
        cards: [
          {
            ...makeBoardCard({ id: "card-1", stage: "merge", orderKey: "m" }),
            threadLinks: [link("thread-build-1", String(BOARD_SEED_STAGE_IDS.building))],
          },
        ],
        nextCardNumberByProject: {},
      },
      settings: settingsWith({ building: [codexStep], globalMaxConcurrent: 3 }),
      initialShells: shellsFor([
        ["thread-build-1", fakeThreadState("thread-build-1", { pendingApproval: true })],
      ]),
    },
    ({ reactor, commands, settledThreads }) =>
      Effect.gen(function* () {
        yield* reactor.releaseThreads;
        assert.ok(!(yield* settledThreads).has("thread-build-1"), "it was not settled");
        assert.deepStrictEqual(
          (yield* commands).filter((command) => command.type === "thread.settle"),
          [],
          "and no settle was even asked for, so no rejected receipt is written",
        );
      }),
  ),
);

// A repeating sweep must not keep settling what it already settled: every
// re-settle would write another `thread.settled` event, forever.
it.effect("a settled thread is not settled again by the next sweep", () =>
  withGovernor(
    {
      board: {
        cards: [
          {
            ...makeBoardCard({ id: "card-1", stage: "merge", orderKey: "m" }),
            threadLinks: [link("thread-build-1", String(BOARD_SEED_STAGE_IDS.building))],
          },
        ],
        nextCardNumberByProject: {},
      },
      settings: settingsWith({ building: [codexStep], globalMaxConcurrent: 3 }),
      initialShells: shellsFor([["thread-build-1", idleThreadShell("thread-build-1")]]),
    },
    ({ reactor, commands }) =>
      Effect.gen(function* () {
        const settleCount = commands.pipe(
          Effect.map(
            (dispatched) =>
              dispatched.filter(
                (command) =>
                  command.type === "thread.settle" &&
                  command.auto &&
                  String(command.threadId) === "thread-build-1",
              ).length,
          ),
        );
        yield* reactor.releaseThreads;
        assert.strictEqual(yield* settleCount, 1, "the first sweep settled it");
        yield* reactor.releaseThreads;
        yield* reactor.releaseThreads;
        assert.strictEqual(yield* settleCount, 1, "later sweeps asked for nothing");
      }),
  ),
);

// ── Graduation ──────────────────────────────────────────────────────────────
it.effect("a forward stage move settles the thread the card is finished with", () =>
  withGovernor(
    {
      board: {
        cards: [
          {
            ...makeBoardCard({
              id: "card-1",
              stage: "review",
              orderKey: "m",
              worktree: readyWorktree("card-1"),
            }),
            threadLinks: [link("thread-build-1", String(BOARD_SEED_STAGE_IDS.building))],
          },
        ],
        nextCardNumberByProject: {},
      },
      settings: reviewSettings(),
      initialShells: shellsFor([["thread-build-1", idleThreadShell("thread-build-1")]]),
    },
    ({ pumpDomain, board, settledThreads }) =>
      Effect.gen(function* () {
        const id = BoardCardId.make("card-1");
        const movedCard = {
          ...makeBoardCard({
            id: "card-1",
            stage: "review",
            orderKey: "m",
            worktree: readyWorktree("card-1"),
          }),
          threadLinks: [link("thread-build-1", String(BOARD_SEED_STAGE_IDS.building))],
        };
        yield* pumpDomain(cardMoved(movedCard, "building", "review", 1));
        assert.ok(
          (yield* settledThreads).has("thread-build-1"),
          "the build thread settled on graduation",
        );
        // The link survives the settle — the card keeps its tab.
        assert.ok(
          (yield* board).cards
            .find((card) => card.id === id)
            ?.threadLinks.some(
              (entry) => String(entry.threadId) === "thread-build-1" && entry.tombstonedAt === null,
            ),
          "the settled thread stays linked to the card",
        );
      }),
  ),
);

// A backward move settles the stage's threads. Safe because a settle is not a one-way door:
// the decider un-settles a thread whose session comes alive again.
it.effect("a backward stage move settles the threads the card was dragged out of", () =>
  withGovernor(
    {
      board: {
        cards: [
          {
            ...makeBoardCard({ id: "card-1", stage: "ready", orderKey: "m" }),
            threadLinks: [link("thread-review-1", "review@1")],
          },
        ],
        nextCardNumberByProject: {},
      },
      settings: settingsWith({ building: [codexStep], globalMaxConcurrent: 3 }),
      initialShells: shellsFor([["thread-review-1", idleThreadShell("thread-review-1")]]),
    },
    ({ pumpDomain, settledThreads }) =>
      Effect.gen(function* () {
        // Drag the card back from Code review to the manual Ready column.
        const reopened = {
          ...makeBoardCard({ id: "card-1", stage: "ready", orderKey: "m" }),
          threadLinks: [link("thread-review-1", "review@1")],
        };
        yield* pumpDomain(cardMoved(reopened, "review", "ready", 1));
        assert.ok(
          (yield* settledThreads).has("thread-review-1"),
          "the review round the card left behind was settled",
        );
      }),
  ),
);

// ── What must never be settled ──────────────────────────────────────────────
// A planning step parked on a human is the single loudest thing in the inbox.
// Settling it would hide the question the card is waiting on.
it.effect("a card's own live step thread is never settled", () =>
  withGovernor(
    {
      board: {
        cards: [makeBoardCard({ id: "card-1", stage: "planning", orderKey: "m" })],
        nextCardNumberByProject: {},
      },
      settings: settingsWith({
        building: [codexStep],
        planning: codexStep,
        planningHumanInLoop: true,
        globalMaxConcurrent: 3,
      }),
    },
    ({ pumpDomain, pumpRuntime, board, shells, settledThreads }) =>
      Effect.gen(function* () {
        const id = BoardCardId.make("card-1");
        yield* pumpDomain(
          cardMoved(
            makeBoardCard({ id: "card-1", stage: "planning", orderKey: "m" }),
            "ready",
            "planning",
            1,
          ),
        );
        const planning = (yield* board).cards
          .find((card) => card.id === id)
          ?.threadLinks.find((entry) => entry.tombstonedAt === null);
        assert.ok(planning, "the planning step spawned a thread");
        const planningThread = String(planning.threadId);

        // The agent stops mid-interview, waiting on the human. Its step parks on
        // the gate, and the release pass runs on that very turn ending.
        yield* Ref.set(shells, shellsFor([[planningThread, idleThreadShell(planningThread)]]));
        yield* pumpRuntime(turnCompleted(ThreadId.make(planningThread)));
        assert.strictEqual(
          (yield* board).stepStates?.[0]?.status,
          "awaiting-input",
          "the step parked on the human gate",
        );
        assert.ok(
          !(yield* settledThreads).has(planningThread),
          "a thread waiting on a human stays in the inbox",
        );
      }),
  ),
);

// ── The backlog nothing would ever ask about again ──────────────────────────
// The release is a predicate over state, not an event to catch, so boot needs no
// backlog to replay: it simply asks the question once. That is what clears the
// threads finished before this ever shipped.
it.effect("boot reconcile settles the threads finished while nothing was asking", () =>
  withGovernor(
    {
      board: {
        cards: [
          {
            ...makeBoardCard({ id: "card-1", stage: "review", orderKey: "m" }),
            threadLinks: [
              link("thread-plan-1", String(BOARD_SEED_STAGE_IDS.planning)),
              link("thread-r1", "review@1"),
              link("thread-r2", "review@2"),
            ],
          },
        ],
        nextCardNumberByProject: {},
        stepStates: [
          {
            cardId: BoardCardId.make("card-1"),
            stepId: "review@2",
            stepLabel: "Review",
            stageLabel: "Code review",
            attempt: 1,
            stallCount: 0,
            stageEntryRecoveries: 0,
            humanTurnAt: null,
            lastNudgeAt: null,
            prompt: "",
            providerInstanceId: codexStep.providerInstanceId,
            model: DEFAULT_TEXT_GENERATION_MODEL,
            mode: "build",
            runtimeMode: "approval-required",
            humanInLoop: false,
            maxAttempts: 3,
            timeoutMs: 600_000,
            baseTipAtRoundStart: null,
            threadId: ThreadId.make("thread-r2"),
            lastError: null,
            status: "stalled",
            awaitingReason: "question",
            stalledReason: "gave-up",
            retryAt: null,
            slotHeld: false,
            forceStart: false,
            queuedBy: null,
            queuedDetail: null,
            startedAt: NOW,
            updatedAt: NOW,
          },
        ],
        // The interview finished: an unfinished one the card kept stays in the
        // inbox.
        stepCompletions: [
          {
            cardId: BoardCardId.make("card-1"),
            stepId: String(BOARD_SEED_STAGE_IDS.planning),
            outcome: "succeeded",
            summary: "planned",
            payload: null,
            threadId: ThreadId.make("thread-plan-1"),
            completedAt: NOW,
          },
        ],
      } as never,
      settings: reviewSettings(),
      initialShells: shellsFor([
        ["thread-plan-1", idleThreadShell("thread-plan-1")],
        ["thread-r1", idleThreadShell("thread-r1")],
        ["thread-r2", idleThreadShell("thread-r2")],
      ]),
    },
    ({ reactor, settledThreads }) =>
      Effect.gen(function* () {
        yield* reactor.drain;
        const settled = yield* settledThreads;
        assert.ok(settled.has("thread-plan-1"), "the stale planning thread settled");
        assert.ok(settled.has("thread-r1"), "the stale review round settled");
        // The card's own stalled step is what a human is being asked to rescue.
        assert.ok(!settled.has("thread-r2"), "the card's live step thread was left alone");
      }),
  ),
);
