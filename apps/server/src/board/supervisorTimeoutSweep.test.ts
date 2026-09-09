/**
 * Timeout-sweep liveness clock (t3o-17, T3O-12): the sweep recovers a running
 * unattended step only when EVERY life sign is older than its `timeoutMs` —
 * the last nudge/start, the thread's todo list advancing (`board_thread_todos`),
 * the thread's last OUTPUT (an assistant message or an activity row, T3O-12 D1),
 * and (for a build-mode step, checked once already overdue) the latest commit on
 * the card's worktree. The output signal shields for a bounded number of
 * windows (T3O-12, D9); the other two life signs have no ceiling. Driven
 * through the reactor's `sweep` test hook against the shared harness.
 * `it.effect` runs on the TestClock, whose "now" is the epoch — so OVERDUE
 * fixtures sit one day BEFORE the epoch and FRESH life signs sit exactly at it,
 * keeping every case deterministic without advancing the clock (which would
 * fire the reactor's own 30s sweep timer millions of times).
 */
import {
  BoardCardId,
  boardCardStepState,
  ProviderInstanceId,
  ThreadId,
  type BoardCardStepState,
  type BoardState,
  type OrchestrationThreadShell,
} from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import {
  aliveThreadShell,
  codexStep,
  makeBoardCard,
  readyWorktree,
  settingsWith,
  withGovernor,
} from "./supervisorHarness.testkit.ts";

/** One day before the TestClock epoch: decisively past any sane timeout, and —
    read as a `startedAt` — decisively past the output-signal shield ceiling
    (T3O-12, D9) too. */
const OVERDUE = "1969-12-31T00:00:00.000Z";
/** Exactly the TestClock "now": a maximally fresh life sign. */
const FRESH = "1970-01-01T00:00:00.000Z";
/** When an ordinary long-running step started: five minutes before the epoch,
    so the 60s timeout below is decisively exceeded while the step is still well
    inside the eight-window output-signal ceiling (eight minutes here). The two
    thresholds are separate questions and these fixtures keep them apart. */
const STARTED = "1969-12-31T23:55:00.000Z";
/** Exactly the output-signal ceiling: eight 60s windows before the epoch. */
const AT_SIGNAL_CEILING = "1969-12-31T23:52:00.000Z";

const cardId = BoardCardId.make("card-sweep");
const threadId = ThreadId.make("thread-sweep");

/** A running unattended step started a day before the TestClock epoch, so a
    60s timeout is decisively exceeded unless a fresher life sign exists. */
const runningStep = (overrides?: Partial<BoardCardStepState>): BoardCardStepState => ({
  cardId,
  stepId: "building",
  stepLabel: "Building",
  stageLabel: "Building",
  attempt: 1,
  stallCount: 0,
  stageEntryRecoveries: 0,
  humanTurnAt: null,
  lastNudgeAt: null,
  baseTipAtRoundStart: null,
  lastError: null,
  awaitingReason: "question" as const,
  prompt: "build it",
  providerInstanceId: ProviderInstanceId.make("codex"),
  model: "gpt-5-codex",
  mode: "build",
  runtimeMode: "auto",
  humanInLoop: false,
  maxAttempts: 3,
  timeoutMs: 60_000,
  threadId,
  status: "running",
  // slotHeld false keeps boot reconcile's slot-restore out of the picture —
  // the sweep's clock is what these tests isolate.
  slotHeld: false,
  forceStart: false,
  startedAt: STARTED,
  updatedAt: STARTED,
  ...overrides,
});

/** A live shell for the step's thread, so boot reconcile resume-watches it
    instead of recovering it before the sweep under test ever runs. */
const aliveShells = (): ReadonlyMap<string, OrchestrationThreadShell> =>
  new Map([[String(threadId), aliveThreadShell(String(threadId))]]);

const boardWithStep = (step: BoardCardStepState): BoardState => ({
  cards: [
    makeBoardCard({
      id: "card-sweep",
      stage: "building",
      orderKey: "m",
      worktree: readyWorktree("card-sweep"),
    }),
  ],
  stepStates: [step],
  nextCardNumberByProject: {},
});

/** A cached todo whose list last advanced at `at` — the t3o-18 liveness signal
    that replaced the deleted `board_report_progress` watermark. */
const todoAdvancedAt = (at: string) =>
  new Map([[String(threadId), { advancedAt: at, hasList: true }]]);

/** The thread's last OUTPUT — its newest assistant message or activity row
    (T3O-12, D1). The life sign the sweep never had. */
const threadSignalAt = (at: string) => new Map([[String(threadId), at]]);

const attemptOf = (board: BoardState): number => boardCardStepState(board, cardId)?.attempt ?? -1;

it.effect("recovers an overdue step with no life sign since the window opened", () =>
  withGovernor(
    {
      board: boardWithStep(runningStep()),
      settings: settingsWith({ building: [codexStep], globalMaxConcurrent: 3 }),
      initialShells: aliveShells(),
    },
    ({ reactor, board }) =>
      Effect.gen(function* () {
        assert.strictEqual(attemptOf(yield* board), 1);
        yield* reactor.sweep;
        // Recovered: the nudge consumed an attempt and stamped lastNudgeAt.
        const after = yield* board;
        assert.strictEqual(attemptOf(after), 2);
        assert.isNotNull(boardCardStepState(after, cardId)?.lastNudgeAt);
      }),
  ),
);

it.effect("a fresh todo advance keeps an overdue-by-start step alive", () =>
  withGovernor(
    {
      board: boardWithStep(runningStep()),
      settings: settingsWith({ building: [codexStep], globalMaxConcurrent: 3 }),
      initialShells: aliveShells(),
      threadTodos: todoAdvancedAt(FRESH),
    },
    ({ reactor, board }) =>
      Effect.gen(function* () {
        yield* reactor.sweep;
        assert.strictEqual(attemptOf(yield* board), 1); // not recovered
      }),
  ),
);

it.effect("a STALE todo advance does not shield an overdue step", () =>
  withGovernor(
    {
      board: boardWithStep(runningStep()),
      settings: settingsWith({ building: [codexStep], globalMaxConcurrent: 3 }),
      initialShells: aliveShells(),
      threadTodos: todoAdvancedAt(OVERDUE),
    },
    ({ reactor, board }) =>
      Effect.gen(function* () {
        yield* reactor.sweep;
        assert.strictEqual(attemptOf(yield* board), 2); // recovered
      }),
  ),
);

it.effect("a fresh commit on the card's branch keeps an overdue build step alive", () =>
  withGovernor(
    {
      board: boardWithStep(runningStep()),
      settings: settingsWith({ building: [codexStep], globalMaxConcurrent: 3 }),
      initialShells: aliveShells(),
      latestBranchCommitIso: FRESH,
    },
    ({ reactor, board }) =>
      Effect.gen(function* () {
        yield* reactor.sweep;
        assert.strictEqual(attemptOf(yield* board), 1); // not recovered
      }),
  ),
);

it.effect("a commit older than the window does not shield an overdue build step", () =>
  withGovernor(
    {
      board: boardWithStep(runningStep()),
      settings: settingsWith({ building: [codexStep], globalMaxConcurrent: 3 }),
      initialShells: aliveShells(),
      latestBranchCommitIso: OVERDUE,
    },
    ({ reactor, board }) =>
      Effect.gen(function* () {
        yield* reactor.sweep;
        assert.strictEqual(attemptOf(yield* board), 2); // recovered
      }),
  ),
);

it.effect("a step with no timestamps at all is skipped, never marched to recovery", () =>
  withGovernor(
    {
      board: boardWithStep(runningStep({ startedAt: null, lastNudgeAt: null })),
      settings: settingsWith({ building: [codexStep], globalMaxConcurrent: 3 }),
      initialShells: aliveShells(),
    },
    ({ reactor, board }) =>
      Effect.gen(function* () {
        yield* reactor.sweep;
        assert.strictEqual(attemptOf(yield* board), 1); // skipped
      }),
  ),
);

it.effect("a human-in-the-loop run is exempt from the timeout sweep", () =>
  withGovernor(
    {
      board: boardWithStep(runningStep({ humanInLoop: true })),
      settings: settingsWith({ building: [codexStep], globalMaxConcurrent: 3 }),
      initialShells: aliveShells(),
    },
    ({ reactor, board }) =>
      Effect.gen(function* () {
        yield* reactor.sweep;
        assert.strictEqual(attemptOf(yield* board), 1); // exempt
      }),
  ),
);

// ── The heartbeat is measured on the card's OWN branch (t3o-10, D4) ────
//
// A base sync fast-forwards commits reachable from the base into the card's
// branch — a sibling card's squash merge, most often. Read as the worktree
// tip, one of those looks exactly like this agent committing: three dead build
// steps re-armed their watchdog for another `timeoutMs` every time a sibling
// merged, and held their concurrency slots for twelve hours.

it.effect("a base-sync commit is NOT this agent's heartbeat: the step is still recovered", () =>
  withGovernor(
    {
      board: boardWithStep(runningStep()),
      settings: settingsWith({ building: [codexStep], globalMaxConcurrent: 3 }),
      initialShells: aliveShells(),
      // Tip freshly moved, nothing of the card's own on the branch.
      latestCommitIso: FRESH,
      latestBranchCommitIso: "",
    },
    ({ reactor, board }) =>
      Effect.gen(function* () {
        yield* reactor.sweep;
        assert.strictEqual(attemptOf(yield* board), 2); // recovered
      }),
  ),
);

it.effect("a plan-mode step reads no commit at all and is recovered on the clock alone", () =>
  withGovernor(
    {
      board: boardWithStep(runningStep({ mode: "plan" })),
      settings: settingsWith({ building: [codexStep], globalMaxConcurrent: 3 }),
      initialShells: aliveShells(),
      // Even a fresh branch commit cannot shield a step with no worktree work.
      latestBranchCommitIso: FRESH,
    },
    ({ reactor, board }) =>
      Effect.gen(function* () {
        yield* reactor.sweep;
        assert.strictEqual(attemptOf(yield* board), 2); // recovered
      }),
  ),
);

it.effect("a build step whose card has no worktree is recovered on the clock alone", () =>
  withGovernor(
    {
      board: {
        cards: [makeBoardCard({ id: "card-sweep", stage: "building", orderKey: "m" })],
        stepStates: [runningStep()],
        nextCardNumberByProject: {},
      },
      settings: settingsWith({ building: [codexStep], globalMaxConcurrent: 3 }),
      initialShells: aliveShells(),
      latestBranchCommitIso: FRESH,
    },
    ({ reactor, board }) =>
      Effect.gen(function* () {
        yield* reactor.sweep;
        assert.strictEqual(attemptOf(yield* board), 2); // recovered
      }),
  ),
);

// ── The same branch scope resets `stallCount` (t3o-10, D4) ────────────
//
// `resolveProgressedSinceLastNudge` reads the identical signal and is what
// clears the stall counter, so a card nudged correctly could still have its
// ladder reset by a sibling's merge and never reach a human.

/** Nudged four minutes before the epoch, so the step is decisively overdue
    against its 60s timeout AND a commit counts as progress only if it landed
    after that nudge. */
const NUDGED = "1969-12-31T23:56:00.000Z";
const nudgedStep = (): BoardCardStepState =>
  runningStep({ stallCount: 1, lastNudgeAt: NUDGED, startedAt: STARTED });

/** After the nudge, but far enough back that it does not shield the step from
    the sweep — the window where the two branch-scoped reads must agree. */
const SINCE_NUDGE = "1969-12-31T23:57:00.000Z";

const stallOf = (board: BoardState): number => boardCardStepState(board, cardId)?.stallCount ?? -1;

it.effect("a commit unique to the branch since the last nudge resets the stall count", () =>
  withGovernor(
    {
      board: boardWithStep(nudgedStep()),
      settings: settingsWith({ building: [codexStep], globalMaxConcurrent: 3 }),
      initialShells: aliveShells(),
      latestBranchCommitIso: SINCE_NUDGE,
    },
    ({ reactor, board }) =>
      Effect.gen(function* () {
        assert.strictEqual(stallOf(yield* board), 1);
        yield* reactor.sweep;
        // Progressed since the nudge → the streak is forgotten, so this stall
        // is the first of a new one rather than the second of the old.
        assert.strictEqual(stallOf(yield* board), 1);
      }),
  ),
);

it.effect("a base-sync commit since the last nudge does NOT reset the stall count", () =>
  withGovernor(
    {
      board: boardWithStep(nudgedStep()),
      settings: settingsWith({ building: [codexStep], globalMaxConcurrent: 3 }),
      initialShells: aliveShells(),
      // A sibling's merge, synced in and sitting on the tip since the nudge.
      latestCommitIso: SINCE_NUDGE,
      latestBranchCommitIso: "",
    },
    ({ reactor, board }) =>
      Effect.gen(function* () {
        yield* reactor.sweep;
        // No work of this card's own → the stall counter climbs toward the
        // ceiling, which is what eventually brings a human in.
        assert.strictEqual(stallOf(yield* board), 2);
      }),
  ),
);

// ── The agent is emitting output right now (T3O-12, D1) ───────────────
//
// The card this suite's newest cases exist for: a Code review loop hit its
// round cap, the user raised the budget, the loop resumed and ran correctly —
// and the card went red with STALLED saying "Nothing is running" while the
// round-6 review thread was visibly mid-turn.
//
// A `review` phase makes NO commits (it reads the diff and records findings)
// and is not obliged to churn a todo list while it reads. Every life sign the
// sweep had was therefore stale after 30 quiet-but-productive minutes, so it
// judged a healthy 56-minute phase dead. "The agent is emitting output right
// now" was not a life sign anywhere in the function — nothing ever asked.

it.effect(
  "T3O-12: a thread that signalled inside the window is alive, with no todo advance and no commit",
  () =>
    withGovernor(
      {
        // The reported shape exactly: overdue by start, todo list never advanced,
        // nothing committed — a review phase reading files for an hour.
        board: boardWithStep(runningStep()),
        settings: settingsWith({ building: [codexStep], globalMaxConcurrent: 3 }),
        initialShells: aliveShells(),
        threadSignals: threadSignalAt(FRESH),
      },
      ({ reactor, board }) =>
        Effect.gen(function* () {
          yield* reactor.sweep;
          assert.strictEqual(attemptOf(yield* board), 1); // not recovered
          assert.isNull(boardCardStepState(yield* board, cardId)?.lastNudgeAt);
        }),
    ),
);

it.effect("T3O-12: a STALE thread signal does not shield an overdue step", () =>
  withGovernor(
    {
      board: boardWithStep(runningStep()),
      settings: settingsWith({ building: [codexStep], globalMaxConcurrent: 3 }),
      initialShells: aliveShells(),
      threadSignals: threadSignalAt(OVERDUE),
    },
    ({ reactor, board }) =>
      Effect.gen(function* () {
        yield* reactor.sweep;
        assert.strictEqual(attemptOf(yield* board), 2); // recovered
      }),
  ),
);

it.effect(
  "T3O-12: a thread that has never signalled reads as no life sign, exactly as before",
  () =>
    withGovernor(
      {
        board: boardWithStep(runningStep()),
        settings: settingsWith({ building: [codexStep], globalMaxConcurrent: 3 }),
        initialShells: aliveShells(),
        // No fixture at all: the query answers null, the conservative direction.
      },
      ({ reactor, board }) =>
        Effect.gen(function* () {
          yield* reactor.sweep;
          assert.strictEqual(attemptOf(yield* board), 2); // recovered
        }),
    ),
);

it.effect(
  "T3O-12: the live thread is settled on the cheap indexed read, before any git subprocess",
  () =>
    withGovernor(
      {
        board: boardWithStep(runningStep()),
        settings: settingsWith({ building: [codexStep], globalMaxConcurrent: 3 }),
        initialShells: aliveShells(),
        threadSignals: threadSignalAt(FRESH),
      },
      ({ reactor, gitInvocations }) =>
        Effect.gen(function* () {
          yield* reactor.sweep;
          // The commit check stays behind the already-overdue gate: this sweep
          // runs every 30 seconds against every running step, and a live step
          // must not cost a subprocess per tick.
          const branchScopedLogs = (yield* gitInvocations).filter(
            (args) => args[0] === "log" && args.includes("--not"),
          );
          assert.deepStrictEqual(branchScopedLogs, []);
        }),
    ),
);

it.effect("T3O-12: an overdue step DOES still reach the git commit check", () =>
  withGovernor(
    {
      // The control for the case above: without a fresh signal the step is
      // overdue, so the expensive read is reached — proving the assertion
      // above is about ordering and not about the sweep never calling git.
      board: boardWithStep(runningStep()),
      settings: settingsWith({ building: [codexStep], globalMaxConcurrent: 3 }),
      initialShells: aliveShells(),
    },
    ({ reactor, gitInvocations }) =>
      Effect.gen(function* () {
        yield* reactor.sweep;
        const branchScopedLogs = (yield* gitInvocations).filter(
          (args) => args[0] === "log" && args.includes("--not"),
        );
        assert.isAbove(branchScopedLogs.length, 0);
      }),
  ),
);

// ── Liveness is NOT progress (T3O-12, D2) ─────────────────────────────
//
// The signal goes into the sweep and nowhere else. "Is it alive" and "is it
// getting anywhere" are different questions, and the stall ladder gates on the
// second on purpose: an agent thrashing in a tool loop is noisy and going
// nowhere, and if chatter reset `stallCount` it would never escalate.

it.effect("T3O-12: a chatty thread that is going nowhere still climbs the stall ladder", () =>
  withGovernor(
    {
      // Nudged a day ago and signalling since — but the signal is stale enough
      // not to shield it from the sweep, so a recovery happens and the only
      // question is whether the streak was forgotten.
      board: boardWithStep(nudgedStep()),
      settings: settingsWith({ building: [codexStep], globalMaxConcurrent: 3 }),
      initialShells: aliveShells(),
      threadSignals: threadSignalAt(SINCE_NUDGE),
    },
    ({ reactor, board }) =>
      Effect.gen(function* () {
        assert.strictEqual(stallOf(yield* board), 1);
        yield* reactor.sweep;
        // Climbed to 2. Had the signal been read as progress, it would have
        // reset to 1 here and on every stall after it — the step would never
        // reach a human.
        assert.strictEqual(stallOf(yield* board), 2);
      }),
  ),
);

// ── Output is not an unbounded licence to run (T3O-12, D9) ────────────
//
// The finding these cases exist for: "is the agent emitting anything" is
// satisfied by noise as readily as by work. An agent thrashing in a tool loop
// emits activity rows continuously, so an uncapped signal would renew its
// shield every window forever — never overdue, so never nudged, so `stallCount`
// never climbs, so the recovery ceiling (only ever charged by an actual
// recovery) is never spent either. The step would hold its slot indefinitely
// and no human would ever be told. That is the inverse of the bug T3O-12 fixed
// and the worse direction: a supervisor that never cries wolf is not a
// supervisor.
//
// So the output signal expires after eight `timeoutMs` windows and the sweep
// reverts to exactly its pre-T3O-12 life signs. The other two keep no ceiling,
// because a todo list that advances and a commit that lands are evidence of
// work rather than of noise.

it.effect("T3O-12: a maximally fresh output signal stops shielding past the ceiling", () =>
  withGovernor(
    {
      // The thrash: signalling right now, but running since a day before the
      // epoch against a 60s timeout — 1440 windows, well past the eight allowed.
      board: boardWithStep(runningStep({ startedAt: OVERDUE, updatedAt: OVERDUE })),
      settings: settingsWith({ building: [codexStep], globalMaxConcurrent: 3 }),
      initialShells: aliveShells(),
      threadSignals: threadSignalAt(FRESH),
    },
    ({ reactor, board }) =>
      Effect.gen(function* () {
        yield* reactor.sweep;
        assert.strictEqual(attemptOf(yield* board), 2); // recovered
      }),
  ),
);

it.effect("T3O-12: the output signal shields right up to the ceiling", () =>
  withGovernor(
    {
      board: boardWithStep(
        runningStep({ startedAt: AT_SIGNAL_CEILING, updatedAt: AT_SIGNAL_CEILING }),
      ),
      settings: settingsWith({ building: [codexStep], globalMaxConcurrent: 3 }),
      initialShells: aliveShells(),
      threadSignals: threadSignalAt(FRESH),
    },
    ({ reactor, board }) =>
      Effect.gen(function* () {
        yield* reactor.sweep;
        assert.strictEqual(attemptOf(yield* board), 1); // not recovered
      }),
  ),
);

it.effect("T3O-12: a thread that only ever signals is eventually escalated to a human", () =>
  withGovernor(
    {
      // One stall short of `maxAttempts`, past the ceiling, and still chattering:
      // the end of the road the case above starts down.
      board: boardWithStep(
        runningStep({
          startedAt: OVERDUE,
          updatedAt: OVERDUE,
          lastNudgeAt: OVERDUE,
          stallCount: 2,
          maxAttempts: 3,
        }),
      ),
      settings: settingsWith({ building: [codexStep], globalMaxConcurrent: 3 }),
      initialShells: aliveShells(),
      threadSignals: threadSignalAt(FRESH),
    },
    ({ reactor, board }) =>
      Effect.gen(function* () {
        yield* reactor.sweep;
        assert.strictEqual(boardCardStepState(yield* board, cardId)?.status, "stalled");
      }),
  ),
);

it.effect("T3O-12: the todo-advance life sign keeps no ceiling", () =>
  withGovernor(
    {
      board: boardWithStep(runningStep({ startedAt: OVERDUE, updatedAt: OVERDUE })),
      settings: settingsWith({ building: [codexStep], globalMaxConcurrent: 3 }),
      initialShells: aliveShells(),
      threadTodos: todoAdvancedAt(FRESH),
    },
    ({ reactor, board }) =>
      Effect.gen(function* () {
        yield* reactor.sweep;
        assert.strictEqual(attemptOf(yield* board), 1); // not recovered
      }),
  ),
);

it.effect("T3O-12: the branch-commit life sign keeps no ceiling", () =>
  withGovernor(
    {
      board: boardWithStep(runningStep({ startedAt: OVERDUE, updatedAt: OVERDUE })),
      settings: settingsWith({ building: [codexStep], globalMaxConcurrent: 3 }),
      initialShells: aliveShells(),
      latestBranchCommitIso: FRESH,
    },
    ({ reactor, board }) =>
      Effect.gen(function* () {
        yield* reactor.sweep;
        assert.strictEqual(attemptOf(yield* board), 1); // not recovered
      }),
  ),
);
