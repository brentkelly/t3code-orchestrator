/**
 * The card auto-settles the orchestration threads it is finished with, so they
 * drop out of the thread inbox (the card↔thread links stay — the card keeps its
 * tabs). The rule for WHICH threads is `boardReleasedThreadIds`, unit-tested in
 * `threadRelease.test.ts`; this file is about the part that was broken (t3o-13):
 * whether the settle ever actually LANDS.
 *
 * It used to be fired once, at the moment a thread became finished. That moment
 * is precisely when it cannot land: an agent reports its step complete from
 * INSIDE its own turn, so its session is still `running` and the decider refuses
 * — and nothing asked again. In the maintainer's own database not one review-
 * phase settle had ever succeeded and thirty-odd finished threads sat in the
 * inbox forever.
 *
 * So every assertion here reads `settledThreads` — what the decider ACCEPTED —
 * rather than `commands`, which only records what the reactor asked for. That
 * distinction is the bug: the old suite asserted the ask and passed throughout.
 * The harness models the decider's settle guard for the same reason.
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
  type OrchestrationEvent,
  type OrchestrationThreadShell,
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
} from "./supervisorHarness.testkit.ts";

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
): OrchestrationEvent =>
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
  }) as unknown as OrchestrationEvent;

const link = (threadId: string, role: string) => ({
  threadId: ThreadId.make(threadId),
  role,
  linkedAt: NOW,
  tombstonedAt: null,
});

const shellsFor = (
  entries: ReadonlyArray<readonly [string, OrchestrationThreadShell]>,
): ReadonlyMap<string, OrchestrationThreadShell> => new Map(entries);

// ── The regression: a settle refused mid-turn is retried, not lost ───────────
//
// The review loop finishes review@1 and moves to triage@1, so review@1's thread
// is finished work. But the agent reported that completion from inside its own
// turn, so the thread is still `running` and the decider refuses. Under the old
// fire-and-forget settle that was the end of it — the thread stayed in the inbox
// for good. The turn then ends, and the release is asked again.
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

// ── The same retry, reached by the periodic sweep ────────────────────────────
// A `turn.completed` can be missed — a dropped runtime event, a server that
// restarted between the completion and the turn ending. The 30-second sweep is
// what makes the release eventual rather than merely likely, so it has to land
// the settle on its own.
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

// A thread with an unanswered approval is blocked-on-YOU work, and the decider
// refuses to settle it. Unlike a busy thread that refusal can last for days, so
// the sweep has to recognise it rather than re-ask every half minute forever —
// it gates on the same `isAutoSettlementCandidate` policy upstream's inactivity
// sweep uses.
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
        [
          "thread-build-1",
          {
            ...idleThreadShell("thread-build-1"),
            hasPendingApprovals: true,
          } as OrchestrationThreadShell,
        ],
      ]),
    },
    ({ reactor, commands, settledThreads }) =>
      Effect.gen(function* () {
        yield* reactor.releaseThreads;
        assert.ok(!(yield* settledThreads).has("thread-build-1"), "it was not settled");
        assert.deepStrictEqual(
          (yield* commands).filter((command) => command.type === "thread.auto-settle"),
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
                  command.type === "thread.auto-settle" &&
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

// ── A backward move is not special ──────────────────────────────────────────
// The card is not in that stage any more, so its threads are finished work. It
// is safe to be this blunt because a settle is not a one-way door: a re-entry
// that adopts the thread — or a human simply typing into it — brings it back,
// since the decider un-settles a thread whose session comes alive.
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
            slotHeld: false,
            forceStart: false,
            startedAt: NOW,
            updatedAt: NOW,
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
