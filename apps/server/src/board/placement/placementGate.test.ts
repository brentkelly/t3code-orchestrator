/**
 * The placement gate at build start (T3O-87): the supervisor ranks every worker, runs the base
 * checks on the top candidate with no claim, claims there, records the placement and why, and
 * provisions there. "Ran on worker W" is what the per-worker workspace logged.
 */
import {
  BOARD_LOCAL_WORKER_ID,
  BoardCardId,
  boardCardStepState,
  EnvironmentId,
  ThreadId,
  type BoardCard,
  type BoardResourceProfile,
  type BoardState,
  type BoardWorkerId,
} from "@t3tools/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Ref from "effect/Ref";

import { makeFakeCapacity, type FakeCapacity } from "../capacity/capacityClient.testkit.ts";
import {
  codexStep,
  makeBoardCard,
  movedToBuilding,
  readyWorktree,
  settingsWith,
  withGovernor,
  type Harness,
} from "../supervisorHarness.testkit.ts";
import { bindBoardWorkspace, type BoardWorkspace } from "../workspace/BoardWorkspace.ts";
import type { LocalBoardWorkspaceDeps } from "../workspace/LocalBoardWorkspace.ts";
import { makeBoardWorkspaces } from "../workspace/workspaceLayer.ts";
import { WorkerUnavailable } from "../workers/WorkerConnections.ts";
import {
  registeredWorker,
  staticPlacement,
  workersState,
  workerView,
} from "../workers/placement.testkit.ts";

const W1 = EnvironmentId.make("env-w1");
const W2 = EnvironmentId.make("env-w2");
const FULL: BoardResourceProfile = { cpuCores: 16, ramGiB: 32, diskGB: 200 };
const BIG: BoardResourceProfile = { cpuCores: 32, ramGiB: 64, diskGB: 200 };
/** The board server declares no build capacity, so it is never a candidate here. */
/** Another board's cards, holding a worker's CPU and RAM but no disk. */
const CPU_RAM_TAKEN: BoardResourceProfile = { cpuCores: 16, ramGiB: 32, diskGB: 0 };
const NO_BUILDS: BoardResourceProfile = { cpuCores: 0, ramGiB: 0, diskGB: 200 };

interface WorkerGit {
  /** `worker:operation`, in order. */
  readonly log: Array<string>;
  /** Workers whose base check answers unreachable. */
  readonly unreachableBase: Set<BoardWorkerId>;
  /** Workers whose base branch is missing (a `stuck` failure). */
  readonly missingBase: Set<BoardWorkerId>;
  /** Branches the remote has. */
  readonly remoteBranches: Set<string>;
}

const newWorkerGit = (): WorkerGit => ({
  log: [],
  unreachableBase: new Set(),
  missingBase: new Set(),
  remoteBranches: new Set(),
});

/** Every worker runs over the harness's own local git, logging what it was asked. */
const loggingWorkspaces = (git: WorkerGit) => (local: LocalBoardWorkspaceDeps) => {
  const base = makeBoardWorkspaces(local).local;
  const on = (workerId: BoardWorkerId): BoardWorkspace => ({
    ...base,
    workerId,
    ensureLocalBaseBranch: (input) => {
      git.log.push(`${workerId}:base`);
      if (git.unreachableBase.has(workerId)) {
        return Effect.fail(
          new WorkerUnavailable({
            workerId: workerId as EnvironmentId,
            state: "unknown",
            message: "unreachable",
          }),
        );
      }
      if (git.missingBase.has(workerId)) return Effect.succeed({ exists: false });
      return base.ensureLocalBaseBranch(input);
    },
    remoteBranchTip: (input) =>
      Effect.succeed(
        git.remoteBranches.has(input.branch)
          ? { sha: "abc123", subject: "Work", committedAt: "2026-01-01T00:00:00Z", author: "a" }
          : null,
      ),
    provisionWorktree: (input) => {
      git.log.push(`${workerId}:provision`);
      return base.provisionWorktree(input);
    },
    provisionWorktreeFromRemoteBranch: (input) => {
      git.log.push(`${workerId}:provision-from-remote`);
      return base.provisionWorktree(input);
    },
  });
  return makeBoardWorkspaces(local, {
    remote: (placement) =>
      Effect.map(local.projectRoot(placement.projectId), (checkoutPath) =>
        bindBoardWorkspace({
          workspace: on(placement.workerId),
          projectId: placement.projectId,
          checkoutPath,
        }),
      ),
    workerProjectOf: (_workerId, projectId) => Effect.succeed(projectId),
  });
};

const unplaced = (id: string, orderKey: string, overrides: Partial<BoardCard> = {}): BoardCard => ({
  ...makeBoardCard({ id, stage: "building", orderKey, worktree: null }),
  ...overrides,
});

const world = (cards: ReadonlyArray<BoardCard>, extra: Partial<BoardState> = {}): BoardState => ({
  cards,
  nextCardNumberByProject: {},
  workers: [registeredWorker(W1), registeredWorker(W2)],
  ...extra,
});

const twoWorkers = staticPlacement(workersState([workerView(W1), workerView(W2)]));

const capacityOf = (declared: ReadonlyArray<readonly [BoardWorkerId, BoardResourceProfile]>) =>
  makeFakeCapacity(new Map([[BOARD_LOCAL_WORKER_ID, NO_BUILDS], ...declared]));

const cardIn = (h: Harness, id: string) =>
  Effect.map(h.board, (board) => board.cards.find((card) => card.id === id)!);

const run = (
  input: {
    readonly cards: ReadonlyArray<BoardCard>;
    readonly capacity: FakeCapacity;
    readonly git: WorkerGit;
    readonly extra?: Partial<BoardState>;
  },
  body: (h: Harness) => Effect.Effect<void>,
) =>
  withGovernor(
    {
      board: world(input.cards, input.extra),
      settings: settingsWith({ building: [codexStep], globalMaxConcurrent: 9 }),
      placement: twoWorkers,
      capacity: input.capacity,
      workspaces: loggingWorkspaces(input.git),
    },
    body,
  );

describe("the placement gate (T3O-87)", () => {
  it.effect("places an unpinned card on the worker with the most room, and says why", () =>
    Effect.gen(function* () {
      const capacity = yield* capacityOf([
        [W1, FULL],
        [W2, BIG],
      ]);
      const git = newWorkerGit();
      const card = unplaced("card-1", "a");
      yield* run({ cards: [card], capacity, git }, (h) =>
        Effect.gen(function* () {
          yield* h.pumpDomain(movedToBuilding(card, 1));
          const placed = yield* cardIn(h, "card-1");
          assert.strictEqual(placed.placedWorkerId, W2);
          assert.strictEqual(placed.worktree?.status, "ready");
          assert.deepInclude(placed.resources?.placement, {
            workerId: W2,
            reason: "offered the most RAM among ready workers",
          });
          assert.isNotNull(placed.resources?.grant);
          assert.deepStrictEqual(git.log, [`${W2}:base`, `${W2}:provision`]);
          assert.deepStrictEqual(
            capacity.claims.filter((claim) => claim.kind === "placement").map((c) => c.workerId),
            [W2],
          );
        }),
      );
    }),
  );

  it.effect("a denial moves on to the next candidate, which gets its own base checks", () =>
    Effect.gen(function* () {
      const capacity = yield* capacityOf([
        [W1, FULL],
        [W2, BIG],
      ]);
      // W2's last snapshot still shows room, but another board has taken it since.
      capacity.frozen.set(W2, (yield* capacity.client.latest(W2))!);
      capacity.external.set(W2, BIG);
      const git = newWorkerGit();
      const card = unplaced("card-1", "a");
      yield* run({ cards: [card], capacity, git }, (h) =>
        Effect.gen(function* () {
          yield* h.pumpDomain(movedToBuilding(card, 1));
          assert.deepStrictEqual(
            capacity.claims.filter((claim) => claim.kind === "placement").map((c) => c.workerId),
            [W2, W1],
          );
          assert.deepStrictEqual(git.log, [`${W2}:base`, `${W1}:base`, `${W1}:provision`]);
          assert.strictEqual((yield* cardIn(h, "card-1")).placedWorkerId, W1);
        }),
      );
    }),
  );

  it.effect("a transient base-check failure moves on with no claim; a stuck one parks", () =>
    Effect.gen(function* () {
      const capacity = yield* capacityOf([
        [W1, FULL],
        [W2, BIG],
      ]);
      const git = newWorkerGit();
      git.unreachableBase.add(W2);
      const card = unplaced("card-1", "a");
      yield* run({ cards: [card], capacity, git }, (h) =>
        Effect.gen(function* () {
          yield* h.pumpDomain(movedToBuilding(card, 1));
          // No claim was sent to W2: the checks run before it.
          assert.deepStrictEqual(
            capacity.claims.filter((claim) => claim.kind === "placement").map((c) => c.workerId),
            [W1],
          );
          assert.strictEqual((yield* cardIn(h, "card-1")).placedWorkerId, W1);
        }),
      );

      const stuckCapacity = yield* capacityOf([
        [W1, FULL],
        [W2, BIG],
      ]);
      const stuckGit = newWorkerGit();
      stuckGit.missingBase.add(W2);
      yield* run({ cards: [card], capacity: stuckCapacity, git: stuckGit }, (h) =>
        Effect.gen(function* () {
          yield* h.pumpDomain(movedToBuilding(card, 1));
          const state = boardCardStepState(yield* h.board, BoardCardId.make("card-1"));
          assert.strictEqual(state?.status, "stalled");
          assert.strictEqual(state?.stalledReason, "no-worktree");
          assert.deepStrictEqual(stuckGit.log, [`${W2}:base`]);
          assert.strictEqual(stuckCapacity.claims.length, 0);
        }),
      );
    }),
  );

  it.effect("a card placed but with no worktree is ranked again", () =>
    Effect.gen(function* () {
      const capacity = yield* capacityOf([
        [W1, FULL],
        [W2, BIG],
      ]);
      const git = newWorkerGit();
      const card = unplaced("card-1", "a", { placedWorkerId: W1 });
      yield* run({ cards: [card], capacity, git }, (h) =>
        Effect.gen(function* () {
          yield* h.pumpDomain(movedToBuilding(card, 1));
          assert.strictEqual((yield* cardIn(h, "card-1")).placedWorkerId, W2);
        }),
      );
    }),
  );

  it.effect("a pin restricts the candidates to the pinned worker", () =>
    Effect.gen(function* () {
      const capacity = yield* capacityOf([
        [W1, FULL],
        [W2, BIG],
      ]);
      const git = newWorkerGit();
      const card = unplaced("card-1", "a", { pinnedWorkerId: W1 });
      yield* run({ cards: [card], capacity, git }, (h) =>
        Effect.gen(function* () {
          yield* h.pumpDomain(movedToBuilding(card, 1));
          const placed = yield* cardIn(h, "card-1");
          assert.strictEqual(placed.placedWorkerId, W1);
          assert.strictEqual(placed.resources?.placement?.reason, "pinned");
        }),
      );
    }),
  );

  it.effect("a worker that built this repository in the last day wins over more room", () =>
    Effect.gen(function* () {
      const capacity = yield* capacityOf([
        [W1, FULL],
        [W2, BIG],
      ]);
      const git = newWorkerGit();
      const done = {
        ...makeBoardCard({ id: "card-done", stage: "done", orderKey: "z" }),
        threadLinks: [
          {
            threadId: ThreadId.make("thread-done"),
            role: "building",
            linkedAt: "2026-01-01T00:00:00.000Z",
            tombstonedAt: null,
            workerId: W1,
          },
        ],
      };
      const card = unplaced("card-1", "a");
      yield* run(
        {
          cards: [done, card],
          capacity,
          git,
          extra: {
            stepCompletions: [
              {
                cardId: BoardCardId.make("card-done"),
                stepId: "building",
                outcome: "succeeded",
                summary: "Built.",
                payload: null,
                threadId: ThreadId.make("thread-done"),
                // An hour before the harness clock's epoch.
                completedAt: "1969-12-31T23:00:00.000Z",
              },
            ],
          },
        },
        (h) =>
          Effect.gen(function* () {
            yield* h.pumpDomain(movedToBuilding(card, 1));
            const placed = yield* cardIn(h, "card-1");
            assert.strictEqual(placed.placedWorkerId, W1);
            assert.match(placed.resources?.placement?.reason ?? "", /most recently$/);
          }),
      );
    }),
  );

  it.effect("a card with a recorded branch starts from the remote branch, else from base", () =>
    Effect.gen(function* () {
      const reclaimed = (id: string) =>
        unplaced(id, "a", {
          worktree: { ...readyWorktree(id), path: null, status: "reclaimed" },
        });
      for (const onRemote of [true, false]) {
        const capacity = yield* capacityOf([[W1, FULL]]);
        const git = newWorkerGit();
        if (onRemote) git.remoteBranches.add("board/card-1");
        const card = reclaimed("card-1");
        yield* run({ cards: [card], capacity, git }, (h) =>
          Effect.gen(function* () {
            yield* h.pumpDomain(movedToBuilding(card, 1));
            assert.include(git.log, onRemote ? `${W1}:provision-from-remote` : `${W1}:provision`);
          }),
        );
      }
    }),
  );

  it.effect("a card with a worktree isn't re-placed while its worker exists", () =>
    Effect.gen(function* () {
      const capacity = yield* capacityOf([
        [W1, FULL],
        [W2, BIG],
      ]);
      const git = newWorkerGit();
      const card = {
        ...makeBoardCard({
          id: "card-1",
          stage: "building",
          orderKey: "a",
          worktree: readyWorktree("card-1"),
        }),
        placedWorkerId: W1,
      };
      yield* run({ cards: [card], capacity, git }, (h) =>
        Effect.gen(function* () {
          yield* h.pumpDomain(movedToBuilding(card, 1));
          const commands = yield* h.commands;
          assert.isFalse(commands.some((command) => command.type === "board.card.place"));
          const spawn = commands.find((command) => command.type === "thread.spawn");
          assert.isTrue(spawn?.type === "thread.spawn" && spawn.workerId === W1);
        }),
      );
    }),
  );

  it.effect("Start anyway places a card nothing has room for, with a force claim", () =>
    Effect.gen(function* () {
      const capacity = yield* capacityOf([
        [W1, FULL],
        [W2, BIG],
      ]);
      capacity.external.set(W1, FULL);
      capacity.external.set(W2, BIG);
      const git = newWorkerGit();
      const card = unplaced("card-1", "a");
      yield* run({ cards: [card], capacity, git }, (h) =>
        Effect.gen(function* () {
          yield* h.pumpDomain(movedToBuilding(card, 1));
          const waiting = boardCardStepState(yield* h.board, BoardCardId.make("card-1"));
          assert.strictEqual(waiting?.status, "queued");
          assert.strictEqual(waiting?.queuedBy, "capacity");
          // A human presses Start anyway.
          const forced = { ...waiting!, forceStart: true };
          yield* Ref.update(h.model, (model) => ({
            ...model,
            board: {
              ...model.board!,
              stepStates: (model.board!.stepStates ?? []).map((state) =>
                state.cardId === forced.cardId ? forced : state,
              ),
            },
          }));
          yield* h.pumpDomain({
            type: "board.card-step-force-start-requested",
            sequence: 2,
            payload: { cardId: forced.cardId, state: forced },
          } as never);
          const placed = yield* cardIn(h, "card-1");
          assert.isNotNull(placed.placedWorkerId);
          assert.strictEqual(placed.resources?.placement?.reason, "started anyway");
          assert.isTrue(capacity.claims.some((claim) => claim.force === true));
        }),
      );
    }),
  );

  it.effect("no worker ready for the project waits amber", () =>
    Effect.gen(function* () {
      const capacity = yield* capacityOf([]);
      const card = unplaced("card-1", "a");
      yield* withGovernor(
        {
          board: world([card]),
          settings: settingsWith({ building: [codexStep], globalMaxConcurrent: 9 }),
          placement: staticPlacement(
            workersState([
              workerView(W1, { checkout: false }),
              workerView(W2, { checkout: false }),
            ]),
          ),
          capacity,
          workspaces: loggingWorkspaces(newWorkerGit()),
        },
        (h) =>
          Effect.gen(function* () {
            yield* h.pumpDomain(movedToBuilding(card, 1));
            const waiting = boardCardStepState(yield* h.board, BoardCardId.make("card-1"));
            assert.strictEqual(waiting?.queuedBy, "no-ready-worker");
          }),
      );
    }),
  );
});

describe("holds at build start (T3O-87)", () => {
  const W3 = EnvironmentId.make("env-w3");
  const W4 = EnvironmentId.make("env-w4");
  const workers = [W1, W2, W3, W4];
  const fourWorkers = staticPlacement(workersState(workers.map((id) => workerView(id))));

  it.effect(
    "a card holds two workers, starts on whichever frees first and releases the other",
    () =>
      Effect.gen(function* () {
        const capacity = yield* capacityOf(workers.map((id) => [id, FULL] as const));
        // Every worker is taken by another board.
        for (const id of workers) capacity.external.set(id, CPU_RAM_TAKEN);
        const card = unplaced("card-1", "a");
        yield* withGovernor(
          {
            board: { ...world([card]), workers: workers.map((id) => registeredWorker(id)) },
            settings: settingsWith({ building: [codexStep], globalMaxConcurrent: 9 }),
            placement: fourWorkers,
            capacity,
            workspaces: loggingWorkspaces(newWorkerGit()),
          },
          (h) =>
            Effect.gen(function* () {
              yield* h.pumpDomain(movedToBuilding(card, 1));
              const held = [...new Set(capacity.holds.map((hold) => hold.workerId))];
              // Four ready workers allow a second hold.
              assert.strictEqual(held.length, 2);
              const waiting = boardCardStepState(yield* h.board, BoardCardId.make("card-1"));
              assert.strictEqual(waiting?.queuedBy, "holding");
              // Room frees on the second held worker.
              capacity.external.delete(held[1]!);
              yield* capacity.publish(held[1]!);
              yield* h.reactor.refreshHolds;
              yield* h.pumpDomain(movedToBuilding(unplaced("card-2", "z"), 2));
              const placed = yield* cardIn(h, "card-1");
              assert.strictEqual(placed.placedWorkerId, held[1]);
              assert.isTrue(
                capacity.claims.some((claim) => claim.cardId === "card-1" && claim.hold === true),
              );
              // The other hold goes at once.
              assert.deepStrictEqual(
                capacity.releasedHolds.filter((entry) => entry.cardId === "card-1"),
                [{ workerId: held[0]!, cardId: "card-1" }],
              );
            }),
        );
      }),
  );

  it.effect("a hold goes when its card leaves the queue, and a lapsed refusal is forgotten", () =>
    Effect.gen(function* () {
      const capacity = yield* capacityOf([[W1, FULL]]);
      capacity.external.set(W1, CPU_RAM_TAKEN);
      const card = unplaced("card-1", "a");
      yield* run({ cards: [card], capacity, git: newWorkerGit() }, (h) =>
        Effect.gen(function* () {
          yield* h.pumpDomain(movedToBuilding(card, 1));
          assert.strictEqual(
            boardCardStepState(yield* h.board, BoardCardId.make("card-1"))?.queuedBy,
            "holding",
          );
          // The card is archived: the next refresh withdraws its hold.
          yield* Ref.update(h.model, (model) => ({
            ...model,
            board: {
              ...model.board!,
              cards: model.board!.cards.map((candidate) =>
                candidate.id === card.id
                  ? { ...candidate, archivedAt: "1970-01-01T00:00:00.000Z" }
                  : candidate,
              ),
            },
          }));
          yield* h.reactor.refreshHolds;
          assert.deepStrictEqual(capacity.releasedHolds, [{ workerId: W1, cardId: "card-1" }]);
        }),
      );
    }),
  );

  it.effect(
    "after a restart, a hold the snapshot shows is kept only for a card still waiting",
    () =>
      Effect.gen(function* () {
        const capacity = yield* capacityOf([
          [W1, FULL],
          [W2, FULL],
        ]);
        const base = yield* capacity.client.latest(W1);
        const snapshotHolding = (cardId: string) => ({
          ...base!,
          hold: { closed: true, until: null, earlyStartFraction: 0.5, cardId },
        });
        capacity.frozen.set(W1, snapshotHolding("gone-card"));
        yield* run({ cards: [], capacity, git: newWorkerGit() }, (h) =>
          Effect.gen(function* () {
            yield* h.reactor.refreshHolds;
            assert.deepStrictEqual(capacity.releasedHolds, [{ workerId: W1, cardId: "gone-card" }]);
          }),
        );
      }),
  );
});
