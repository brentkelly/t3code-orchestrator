/**
 * T3o (T3O-65, D11/D20) — the live supervisor placing steps on workers.
 *
 * Driven against the stateful engine double with a placement whose worker
 * summary each test sets: which workers are online, what they have checked
 * out, which provider instances they run. The thread gateway is the fake, so
 * "ran on worker W" is the `workerId` the spawn named and the worker the card's
 * thread link records.
 */
import {
  BOARD_LOCAL_WORKER_ID,
  BOARD_SEED_STAGE_IDS,
  BoardCardId,
  boardCardStepState,
  EnvironmentId,
  PositiveInt,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type BoardCard,
  type BoardCardStepState,
  type BoardWorkerId,
  type BoardWorkersState,
  type BoardWorkerView,
} from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";

import {
  buildingCard,
  cardMoved,
  codexStep,
  makeBoardCard,
  movedToBuilding,
  readyWorktree,
  settingsWith,
  stepCompleted,
  withGovernor,
  type Harness,
  type HarnessEvent,
} from "./supervisorHarness.testkit.ts";
import { aliveThread } from "./threadGateway.testkit.ts";
import type { BoardPlacementShape } from "./workers/BoardPlacement.ts";

const W1 = EnvironmentId.make("env-w1");
const W2 = EnvironmentId.make("env-w2");
const codex = ProviderInstanceId.make("codex");
const claude = ProviderInstanceId.make("claude");

/** The harness project's repository, as the workers' checkouts report it. */
const REPOSITORY_KEY = "github.com/acme/repo";

const workerView = (
  id: EnvironmentId,
  options: {
    readonly online?: boolean;
    readonly checkout?: boolean;
    readonly providers?: ReadonlyArray<ProviderInstanceId>;
  } = {},
): BoardWorkerView => ({
  id,
  label: id === W1 ? "w1" : "w2",
  url: `http://${id}:3773`,
  addedAt: "2026-01-01T00:00:00.000Z",
  status: {
    state: options.online === false ? "offline" : "online",
    lastSeenAt: null,
    t3oVersion: "0.1.0",
    protocolVersion: 1,
  },
  snapshot: {
    providers: (options.providers ?? [codex]).map((instanceId) => ({
      instanceId,
      driver: "codex",
      displayName: null,
      enabled: true,
      models: [],
    })),
    checkouts:
      options.checkout === false
        ? []
        : [
            {
              projectId: ProjectId.make(`${id}-project`),
              title: "repo",
              workspaceRoot: `/home/${id}/repo`,
              repositoryKey: REPOSITORY_KEY,
            },
          ],
    projectsFolder: null,
    reportedAt: "2026-01-01T00:00:00.000Z",
  },
});

const workersState = (
  workers: ReadonlyArray<BoardWorkerView>,
  defaultWorkerId: BoardWorkerId = BOARD_LOCAL_WORKER_ID,
): BoardWorkersState => ({ defaultWorkerId, workers, setups: [] });

/** A placement whose worker summary the test changes, ticking on each change. */
const makePlacement = (initial: BoardWorkersState) =>
  Effect.map(SubscriptionRef.make(initial), (ref) => ({
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
  { id: W2, label: "w2", url: "http://env-w2:3773", addedAt: "2026-01-01T00:00:00.000Z" },
];

/** The card as the move into Planning leaves it. */
const inPlanning = (before: BoardCard): BoardCard => ({
  ...before,
  stage: BOARD_SEED_STAGE_IDS.planning,
});

/** A card in Building with a ready worktree, placed on `workerId`. */
const placedBuildingCard = (id: string, orderKey: string, workerId: BoardWorkerId): BoardCard => ({
  ...buildingCard(id, orderKey),
  placedWorkerId: workerId,
});

const spawnsOn = (h: Harness) =>
  Effect.map(h.commands, (commands) =>
    commands.flatMap((command) =>
      command.type === "thread.spawn" ? [command.workerId ?? BOARD_LOCAL_WORKER_ID] : [],
    ),
  );

const card = (h: Harness, id: string) =>
  Effect.map(h.board, (board) => board.cards.find((candidate) => candidate.id === id)!);

const step = (h: Harness, id: string) =>
  Effect.map(h.board, (board) => boardCardStepState(board, BoardCardId.make(id)));

/** The domain event a human's pin produces, as the engine would publish it. */
const pinned = (before: BoardCard, workerId: BoardWorkerId | null, sequence: number) =>
  ({
    type: "board.card-worker-pinned",
    sequence,
    payload: {
      cardId: before.id,
      workerId,
      card: { ...before, pinnedWorkerId: workerId, placedWorkerId: null },
    },
  }) as unknown as HarnessEvent;

// ── Placement ─────────────────────────────────────────────────────────────

it.effect("a pinned card's first thread spawns on its worker, which becomes its placement", () =>
  Effect.gen(function* () {
    const { placement } = yield* makePlacement(workersState([workerView(W1)]));
    const sprint = makeBoardCard({
      id: "card-1",
      stage: "sprint",
      orderKey: "m",
      pinnedWorkerId: W1,
    });
    yield* withGovernor(
      {
        board: { cards: [sprint], nextCardNumberByProject: {}, workers: registered },
        settings: settingsWith({
          building: [codexStep],
          planning: codexStep,
          globalMaxConcurrent: 3,
        }),
        placement,
      },
      (h) =>
        Effect.gen(function* () {
          yield* h.pumpDomain(cardMoved(inPlanning(sprint), "sprint", "planning", 1));
          assert.deepStrictEqual(yield* spawnsOn(h), [W1]);
          const after = yield* card(h, "card-1");
          assert.strictEqual(after.placedWorkerId, W1);
          // The link records where the thread lives.
          assert.strictEqual(after.threadLinks[0]?.workerId, W1);
        }),
    );
  }),
);

it.effect("an unpinned card follows the default worker", () =>
  Effect.gen(function* () {
    const { placement } = yield* makePlacement(workersState([workerView(W1)], W1));
    const sprint = makeBoardCard({ id: "card-1", stage: "sprint", orderKey: "m" });
    yield* withGovernor(
      {
        board: {
          cards: [sprint],
          nextCardNumberByProject: {},
          workers: registered,
          defaultWorkerId: W1,
        },
        settings: settingsWith({
          building: [codexStep],
          planning: codexStep,
          globalMaxConcurrent: 3,
        }),
        placement,
      },
      (h) =>
        Effect.gen(function* () {
          yield* h.pumpDomain(cardMoved(inPlanning(sprint), "sprint", "planning", 1));
          assert.deepStrictEqual(yield* spawnsOn(h), [W1]);
          assert.strictEqual((yield* card(h, "card-1")).placedWorkerId, W1);
        }),
    );
  }),
);

it.effect("a card with a worktree stays where it was placed when the default changes", () =>
  Effect.gen(function* () {
    const { placement } = yield* makePlacement(workersState([workerView(W1)], W1));
    // Its worktree was cut here, before the default moved to W1.
    const building = placedBuildingCard("card-1", "m", BOARD_LOCAL_WORKER_ID);
    yield* withGovernor(
      {
        board: {
          cards: [building],
          nextCardNumberByProject: {},
          workers: registered,
          defaultWorkerId: W1,
        },
        settings: settingsWith({ building: [codexStep], globalMaxConcurrent: 3 }),
        placement,
      },
      (h) =>
        Effect.gen(function* () {
          yield* h.pumpDomain(movedToBuilding(building, 1));
          assert.deepStrictEqual(yield* spawnsOn(h), [BOARD_LOCAL_WORKER_ID]);
          assert.strictEqual((yield* card(h, "card-1")).placedWorkerId, BOARD_LOCAL_WORKER_ID);
        }),
    );
  }),
);

// ── Gates ─────────────────────────────────────────────────────────────────

it.effect("a step whose provider the worker lacks stalls amber, and a re-pin clears it", () =>
  Effect.gen(function* () {
    const { placement } = yield* makePlacement(
      workersState([workerView(W1, { providers: [claude] }), workerView(W2)]),
    );
    const sprint = makeBoardCard({
      id: "card-1",
      stage: "sprint",
      orderKey: "m",
      pinnedWorkerId: W1,
    });
    yield* withGovernor(
      {
        board: { cards: [sprint], nextCardNumberByProject: {}, workers: registered },
        settings: settingsWith({
          building: [codexStep],
          planning: codexStep,
          globalMaxConcurrent: 3,
        }),
        placement,
      },
      (h) =>
        Effect.gen(function* () {
          yield* h.pumpDomain(cardMoved(inPlanning(sprint), "sprint", "planning", 1));
          const stalled = yield* step(h, "card-1");
          assert.strictEqual(stalled?.status, "stalled");
          assert.strictEqual(stalled?.stalledReason, "provider-not-on-worker");
          assert.include(stalled?.lastError ?? "", "codex");
          assert.deepStrictEqual(yield* spawnsOn(h), []);

          // A human pins the card to a worker that has codex.
          yield* h.pumpDomain(pinned(yield* card(h, "card-1"), W2, 2));
          yield* h.reactor.drain;
          assert.strictEqual((yield* step(h, "card-1"))?.status, "running");
          assert.deepStrictEqual(yield* spawnsOn(h), [W2]);
        }),
    );
  }),
);

it.effect("a provider stall clears when the instance appears on the worker", () =>
  Effect.gen(function* () {
    const { placement, ref } = yield* makePlacement(
      workersState([workerView(W1, { providers: [claude] })]),
    );
    const sprint = makeBoardCard({
      id: "card-1",
      stage: "sprint",
      orderKey: "m",
      pinnedWorkerId: W1,
    });
    yield* withGovernor(
      {
        board: { cards: [sprint], nextCardNumberByProject: {}, workers: registered },
        settings: settingsWith({
          building: [codexStep],
          planning: codexStep,
          globalMaxConcurrent: 3,
        }),
        placement,
      },
      (h) =>
        Effect.gen(function* () {
          yield* h.pumpDomain(cardMoved(inPlanning(sprint), "sprint", "planning", 1));
          assert.strictEqual((yield* step(h, "card-1"))?.stalledReason, "provider-not-on-worker");

          yield* SubscriptionRef.set(
            ref,
            workersState([workerView(W1, { providers: [claude, codex] })]),
          );
          yield* Effect.yieldNow;
          yield* h.reactor.drain;
          assert.strictEqual((yield* step(h, "card-1"))?.status, "running");
          assert.deepStrictEqual(yield* spawnsOn(h), [W1]);
        }),
    );
  }),
);

it.effect("a card pinned to a worker still cloning the project holds, then starts", () =>
  Effect.gen(function* () {
    const { placement, ref } = yield* makePlacement(
      workersState([workerView(W1, { checkout: false })]),
    );
    const sprint = makeBoardCard({
      id: "card-1",
      stage: "sprint",
      orderKey: "m",
      pinnedWorkerId: W1,
    });
    yield* withGovernor(
      {
        board: { cards: [sprint], nextCardNumberByProject: {}, workers: registered },
        settings: settingsWith({
          building: [codexStep],
          planning: codexStep,
          globalMaxConcurrent: 3,
        }),
        placement,
      },
      (h) =>
        Effect.gen(function* () {
          yield* h.pumpDomain(cardMoved(inPlanning(sprint), "sprint", "planning", 1));
          const held = yield* step(h, "card-1");
          assert.strictEqual(held?.status, "queued");
          assert.strictEqual(held?.queuedBy, "setup");
          assert.deepStrictEqual(yield* spawnsOn(h), []);

          // The clone finishes: the worker reports the checkout.
          yield* SubscriptionRef.set(ref, workersState([workerView(W1)]));
          yield* Effect.yieldNow;
          yield* h.reactor.drain;
          assert.strictEqual((yield* step(h, "card-1"))?.status, "running");
          assert.deepStrictEqual(yield* spawnsOn(h), [W1]);
        }),
    );
  }),
);

it.effect(
  "a build card pinned to a worker still cloning cuts no worktree until the clone lands",
  () =>
    Effect.gen(function* () {
      const { placement, ref } = yield* makePlacement(
        workersState([workerView(W1, { checkout: false })]),
      );
      const building = makeBoardCard({
        id: "card-1",
        stage: "building",
        orderKey: "m",
        pinnedWorkerId: W1,
      });
      yield* withGovernor(
        {
          board: { cards: [building], nextCardNumberByProject: {}, workers: registered },
          settings: settingsWith({ building: [codexStep], globalMaxConcurrent: 3 }),
          placement,
        },
        (h) =>
          Effect.gen(function* () {
            yield* h.pumpDomain(movedToBuilding(building, 1));
            // Held as setting up, not stalled for a missing worktree, and no
            // worktree cut anywhere while the worker has no checkout.
            const held = yield* step(h, "card-1");
            assert.strictEqual(held?.status, "queued");
            assert.strictEqual(held?.queuedBy, "setup");
            assert.isNull((yield* card(h, "card-1")).worktree);
            assert.deepStrictEqual(yield* spawnsOn(h), []);

            yield* SubscriptionRef.set(ref, workersState([workerView(W1)]));
            yield* Effect.yieldNow;
            yield* h.reactor.drain;
            assert.strictEqual((yield* step(h, "card-1"))?.status, "running");
            assert.deepStrictEqual(yield* spawnsOn(h), [W1]);
          }),
      );
    }),
);

it.effect("a provider stall stays stalled while its worker is offline", () =>
  Effect.gen(function* () {
    const { placement, ref } = yield* makePlacement(
      workersState([workerView(W1, { providers: [claude] })]),
    );
    const sprint = makeBoardCard({
      id: "card-1",
      stage: "sprint",
      orderKey: "m",
      pinnedWorkerId: W1,
    });
    yield* withGovernor(
      {
        board: { cards: [sprint], nextCardNumberByProject: {}, workers: registered },
        settings: settingsWith({
          building: [codexStep],
          planning: codexStep,
          globalMaxConcurrent: 3,
        }),
        placement,
      },
      (h) =>
        Effect.gen(function* () {
          yield* h.pumpDomain(cardMoved(inPlanning(sprint), "sprint", "planning", 1));
          assert.strictEqual((yield* step(h, "card-1"))?.stalledReason, "provider-not-on-worker");

          yield* SubscriptionRef.set(
            ref,
            workersState([workerView(W1, { providers: [claude], online: false })]),
          );
          yield* Effect.yieldNow;
          yield* h.reactor.drain;
          const still = yield* step(h, "card-1");
          assert.strictEqual(still?.status, "stalled");
          assert.strictEqual(still?.stalledReason, "provider-not-on-worker");
        }),
    );
  }),
);

it.effect("an offline worker holds its cards without spawning anything", () =>
  Effect.gen(function* () {
    const { placement } = yield* makePlacement(workersState([workerView(W1, { online: false })]));
    const sprint = makeBoardCard({
      id: "card-1",
      stage: "sprint",
      orderKey: "m",
      pinnedWorkerId: W1,
    });
    yield* withGovernor(
      {
        board: { cards: [sprint], nextCardNumberByProject: {}, workers: registered },
        settings: settingsWith({
          building: [codexStep],
          planning: codexStep,
          globalMaxConcurrent: 3,
        }),
        placement,
      },
      (h) =>
        Effect.gen(function* () {
          yield* h.pumpDomain(cardMoved(inPlanning(sprint), "sprint", "planning", 1));
          // Held queued for its worker (T3O-66), which the card shows as
          // Worker offline.
          assert.strictEqual((yield* step(h, "card-1"))?.status, "queued");
          assert.strictEqual((yield* step(h, "card-1"))?.queuedBy, "worker-offline");
          assert.deepStrictEqual(yield* spawnsOn(h), []);
        }),
    );
  }),
);

it.effect("a card mid-move holds until the move lands", () =>
  Effect.gen(function* () {
    const { placement } = yield* makePlacement(workersState([workerView(W1)]));
    const moving: BoardCard = {
      ...placedBuildingCard("card-1", "m", BOARD_LOCAL_WORKER_ID),
      workerMove: {
        fromWorkerId: BOARD_LOCAL_WORKER_ID,
        toWorkerId: W1,
        status: "moving",
        sha: null,
        error: null,
        startedAt: "2026-01-01T00:00:00.000Z",
      },
    };
    yield* withGovernor(
      {
        board: { cards: [moving], nextCardNumberByProject: {}, workers: registered },
        settings: settingsWith({ building: [codexStep], globalMaxConcurrent: 3 }),
        placement,
      },
      (h) =>
        Effect.gen(function* () {
          yield* h.pumpDomain(movedToBuilding(moving, 1));
          assert.deepStrictEqual(yield* spawnsOn(h), []);
        }),
    );
  }),
);

it.effect("a re-planned review round cuts no worktree on a card whose move failed", () =>
  Effect.gen(function* () {
    const { placement } = yield* makePlacement(workersState([workerView(W1)]));
    const cardId = BoardCardId.make("card-1");
    // Retired here, then provisioning on W1 failed: the old pin still names
    // this server, and the branch is safe on the remote.
    const failedMove: BoardCard = {
      ...makeBoardCard({
        id: "card-1",
        stage: String(BOARD_SEED_STAGE_IDS.review),
        orderKey: "m",
        worktree: { ...readyWorktree("card-1"), status: "reclaimed" },
      }),
      placedWorkerId: BOARD_LOCAL_WORKER_ID,
      workerMove: {
        fromWorkerId: BOARD_LOCAL_WORKER_ID,
        toWorkerId: W1,
        status: "failed",
        sha: "abc123",
        error: "clone failed",
        startedAt: "2026-01-01T00:00:00.000Z",
      },
    };
    const settled: BoardCardStepState = {
      cardId,
      stepId: "review@1",
      stepLabel: "Review · round 1",
      stageLabel: "Code review",
      attempt: 1,
      stallCount: 0,
      stageEntryRecoveries: 0,
      humanTurnAt: null,
      lastNudgeAt: null,
      baseTipAtRoundStart: "main",
      lastError: null,
      awaitingReason: "question",
      stalledReason: "gave-up",
      retryAt: null,
      prompt: "review it",
      providerInstanceId: codex,
      model: "gpt-5-codex",
      mode: "build",
      runtimeMode: "auto",
      humanInLoop: false,
      maxAttempts: 3,
      timeoutMs: 600_000,
      threadId: null,
      status: "succeeded",
      slotHeld: false,
      forceStart: false,
      queuedBy: null,
      startedAt: null,
      updatedAt: "2026-01-01T00:00:00.000Z",
    };
    yield* withGovernor(
      {
        board: {
          cards: [failedMove],
          stepStates: [settled],
          stepCompletions: [
            {
              cardId,
              stepId: "review@1",
              outcome: "succeeded",
              summary: "clean",
              payload: JSON.stringify({ reviewedSha: "sha-reviewed", findings: [] }),
              threadId: null,
              completedAt: "2026-01-01T00:00:00.000Z",
            },
          ],
          nextCardNumberByProject: {},
          workers: registered,
        },
        settings: settingsWith({ building: [codexStep], globalMaxConcurrent: 3 }),
        placement,
      },
      (h) =>
        Effect.gen(function* () {
          // A human asks for one more round: the edit re-plans the settled loop.
          const edited: BoardCard = {
            ...(yield* card(h, "card-1")),
            reviewOverrides: {
              rounds: null,
              stopAfterRound: null,
              roundModels: {},
              runThroughRound: PositiveInt.make(2),
            },
          };
          yield* h.pumpDomain({
            type: "board.card-updated",
            sequence: 1,
            payload: { cardId, card: edited },
          } as unknown as HarnessEvent);
          yield* h.reactor.drain;
          assert.strictEqual((yield* step(h, "card-1"))?.stepId, "review@2");
          // Held for the move: no worktree cut on the old worker, nothing spawned.
          assert.strictEqual((yield* card(h, "card-1")).worktree?.status, "reclaimed");
          assert.deepStrictEqual(yield* spawnsOn(h), []);
        }),
    );
  }),
);

// ── Concurrency: board, worker and provider ceilings ──────────────────────

it.effect("a full worker queues its cards without holding up another worker's", () =>
  Effect.gen(function* () {
    const { placement } = yield* makePlacement(workersState([workerView(W1)]));
    const cards = [
      placedBuildingCard("card-a", "a", W1),
      placedBuildingCard("card-b", "b", W1),
      placedBuildingCard("card-c", "c", BOARD_LOCAL_WORKER_ID),
    ];
    yield* withGovernor(
      {
        board: { cards, nextCardNumberByProject: {}, workers: registered },
        settings: settingsWith({
          building: [codexStep],
          globalMaxConcurrent: 8,
          workers: { [W1]: { maxConcurrent: PositiveInt.make(1), perInstance: {} } },
        }),
        placement,
      },
      (h) =>
        Effect.gen(function* () {
          for (const [index, building] of cards.entries()) {
            yield* h.pumpDomain(movedToBuilding(building, index + 1));
          }
          assert.strictEqual((yield* step(h, "card-a"))?.status, "running");
          const waiting = yield* step(h, "card-b");
          assert.strictEqual(waiting?.status, "queued");
          assert.strictEqual(waiting?.queuedBy, "worker");
          assert.strictEqual((yield* step(h, "card-c"))?.status, "running");
          assert.strictEqual(yield* h.slots.heldOnWorker(W1), 1);

          // card-a finishes on W1: the slot it frees there goes to card-b.
          yield* h.pumpDomain(stepCompleted(BoardCardId.make("card-a"), "succeeded", 9));
          assert.strictEqual((yield* step(h, "card-b"))?.status, "running");
        }),
    );
  }),
);

it.effect("a provider cap on one worker queues that provider there and names it", () =>
  Effect.gen(function* () {
    const { placement } = yield* makePlacement(workersState([workerView(W1)]));
    const cards = [placedBuildingCard("card-a", "a", W1), placedBuildingCard("card-b", "b", W1)];
    yield* withGovernor(
      {
        board: { cards, nextCardNumberByProject: {}, workers: registered },
        settings: settingsWith({
          building: [codexStep],
          globalMaxConcurrent: 8,
          // A codex cap of 1 on W1, and none here: local codex is untouched.
          workers: {
            [W1]: {
              maxConcurrent: PositiveInt.make(4),
              perInstance: { [codex]: PositiveInt.make(1) },
            },
          },
        }),
        placement,
      },
      (h) =>
        Effect.gen(function* () {
          yield* h.pumpDomain(movedToBuilding(cards[0]!, 1));
          yield* h.pumpDomain(movedToBuilding(cards[1]!, 2));
          assert.strictEqual((yield* step(h, "card-a"))?.status, "running");
          assert.strictEqual((yield* step(h, "card-b"))?.queuedBy, "provider");
          assert.strictEqual(yield* h.slots.heldFor(codex, W1), 1);
        }),
    );
  }),
);

it.effect("the board limit holds a card even when its worker has room", () =>
  Effect.gen(function* () {
    const { placement } = yield* makePlacement(workersState([workerView(W1), workerView(W2)]));
    const cards = [
      placedBuildingCard("card-a", "a", BOARD_LOCAL_WORKER_ID),
      placedBuildingCard("card-b", "b", W1),
      placedBuildingCard("card-c", "c", W2),
    ];
    yield* withGovernor(
      {
        board: { cards, nextCardNumberByProject: {}, workers: registered },
        settings: settingsWith({ building: [codexStep], globalMaxConcurrent: 2 }),
        placement,
      },
      (h) =>
        Effect.gen(function* () {
          for (const [index, building] of cards.entries()) {
            yield* h.pumpDomain(movedToBuilding(building, index + 1));
          }
          const waiting = yield* step(h, "card-c");
          assert.strictEqual(waiting?.status, "queued");
          assert.strictEqual(waiting?.queuedBy, "board");
          assert.strictEqual(yield* h.slots.heldTotal, 2);
        }),
    );
  }),
);

it.effect("a step restored at boot holds its slot on its own worker", () =>
  Effect.gen(function* () {
    const { placement } = yield* makePlacement(workersState([workerView(W1)]));
    const threadId = ThreadId.make("thread-running");
    const running: BoardCard = {
      ...placedBuildingCard("card-a", "a", W1),
      threadLinks: [
        {
          threadId,
          role: "building",
          linkedAt: "2026-01-01T00:00:00.000Z",
          tombstonedAt: null,
          workerId: W1,
        },
      ],
    };
    const runningStep: BoardCardStepState = {
      cardId: running.id,
      stepId: String(BOARD_SEED_STAGE_IDS.building),
      stepLabel: null,
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
      timeoutMs: 30 * 60_000,
      threadId,
      status: "running",
      slotHeld: true,
      forceStart: false,
      queuedBy: null,
      startedAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    };
    const waiting = placedBuildingCard("card-b", "b", W1);
    yield* withGovernor(
      {
        board: {
          cards: [running, waiting],
          stepStates: [runningStep],
          nextCardNumberByProject: {},
          workers: registered,
        },
        settings: settingsWith({
          building: [codexStep],
          globalMaxConcurrent: 8,
          workers: { [W1]: { maxConcurrent: PositiveInt.make(1), perInstance: {} } },
        }),
        initialShells: new Map([[String(threadId), aliveThread(String(threadId))]]),
        placement,
      },
      (h) =>
        Effect.gen(function* () {
          yield* h.reactor.drain;
          assert.strictEqual(yield* h.slots.heldFor(codex, W1), 1);
          assert.strictEqual(yield* h.slots.heldFor(codex), 0);
          yield* h.pumpDomain(movedToBuilding(waiting, 1));
          assert.strictEqual((yield* step(h, "card-b"))?.queuedBy, "worker");
        }),
    );
  }),
);

// ── Moving ────────────────────────────────────────────────────────────────

it.effect("after a move, a paused step's next turn starts afresh on the new worker", () =>
  Effect.gen(function* () {
    const { placement } = yield* makePlacement(workersState([workerView(W1)]));
    const oldThread = ThreadId.make("thread-old");
    // Moved to W1 while paused: its thread ran here, in the retired worktree.
    const moved: BoardCard = {
      ...placedBuildingCard("card-a", "a", W1),
      pinnedWorkerId: W1,
      threadLinks: [
        {
          threadId: oldThread,
          role: "building",
          linkedAt: "2026-01-01T00:00:00.000Z",
          tombstonedAt: null,
        },
      ],
    };
    const paused: BoardCardStepState = {
      cardId: moved.id,
      stepId: String(BOARD_SEED_STAGE_IDS.building),
      stepLabel: null,
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
      timeoutMs: 30 * 60_000,
      threadId: oldThread,
      status: "queued",
      slotHeld: false,
      forceStart: false,
      queuedBy: null,
      startedAt: null,
      updatedAt: "2026-01-01T00:00:00.000Z",
    };
    yield* withGovernor(
      {
        board: {
          cards: [moved],
          stepStates: [paused],
          nextCardNumberByProject: {},
          workers: registered,
        },
        settings: settingsWith({ building: [codexStep], globalMaxConcurrent: 3 }),
        initialShells: new Map([[String(oldThread), aliveThread(String(oldThread))]]),
        placement,
      },
      (h) =>
        Effect.gen(function* () {
          yield* h.reactor.drain;
          // Not a nudge into the old thread: a fresh spawn on W1.
          const commands = yield* h.commands;
          assert.isFalse(
            commands.some(
              (command) => command.type === "thread.send" && command.threadId === oldThread,
            ),
          );
          assert.deepStrictEqual(yield* spawnsOn(h), [W1]);
        }),
    );
  }),
);

it.effect("an edit that leaves the model alone does not restart a provider stall", () =>
  Effect.gen(function* () {
    const { placement } = yield* makePlacement(
      workersState([workerView(W1, { providers: [claude] })]),
    );
    const building = placedBuildingCard("card-1", "m", W1);
    yield* withGovernor(
      {
        board: { cards: [building], nextCardNumberByProject: {}, workers: registered },
        settings: settingsWith({ building: [codexStep], globalMaxConcurrent: 3 }),
        placement,
      },
      (h) =>
        Effect.gen(function* () {
          yield* h.pumpDomain(movedToBuilding(building, 1));
          assert.strictEqual((yield* step(h, "card-1"))?.stalledReason, "provider-not-on-worker");

          const retitled: BoardCard = { ...(yield* card(h, "card-1")), title: "Renamed" };
          yield* h.pumpDomain({
            type: "board.card-updated",
            sequence: 2,
            payload: { cardId: retitled.id, card: retitled },
          } as unknown as HarnessEvent);
          yield* h.reactor.drain;
          assert.isUndefined(
            (yield* h.decided).find((event) => event.type === "board.card-stage-thread-requested"),
          );
          assert.strictEqual((yield* step(h, "card-1"))?.status, "stalled");
        }),
    );
  }),
);

it.effect("changing the stage's model to one the worker has restarts a provider stall", () =>
  Effect.gen(function* () {
    const { placement } = yield* makePlacement(
      workersState([workerView(W1, { providers: [claude] })]),
    );
    const building = placedBuildingCard("card-1", "m", W1);
    yield* withGovernor(
      {
        board: { cards: [building], nextCardNumberByProject: {}, workers: registered },
        settings: settingsWith({ building: [codexStep], globalMaxConcurrent: 3 }),
        placement,
      },
      (h) =>
        Effect.gen(function* () {
          yield* h.pumpDomain(movedToBuilding(building, 1));
          assert.strictEqual((yield* step(h, "card-1"))?.stalledReason, "provider-not-on-worker");

          // The human picks a model W1 offers for the Building stage.
          const edited: BoardCard = {
            ...(yield* card(h, "card-1")),
            modelOverrides: {
              [BOARD_SEED_STAGE_IDS.building]: { instanceId: claude, model: "claude-sonnet" },
            },
          };
          yield* h.pumpDomain({
            type: "board.card-updated",
            sequence: 2,
            payload: { cardId: edited.id, card: edited, modelOverridesEdited: true },
          } as unknown as HarnessEvent);
          yield* h.reactor.drain;
          // The engine publishes the restart it decided; the double does not,
          // so it is delivered here as the live stream would.
          const requested = (yield* h.decided).find(
            (event) => event.type === "board.card-stage-thread-requested",
          );
          assert.isDefined(requested);
          yield* h.pumpDomain(requested!);
          const restarted = yield* step(h, "card-1");
          assert.strictEqual(restarted?.status, "running");
          assert.strictEqual(restarted?.providerInstanceId, claude);
          assert.deepStrictEqual(yield* spawnsOn(h), [W1]);
        }),
    );
  }),
);
