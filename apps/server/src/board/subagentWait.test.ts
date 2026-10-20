/**
 * A turn that ends while the agent's subagents run on is waiting, not stopped
 * (T3O-9).
 *
 * An agent that fans work out to background subagents ends its own turn
 * straight away; the provider wakes it again when they report back. The board
 * read that turn ending as the agent stopping without `board_complete_step`, so
 * it parked the card as "waiting to resume — nothing is running right now" and,
 * when the backoff ran out, nudged the agent in the middle of its wait. Every
 * nudge interrupted the agent and made it end another turn, so the card climbed
 * the stall ladder while its subagents were doing the work.
 *
 * The thread already says when background work is running: the shell's
 * `backgroundLiveness` is what draws the composer's "N agents working" /
 * "Monitoring" banner and the card's working dot. The turn-end handler reads
 * the same field, and since T3O-20 treats a monitor the same as subagents.
 *
 * Driven through the live reactor against the stateful engine double, because
 * the behaviour spans the turn-end handler and the decider.
 */
import {
  BoardCardId,
  boardCardStepState,
  type BoardState,
  type OrchestrationThreadShell,
  type ThreadId,
} from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Ref from "effect/Ref";

import {
  buildingCard,
  codexStep,
  movedToBuilding,
  settingsWith,
  turnCompleted,
  withGovernor,
  type Harness,
  type HarnessCommand,
} from "./supervisorHarness.testkit.ts";

const oneBuildCard = (id: string) => ({
  board: { cards: [buildingCard(id, "m")], nextCardNumberByProject: {} },
  settings: settingsWith({ building: [codexStep], globalMaxConcurrent: 3 }),
});

const startBuild = (h: Pick<Harness, "pumpDomain" | "board">, id: string) =>
  Effect.gen(function* () {
    yield* h.pumpDomain(movedToBuilding(buildingCard(id, "m"), 1));
    const state = boardCardStepState(yield* h.board, BoardCardId.make(id));
    assert.strictEqual(state?.status, "running");
    assert.strictEqual(state?.humanInLoop, false);
    return state!.threadId!;
  });

/** The thread between turns: no turn live, with whatever background work the
    liveness registry reports. */
const idleShell = (
  threadId: ThreadId,
  backgroundLiveness: "working" | "monitoring" | null,
): OrchestrationThreadShell =>
  ({
    id: threadId,
    hasPendingUserInput: false,
    hasPendingApprovals: false,
    archivedAt: null,
    settledOverride: null,
    session: { status: "ready", activeTurnId: null },
    backgroundLiveness,
  }) as unknown as OrchestrationThreadShell;

const setShell = (
  shells: Harness["shells"],
  threadId: ThreadId,
  backgroundLiveness: "working" | "monitoring" | null,
) =>
  Ref.update(
    shells,
    (current) => new Map([...current, [String(threadId), idleShell(threadId, backgroundLiveness)]]),
  );

const stateOf = (board: BoardState, id: string) => boardCardStepState(board, BoardCardId.make(id));

const recoveries = (commands: ReadonlyArray<HarnessCommand>) =>
  commands.filter((command) => command.type === "board.card.recover-step").length;

it.effect("a turn that ends while subagents are working leaves the step running", () =>
  withGovernor(oneBuildCard("fanout"), ({ pumpDomain, pumpRuntime, board, commands, shells }) =>
    Effect.gen(function* () {
      const threadId = yield* startBuild({ pumpDomain, board }, "fanout");
      yield* setShell(shells, threadId, "working");

      yield* pumpRuntime(turnCompleted(threadId));

      const after = stateOf(yield* board, "fanout");
      assert.strictEqual(recoveries(yield* commands), 0);
      assert.strictEqual(after?.status, "running");
      assert.strictEqual(after?.attempt, 1);
      assert.strictEqual(after?.stallCount, 0);
      assert.strictEqual(after?.stageEntryRecoveries, 0);
      assert.strictEqual(after?.threadId, threadId);
    }),
  ),
);

it.effect("once the subagents finish, a turn that ends without completing recovers", () =>
  withGovernor(oneBuildCard("settled"), ({ pumpDomain, pumpRuntime, board, commands, shells }) =>
    Effect.gen(function* () {
      const threadId = yield* startBuild({ pumpDomain, board }, "settled");
      yield* setShell(shells, threadId, "working");
      yield* pumpRuntime(turnCompleted(threadId));
      assert.strictEqual(recoveries(yield* commands), 0);

      // The subagents reported back, the provider woke the agent, and that
      // turn ended too — with nothing left running and no completion.
      yield* setShell(shells, threadId, null);
      yield* pumpRuntime(turnCompleted(threadId));

      assert.strictEqual(recoveries(yield* commands), 1);
      assert.strictEqual(stateOf(yield* board, "settled")?.stallCount, 1);
    }),
  ),
);

// A background command or a Monitor ("monitoring", T3O-20) is a wait too:
// the provider wakes the agent when it reports. It used to be supervised as a
// stop, so the agent was nudged with "your turn ended without calling
// board_complete_step", replied "still waiting" and climbed the stall ladder.
// The timeout sweep's check-ins supervise it instead
// (`backgroundWaitCheckIns.test.ts`).
it.effect(
  "a turn that ends with a background command or monitor running leaves the step running",
  () =>
    withGovernor(oneBuildCard("watch"), ({ pumpDomain, pumpRuntime, board, commands, shells }) =>
      Effect.gen(function* () {
        const threadId = yield* startBuild({ pumpDomain, board }, "watch");
        yield* setShell(shells, threadId, "monitoring");

        yield* pumpRuntime(turnCompleted(threadId));

        const after = stateOf(yield* board, "watch");
        assert.strictEqual(recoveries(yield* commands), 0);
        assert.strictEqual(after?.status, "running");
        assert.strictEqual(after?.stallCount, 0);
        assert.strictEqual(after?.stageEntryRecoveries, 0);
      }),
    ),
);

// A human-in-the-loop run keeps its pre-T3O-20 handling of a monitor: the human
// is the pacing, so the step parks on them rather than starting a wait.
it.effect("a human-in-the-loop turn that ends with a monitor running parks on the human", () =>
  withGovernor(
    {
      board: { cards: [buildingCard("hitl", "m", true)], nextCardNumberByProject: {} },
      settings: settingsWith({ building: [codexStep], globalMaxConcurrent: 3 }),
    },
    ({ pumpDomain, pumpRuntime, board, commands, shells }) =>
      Effect.gen(function* () {
        yield* pumpDomain(movedToBuilding(buildingCard("hitl", "m", true), 1));
        const threadId = stateOf(yield* board, "hitl")!.threadId!;
        yield* setShell(shells, threadId, "monitoring");

        yield* pumpRuntime(turnCompleted(threadId));

        const parked = stateOf(yield* board, "hitl");
        assert.strictEqual(parked?.humanInLoop, true);
        assert.strictEqual(parked?.status, "awaiting-input");
        assert.strictEqual(parked?.awaitingReason, "stopped");
        assert.strictEqual(recoveries(yield* commands), 0);
      }),
  ),
);
