/**
 * Timeout-sweep liveness clock (t3o-17): the sweep recovers a running
 * unattended step only when EVERY life sign is older than its `timeoutMs` —
 * the last nudge/start, the thread's todo list advancing (`board_thread_todos`), and
 * (for a build-mode step, checked once already overdue) the latest commit on
 * the card's worktree. Driven through the reactor's `sweep` test hook against
 * the shared harness. `it.effect` runs on the TestClock, whose "now" is the
 * epoch — so OVERDUE fixtures sit one day BEFORE the epoch and FRESH life
 * signs sit exactly at it, keeping every case deterministic without advancing
 * the clock (which would fire the reactor's own 30s sweep timer millions of
 * times).
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
  codexStep,
  makeBoardCard,
  readyWorktree,
  settingsWith,
  withGovernor,
} from "./supervisorHarness.testkit.ts";

/** One day before the TestClock epoch: decisively past any sane timeout. */
const OVERDUE = "1969-12-31T00:00:00.000Z";
/** Exactly the TestClock "now": a maximally fresh life sign. */
const FRESH = "1970-01-01T00:00:00.000Z";

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
  lastNudgeAt: null,
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
  startedAt: OVERDUE,
  updatedAt: OVERDUE,
  ...overrides,
});

/** A live shell for the step's thread, so boot reconcile resume-watches it
    instead of recovering it before the sweep under test ever runs. */
const aliveShells = (): ReadonlyMap<string, OrchestrationThreadShell> =>
  new Map([
    [
      String(threadId),
      {
        hasPendingUserInput: false,
        session: { activeTurnId: "turn-live" },
      } as unknown as OrchestrationThreadShell,
    ],
  ]);

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
      latestCommitIso: FRESH,
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
      latestCommitIso: OVERDUE,
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
