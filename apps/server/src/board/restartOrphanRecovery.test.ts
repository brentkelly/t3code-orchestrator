/**
 * A restart mid-build leaves an `error` session whose turn id lingers; boot
 * reconcile must not read it as mid-turn and watch it forever. Asserts on the
 * state reconcile leaves: attempt burned, slot kept, step eventually stalled.
 */
import {
  BoardCardId,
  boardCardStepState,
  ProviderInstanceId,
  ThreadId,
  type BoardCardStepState,
  type BoardState,
} from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as TestClock from "effect/testing/TestClock";

import type { BoardThreadState } from "./ThreadGateway.ts";
import {
  aliveThreadShell,
  codexStep,
  failedThreadShell,
  makeBoardCard,
  readyWorktree,
  settingsWith,
  withGovernor,
} from "./supervisorHarness.testkit.ts";

const cardId = BoardCardId.make("card-orphan");
const threadId = ThreadId.make("thread-orphan");
const codex = ProviderInstanceId.make("codex");

/** A build step the restart caught mid-run: running, holding its slot. */
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
  stalledReason: "gave-up" as const,
  retryAt: null,
  prompt: "build it",
  providerInstanceId: codex,
  model: "gpt-5-codex",
  mode: "build",
  runtimeMode: "auto",
  humanInLoop: false,
  maxAttempts: 3,
  // Well past any backoff rung this fixture waits out: with a
  // one-minute timeout the 30s tick's timeout sweep would fire while the step
  // sat waiting for its rung and re-park it, testing the sweep rather than the
  // restart recovery this is about.
  timeoutMs: 30 * 60_000,
  threadId,
  status: "running",
  slotHeld: true,
  forceStart: false,
  queuedBy: null,
  startedAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  ...overrides,
});

const boardWithStep = (step: BoardCardStepState): BoardState => ({
  cards: [
    makeBoardCard({
      id: String(cardId),
      stage: "building",
      orderKey: "m",
      worktree: readyWorktree(String(cardId)),
    }),
  ],
  stepStates: [step],
  nextCardNumberByProject: {},
});

const shells = (shell: BoardThreadState) => new Map([[String(threadId), shell]]);

/** A turn driven into the thread — a fresh spawn's first turn or a nudge. */
const drivesTurn = (command: { readonly type: string }) =>
  command.type === "thread.spawn" || command.type === "thread.send";

it.effect("boot: a step whose session upstream marked `error` is recovered, not watched", () =>
  withGovernor(
    {
      board: boardWithStep(runningStep()),
      settings: settingsWith({ building: [codexStep], globalMaxConcurrent: 3 }),
      // The reaped shape: session errored, no turn left behind.
      initialShells: shells(failedThreadShell(String(threadId), { staleActiveTurnId: false })),
    },
    ({ board, reactor }) =>
      Effect.gen(function* () {
        yield* reactor.drain;
        const state = boardCardStepState(yield* board, cardId);
        assert.strictEqual(state?.attempt, 2, "the restart orphan burned a recovery attempt");
      }),
  ),
);

it.effect("boot: a STALE activeTurnRef does not keep an errored session alive", () =>
  withGovernor(
    {
      board: boardWithStep(runningStep()),
      settings: settingsWith({ building: [codexStep], globalMaxConcurrent: 3 }),
      // The exact shape the projection holds at boot: `error` plus the id of
      // the turn that died with the process. This is the one that used to read
      // as alive and hold its slot forever.
      initialShells: shells(failedThreadShell(String(threadId))),
    },
    ({ board, slots, reactor }) =>
      Effect.gen(function* () {
        yield* reactor.drain;
        const parked = boardCardStepState(yield* board, cardId);
        // Recovery charged the attempt, but it waits its first backoff rung and
        // gives the restored slot back meanwhile: idling a worker is the worse trade.
        assert.strictEqual(parked?.attempt, 2);
        assert.strictEqual(parked?.status, "stalled");
        assert.strictEqual(parked?.stalledReason, "waiting-retry");
        assert.isFalse(parked?.slotHeld);
        assert.strictEqual(yield* slots.heldFor(codex), 0);

        // …and the rung arriving is what puts it back to work, slot and all.
        yield* TestClock.adjust(Duration.minutes(5));
        yield* reactor.fireRetries;
        yield* reactor.drain;
        const resumed = boardCardStepState(yield* board, cardId);
        assert.strictEqual(resumed?.status, "running");
        assert.isTrue(resumed?.slotHeld);
        assert.strictEqual(yield* slots.heldFor(codex), 1);
      }),
  ),
);

it.effect("boot: a genuinely live thread is still left to resume watching", () =>
  withGovernor(
    {
      board: boardWithStep(runningStep()),
      settings: settingsWith({ building: [codexStep], globalMaxConcurrent: 3 }),
      initialShells: shells(aliveThreadShell(String(threadId))),
    },
    ({ board, slots, commands, reactor }) =>
      Effect.gen(function* () {
        yield* reactor.drain;
        const state = boardCardStepState(yield* board, cardId);
        assert.strictEqual(state?.attempt, 1, "a live thread is not nudged at boot");
        assert.isTrue(state?.slotHeld);
        assert.strictEqual(yield* slots.heldFor(codex), 1);
        assert.isFalse(
          (yield* commands).some(drivesTurn),
          "no turn is driven into a thread that is already mid-turn",
        );
      }),
  ),
);

it.effect("boot: an errored session with the ladder spent still stalls and frees its slot", () =>
  withGovernor(
    {
      board: boardWithStep(runningStep({ attempt: 3, maxAttempts: 3, stallCount: 3 })),
      settings: settingsWith({ building: [codexStep], globalMaxConcurrent: 3 }),
      initialShells: shells(failedThreadShell(String(threadId))),
    },
    ({ board, slots, commands, reactor }) =>
      Effect.gen(function* () {
        yield* reactor.drain;
        const state = boardCardStepState(yield* board, cardId);
        assert.strictEqual(state?.status, "stalled");
        assert.isFalse(state?.slotHeld);
        assert.strictEqual(yield* slots.heldFor(codex), 0);
        // Escalation parks the step for a human; it never drives the agent.
        assert.isFalse((yield* commands).some(drivesTurn));
      }),
  ),
);
