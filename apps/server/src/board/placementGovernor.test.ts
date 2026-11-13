// @effect-diagnostics nodeBuiltinImport:off
/**
 * The live supervisor placing steps on workers. "Ran on worker W" is the
 * `workerId` the fake gateway's spawn named and the card's thread link records.
 */
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import {
  BOARD_LOCAL_WORKER_ID,
  BoardCardAttachmentId,
  BOARD_SEED_STAGE_IDS,
  BoardCardId,
  boardCardStepState,
  EnvironmentId,
  PositiveInt,
  ProviderInstanceId,
  ThreadId,
  type BoardCard,
  type BoardCardStepState,
  type BoardResourceProfile,
  type BoardWorkerId,
  type BoardWorkerView,
} from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SubscriptionRef from "effect/SubscriptionRef";

import { layerTest } from "../config.ts";
import { makeFakeCapacity } from "./capacity/capacityClient.testkit.ts";
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
import {
  makePlacement,
  workersState,
  workerView as workerViewOf,
} from "./workers/placement.testkit.ts";

const W1 = EnvironmentId.make("env-w1");
const W2 = EnvironmentId.make("env-w2");
const codex = ProviderInstanceId.make("codex");
const claude = ProviderInstanceId.make("claude");

const workerView = (
  id: EnvironmentId,
  options: Parameters<typeof workerViewOf>[1] = {},
): BoardWorkerView => workerViewOf(id, { label: id === W1 ? "w1" : "w2", ...options });

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

it.effect("a pinned card plans on the board server and records no placement (T3O-87)", () =>
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
          // A pin steers builds only.
          assert.deepStrictEqual(yield* spawnsOn(h), [BOARD_LOCAL_WORKER_ID]);
          const after = yield* card(h, "card-1");
          // Only the placement gate at build start records placement.
          assert.isNull(after.placedWorkerId);
          assert.isUndefined(after.threadLinks[0]?.workerId);
        }),
    );
  }),
);

// A worker runs the step with its own instances, so this server's text generators say nothing
// about it (T3O-72).
it.effect(
  "a step on a worker is not refused for an instance central knows as a text generator",
  () =>
    Effect.gen(function* () {
      const { placement } = yield* makePlacement(workersState([workerView(W1)]));
      // A build step: planning runs on the board server (T3O-87).
      const sprint = makeBoardCard({
        id: "card-1",
        stage: "building",
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
          serverSettings: {
            textGenerators: {
              [codex]: {
                kind: "openai",
                baseUrl: "https://api.example.test",
                apiKey: "",
                enabled: true,
              },
            },
          } as never,
          placement,
        },
        (h) =>
          Effect.gen(function* () {
            yield* h.pumpDomain(movedToBuilding(sprint, 1));
            assert.deepStrictEqual(yield* spawnsOn(h), [W1]);
          }),
      );
    }),
);

// T3O-74: a worker's gateway sends no attachments, so the central server
// stages no pending copies for it; its thread reads the files staged there.
it.effect("a card on a worker stages no attachment copies on the central server", () =>
  Effect.gen(function* () {
    const { placement } = yield* makePlacement(workersState([workerView(W1)]));
    const baseDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3o-remote-brief-"));
    const stateDir = NodePath.join(baseDir, "userdata");
    const folder = NodePath.join(stateDir, "board", "attachments", "card-1");
    NodeFS.mkdirSync(folder, { recursive: true });
    NodeFS.writeFileSync(NodePath.join(folder, "spec.pdf"), "pdf");
    const planning: BoardCard = {
      // A build step on W1: planning runs on the board server (T3O-87).
      ...placedBuildingCard("card-1", "m", W1),
      attachments: [
        {
          id: BoardCardAttachmentId.make("att-doc"),
          name: "spec.pdf",
          type: "file",
          mimeType: "application/pdf",
          sizeBytes: 3,
          addedAt: "2026-01-01T00:00:00.000Z",
        },
      ],
    };
    yield* withGovernor(
      {
        board: { cards: [planning], nextCardNumberByProject: {}, workers: registered },
        settings: settingsWith({
          building: [codexStep],
          planning: codexStep,
          globalMaxConcurrent: 3,
        }),
        placement,
        serverConfig: layerTest(process.cwd(), baseDir).pipe(
          Layer.provide(NodeServices.layer),
          Layer.orDie,
        ),
      },
      (h) =>
        Effect.gen(function* () {
          yield* h.pumpDomain(movedToBuilding(planning, 1));
          const spawn = (yield* h.commands).find((command) => command.type === "thread.spawn");
          assert.isTrue(spawn?.type === "thread.spawn" && spawn.workerId === W1);
          assert.deepStrictEqual(spawn?.type === "thread.spawn" ? spawn.attachments : null, []);
          const pending = NodePath.join(stateDir, "attachments");
          assert.deepStrictEqual(NodeFS.existsSync(pending) ? NodeFS.readdirSync(pending) : [], []);
        }),
    );
    NodeFS.rmSync(baseDir, { recursive: true, force: true });
  }),
);

it.effect("a default worker no longer steers anything: an unpinned card plans here", () =>
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
          assert.deepStrictEqual(yield* spawnsOn(h), [BOARD_LOCAL_WORKER_ID]);
          assert.isNull((yield* card(h, "card-1")).placedWorkerId);
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
    // A build step: planning runs on the board server (T3O-87).
    const sprint = makeBoardCard({
      id: "card-1",
      stage: "building",
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
          yield* h.pumpDomain(movedToBuilding(sprint, 1));
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
    // A build step: planning runs on the board server (T3O-87).
    const sprint = makeBoardCard({
      id: "card-1",
      stage: "building",
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
          yield* h.pumpDomain(movedToBuilding(sprint, 1));
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
    // A build step: planning runs on the board server (T3O-87).
    const sprint = makeBoardCard({
      id: "card-1",
      stage: "building",
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
          yield* h.pumpDomain(movedToBuilding(sprint, 1));
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
    // A build step: planning runs on the board server (T3O-87).
    const sprint = makeBoardCard({
      id: "card-1",
      stage: "building",
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
          yield* h.pumpDomain(movedToBuilding(sprint, 1));
          // Held queued for its worker, which the card shows as
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
      queuedDetail: null,
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
              carriedFindings: {},
              stuckWaivedThrough: null,
              roundModes: {},
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

/** W1 with room for one default card (2 cores of the 2/4/5 placeholder); `local` roomy. */
const w1RoomForOne = () =>
  makeFakeCapacity(
    new Map<BoardWorkerId, BoardResourceProfile>([
      [W1, { cpuCores: 3, ramGiB: 16, diskGB: 100 }],
      [BOARD_LOCAL_WORKER_ID, { cpuCores: 64, ramGiB: 256, diskGB: 1000 }],
    ]),
  );

it.effect("a full worker queues its cards without holding up another worker's (T3O-86)", () =>
  Effect.gen(function* () {
    const { placement } = yield* makePlacement(workersState([workerView(W1)]));
    const capacity = yield* w1RoomForOne();
    // Priority (T3O-95): an Urgent card behind card-b takes W1's freed room first, and a Low
    // card still runs on a worker with room while Normal ones wait on W1.
    const cards = [
      placedBuildingCard("card-a", "a", W1),
      placedBuildingCard("card-b", "b", W1),
      { ...placedBuildingCard("card-c", "c", BOARD_LOCAL_WORKER_ID), priority: "low" as const },
      { ...placedBuildingCard("card-d", "d", W1), priority: "urgent" as const },
    ];
    yield* withGovernor(
      {
        board: { cards, nextCardNumberByProject: {}, workers: registered },
        settings: settingsWith({ building: [codexStep], globalMaxConcurrent: 8 }),
        placement,
        capacity,
      },
      (h) =>
        Effect.gen(function* () {
          for (const [index, building] of cards.entries()) {
            yield* h.pumpDomain(movedToBuilding(building, index + 1));
          }
          assert.strictEqual((yield* step(h, "card-a"))?.status, "running");
          // T3o: the Urgent card-d is first in the queue, so it holds W1 to grow (T3O-87).
          const urgent = yield* step(h, "card-d");
          assert.strictEqual(urgent?.status, "queued");
          assert.strictEqual(urgent?.queuedBy, "holding");
          assert.strictEqual(urgent?.queuedDetail?.workerId, W1);
          assert.strictEqual((yield* step(h, "card-b"))?.status, "queued");
          assert.strictEqual((yield* step(h, "card-c"))?.status, "running");

          // card-a finishes on W1: the room it frees there goes to the Urgent card-d, then card-b.
          yield* h.pumpDomain(stepCompleted(BoardCardId.make("card-a"), "succeeded", 9));
          yield* h.reactor.sweep;
          assert.strictEqual((yield* step(h, "card-d"))?.status, "running");
          assert.strictEqual((yield* step(h, "card-b"))?.status, "queued");
          yield* h.pumpDomain(stepCompleted(BoardCardId.make("card-d"), "succeeded", 10));
          yield* h.reactor.sweep;
          assert.strictEqual((yield* step(h, "card-b"))?.status, "running");
        }),
    );
  }),
);

it.effect("a reclaimed card whose branch the remote lacks goes back where its commits are", () =>
  Effect.gen(function* () {
    const { placement } = yield* makePlacement(workersState([workerView(W1)]));
    // `local` has far more room, so an unbound card would rank there first.
    const capacity = yield* w1RoomForOne();
    const reclaimed: BoardCard = {
      ...placedBuildingCard("card-a", "a", W1),
      worktree: { ...readyWorktree("card-a"), status: "reclaimed", path: null },
    };
    yield* withGovernor(
      {
        board: { cards: [reclaimed], nextCardNumberByProject: {}, workers: registered },
        settings: settingsWith({ building: [codexStep], globalMaxConcurrent: 8 }),
        placement,
        capacity,
      },
      (h) =>
        Effect.gen(function* () {
          yield* h.pumpDomain(movedToBuilding(reclaimed, 1));
          assert.deepStrictEqual(yield* spawnsOn(h), [W1]);
        }),
    );
  }),
);

it.effect("a grow hold goes when its card waits on something other than room (T3O-87)", () =>
  Effect.gen(function* () {
    const { placement } = yield* makePlacement(workersState([workerView(W1)]));
    const capacity = yield* w1RoomForOne();
    const cards = [placedBuildingCard("card-a", "a", W1), placedBuildingCard("card-b", "b", W1)];
    yield* withGovernor(
      {
        board: { cards, nextCardNumberByProject: {}, workers: registered },
        settings: settingsWith({ building: [codexStep], globalMaxConcurrent: 8 }),
        placement,
        capacity,
      },
      (h) =>
        Effect.gen(function* () {
          for (const [index, building] of cards.entries()) {
            yield* h.pumpDomain(movedToBuilding(building, index + 1));
          }
          assert.strictEqual((yield* step(h, "card-b"))?.queuedBy, "holding");
          // W1 stops answering: card-b now waits on the worker, not on room.
          capacity.unreachable.add(W1);
          yield* h.reactor.sweep;
          assert.strictEqual((yield* step(h, "card-b"))?.queuedBy, "worker-offline");
          assert.deepStrictEqual(
            capacity.releasedHolds.filter((entry) => entry.cardId === "card-b"),
            [{ workerId: W1, cardId: "card-b" }],
          );
          const asked = capacity.holds.length;
          yield* h.reactor.sweep;
          // Forgotten, so the sweep's refresh no longer re-asks it.
          assert.strictEqual(capacity.holds.length, asked);
          // A snapshot from before the release still names card-b: it is neither adopted nor
          // released again.
          const released = capacity.releasedHolds.length;
          const stale = yield* capacity.client.latest(W1);
          capacity.frozen.set(W1, {
            ...stale!,
            hold: { ...stale!.hold!, closed: true, cardId: "card-b" },
          });
          yield* h.reactor.refreshHolds;
          yield* h.reactor.refreshHolds;
          assert.strictEqual(capacity.holds.length, asked);
          assert.strictEqual(capacity.releasedHolds.length, released);
        }),
    );
  }),
);

it.effect(
  "after a restart, a running card's grant reaches its worker before anything is placed there",
  () =>
    Effect.gen(function* () {
      const { placement } = yield* makePlacement(workersState([workerView(W1)]));
      const capacity = yield* w1RoomForOne();
      const threadId = ThreadId.make("thread-running");
      const running: BoardCard = {
        ...placedBuildingCard("card-a", "a", W1),
        resources: {
          sizing: null,
          setup: null,
          grant: {
            profile: { cpuCores: 2, ramGiB: 4, diskGB: 5 },
            heavy: true,
            claimId: "card-a:1:0",
            grantedAt: "2026-01-01T00:00:00.000Z",
            settled: true,
          },
        },
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
        queuedDetail: null,
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
          settings: settingsWith({ building: [codexStep], globalMaxConcurrent: 8 }),
          initialShells: new Map([[String(threadId), aliveThread(String(threadId))]]),
          placement,
          capacity,
        },
        (h) =>
          Effect.gen(function* () {
            yield* h.reactor.drain;
            yield* h.pumpDomain(movedToBuilding(waiting, 1));
            // The first sync on the connection is sent before any claim, listing the running
            // card heavy, so the waiting card finds no room.
            assert.deepStrictEqual(
              capacity.syncs.find((sync) => sync.workerId === W1)?.cards.map((card) => card.phase),
              ["heavy"],
            );
            assert.strictEqual((yield* step(h, "card-b"))?.queuedBy, "holding");
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
      queuedDetail: null,
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

it.effect("the board server's own capacity counts only its live local threads (T3O-71)", () =>
  Effect.gen(function* () {
    const link = (threadId: string, extra: Partial<BoardCard["threadLinks"][number]> = {}) => ({
      threadId: ThreadId.make(threadId),
      role: "build",
      linkedAt: "2026-01-01T00:00:00.000Z",
      tombstonedAt: null,
      ...extra,
    });
    const here = {
      ...buildingCard("card-1", "a"),
      threadLinks: [
        link("thread-local"),
        link("thread-tombstoned", { tombstonedAt: "2026-01-01T00:00:01.000Z" }),
        link("thread-retired", { retiredAt: "2026-01-01T00:00:01.000Z" }),
      ],
    } as BoardCard;
    const away = {
      ...placedBuildingCard("card-2", "b", W1),
      threadLinks: [link("thread-on-w1", { workerId: W1 })],
    } as BoardCard;
    yield* withGovernor(
      {
        board: { cards: [here, away], nextCardNumberByProject: {}, workers: registered },
        settings: settingsWith({ building: [codexStep], globalMaxConcurrent: 3 }),
      },
      (h) =>
        Effect.gen(function* () {
          assert.deepStrictEqual([...(yield* h.localBoardThreads)], ["thread-local"]);
        }),
    );
  }),
);
