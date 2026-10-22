/**
 * T3o (T3O-66, D22) — the supervisor and a worker it can't reach.
 *
 * An offline worker is unknown, not dead: its steps keep their state and their
 * slots, nothing times them out, and no signal from it is acted on until it is
 * back and the boot reconcile, scoped to it, has run. Driven against the
 * stateful engine double with a placement whose worker summary each test flips
 * between online and offline; the thread gateway is the fake, so "is the thread
 * alive" is whatever the test sets. `it.effect` runs on the TestClock, whose
 * "now" starts at the epoch.
 */
import {
  BOARD_LOCAL_WORKER_ID,
  BoardCardId,
  boardCardStepState,
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type BoardCard,
  type BoardCardStepState,
  type BoardState,
  type BoardWorkersState,
  type BoardWorkerView,
} from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import {
  boardTurnStartRequested,
  codexStep,
  makeBoardCard,
  readyWorktree,
  settingsWith,
  turnCompleted,
  userInputRequested,
  withGovernor,
  type Harness,
} from "./supervisorHarness.testkit.ts";
import {
  ThreadCommandFailedError,
  ThreadReadError,
  UNKNOWN_THREAD_STATE,
  type LocalThreadGatewayShape,
  type ThreadGatewayShape,
} from "./ThreadGateway.ts";
import { aliveThread, idleThread } from "./threadGateway.testkit.ts";
import type { BoardPlacementShape } from "./workers/BoardPlacement.ts";
import { CardFilesNotStaged } from "./workers/RemoteThreadGateway.ts";
import { WorkerUnavailable } from "./workers/WorkerConnections.ts";
import { WorkerRpcError } from "./workers/WorkerTransport.ts";

const W1 = EnvironmentId.make("env-w1");
const codex = ProviderInstanceId.make("codex");
const cardId = BoardCardId.make("card-1");
const threadId = ThreadId.make("thread-w1");
/** Five minutes before the epoch: under a ten-minute timeout, a step started
    then is not yet overdue at the epoch. */
const STARTED = "1969-12-31T23:55:00.000Z";
const TIMEOUT_MS = 10 * 60_000;

const workerView = (online: boolean): BoardWorkerView => ({
  id: W1,
  label: "w1",
  url: "http://env-w1:3773",
  addedAt: "2026-01-01T00:00:00.000Z",
  status: {
    state: online ? "online" : "offline",
    lastSeenAt: null,
    t3oVersion: "0.1.0",
    protocolVersion: 1,
  },
  snapshot: {
    providers: [
      { instanceId: codex, driver: "codex", displayName: null, enabled: true, models: [] },
    ],
    checkouts: [
      {
        projectId: ProjectId.make("env-w1-project"),
        title: "repo",
        workspaceRoot: "/home/env-w1/repo",
        repositoryKey: "github.com/acme/repo",
      },
    ],
    projectsFolder: null,
    reportedAt: "2026-01-01T00:00:00.000Z",
  },
});

const workersState = (online: boolean): BoardWorkersState => ({
  defaultWorkerId: BOARD_LOCAL_WORKER_ID,
  workers: [workerView(online)],
  setups: [],
});

/** The worker summary a test flips, and the supervisor's view of its changes. */
interface WorkersFeed {
  /** Publish summaries back to back; resolves once the supervisor has taken
      in every one. */
  readonly set: (...states: ReadonlyArray<BoardWorkersState>) => Effect.Effect<void>;
}

/**
 * A placement whose single worker each test takes offline and back. Its change
 * feed hands the supervisor one summary per pull, and a pull after the first
 * means the summary before it was handled — the milestone `set` waits on, so
 * no test depends on how its fibers happen to be scheduled.
 */
const makePlacement = (online: boolean) =>
  Effect.gen(function* () {
    const current = yield* Ref.make(workersState(online));
    const inbox = yield* Queue.unbounded<BoardWorkersState>();
    const taken = yield* Queue.unbounded<void>();
    const pulled = yield* Ref.make(false);
    const ref: WorkersFeed = {
      set: (...states) =>
        Effect.forEach(states, (state) =>
          Ref.set(current, state).pipe(Effect.andThen(Queue.offer(inbox, state))),
        ).pipe(Effect.andThen(Effect.forEach(states, () => Queue.take(taken)))),
    };
    return {
      ref,
      placement: {
        workers: Ref.get(current),
        changes: Stream.fromEffectRepeat(
          Ref.getAndSet(pulled, true).pipe(
            Effect.flatMap((again) => (again ? Queue.offer(taken, undefined) : Effect.void)),
            Effect.andThen(Queue.take(inbox)),
          ),
        ),
      } satisfies BoardPlacementShape,
    };
  });

const registered = [
  { id: W1, label: "w1", url: "http://env-w1:3773", addedAt: "2026-01-01T00:00:00.000Z" },
];

/** A card in Building placed on W1, its step's thread living there. */
const placedCard = (): BoardCard => ({
  ...makeBoardCard({
    id: "card-1",
    stage: "building",
    orderKey: "m",
    worktree: readyWorktree("card-1"),
    placedWorkerId: W1,
  }),
  threadLinks: [
    {
      threadId,
      role: "building",
      linkedAt: "1969-12-31T23:55:00.000Z",
      tombstonedAt: null,
      workerId: W1,
    },
  ],
});

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
  awaitingReason: "question",
  stalledReason: "gave-up",
  retryAt: null,
  prompt: "build it",
  providerInstanceId: codex,
  model: "gpt-5-codex",
  mode: "build",
  runtimeMode: "auto",
  humanInLoop: false,
  maxAttempts: 3,
  timeoutMs: TIMEOUT_MS,
  threadId,
  status: "running",
  slotHeld: true,
  forceStart: false,
  queuedBy: null,
  startedAt: STARTED,
  updatedAt: STARTED,
  ...overrides,
});

const board = (step: BoardCardStepState = runningStep()): BoardState => ({
  cards: [placedCard()],
  stepStates: [step],
  nextCardNumberByProject: {},
  workers: registered,
});

const aliveShells = () => new Map([[String(threadId), aliveThread(String(threadId))]]);

/** Flip the worker and let the supervisor process the change. */
const setOnline = (h: Harness, ref: WorkersFeed, online: boolean) =>
  ref.set(workersState(online)).pipe(Effect.andThen(h.reactor.drain));

/** Move the clock on, and let the sweeps it fires finish. */
const advance = (h: Harness, minutes: number) =>
  TestClock.adjust(`${minutes} minutes`).pipe(
    Effect.andThen(Effect.yieldNow),
    Effect.andThen(h.reactor.drain),
  );

const step = (h: Harness) => Effect.map(h.board, (state) => boardCardStepState(state, cardId));

const spawns = (h: Harness) =>
  Effect.map(
    h.commands,
    (commands) => commands.filter((command) => command.type === "thread.spawn").length,
  );

/** Recoveries — a nudge, or the backoff rung this harness's ladder starts on. */
const recoveries = (h: Harness) =>
  Effect.map(
    h.commands,
    (commands) =>
      commands.filter(
        (command) =>
          command.type === "board.card.recover-step" && command.stalledReason !== "worker-removed",
      ).length,
  );

/** Put a card into the model as the projection would, before its event. */
const setCard = (h: Harness, card: BoardCard) =>
  Ref.update(h.model, (model) => ({
    ...model,
    board: {
      ...model.board!,
      cards: model.board!.cards.map((candidate) => (candidate.id === card.id ? card : candidate)),
    },
  }));

const moveRecorded = (card: BoardCard, step: unknown, sequence: number) =>
  ({
    type: "board.card-worker-move-recorded",
    sequence,
    payload: { cardId: card.id, step, move: card.workerMove, card },
  }) as never;

const settings = settingsWith({ building: [codexStep], globalMaxConcurrent: 3 });

it.effect("a worker going offline mid-step pauses it: no timeout, no recovery, slot held", () =>
  Effect.gen(function* () {
    const { ref, placement } = yield* makePlacement(true);
    yield* withGovernor(
      { board: board(), settings, placement, initialShells: aliveShells() },
      (h) =>
        Effect.gen(function* () {
          yield* h.reactor.drain;
          assert.strictEqual(yield* h.slots.heldOnWorker(W1), 1);
          yield* setOnline(h, ref, false);
          // Far past the timeout, and the thread even reads as dead.
          yield* Ref.set(h.shells, new Map([[String(threadId), idleThread(String(threadId))]]));
          yield* advance(h, 30);
          yield* h.reactor.sweep;
          // A turn ending on the worker arrives with nobody able to act on it.
          yield* h.pumpRuntime(turnCompleted(threadId, "turn-live"));
          const paused = yield* step(h);
          assert.strictEqual(paused?.status, "running");
          assert.strictEqual(paused?.attempt, 1);
          assert.strictEqual(yield* recoveries(h), 0);
          assert.strictEqual(yield* h.slots.heldOnWorker(W1), 1);
        }),
    );
  }),
);

it.effect("back online with the thread live: no new thread, and the offline time isn't timed", () =>
  Effect.gen(function* () {
    const { ref, placement } = yield* makePlacement(true);
    yield* withGovernor(
      { board: board(), settings, placement, initialShells: aliveShells() },
      (h) =>
        Effect.gen(function* () {
          yield* h.reactor.drain;
          // Started 5 minutes before the epoch with a 10-minute timeout.
          yield* advance(h, 3);
          yield* setOnline(h, ref, false);
          yield* advance(h, 10);
          yield* setOnline(h, ref, true);
          // Now 18 minutes after the start, 10 of them offline: 8 count.
          yield* h.reactor.sweep;
          assert.strictEqual((yield* step(h))?.attempt, 1);
          assert.strictEqual(yield* recoveries(h), 0);
          assert.strictEqual(yield* spawns(h), 0);
          assert.strictEqual((yield* step(h))?.threadId, threadId);
          assert.strictEqual(yield* h.slots.heldOnWorker(W1), 1);
          // Three minutes on, 11 count: the shifted reference is now overdue.
          yield* advance(h, 3);
          yield* h.reactor.sweep;
          assert.strictEqual((yield* step(h))?.attempt, 2);
          assert.strictEqual(yield* spawns(h), 0);
        }),
    );
  }),
);

it.effect("back online after the thread died offline: recovered once, as the boot path does", () =>
  Effect.gen(function* () {
    const { ref, placement } = yield* makePlacement(true);
    yield* withGovernor(
      { board: board(), settings, placement, initialShells: aliveShells() },
      (h) =>
        Effect.gen(function* () {
          yield* h.reactor.drain;
          yield* setOnline(h, ref, false);
          // The turn ended on the worker while it was out of reach; its signal
          // is held, and the thread now reads as idle.
          yield* Ref.set(h.shells, new Map([[String(threadId), idleThread(String(threadId))]]));
          yield* h.pumpRuntime(turnCompleted(threadId, "turn-live"));
          assert.strictEqual(yield* recoveries(h), 0);
          yield* setOnline(h, ref, true);
          // Reconcile recovered it, and the held turn-end it already accounted
          // for is not handled a second time.
          assert.strictEqual(yield* recoveries(h), 1);
          assert.strictEqual((yield* step(h))?.attempt, 2);
          assert.strictEqual(yield* spawns(h), 0);
        }),
    );
  }),
);

it.effect("a drop and reconnect both landing before the supervisor looks is still reconciled", () =>
  Effect.gen(function* () {
    const { ref, placement } = yield* makePlacement(true);
    yield* withGovernor(
      { board: board(), settings, placement, initialShells: aliveShells() },
      (h) =>
        Effect.gen(function* () {
          yield* h.reactor.drain;
          // Out and back with nothing processed between: the thread died in
          // the gap, and the summary already reads online again.
          yield* Ref.set(h.shells, new Map([[String(threadId), idleThread(String(threadId))]]));
          yield* ref.set(workersState(false), workersState(true));
          yield* h.reactor.drain;
          assert.strictEqual(yield* recoveries(h), 1);
          assert.strictEqual((yield* step(h))?.attempt, 2);
          assert.strictEqual(yield* spawns(h), 0);
        }),
    );
  }),
);

it.effect("a reconcile that fails partway still drops the held signals it already decided", () =>
  Effect.gen(function* () {
    const { ref, placement } = yield* makePlacement(true);
    const otherCardId = BoardCardId.make("card-2");
    const otherThreadId = ThreadId.make("thread-w1-other");
    const otherCard: BoardCard = {
      ...placedCard(),
      ...makeBoardCard({
        id: "card-2",
        stage: "building",
        orderKey: "n",
        worktree: readyWorktree("card-2"),
        placedWorkerId: W1,
      }),
      threadLinks: [{ ...placedCard().threadLinks[0]!, threadId: otherThreadId }],
    };
    /** The other card's thread can't be read once: the worker went again. */
    const failOtherRead = yield* Ref.make(false);
    yield* withGovernor(
      {
        board: {
          ...board(),
          cards: [placedCard(), otherCard],
          stepStates: [
            runningStep(),
            runningStep({ cardId: otherCardId, threadId: otherThreadId }),
          ],
        },
        settings,
        placement,
        initialShells: new Map([
          [String(threadId), aliveThread(String(threadId))],
          [String(otherThreadId), aliveThread(String(otherThreadId))],
        ]),
        gateway: (local) => ({
          ...local,
          threadState: (id) =>
            id === otherThreadId
              ? Ref.getAndSet(failOtherRead, false).pipe(
                  Effect.flatMap((fail) =>
                    fail
                      ? Effect.fail(
                          new ThreadReadError({ operation: "threadState", detail: "gone" }),
                        )
                      : local.threadState(id),
                  ),
                )
              : local.threadState(id),
        }),
      },
      (h) =>
        Effect.gen(function* () {
          yield* h.reactor.drain;
          yield* setOnline(h, ref, false);
          // While out of reach the board's last turn started and the thread
          // then died; both signals are held.
          yield* h.pumpRuntime(boardTurnStartRequested(threadId));
          yield* Ref.update(h.shells, (shells) =>
            new Map(shells).set(String(threadId), idleThread(String(threadId))),
          );
          yield* h.pumpRuntime(turnCompleted(threadId, "turn-live"));
          yield* Ref.set(failOtherRead, true);
          yield* setOnline(h, ref, true);
          // The dead step was recovered onto its backoff rung; the other
          // couldn't be read, so the worker is not reconciled yet.
          assert.strictEqual(yield* recoveries(h), 1);
          assert.strictEqual((yield* step(h))?.status, "stalled");
          yield* setOnline(h, ref, true);
          // The held turn start predates that recovery: it doesn't wake the
          // step off its rung, and nothing is recovered twice.
          assert.strictEqual((yield* step(h))?.status, "stalled");
          assert.strictEqual(yield* recoveries(h), 1);
          assert.strictEqual((yield* step(h))?.attempt, 2);
          assert.strictEqual(yield* spawns(h), 0);
        }),
    );
  }),
);

it.effect("back online after the step completed offline: it advances, once", () =>
  Effect.gen(function* () {
    const { ref, placement } = yield* makePlacement(true);
    yield* withGovernor(
      { board: board(), settings, placement, initialShells: aliveShells() },
      (h) =>
        Effect.gen(function* () {
          yield* h.reactor.drain;
          yield* setOnline(h, ref, false);
          // The agent's completion reached the board; its turn-end didn't.
          yield* Ref.update(h.model, (model) => ({
            ...model,
            board: {
              ...model.board!,
              stepCompletions: [
                {
                  cardId,
                  stepId: "building",
                  outcome: "succeeded" as const,
                  summary: "done",
                  payload: null,
                  threadId,
                  completedAt: "1970-01-01T00:00:00.000Z",
                },
              ],
            },
          }));
          yield* Ref.set(h.shells, new Map([[String(threadId), idleThread(String(threadId))]]));
          yield* h.pumpRuntime(turnCompleted(threadId, "turn-live"));
          assert.strictEqual((yield* step(h))?.status, "running");
          yield* setOnline(h, ref, true);
          // Settled once and on to Code review — whose step runs on W1 too —
          // with nothing recovered.
          const settles = (yield* h.commands).filter(
            (command) => command.type === "board.card.settle-step",
          );
          assert.strictEqual(settles.length, 1);
          assert.strictEqual((yield* step(h))?.stepId, "review@1");
          assert.strictEqual(yield* recoveries(h), 0);
          assert.strictEqual(yield* h.slots.heldOnWorker(W1), 1);
        }),
    );
  }),
);

it.effect(
  "a step on a worker that is offline at boot is held, with its slot, until it is back",
  () =>
    Effect.gen(function* () {
      const { ref, placement } = yield* makePlacement(false);
      yield* withGovernor(
        {
          board: board(),
          settings,
          placement,
          initialShells: new Map([[String(threadId), idleThread(String(threadId))]]),
        },
        (h) =>
          Effect.gen(function* () {
            yield* h.reactor.drain;
            // Boot found a dead-looking thread on a worker it can't reach.
            assert.strictEqual((yield* step(h))?.status, "running");
            assert.strictEqual(yield* recoveries(h), 0);
            assert.strictEqual(yield* h.slots.heldOnWorker(W1), 1);
            yield* setOnline(h, ref, true);
            // Recovered once, exactly as a boot with the worker online would.
            assert.strictEqual(yield* recoveries(h), 1);
            assert.strictEqual((yield* step(h))?.attempt, 2);
          }),
      );
    }),
);

it.effect("nothing new starts on an offline worker", () =>
  Effect.gen(function* () {
    const { ref, placement } = yield* makePlacement(false);
    const pending = runningStep({
      status: "pending",
      threadId: null,
      slotHeld: false,
      startedAt: null,
    });
    yield* withGovernor(
      {
        board: { ...board(pending), cards: [{ ...placedCard(), threadLinks: [] }] },
        settings,
        placement,
      },
      (h) =>
        Effect.gen(function* () {
          yield* h.reactor.drain;
          assert.strictEqual(yield* spawns(h), 0);
          // Held as queued for its worker, so the card can say why.
          assert.strictEqual((yield* step(h))?.status, "queued");
          assert.strictEqual((yield* step(h))?.queuedBy, "worker-offline");
          yield* setOnline(h, ref, true);
          assert.strictEqual(yield* spawns(h), 1);
          assert.strictEqual((yield* step(h))?.status, "running");
        }),
    );
  }),
);

it.effect("removing the worker stalls its running step and frees the slot", () =>
  Effect.gen(function* () {
    const { placement } = yield* makePlacement(true);
    yield* withGovernor(
      { board: board(), settings, placement, initialShells: aliveShells() },
      (h) =>
        Effect.gen(function* () {
          yield* h.reactor.drain;
          assert.strictEqual(yield* h.slots.heldOnWorker(W1), 1);
          // The removal held the card, its worktree there.
          yield* setCard(h, {
            ...placedCard(),
            placementOrphaned: { workerId: W1, workerLabel: "w1", orphanedAt: STARTED },
          });
          yield* h.pumpDomain({
            type: "board.worker-removed",
            sequence: 2,
            payload: { workerId: W1 },
          } as never);
          const stalled = yield* step(h);
          assert.strictEqual(stalled?.status, "stalled");
          assert.strictEqual(stalled?.stalledReason, "worker-removed");
          assert.strictEqual(yield* h.slots.heldOnWorker(W1), 0);
          // Spends no recovery budget.
          assert.strictEqual(stalled?.attempt, 1);
        }),
    );
  }),
);

it.effect("removing the worker restarts a fallback card's parked step on the default", () =>
  Effect.gen(function* () {
    const { placement } = yield* makePlacement(true);
    // Pinned to W1 with no worktree yet, its agent waiting on a question there.
    const pinned: BoardCard = {
      ...placedCard(),
      worktree: null,
      placedWorkerId: null,
      pinnedWorkerId: W1,
    };
    const parked = runningStep({ status: "awaiting-input", slotHeld: false });
    yield* withGovernor(
      {
        board: { ...board(parked), cards: [pinned] },
        settings,
        placement,
        initialShells: new Map([
          [String(threadId), aliveThread(String(threadId), { awaitingUserInput: true })],
        ]),
      },
      (h) =>
        Effect.gen(function* () {
          yield* h.reactor.drain;
          assert.strictEqual((yield* step(h))?.status, "awaiting-input");
          // The removal fell the card back to the default worker.
          yield* setCard(h, { ...pinned, pinnedWorkerId: null });
          yield* h.pumpDomain({
            type: "board.worker-removed",
            sequence: 2,
            payload: { workerId: W1 },
          } as never);
          const stalls = (yield* h.commands).filter(
            (command) =>
              command.type === "board.card.recover-step" &&
              command.stalledReason === "worker-removed",
          );
          assert.strictEqual(stalls.length, 1);
          // Requeued, and started afresh here rather than left on W1's thread.
          const restarted = yield* step(h);
          assert.notStrictEqual(restarted?.status, "awaiting-input");
          assert.notStrictEqual(restarted?.status, "stalled");
          assert.notStrictEqual(restarted?.threadId, threadId);
        }),
    );
  }),
);

it.effect(
  "a signal held while offline, that reconcile didn't decide on, is released after it",
  () =>
    Effect.gen(function* () {
      const { ref, placement } = yield* makePlacement(true);
      yield* withGovernor(
        { board: board(), settings, placement, initialShells: aliveShells() },
        (h) =>
          Effect.gen(function* () {
            yield* h.reactor.drain;
            yield* setOnline(h, ref, false);
            // The agent asked a question while the board couldn't see it.
            yield* Ref.set(
              h.shells,
              new Map([
                [String(threadId), aliveThread(String(threadId), { awaitingUserInput: true })],
              ]),
            );
            yield* h.pumpRuntime(userInputRequested(threadId));
            assert.strictEqual((yield* step(h))?.status, "running");
            yield* setOnline(h, ref, true);
            // Still alive, so reconcile watched it; the held question then parked it.
            const parked = yield* step(h);
            assert.strictEqual(parked?.status, "awaiting-input");
            assert.strictEqual(yield* spawns(h), 0);
          }),
      );
    }),
);

/** The card as a removal left it, holding on W1 with its step stalled there. */
const stalledByRemoval = (): BoardCardStepState =>
  runningStep({ status: "stalled", stalledReason: "worker-removed", slotHeld: false });

it.effect("re-adding a removed worker resumes the step its removal stalled, on its thread", () =>
  Effect.gen(function* () {
    const { placement } = yield* makePlacement(true);
    yield* withGovernor(
      {
        board: board(stalledByRemoval()),
        settings,
        placement,
        initialShells: new Map([[String(threadId), idleThread(String(threadId))]]),
      },
      (h) =>
        Effect.gen(function* () {
          yield* h.reactor.drain;
          yield* h.pumpDomain({
            type: "board.card-worker-removal",
            sequence: 2,
            payload: {
              cardId,
              workerId: W1,
              workerLabel: "w1",
              outcome: "reattached",
              card: placedCard(),
            },
          } as never);
          const resumed = yield* step(h);
          assert.strictEqual(resumed?.status, "running");
          // Its own thread, still on W1: nothing respawned.
          assert.strictEqual(resumed?.threadId, threadId);
          assert.strictEqual(yield* spawns(h), 0);
          const sends = (yield* h.commands).filter((command) => command.type === "thread.send");
          assert.strictEqual(sends.length, 1);
          assert.strictEqual(yield* h.slots.heldOnWorker(W1), 1);
        }),
    );
  }),
);

it.effect("a step still held by its worker's removal is not resumed", () =>
  Effect.gen(function* () {
    const { placement } = yield* makePlacement(true);
    yield* withGovernor(
      {
        board: {
          ...board(stalledByRemoval()),
          cards: [
            {
              ...placedCard(),
              placementOrphaned: { workerId: W1, workerLabel: "w1", orphanedAt: STARTED },
            },
          ],
        },
        settings,
        placement,
      },
      (h) =>
        Effect.gen(function* () {
          yield* h.reactor.drain;
          yield* h.reactor.sweep;
          assert.strictEqual((yield* step(h))?.status, "stalled");
          assert.strictEqual(yield* spawns(h), 0);
        }),
    );
  }),
);

it.effect("a force-move strands the step on the offline worker, then runs it where it lands", () =>
  Effect.gen(function* () {
    const { placement } = yield* makePlacement(false);
    yield* withGovernor(
      {
        board: board(),
        settings,
        placement,
        initialShells: aliveShells(),
        // W1 is offline: as the remote gateway does, its thread reads unknown.
        gateway: (local) => ({
          ...local,
          threadState: (id) =>
            id === threadId ? Effect.succeed(UNKNOWN_THREAD_STATE) : local.threadState(id),
        }),
      },
      (h) =>
        Effect.gen(function* () {
          yield* h.reactor.drain;
          assert.strictEqual(yield* h.slots.heldOnWorker(W1), 1);
          // The human force-moved it to this server; the move has started.
          const moving: BoardCard = {
            ...placedCard(),
            workerMove: {
              fromWorkerId: W1,
              toWorkerId: BOARD_LOCAL_WORKER_ID,
              status: "moving",
              sha: "4e1a9c2",
              error: null,
              startedAt: "1970-01-01T00:00:00.000Z",
            },
          };
          yield* setCard(h, moving);
          yield* h.pumpDomain(
            moveRecorded(
              moving,
              { phase: "start", toWorkerId: BOARD_LOCAL_WORKER_ID, sha: "4e1a9c2", force: true },
              2,
            ),
          );
          const stranded = yield* step(h);
          assert.strictEqual(stranded?.status, "stalled");
          assert.strictEqual(stranded?.stalledReason, "worker-removed");
          assert.strictEqual(yield* h.slots.heldOnWorker(W1), 0);
          // It lands: a worktree here, from the pushed branch.
          const landed: BoardCard = {
            ...placedCard(),
            pinnedWorkerId: BOARD_LOCAL_WORKER_ID,
            placedWorkerId: BOARD_LOCAL_WORKER_ID,
            worktree: { ...readyWorktree("card-1"), path: "/tmp/worktrees/card-1-here" },
          };
          yield* setCard(h, landed);
          yield* h.pumpDomain(
            moveRecorded(landed, { phase: "done", worktreePath: "/tmp/worktrees/card-1-here" }, 3),
          );
          // A fresh thread here; the old one stays linked, on W1.
          const spawned = (yield* h.commands).filter((command) => command.type === "thread.spawn");
          assert.strictEqual(spawned.length, 1);
          assert.strictEqual(
            spawned[0]?.type === "thread.spawn" ? spawned[0].workerId : "?",
            undefined,
          );
          const running = yield* step(h);
          assert.strictEqual(running?.status, "running");
          assert.notStrictEqual(running?.threadId, threadId);
          assert.strictEqual(yield* h.slots.heldOnWorker(BOARD_LOCAL_WORKER_ID), 1);
        }),
    );
  }),
);

it.effect("a force-move off an offline worker takes a parked step with it", () =>
  Effect.gen(function* () {
    const { placement } = yield* makePlacement(false);
    // Parked on a usage limit, on W1's thread.
    const parked = runningStep({
      status: "stalled",
      stalledReason: "usage-limit",
      slotHeld: false,
    });
    yield* withGovernor(
      {
        board: board(parked),
        settings,
        placement,
        initialShells: new Map([[String(threadId), idleThread(String(threadId))]]),
        gateway: (local) => ({
          ...local,
          threadState: (id) =>
            id === threadId ? Effect.succeed(UNKNOWN_THREAD_STATE) : local.threadState(id),
        }),
      },
      (h) =>
        Effect.gen(function* () {
          yield* h.reactor.drain;
          const moving: BoardCard = {
            ...placedCard(),
            workerMove: {
              fromWorkerId: W1,
              toWorkerId: BOARD_LOCAL_WORKER_ID,
              status: "moving",
              sha: "4e1a9c2",
              error: null,
              startedAt: "1970-01-01T00:00:00.000Z",
            },
          };
          yield* setCard(h, moving);
          yield* h.pumpDomain(
            moveRecorded(
              moving,
              { phase: "start", toWorkerId: BOARD_LOCAL_WORKER_ID, sha: "4e1a9c2", force: true },
              2,
            ),
          );
          const stranded = yield* step(h);
          assert.strictEqual(stranded?.status, "stalled");
          assert.strictEqual(stranded?.stalledReason, "worker-removed");
          const landed: BoardCard = {
            ...placedCard(),
            pinnedWorkerId: BOARD_LOCAL_WORKER_ID,
            placedWorkerId: BOARD_LOCAL_WORKER_ID,
            worktree: { ...readyWorktree("card-1"), path: "/tmp/worktrees/card-1-here" },
          };
          yield* setCard(h, landed);
          yield* h.pumpDomain(
            moveRecorded(landed, { phase: "done", worktreePath: "/tmp/worktrees/card-1-here" }, 3),
          );
          // A fresh thread where it landed.
          assert.strictEqual(yield* spawns(h), 1);
          const running = yield* step(h);
          assert.strictEqual(running?.status, "running");
          assert.notStrictEqual(running?.threadId, threadId);
        }),
    );
  }),
);

/** A step about to start on W1, with no thread yet. */
const pendingStep = () =>
  runningStep({ status: "pending", threadId: null, slotHeld: false, startedAt: null });
const unlinkedCard = (): BoardCard => ({ ...placedCard(), threadLinks: [] });

it.effect("a spawn whose connection drops after the worker took it is run, not stalled", () =>
  Effect.gen(function* () {
    const { ref, placement } = yield* makePlacement(true);
    yield* withGovernor(
      {
        board: { ...board(pendingStep()), cards: [unlinkedCard()] },
        settings,
        placement,
        // The worker created the thread; the answer never came back.
        gateway: (local) => ({
          ...local,
          spawn: (input) =>
            local.spawn(input).pipe(
              Effect.andThen(
                Effect.fail(
                  new ThreadCommandFailedError({
                    command: "spawn",
                    threadId: input.threadId,
                    detail: "The connection to the worker went.",
                    cause: new WorkerRpcError({ message: "The connection to the worker went." }),
                  }),
                ),
              ),
            ),
        }),
      },
      (h) =>
        Effect.gen(function* () {
          yield* h.reactor.drain;
          const started = yield* step(h);
          assert.strictEqual(started?.status, "running");
          assert.isNotNull(started?.threadId ?? null);
          // Linked on W1, so the worker's reconcile can find it.
          const card = (yield* h.board).cards.find((candidate) => candidate.id === cardId);
          assert.deepStrictEqual(
            card?.threadLinks.map((link) => [link.threadId, link.workerId]),
            [[started?.threadId, W1]],
          );
          assert.strictEqual(yield* h.slots.heldOnWorker(W1), 1);
          // The worker comes back with the thread working: watched, not respawned.
          yield* setOnline(h, ref, false);
          yield* Ref.set(
            h.shells,
            new Map([[String(started!.threadId), aliveThread(String(started!.threadId))]]),
          );
          yield* setOnline(h, ref, true);
          assert.strictEqual(yield* spawns(h), 1);
          assert.strictEqual(yield* recoveries(h), 0);
          assert.strictEqual((yield* step(h))?.threadId, started?.threadId);
        }),
    );
  }),
);

/** A spawn that fails on W1 with `cause` and never reaches the worker. */
const failedSpawnBoard = (cause: unknown) =>
  Effect.map(makePlacement(true), ({ placement }) => ({
    board: { ...board(pendingStep()), cards: [unlinkedCard()] },
    settings,
    placement,
    gateway: (local: LocalThreadGatewayShape): ThreadGatewayShape => ({
      ...local,
      spawn: (input) =>
        Effect.fail(
          new ThreadCommandFailedError({
            command: "spawn",
            threadId: input.threadId,
            detail: "failed",
            cause,
          }),
        ),
    }),
  }));

for (const [name, cause] of [
  [
    "a worker without the spawn call",
    new WorkerRpcError({ message: "unsupported", unsupported: true }),
  ],
  [
    "a spawn whose card files never reached the worker",
    new CardFilesNotStaged({ cause: new WorkerRpcError({ message: "gone" }) }),
  ],
] as const) {
  it.effect(`${name} leaves no thread: the step stalls, nothing is linked`, () =>
    Effect.gen(function* () {
      yield* withGovernor(yield* failedSpawnBoard(cause), (h) =>
        Effect.gen(function* () {
          yield* h.reactor.drain;
          const stalled = yield* step(h);
          assert.strictEqual(stalled?.status, "stalled");
          assert.isNull(stalled?.threadId ?? null);
          const card = (yield* h.board).cards.find((candidate) => candidate.id === cardId);
          assert.deepStrictEqual(card?.threadLinks, []);
          assert.strictEqual(yield* h.slots.heldOnWorker(W1), 0);
        }),
      );
    }),
  );
}

it.effect("a worker unreachable at spawn holds the step for it and frees the slot", () =>
  Effect.gen(function* () {
    const { ref, placement } = yield* makePlacement(true);
    const reachable = yield* Ref.make(false);
    yield* withGovernor(
      {
        board: { ...board(pendingStep()), cards: [unlinkedCard()] },
        settings,
        placement,
        // The summary still says online; the link is already gone.
        gateway: (local) => ({
          ...local,
          spawn: (input) =>
            Effect.flatMap(Ref.get(reachable), (up) =>
              up
                ? local.spawn(input)
                : Effect.fail(
                    new ThreadCommandFailedError({
                      command: "spawn",
                      threadId: input.threadId,
                      detail: "Worker env-w1 is offline.",
                      cause: new WorkerUnavailable({
                        workerId: W1,
                        state: "offline",
                        message: "Worker env-w1 is offline.",
                      }),
                    }),
                  ),
            ),
        }),
      },
      (h) =>
        Effect.gen(function* () {
          yield* h.reactor.drain;
          const held = yield* step(h);
          assert.strictEqual(held?.status, "queued");
          assert.strictEqual(held?.queuedBy, "worker-offline");
          assert.strictEqual(yield* h.slots.heldOnWorker(W1), 0);
          assert.strictEqual(yield* spawns(h), 0);
          // Back: it starts.
          yield* Ref.set(reachable, true);
          yield* setOnline(h, ref, false);
          yield* setOnline(h, ref, true);
          assert.strictEqual(yield* spawns(h), 1);
          assert.strictEqual((yield* step(h))?.status, "running");
          assert.strictEqual(yield* h.slots.heldOnWorker(W1), 1);
        }),
    );
  }),
);

it.effect("a worker dropping between the gate and the read of a step's thread leaks no slot", () =>
  Effect.gen(function* () {
    const { placement } = yield* makePlacement(true);
    // Resumed through the queue, on the thread it already owns on W1.
    const queued = runningStep({ status: "queued", slotHeld: false, queuedBy: "worker" });
    yield* withGovernor(
      {
        board: board(queued),
        settings,
        placement,
        gateway: (local) => ({
          ...local,
          threadState: (id) =>
            id === threadId ? Effect.succeed(UNKNOWN_THREAD_STATE) : local.threadState(id),
        }),
      },
      (h) =>
        Effect.gen(function* () {
          yield* h.reactor.drain;
          assert.strictEqual((yield* step(h))?.status, "queued");
          assert.strictEqual(yield* h.slots.heldOnWorker(W1), 0);
        }),
    );
  }),
);
