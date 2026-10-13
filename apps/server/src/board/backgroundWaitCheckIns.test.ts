/**
 * A step whose agent is waiting on its own background work is checked on, not
 * nudged (T3O-20).
 *
 * Claude often ends a turn with a background command or a Monitor still
 * running. The turn-end handler now treats that as a wait
 * (`subagentWait.test.ts`), and the timeout sweep supervises the wait on its
 * own schedule: a check-in at +5, +15 and +30 minutes, then every 30 minutes.
 * The first three are free; each one after spends the recovery budget, and the
 * one that would cross a ceiling escalates the card to a human instead.
 *
 * Driven through the live reactor against the stateful engine double. The
 * clock is the TestClock: each step advances it and runs one sweep pass.
 */
import {
  BoardCardId,
  boardCardStepState,
  type BoardState,
  type OrchestrationCommand,
  type OrchestrationThreadShell,
  type ThreadId,
} from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Ref from "effect/Ref";
import * as TestClock from "effect/testing/TestClock";

import {
  buildingCard,
  codexStep,
  movedToBuilding,
  settingsWith,
  turnCompleted,
  withGovernor,
  type Harness,
} from "./supervisorHarness.testkit.ts";

const CARD = "waiting";

type TodoRow = { readonly advancedAt: string | null; readonly hasList: boolean };

const fixture = (threadTodos?: Map<string, TodoRow>) => ({
  board: { cards: [buildingCard(CARD, "m")], nextCardNumberByProject: {} },
  settings: settingsWith({ building: [codexStep], globalMaxConcurrent: 3 }),
  ...(threadTodos === undefined ? {} : { threadTodos }),
});

/** The thread with no turn live — or mid-turn — and whatever background work
    the liveness registry reports. */
const shellOf = (
  threadId: ThreadId,
  backgroundLiveness: "working" | "monitoring" | null,
  sessionStatus: "ready" | "running" = "ready",
): OrchestrationThreadShell =>
  ({
    id: threadId,
    hasPendingUserInput: false,
    hasPendingApprovals: false,
    archivedAt: null,
    settledOverride: null,
    session: { status: sessionStatus, activeTurnId: null },
    backgroundLiveness,
  }) as unknown as OrchestrationThreadShell;

const setShell = (
  shells: Harness["shells"],
  threadId: ThreadId,
  backgroundLiveness: "working" | "monitoring" | null,
  sessionStatus: "ready" | "running" = "ready",
) =>
  Ref.update(
    shells,
    (current) =>
      new Map([
        ...current,
        [String(threadId), shellOf(threadId, backgroundLiveness, sessionStatus)],
      ]),
  );

const stateOf = (board: BoardState) => boardCardStepState(board, BoardCardId.make(CARD));

const turnTexts = (commands: ReadonlyArray<OrchestrationCommand>) =>
  commands.flatMap((command) =>
    command.type === "thread.turn.start" ? [command.message.text] : [],
  );
const checkInsOf = (commands: ReadonlyArray<OrchestrationCommand>) =>
  turnTexts(commands).filter((text) => text.includes("scheduled check-in")).length;
const stallNudgesOf = (commands: ReadonlyArray<OrchestrationCommand>) =>
  turnTexts(commands).filter((text) => text.includes("without calling board_complete_step")).length;
const recoveriesOf = (commands: ReadonlyArray<OrchestrationCommand>) =>
  commands.filter((command) => command.type === "board.card.recover-step").length;

/** Start the card building and end its first turn with a monitor running. */
const startWaiting = (h: Harness) =>
  Effect.gen(function* () {
    yield* h.pumpDomain(movedToBuilding(buildingCard(CARD, "m"), 1));
    const threadId = stateOf(yield* h.board)!.threadId!;
    yield* setShell(h.shells, threadId, "monitoring");
    yield* h.pumpRuntime(turnCompleted(threadId));
    return threadId;
  });

/** Advance the clock and run one sweep pass. */
const after = (h: Harness, minutes: number) =>
  Effect.gen(function* () {
    yield* TestClock.adjust(Duration.minutes(minutes));
    yield* h.reactor.sweep;
    yield* h.reactor.drain;
  });

it.effect("check-ins go out at +5, +15 and +30 free, then +60 charged", () =>
  withGovernor(fixture(), (h) =>
    Effect.gen(function* () {
      yield* startWaiting(h);

      yield* after(h, 4);
      assert.strictEqual(checkInsOf(yield* h.commands), 0, "nothing before +5");

      yield* after(h, 1);
      assert.strictEqual(checkInsOf(yield* h.commands), 1, "+5");
      yield* after(h, 10);
      assert.strictEqual(checkInsOf(yield* h.commands), 2, "+15");
      yield* after(h, 15);
      assert.strictEqual(checkInsOf(yield* h.commands), 3, "+30");

      const free = stateOf(yield* h.board);
      assert.strictEqual(free?.status, "running");
      assert.strictEqual(free?.stallCount, 0);
      assert.strictEqual(free?.attempt, 1);
      assert.strictEqual(free?.stageEntryRecoveries, 0);

      yield* after(h, 29);
      assert.strictEqual(checkInsOf(yield* h.commands), 3, "nothing before +60");
      yield* after(h, 1);
      assert.strictEqual(checkInsOf(yield* h.commands), 4, "+60");

      const charged = stateOf(yield* h.board);
      assert.strictEqual(charged?.status, "running");
      assert.strictEqual(charged?.stallCount, 1);
      assert.strictEqual(charged?.attempt, 2);
      assert.strictEqual(charged?.stageEntryRecoveries, 1);

      const commands = yield* h.commands;
      assert.strictEqual(recoveriesOf(commands), 0);
      assert.strictEqual(stallNudgesOf(commands), 0, "the stall nudge never goes out");
    }),
  ),
);

it.effect("a check-in turn that ends still waiting keeps the schedule", () =>
  withGovernor(fixture(), (h) =>
    Effect.gen(function* () {
      const threadId = yield* startWaiting(h);
      yield* after(h, 5);
      assert.strictEqual(checkInsOf(yield* h.commands), 1);

      // The agent checked, its monitor is still running, and it ended its turn.
      yield* h.pumpRuntime(turnCompleted(threadId));

      // The second check-in is still due at +15 from the START of the wait.
      yield* after(h, 10);
      assert.strictEqual(checkInsOf(yield* h.commands), 2);
      assert.strictEqual(recoveriesOf(yield* h.commands), 0);
    }),
  ),
);

it.effect("a wait that never ends escalates to a human once the ladder is spent", () =>
  withGovernor(fixture(), (h) =>
    Effect.gen(function* () {
      yield* startWaiting(h);
      const maxAttempts = stateOf(yield* h.board)!.maxAttempts;
      // Three free check-ins, then one charged per half hour until the next
      // would reach `maxAttempts` consecutive stalls.
      yield* after(h, 5);
      yield* after(h, 10);
      yield* after(h, 15);
      for (let charged = 1; charged < maxAttempts; charged++) {
        yield* after(h, 30);
        assert.strictEqual(stateOf(yield* h.board)?.status, "running");
        assert.strictEqual(stateOf(yield* h.board)?.stallCount, charged);
      }
      const sent = 3 + maxAttempts - 1;
      assert.strictEqual(checkInsOf(yield* h.commands), sent);

      yield* after(h, 30);
      const escalated = stateOf(yield* h.board);
      assert.strictEqual(escalated?.status, "stalled");
      assert.strictEqual(escalated?.stalledReason, "gave-up");
      assert.strictEqual(escalated?.slotHeld, false);
      assert.strictEqual(checkInsOf(yield* h.commands), sent, "no check-in past it");
      assert.strictEqual(stallNudgesOf(yield* h.commands), 0);
    }),
  ),
);

it.effect("a todo edit while answering a check-in does not restart the schedule", () => {
  const todos = new Map<string, TodoRow>();
  return withGovernor(fixture(todos), (h) =>
    Effect.gen(function* () {
      const threadId = yield* startWaiting(h);
      yield* after(h, 5);
      assert.strictEqual(checkInsOf(yield* h.commands), 1);

      // The agent answers the check-in the way it is asked to — flipping its
      // todo list — and ends the turn with the monitor still running.
      todos.set(String(threadId), {
        advancedAt: DateTime.formatIso(yield* DateTime.now),
        hasList: true,
      });
      yield* h.pumpRuntime(turnCompleted(threadId));

      // Nothing new at +5 from the reply; the second is still due at +15 from
      // the start of the wait.
      yield* after(h, 9);
      assert.strictEqual(checkInsOf(yield* h.commands), 1, "the reply did not restart the wait");
      yield* after(h, 1);
      assert.strictEqual(checkInsOf(yield* h.commands), 2);
      yield* after(h, 15);
      assert.strictEqual(checkInsOf(yield* h.commands), 3);
    }),
  );
});

it.effect("a turn the board did not start restarts the schedule", () =>
  withGovernor(fixture(), (h) =>
    Effect.gen(function* () {
      const threadId = yield* startWaiting(h);
      yield* after(h, 5);
      yield* h.pumpRuntime(turnCompleted(threadId));
      yield* after(h, 10);
      yield* h.pumpRuntime(turnCompleted(threadId));
      assert.strictEqual(checkInsOf(yield* h.commands), 2);

      // The provider woke the agent; it worked, started a new job and ended
      // its turn still waiting. That is a new wait.
      yield* after(h, 1);
      yield* h.pumpRuntime(turnCompleted(threadId));

      // The new wait's first check is five minutes out — not the old +30.
      yield* after(h, 4);
      assert.strictEqual(checkInsOf(yield* h.commands), 2);
      yield* after(h, 1);
      assert.strictEqual(checkInsOf(yield* h.commands), 3);
    }),
  ),
);

it.effect("a quiet thread with background work is put on the schedule without a turn end", () =>
  withGovernor(fixture(), (h) =>
    Effect.gen(function* () {
      yield* h.pumpDomain(movedToBuilding(buildingCard(CARD, "m"), 1));
      const threadId = stateOf(yield* h.board)!.threadId!;
      // The turn ended with a monitor running, but its completion never
      // reached the reactor.
      yield* setShell(h.shells, threadId, "monitoring");

      // Long before the step's timeout, the sweep begins the wait...
      yield* after(h, 1);
      assert.strictEqual(checkInsOf(yield* h.commands), 0);
      // ...and its first check-in goes out five minutes later.
      yield* after(h, 5);
      assert.strictEqual(checkInsOf(yield* h.commands), 1);
      assert.strictEqual(recoveriesOf(yield* h.commands), 0);
    }),
  ),
);

it.effect("a turn that ends with the background work gone ends the wait", () =>
  withGovernor(fixture(), (h) =>
    Effect.gen(function* () {
      const threadId = yield* startWaiting(h);
      yield* after(h, 5);
      assert.strictEqual(checkInsOf(yield* h.commands), 1);

      // The job finished; the agent ended its turn without completing.
      yield* setShell(h.shells, threadId, null);
      yield* h.pumpRuntime(turnCompleted(threadId));
      assert.strictEqual(recoveriesOf(yield* h.commands), 1, "ordinary recovery applies");

      yield* after(h, 10);
      assert.strictEqual(checkInsOf(yield* h.commands), 1, "no check-in after the wait ended");
    }),
  ),
);

it.effect("a live turn is not checked in on", () =>
  withGovernor(fixture(), (h) =>
    Effect.gen(function* () {
      const threadId = yield* startWaiting(h);
      // The provider woke the agent and it is mid-turn.
      yield* setShell(h.shells, threadId, "monitoring", "running");
      yield* after(h, 5);
      assert.strictEqual(checkInsOf(yield* h.commands), 0);
    }),
  ),
);
