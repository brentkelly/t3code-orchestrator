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
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import * as TestClock from "effect/testing/TestClock";

import {
  codexStep,
  makeBoardCard,
  readyWorktree,
  settingsWith,
  turnCompleted,
  userInputRequested,
  withGovernor,
  type Harness,
} from "./supervisorHarness.testkit.ts";
import { aliveThread, idleThread } from "./threadGateway.testkit.ts";
import type { BoardPlacementShape } from "./workers/BoardPlacement.ts";

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

/** A placement whose single worker each test takes offline and back. */
const makePlacement = (online: boolean) =>
  Effect.map(SubscriptionRef.make(workersState(online)), (ref) => ({
    ref,
    placement: {
      workers: SubscriptionRef.get(ref),
      changes: SubscriptionRef.changes(ref).pipe(
        Stream.drop(1),
        Stream.map(() => undefined),
      ),
    } satisfies BoardPlacementShape,
  }));

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
const setOnline = (
  h: Harness,
  ref: SubscriptionRef.SubscriptionRef<BoardWorkersState>,
  online: boolean,
) =>
  SubscriptionRef.set(ref, workersState(online)).pipe(
    Effect.andThen(Effect.yieldNow),
    Effect.andThen(Effect.yieldNow),
    Effect.andThen(h.reactor.drain),
  );

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

it.effect("a step on a worker that is offline at boot is held, with its slot, until it is back", () =>
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

it.effect("a signal held while offline, that reconcile didn't decide on, is released after it", () =>
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
      { board: board(), settings, placement, initialShells: aliveShells() },
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
          yield* h.pumpDomain(moveRecorded(moving, { phase: "start", toWorkerId: BOARD_LOCAL_WORKER_ID, sha: "4e1a9c2", force: true }, 2));
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
          yield* h.pumpDomain(moveRecorded(landed, { phase: "done", worktreePath: "/tmp/worktrees/card-1-here" }, 3));
          // A fresh thread here; the old one stays linked, on W1.
          const spawned = (yield* h.commands).filter((command) => command.type === "thread.spawn");
          assert.strictEqual(spawned.length, 1);
          assert.strictEqual(spawned[0]?.type === "thread.spawn" ? spawned[0].workerId : "?", undefined);
          const running = yield* step(h);
          assert.strictEqual(running?.status, "running");
          assert.notStrictEqual(running?.threadId, threadId);
          assert.strictEqual(yield* h.slots.heldOnWorker(BOARD_LOCAL_WORKER_ID), 1);
        }),
    );
  }),
);

