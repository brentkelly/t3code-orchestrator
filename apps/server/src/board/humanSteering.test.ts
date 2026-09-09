/**
 * A human's message beats the supervisor's nudge (T3O-17).
 *
 * Typing into a running unattended step used to draw a resume nudge in right
 * behind the message — the two-bubble order in this card's attachment. The
 * board could not tell "the agent stopped" from "a human interrupted it", so it
 * talked over the human every time.
 *
 * The fix is one durable field. A human's own turn-start records `humanTurnAt`
 * on the step row, which buys that turn exactly ONE free ending and restarts the
 * recovery ladder; the next `turn.completed` spends the free ending instead of
 * recovering. Bounded on purpose (D3): the supervisor is back on duty
 * immediately afterwards, and the timeout sweep never consumes the free ending
 * at all, so a genuinely hung agent is still caught.
 *
 * Driven through the live reactor against the stateful engine double, because
 * the behaviour spans the turn-start handler, the turn-end handler, the decider
 * and the timeout sweep.
 */
import {
  BoardCardId,
  boardCardStepState,
  ProviderInstanceId,
  ThreadId,
  type BoardCardStepState,
  type BoardState,
  type OrchestrationCommand,
  type OrchestrationThreadShell,
} from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import {
  aliveThreadShell,
  boardTurnStartRequested,
  buildingCard,
  codexStep,
  humanTurnStartRequested,
  makeBoardCard,
  movedToBuilding,
  NOW,
  readyWorktree,
  settingsWith,
  stepStatus,
  turnCompleted,
  withGovernor,
  type Harness,
} from "./supervisorHarness.testkit.ts";

const codex = ProviderInstanceId.make("codex");

/** When the human typed: a minute after the fixtures' `NOW`, so a test can tell
    the instant the steer recorded from the one the step started at. */
const TYPED_AT = "2026-01-01T00:01:00.000Z";

/** One unattended build card — the shape every steering test starts from. */
const oneBuildCard = (id: string) => ({
  board: { cards: [buildingCard(id, "m")], nextCardNumberByProject: {} },
  settings: settingsWith({ building: [codexStep], globalMaxConcurrent: 3 }),
});

/** Drive a card into a running, unattended build step and hand back its thread. */
const startBuild = (h: Pick<Harness, "pumpDomain" | "board">, id: string) =>
  Effect.gen(function* () {
    yield* h.pumpDomain(movedToBuilding(buildingCard(id, "m"), 1));
    const state = boardCardStepState(yield* h.board, BoardCardId.make(id));
    assert.strictEqual(state?.status, "running");
    assert.strictEqual(state?.humanInLoop, false);
    assert.isNotNull(state?.threadId);
    return state!.threadId!;
  });

const stateOf = (board: BoardState, id: string) => boardCardStepState(board, BoardCardId.make(id));

const commandTypes = (commands: ReadonlyArray<OrchestrationCommand>) =>
  commands.map((command) => command.type);

const turnStarts = (commands: ReadonlyArray<OrchestrationCommand>) =>
  commandTypes(commands).filter((type) => type === "thread.turn.start").length;

// ── The steer is recorded ─────────────────────────────────────────────────

it.effect("a human turn on a running unattended step records the steer and resets the ladder", () =>
  withGovernor(oneBuildCard("steer"), ({ pumpDomain, pumpRuntime, board }) =>
    Effect.gen(function* () {
      const threadId = yield* startBuild({ pumpDomain, board }, "steer");

      // One unproductive stop first, so there is a ladder to reset: the nudge
      // consumes an attempt, charges a stall and stamps `lastNudgeAt`.
      yield* pumpRuntime(turnCompleted(threadId));
      const nudged = stateOf(yield* board, "steer");
      assert.strictEqual(nudged?.stallCount, 1);
      assert.strictEqual(nudged?.attempt, 2);
      assert.strictEqual(nudged?.humanTurnAt, null);

      // Onto the step's CURRENT thread: a recovery spawns a fresh one and
      // relinks the card, so the thread the build started on is already gone.
      yield* pumpDomain(humanTurnStartRequested(nudged!.threadId!, 2, TYPED_AT));

      const steered = stateOf(yield* board, "steer");
      assert.strictEqual(steered?.humanTurnAt, TYPED_AT);
      // The ladder starts over: consecutive stalls back to zero, and the
      // "since the last nudge" boundary moved to the human's turn.
      assert.strictEqual(steered?.stallCount, 0);
      assert.strictEqual(steered?.lastNudgeAt, TYPED_AT);
      // A human's own turn is neither a board invocation nor a board recovery,
      // so neither counter moves.
      assert.strictEqual(steered?.attempt, nudged?.attempt);
      assert.strictEqual(steered?.stageEntryRecoveries, nudged?.stageEntryRecoveries);
      // And the card is still unattended: a message is steering, not a takeover.
      assert.strictEqual(steered?.humanInLoop, false);
      assert.strictEqual(steered?.status, "running");
    }),
  ),
);

it.effect("a BOARD nudge's own turn-start records nothing", () =>
  withGovernor(oneBuildCard("nudge"), ({ pumpDomain, board }) =>
    Effect.gen(function* () {
      const threadId = yield* startBuild({ pumpDomain, board }, "nudge");

      const before = stateOf(yield* board, "nudge");

      yield* pumpDomain(boardTurnStartRequested(threadId, 2, TYPED_AT));

      // No free ending bought, and the ladder untouched — if a nudge's own
      // turn-start counted as steering, the escalation ceiling could never be
      // reached.
      const after = stateOf(yield* board, "nudge");
      assert.strictEqual(after?.humanTurnAt, null);
      assert.strictEqual(after?.lastNudgeAt, before?.lastNudgeAt);
      assert.strictEqual(after?.stallCount, before?.stallCount);
    }),
  ),
);

it.effect("a human turn on a human-in-the-loop step records nothing", () =>
  withGovernor(
    {
      board: { cards: [buildingCard("hitl", "m", true)], nextCardNumberByProject: {} },
      settings: settingsWith({ building: [codexStep], globalMaxConcurrent: 3 }),
    },
    ({ pumpDomain, board }) =>
      Effect.gen(function* () {
        yield* pumpDomain(movedToBuilding(buildingCard("hitl", "m", true), 1));
        const running = stateOf(yield* board, "hitl");
        assert.strictEqual(running?.status, "running");
        assert.strictEqual(running?.humanInLoop, true);

        yield* pumpDomain(humanTurnStartRequested(running!.threadId!, 2, TYPED_AT));

        // Nothing to suppress: this step's turn-end parks on the human, it
        // never recovers, so recording would be noise on every turn.
        const after = stateOf(yield* board, "hitl");
        assert.strictEqual(after?.humanTurnAt, null);
        assert.strictEqual(after?.stallCount, running?.stallCount);
      }),
  ),
);

// ── The free ending, and its bound ────────────────────────────────────────

it.effect("the next turn.completed after a steer sends no nudge and spends the free ending", () =>
  withGovernor(oneBuildCard("free"), ({ pumpDomain, pumpRuntime, board, commands }) =>
    Effect.gen(function* () {
      const threadId = yield* startBuild({ pumpDomain, board }, "free");
      yield* pumpDomain(humanTurnStartRequested(threadId, 2, TYPED_AT));
      const steered = stateOf(yield* board, "free");
      const turnsBefore = turnStarts(yield* commands);

      yield* pumpRuntime(turnCompleted(threadId));

      const after = stateOf(yield* board, "free");
      // THE headline regression: no second turn went into the thread, so
      // nothing landed on top of what the human said.
      assert.strictEqual(turnStarts(yield* commands), turnsBefore);
      assert.notInclude(commandTypes(yield* commands), "board.card.recover-step");
      assert.strictEqual(after?.attempt, steered?.attempt);
      assert.strictEqual(after?.stallCount, 0);
      assert.strictEqual(after?.stageEntryRecoveries, steered?.stageEntryRecoveries);
      // Spent: the step is back under ordinary supervision.
      assert.strictEqual(after?.humanTurnAt, null);
      assert.strictEqual(after?.status, "running");
    }),
  ),
);

it.effect("the turn.completed after THAT recovers normally — one free ending, not a wedge", () =>
  withGovernor(oneBuildCard("bounded"), ({ pumpDomain, pumpRuntime, board, commands }) =>
    Effect.gen(function* () {
      const threadId = yield* startBuild({ pumpDomain, board }, "bounded");
      yield* pumpDomain(humanTurnStartRequested(threadId, 2, TYPED_AT));

      yield* pumpRuntime(turnCompleted(threadId)); // the free one
      const spent = stateOf(yield* board, "bounded");
      assert.strictEqual(spent?.humanTurnAt, null);

      yield* pumpRuntime(turnCompleted(threadId)); // back on duty

      const after = stateOf(yield* board, "bounded");
      assert.include(commandTypes(yield* commands), "board.card.recover-step");
      assert.strictEqual(after?.attempt, (spent?.attempt ?? 0) + 1);
      assert.strictEqual(after?.stallCount, 1);
    }),
  ),
);

it.effect("steering does not lift the escalation ceiling — the ladder still ends", () =>
  withGovernor(oneBuildCard("ceiling"), ({ pumpDomain, pumpRuntime, board }) =>
    Effect.gen(function* () {
      const threadId = yield* startBuild({ pumpDomain, board }, "ceiling");
      yield* pumpDomain(humanTurnStartRequested(threadId, 2, TYPED_AT));

      // The free ending, then `maxAttempts` unproductive stops in a row. Each
      // recovery spawns a fresh thread, and each nudge's own turn-start is
      // board-minted — so none of them buys another free ending, which is the
      // property that makes the ceiling reachable at all.
      yield* pumpRuntime(turnCompleted(threadId));
      const maxAttempts = stateOf(yield* board, "ceiling")?.maxAttempts ?? 0;
      assert.isAbove(maxAttempts, 0);
      for (let index = 0; index < maxAttempts; index += 1) {
        const live = stateOf(yield* board, "ceiling");
        if (live?.status !== "running") break;
        yield* pumpDomain(boardTurnStartRequested(live.threadId!, 10 + index, TYPED_AT));
        yield* pumpRuntime(turnCompleted(live.threadId!));
      }

      assert.strictEqual(stepStatus(yield* board, BoardCardId.make("ceiling")), "stalled");
    }),
  ),
);

// ── The timeout sweep ─────────────────────────────────────────────────────

/** One day before the TestClock epoch, so a 60s timeout is decisively
    exceeded. `it.effect` runs at the epoch, and the sweep's other life signs
    all read as absent for a step with no todo list, output or commits. */
const OVERDUE = "1969-12-31T00:00:00.000Z";
/** Exactly the TestClock "now" — a maximally fresh pending turn request. */
const FRESH = "1970-01-01T00:00:00.000Z";

const sweepCardId = BoardCardId.make("card-sweep");
const sweepThreadId = ThreadId.make("thread-sweep");

/** A running unattended step whose every life sign is a day stale. */
const overdueStep = (overrides?: Partial<BoardCardStepState>): BoardCardStepState => ({
  cardId: sweepCardId,
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
  providerInstanceId: codex,
  model: "gpt-5-codex",
  mode: "build",
  runtimeMode: "auto",
  humanInLoop: false,
  maxAttempts: 3,
  timeoutMs: 60_000,
  threadId: sweepThreadId,
  status: "running",
  // False keeps boot reconcile's slot restore out of what these assert.
  slotHeld: false,
  forceStart: false,
  startedAt: OVERDUE,
  updatedAt: OVERDUE,
  ...overrides,
});

const sweepBoard = (step: BoardCardStepState): BoardState => ({
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

/** A live shell for the step's thread, so boot reconcile resume-watches it
    rather than recovering it before the sweep under test runs. */
const sweepShells = (): ReadonlyMap<string, OrchestrationThreadShell> =>
  new Map([[String(sweepThreadId), aliveThreadShell(String(sweepThreadId))]]);

it.effect("the sweep does not nudge over a turn a human has already requested", () =>
  withGovernor(
    {
      board: sweepBoard(overdueStep()),
      settings: settingsWith({ building: [codexStep], globalMaxConcurrent: 3 }),
      initialShells: sweepShells(),
      // Requested and not yet started: it has no turn id, emits no output and
      // advances no todo list, so every other life sign is blind to it.
      threadPendingTurnStarts: new Map([[String(sweepThreadId), FRESH]]),
    },
    ({ reactor, board }) =>
      Effect.gen(function* () {
        yield* reactor.sweep;
        assert.strictEqual(boardCardStepState(yield* board, sweepCardId)?.attempt, 1);
      }),
  ),
);

it.effect("the sweep nudges the same step with no turn outstanding", () =>
  withGovernor(
    {
      board: sweepBoard(overdueStep()),
      settings: settingsWith({ building: [codexStep], globalMaxConcurrent: 3 }),
      initialShells: sweepShells(),
    },
    ({ reactor, board }) =>
      Effect.gen(function* () {
        yield* reactor.sweep;
        assert.strictEqual(boardCardStepState(yield* board, sweepCardId)?.attempt, 2);
      }),
  ),
);

it.effect("a step steered and then silent past its timeout is still nudged by the sweep", () =>
  withGovernor(
    {
      board: sweepBoard(overdueStep({ humanTurnAt: OVERDUE, lastNudgeAt: OVERDUE })),
      settings: settingsWith({ building: [codexStep], globalMaxConcurrent: 3 }),
      initialShells: sweepShells(),
    },
    ({ reactor, board }) =>
      Effect.gen(function* () {
        yield* reactor.sweep;

        // The hang detector survives the steer (D6). The sweep never sees a
        // `turn.completed`, so a guard on `humanTurnAt` down here would mean
        // the free ending was never spent and this agent was never caught.
        const after = boardCardStepState(yield* board, sweepCardId);
        assert.strictEqual(after?.attempt, 2);
        assert.strictEqual(after?.humanTurnAt, OVERDUE);
      }),
  ),
);

// ── The instant the steer records ─────────────────────────────────────────

it.effect("the steer records the instant the human typed, not when it was processed", () =>
  withGovernor(oneBuildCard("instant"), ({ pumpDomain, board }) =>
    Effect.gen(function* () {
      const threadId = yield* startBuild({ pumpDomain, board }, "instant");
      assert.notStrictEqual(TYPED_AT, NOW);

      yield* pumpDomain(humanTurnStartRequested(threadId, 2, TYPED_AT));

      // The turn's own `createdAt`, so the "since the last nudge" window the
      // sweep and the progress signal measure from starts when the human
      // actually spoke.
      assert.strictEqual(stateOf(yield* board, "instant")?.lastNudgeAt, TYPED_AT);
    }),
  ),
);
