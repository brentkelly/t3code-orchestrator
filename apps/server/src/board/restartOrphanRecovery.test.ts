/**
 * A server restart mid-build leaves a card claiming work nobody is doing
 * (t3o-10). Upstream's `reconcileProviderSessions` marks the orphaned session
 * `error` — the `Failed` the thread list shows — while the killed turn's id
 * lingers on the projection, so the board's boot reconcile used to read the
 * corpse as mid-turn and resume-watch it forever: the step held its
 * concurrency slot and its card pulsed blue for as long as the server stayed
 * up.
 *
 * Driven through the shared governor harness rather than the command-level
 * reactor stubs, because what matters here is the STATE the reconcile leaves:
 * the attempt burned, the slot kept, the step eventually stalled.
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
  threadId,
  status: "running",
  slotHeld: true,
  forceStart: false,
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

const shells = (shell: OrchestrationThreadShell) => new Map([[String(threadId), shell]]);

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

it.effect("boot: a STALE activeTurnId does not keep an errored session alive", () =>
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
        const state = boardCardStepState(yield* board, cardId);
        assert.strictEqual(state?.attempt, 2);
        assert.strictEqual(state?.status, "running");
        // An ordinary retry keeps its place in the queue (t3o-17, D13), so the
        // slot the restart orphaned is restored and still held.
        assert.isTrue(state?.slotHeld);
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
          (yield* commands).some((command) => command.type === "thread.turn.start"),
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
        assert.isFalse((yield* commands).some((command) => command.type === "thread.turn.start"));
      }),
  ),
);
