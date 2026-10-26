/**
 * Usage limits: the board's bridge to orchestration-v2's own recovery (T3O-72).
 *
 * v2 detects a usage limit (`usageLimit` on the thread state) and resumes a
 * thread at its reset once recovery is armed. The board's part is small: park
 * an unattended step `usage-limit` without spending its retry budget, arm v2's
 * recovery, un-park on `limit-resumed`, and wake the step itself from the retry
 * sweep if that signal never comes.
 *
 * Driven through the live reactor against the stateful engine double
 * (`withGovernor`). `it.effect` runs on the TestClock, whose "now" is the
 * epoch, so every reset time sits a fixed distance from it and the clock is
 * advanced explicitly.
 *
 * The generic retry ladder the park rides on is pinned here too: it is the
 * path a limit with no reset time takes, and the sweep that wakes a park.
 */
import {
  BOARD_SEED_STAGE_IDS,
  BoardCardId,
  boardCardStepState,
  ThreadId,
  type BoardCard,
} from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Clock from "effect/Clock";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Ref from "effect/Ref";
import * as TestClock from "effect/testing/TestClock";

import { BOARD_STEP_USAGE_LIMIT_RESUME_NUDGE } from "./supervisor.ts";
import type { BoardThreadUsageLimit } from "./ThreadGateway.ts";
import {
  cardMoved,
  codexStep,
  idleThreadShell,
  makeBoardCard,
  movedToBuilding,
  readyWorktree,
  settingsWith,
  turnCompleted,
  withGovernor,
  type Harness,
} from "./supervisorHarness.testkit.ts";

/** An hour past the TestClock epoch — decisively ahead of any backoff rung. */
const RESETS_AT = "1970-01-01T01:00:00.000Z";
const RESETS_AT_MS = Date.parse(RESETS_AT);
const LIMIT_MESSAGE = "You've hit your session limit · resets 1am";

const limitAt = (resetAt: string | null = RESETS_AT): BoardThreadUsageLimit => ({
  resetAt,
  message: LIMIT_MESSAGE,
  resumeArmed: false,
});

const buildingCard = (id: string, orderKey: string): BoardCard =>
  makeBoardCard({
    id,
    stage: String(BOARD_SEED_STAGE_IDS.building),
    orderKey,
    worktree: readyWorktree(id),
  });

const unattended = {
  board: { cards: [buildingCard("a", "a")], nextCardNumberByProject: {} },
  settings: settingsWith({ building: [codexStep], globalMaxConcurrent: 3 }),
};

/** Every turn the reactor sent into one thread, in order. */
const turnTextsFor = (harness: Harness, threadId: ThreadId) =>
  harness.commands.pipe(
    Effect.map((commands) =>
      commands.flatMap((command) =>
        (command.type === "thread.spawn" || command.type === "thread.send") &&
        command.threadId === threadId
          ? [command.text]
          : [],
      ),
    ),
  );

const armsFor = (harness: Harness, threadId: ThreadId) =>
  harness.commands.pipe(
    Effect.map(
      (commands) =>
        commands.filter(
          (command) =>
            command.type === "thread.arm-limit-recovery" && command.threadId === threadId,
        ).length,
    ),
  );

const stepOf = (harness: Harness, id: string) =>
  harness.board.pipe(Effect.map((board) => boardCardStepState(board, BoardCardId.make(id))));

/** Seed a thread's live view as idle, optionally limited. */
const seedThread = (
  harness: Harness,
  threadId: ThreadId,
  usageLimit: BoardThreadUsageLimit | null = null,
) =>
  Ref.update(harness.shells, (current) => {
    const shell = current.get(String(threadId)) ?? idleThreadShell(String(threadId));
    return new Map([...current, [String(threadId), { ...shell, usageLimit }]]);
  });

/** Move a card into Building and seed its spawned thread as idle. */
const startCard = (harness: Harness, id: string, orderKey: string, sequence: number) =>
  Effect.gen(function* () {
    yield* harness.pumpDomain(movedToBuilding(buildingCard(id, orderKey), sequence));
    const state = yield* stepOf(harness, id);
    assert.ok(state?.threadId != null, `card ${id} spawned a thread`);
    yield* seedThread(harness, state.threadId);
    return state.threadId;
  });

/** Start a card and end its first turn, on a limit or not. */
const stopCard = (harness: Harness, limit: BoardThreadUsageLimit | null) =>
  Effect.gen(function* () {
    const threadId = yield* startCard(harness, "a", "a", 1);
    yield* seedThread(harness, threadId, limit);
    yield* harness.pumpRuntime(turnCompleted(threadId));
    return threadId;
  });

const fireRetriesAfter = (harness: Harness, minutes: number) =>
  Effect.gen(function* () {
    yield* TestClock.adjust(Duration.minutes(minutes));
    yield* harness.reactor.fireRetries;
    yield* harness.reactor.drain;
  });

// ── The park ───────────────────────────────────────────────────────────────

it.effect("a limit with a reset time parks the step free of charge and arms v2's resume", () =>
  withGovernor(unattended, (harness) =>
    Effect.gen(function* () {
      const threadId = yield* stopCard(harness, limitAt());

      const parked = yield* stepOf(harness, "a");
      assert.strictEqual(parked?.status, "stalled");
      assert.strictEqual(parked?.stalledReason, "usage-limit");
      // A grace past the reset, so v2's own resume normally lands first.
      assert.ok(parked?.retryAt != null);
      const graceMinutes = (Date.parse(parked.retryAt) - RESETS_AT_MS) / 60_000;
      assert.isAtLeast(graceMinutes, 9);
      assert.isAtMost(graceMinutes, 11);
      // The provider's own words, so the card says why.
      assert.strictEqual(parked?.lastError, LIMIT_MESSAGE);
      // The card is not failing, the provider is: no budget spent.
      assert.strictEqual(parked?.attempt, 1);
      assert.strictEqual(parked?.stallCount, 0);
      assert.strictEqual(parked?.stageEntryRecoveries, 0);
      // And it holds no capacity while it waits.
      assert.isFalse(parked?.slotHeld);

      assert.strictEqual(yield* armsFor(harness, threadId), 1);
      const shells = yield* Ref.get(harness.shells);
      assert.isTrue(shells.get(String(threadId))?.usageLimit?.resumeArmed);
    }),
  ),
);

it.effect("a refusal that ends with a monitor still live parks rather than waits", () =>
  withGovernor(unattended, (harness) =>
    Effect.gen(function* () {
      const threadId = yield* startCard(harness, "a", "a", 1);
      yield* Ref.update(harness.shells, (current) => {
        const shell = current.get(String(threadId))!;
        return new Map([
          ...current,
          [String(threadId), { ...shell, backgroundWork: "monitoring", usageLimit: limitAt() }],
        ]);
      });
      yield* harness.pumpRuntime(turnCompleted(threadId));

      assert.strictEqual((yield* stepOf(harness, "a"))?.stalledReason, "usage-limit");
      // No background-wait check-in follows the park.
      yield* TestClock.adjust(Duration.minutes(5));
      yield* harness.reactor.sweep;
      yield* harness.reactor.drain;
      const texts = yield* turnTextsFor(harness, threadId);
      assert.isFalse(texts.some((text) => text.includes("scheduled check-in")));
    }),
  ),
);

it.effect("a limit with no reset time takes the ordinary recovery ladder", () =>
  withGovernor(unattended, (harness) =>
    Effect.gen(function* () {
      const threadId = yield* stopCard(harness, limitAt(null));

      const parked = yield* stepOf(harness, "a");
      assert.strictEqual(parked?.status, "stalled");
      assert.strictEqual(parked?.stalledReason, "waiting-retry");
      assert.strictEqual(parked?.attempt, 2, "an ordinary stop spends the budget");
      assert.strictEqual(yield* armsFor(harness, threadId), 0);
    }),
  ),
);

it.effect("a human-in-the-loop step is never parked by a limit", () =>
  withGovernor(
    {
      board: {
        cards: [makeBoardCard({ id: "plan", stage: "planning", orderKey: "m" })],
        nextCardNumberByProject: {},
      },
      settings: settingsWith({
        building: [codexStep],
        planning: codexStep,
        planningHumanInLoop: true,
        globalMaxConcurrent: 3,
      }),
    },
    (harness) =>
      Effect.gen(function* () {
        yield* harness.pumpDomain(
          cardMoved(
            makeBoardCard({ id: "plan", stage: "planning", orderKey: "m" }),
            "ready",
            "planning",
            1,
          ),
        );
        const threadId = (yield* stepOf(harness, "plan"))?.threadId;
        assert.ok(threadId != null);
        // Planning is an interview: a stopped planning card is waiting on a
        // person whatever the provider is doing.
        yield* seedThread(harness, threadId, limitAt());
        yield* harness.pumpRuntime(turnCompleted(threadId));

        const parked = yield* stepOf(harness, "plan");
        assert.strictEqual(parked?.status, "awaiting-input");
        assert.strictEqual(yield* armsFor(harness, threadId), 0);
      }),
  ),
);

// ── The two ways back ──────────────────────────────────────────────────────

it.effect("v2's limit resume un-parks the step, and the board sends nothing of its own", () =>
  withGovernor(unattended, (harness) =>
    Effect.gen(function* () {
      const threadId = yield* stopCard(harness, limitAt());
      const sentBefore = (yield* turnTextsFor(harness, threadId)).length;

      yield* harness.pumpRuntime({ type: "limit-resumed", threadId });
      yield* harness.reactor.drain;

      const resumed = yield* stepOf(harness, "a");
      assert.strictEqual(resumed?.status, "running");
      // The engine's resume is not a human steering: no free ending.
      assert.isNull(resumed?.humanTurnAt ?? null);
      assert.lengthOf(yield* turnTextsFor(harness, threadId), sentBefore);
    }),
  ),
);

it.effect("with no resume from v2, the retry sweep wakes the step once its time passes", () =>
  withGovernor(unattended, (harness) =>
    Effect.gen(function* () {
      const threadId = yield* stopCard(harness, limitAt());

      // At the reset itself the grace has not run out.
      yield* fireRetriesAfter(harness, 60);
      assert.strictEqual((yield* stepOf(harness, "a"))?.status, "stalled");

      yield* fireRetriesAfter(harness, 12);
      const woken = yield* stepOf(harness, "a");
      assert.strictEqual(woken?.status, "running");
      // Woken with its budget intact, and told why it stopped.
      assert.strictEqual(woken?.attempt, 1);
      assert.strictEqual((yield* turnTextsFor(harness, threadId)).at(-1), BOARD_STEP_USAGE_LIMIT_RESUME_NUDGE);
    }),
  ),
);

it.effect("v2's resume and the sweep together resume the step once", () =>
  withGovernor(unattended, (harness) =>
    Effect.gen(function* () {
      const threadId = yield* stopCard(harness, limitAt());

      yield* TestClock.adjust(Duration.minutes(60));
      yield* harness.pumpRuntime({ type: "limit-resumed", threadId });
      yield* harness.reactor.drain;
      assert.strictEqual((yield* stepOf(harness, "a"))?.status, "running");
      const sentAfterResume = (yield* turnTextsFor(harness, threadId)).length;

      // The board's own wake comes due later and finds nothing parked.
      yield* fireRetriesAfter(harness, 12);
      assert.strictEqual((yield* stepOf(harness, "a"))?.status, "running");
      assert.lengthOf(yield* turnTextsFor(harness, threadId), sentAfterResume);

      // And the other order: a late `limit-resumed` after the sweep woke it.
      yield* harness.pumpRuntime({ type: "limit-resumed", threadId });
      yield* harness.reactor.drain;
      assert.lengthOf(yield* turnTextsFor(harness, threadId), sentAfterResume);
    }),
  ),
);

it.effect("v2's limit resume leaves a step parked on a question alone", () =>
  withGovernor(unattended, (harness) =>
    Effect.gen(function* () {
      const threadId = yield* startCard(harness, "a", "a", 1);
      yield* Ref.update(harness.shells, (current) => {
        const shell = current.get(String(threadId))!;
        return new Map([...current, [String(threadId), { ...shell, awaitingUserInput: true }]]);
      });
      yield* harness.pumpRuntime(turnCompleted(threadId));
      assert.strictEqual((yield* stepOf(harness, "a"))?.status, "awaiting-input");

      yield* harness.pumpRuntime({ type: "limit-resumed", threadId });
      yield* harness.reactor.drain;
      assert.strictEqual((yield* stepOf(harness, "a"))?.status, "awaiting-input");
    }),
  ),
);

// ── The generic retry ladder (T3O-22, D7/D12) ──────────────────────────────

it.effect("a non-limit stall climbs 2, 4, 8 minutes, releasing its slot between rungs", () =>
  withGovernor(unattended, (harness) =>
    Effect.gen(function* () {
      const threadId = yield* stopCard(harness, null);
      const rungs: Array<number> = [];
      for (let attempt = 1; attempt <= 3; attempt += 1) {
        const parked = yield* stepOf(harness, "a");
        assert.strictEqual(parked?.status, "stalled");
        assert.strictEqual(parked?.stalledReason, "waiting-retry");
        assert.isFalse(parked?.slotHeld, "a waiting card holds no capacity");
        assert.ok(parked?.retryAt != null);
        rungs.push(Date.parse(parked.retryAt) - (yield* Clock.currentTimeMillis));

        // Past the rung but well inside the step's own 30-minute timeout.
        yield* fireRetriesAfter(harness, 10);
        assert.strictEqual((yield* stepOf(harness, "a"))?.status, "running");
        yield* harness.pumpRuntime(turnCompleted(threadId));
      }
      // 2, 4, 8 minutes, each jittered by at most a minute either way.
      const minutes = rungs.map((ms) => Math.round(ms / 60_000));
      assert.deepStrictEqual(
        minutes.map((value, index) => Math.abs(value - [2, 4, 8][index]!) <= 1),
        [true, true, true],
        `expected 2/4/8-minute rungs, got ${minutes.join(", ")}`,
      );
    }),
  ),
);

it.effect("a backoff rung arriving delivers the recovery nudge it deferred", () =>
  withGovernor(unattended, (harness) =>
    Effect.gen(function* () {
      const threadId = yield* stopCard(harness, null);
      assert.strictEqual((yield* stepOf(harness, "a"))?.stalledReason, "waiting-retry");

      yield* fireRetriesAfter(harness, 10);
      assert.strictEqual((yield* stepOf(harness, "a"))?.status, "running");

      // The nudge is recomposed at delivery from the step row.
      const delivered = (yield* turnTextsFor(harness, threadId)).at(-1) ?? "";
      assert.include(delivered, "board_complete_step");
      assert.include(delivered, "your work is not finished");

      // And the reason does not outlive the resume.
      assert.strictEqual((yield* stepOf(harness, "a"))?.stalledReason, "gave-up");
      assert.strictEqual((yield* stepOf(harness, "a"))?.retryAt, null);
    }),
  ),
);

it.effect("a resume that stops again keeps climbing, and never resets the stage ceiling", () =>
  withGovernor(unattended, (harness) =>
    Effect.gen(function* () {
      const threadId = yield* stopCard(harness, null);
      assert.strictEqual((yield* stepOf(harness, "a"))?.attempt, 2);

      yield* fireRetriesAfter(harness, 10);
      yield* harness.pumpRuntime(turnCompleted(threadId));
      const climbing = yield* stepOf(harness, "a");
      assert.strictEqual(climbing?.attempt, 3);
      assert.strictEqual(climbing?.stallCount, 2);
      assert.strictEqual(climbing?.stageEntryRecoveries, 2);
    }),
  ),
);
