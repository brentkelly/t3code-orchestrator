/**
 * T3O-23: the supervisor retires a worktree before removing it.
 *
 * The retirement itself (stop, check, remove scripts, remove) is proven in
 * `worktreeRetire.test.ts`. Here: what the board does with its answers — a
 * process still running keeps the worktree and says why, a remove script's
 * failure reaches the card's rail, and a card delete does not wait for it.
 */
import {
  BOARD_SEED_STAGE_IDS,
  BoardCardId,
  boardCardStepState,
  type BoardCard,
  type OrchestrationCommand,
  type OrchestrationEvent,
} from "@t3tools/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";

import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import {
  buildingCard,
  cardArchived,
  cardDeleted,
  codexStep,
  makeBoardCard,
  movedToBuilding,
  readyWorktree,
  settingsWith,
  withGovernor,
} from "./supervisorHarness.testkit.ts";
import { WorktreeRetirer, type WorktreeRetireInput } from "./worktreeRetire.ts";
import { worktreeRetirerTestLayer } from "./worktreeRetire.testkit.ts";

const settings = () =>
  settingsWith({ building: [codexStep], globalMaxConcurrent: 4, reclaimWorktreeOnDone: true });

const doneCard = (overrides: Partial<Parameters<typeof makeBoardCard>[0]> = {}): BoardCard =>
  makeBoardCard({
    id: "card-1",
    stage: String(BOARD_SEED_STAGE_IDS.done),
    orderKey: "d",
    worktree: readyWorktree("card-1"),
    ...overrides,
  });

const reclaims = (commands: ReadonlyArray<OrchestrationCommand>) =>
  commands.flatMap((command) => (command.type === "board.card.reclaim-worktree" ? [command] : []));

const reclaimedEvents = (events: ReadonlyArray<OrchestrationEvent>) =>
  events.flatMap((event) => (event.type === "board.card-worktree-reclaimed" ? [event] : []));

const HOOK_WARNING = 'Remove script "park" exited with code 1';

/** A retirer whose remove script always fails, after a real (stubbed) removal. */
const failingHookRetirer = Layer.effect(
  WorktreeRetirer,
  Effect.gen(function* () {
    const git = yield* GitVcsDriver.GitVcsDriver;
    return WorktreeRetirer.of({
      retire: (input) =>
        git
          .removeWorktree({ cwd: input.projectCwd, path: input.worktreePath, force: true })
          .pipe(Effect.as({ outcome: "removed" as const, hookWarning: HOOK_WARNING })),
    });
  }),
);

describe("a process still running in the worktree (T3O-23)", () => {
  it.effect("keeps a Done card's worktree, naming the process, and Check again retries", () =>
    withGovernor(
      {
        board: { nextCardNumberByProject: {}, cards: [doneCard()] },
        settings: settings(),
        pullRequest: null,
        // The boot sweep finds cargo still building; by Check again it has exited.
        worktreeRetirer: worktreeRetirerTestLayer({
          survivors: [[{ pid: 4412, name: "cargo" }], []],
        }),
      },
      (h) =>
        Effect.gen(function* () {
          yield* h.reactor.drainWorktreeSweep;
          assert.deepEqual(yield* h.removedWorktrees, []);
          const kept = (yield* h.board).cards[0]!;
          assert.equal(kept.worktree?.status, "ready");
          assert.equal(
            kept.worktree?.reclaimBlockedReason,
            "cargo (pid 4412) is still running in the worktree",
          );

          const result = yield* h.reactor.checkWorktree(kept.id);
          assert.deepEqual(result, { outcome: "removed" });
          assert.deepEqual(yield* h.removedWorktrees, ["/tmp/wt/card-1"]);
        }),
    ),
  );
});

describe("a failing remove script (T3O-23)", () => {
  it.effect("still reclaims at Done, and the reclaim carries the warning to the rail", () =>
    withGovernor(
      {
        board: { nextCardNumberByProject: {}, cards: [doneCard()] },
        settings: settings(),
        pullRequest: null,
        worktreeRetirer: failingHookRetirer,
      },
      (h) =>
        Effect.gen(function* () {
          yield* h.reactor.drainWorktreeSweep;
          assert.deepEqual(yield* h.removedWorktrees, ["/tmp/wt/card-1"]);
          assert.equal((yield* h.board).cards[0]!.worktree?.status, "reclaimed");
          assert.equal(reclaims(yield* h.commands).at(-1)?.hookWarning, HOOK_WARNING);
          const event = reclaimedEvents(yield* h.decided).at(-1)!;
          assert.equal(event.payload.outcome, "removed");
          assert.equal(event.payload.hookWarning, HOOK_WARNING);
        }),
    ),
  );

  it.effect("still force-removes, and the forced removal carries the warning", () =>
    withGovernor(
      {
        board: { nextCardNumberByProject: {}, cards: [doneCard()] },
        settings: settings(),
        pullRequest: null,
        worktreeDirty: true,
        worktreeRetirer: failingHookRetirer,
      },
      (h) =>
        Effect.gen(function* () {
          yield* h.reactor.drainWorktreeSweep;
          const card = (yield* h.board).cards[0]!;
          assert.deepEqual(yield* h.reactor.forceRemoveWorktree(card.id), { outcome: "removed" });
          const event = reclaimedEvents(yield* h.decided).at(-1)!;
          assert.equal(event.payload.forced, true);
          assert.equal(event.payload.hookWarning, HOOK_WARNING);
        }),
    ),
  );
});

describe("card delete (T3O-23)", () => {
  it.effect("queues the forced retirement and moves on without waiting for the hook", () => {
    const calls: Array<WorktreeRetireInput> = [];
    let started: Deferred.Deferred<void> | undefined;
    let release: Deferred.Deferred<void> | undefined;
    const blockingRetirer = Layer.effect(
      WorktreeRetirer,
      Effect.gen(function* () {
        const git = yield* GitVcsDriver.GitVcsDriver;
        return WorktreeRetirer.of({
          retire: (input) =>
            Effect.gen(function* () {
              calls.push(input);
              yield* Deferred.succeed(started!, undefined);
              yield* Deferred.await(release!);
              yield* git.removeWorktree({ cwd: input.projectCwd, path: input.worktreePath });
              return { outcome: "removed" as const, hookWarning: HOOK_WARNING };
            }),
        });
      }),
    );
    return withGovernor(
      {
        board: {
          cards: [buildingCard("doomed", "m"), buildingCard("waiting", "n")],
          nextCardNumberByProject: {},
        },
        // One slot: `waiting` can only start once the delete releases it.
        settings: settingsWith({ building: [codexStep], globalMaxConcurrent: 1 }),
        worktreeRetirer: blockingRetirer,
      },
      (h) =>
        Effect.gen(function* () {
          started = yield* Deferred.make<void>();
          release = yield* Deferred.make<void>();
          yield* h.pumpDomain(movedToBuilding(buildingCard("doomed", "m"), 1));
          yield* h.pumpDomain(movedToBuilding(buildingCard("waiting", "n"), 2));
          const board = yield* h.board;
          const running = boardCardStepState(board, BoardCardId.make("doomed"))!;
          assert.equal(running.status, "running");
          assert.equal(boardCardStepState(board, BoardCardId.make("waiting"))?.status, "queued");
          const doomed = board.cards.find((card) => card.id === BoardCardId.make("doomed"))!;

          // The pump drains the cleanup worker too, so it waits on the retirement.
          const pump = yield* Effect.forkChild(h.pumpDomain(cardDeleted(doomed, 3, running)));
          yield* Deferred.await(started);
          assert.deepEqual(
            calls.map((call) => [call.worktreePath, call.kind, call.verifiedClean]),
            [["/tmp/wt/doomed", "forced", false]],
          );
          // The handler finished while the hook is still running: the freed slot
          // already went to the waiting card, and nothing was removed yet.
          assert.equal(
            boardCardStepState(yield* h.board, BoardCardId.make("waiting"))?.status,
            "running",
          );
          assert.deepEqual(yield* h.removedWorktrees, []);

          yield* Deferred.succeed(release, undefined);
          yield* Fiber.join(pump);
          assert.deepEqual(yield* h.removedWorktrees, ["/tmp/wt/doomed"]);
        }),
    );
  });

  it.effect("an archive reclaim does not wait behind a deleted card's remove scripts", () => {
    let started: Deferred.Deferred<void> | undefined;
    let release: Deferred.Deferred<void> | undefined;
    let otherRemoved: Deferred.Deferred<void> | undefined;
    // Only the deleted card's retirement hangs; any other removes at once.
    const hangingRetirer = Layer.effect(
      WorktreeRetirer,
      Effect.gen(function* () {
        const git = yield* GitVcsDriver.GitVcsDriver;
        return WorktreeRetirer.of({
          retire: (input) =>
            Effect.gen(function* () {
              const doomed = input.worktreePath === "/tmp/wt/doomed";
              if (doomed) {
                yield* Deferred.succeed(started!, undefined);
                yield* Deferred.await(release!);
              }
              yield* git.removeWorktree({ cwd: input.projectCwd, path: input.worktreePath });
              if (!doomed) yield* Deferred.succeed(otherRemoved!, undefined);
              return { outcome: "removed" as const, hookWarning: null };
            }),
        });
      }),
    );
    // Shelved in Backlog: nothing reclaims it before its archive does.
    const shelved = doneCard({ stage: String(BOARD_SEED_STAGE_IDS.backlog) });
    return withGovernor(
      {
        board: { cards: [buildingCard("doomed", "m"), shelved], nextCardNumberByProject: {} },
        settings: settings(),
        pullRequest: null,
        worktreeRetirer: hangingRetirer,
      },
      (h) =>
        Effect.gen(function* () {
          started = yield* Deferred.make<void>();
          release = yield* Deferred.make<void>();
          otherRemoved = yield* Deferred.make<void>();
          yield* h.pumpDomain(movedToBuilding(buildingCard("doomed", "m"), 1));
          const board = yield* h.board;
          const running = boardCardStepState(board, BoardCardId.make("doomed"))!;
          const doomed = board.cards.find((card) => card.id === BoardCardId.make("doomed"))!;

          const deleted = yield* Effect.forkChild(h.pumpDomain(cardDeleted(doomed, 2, running)));
          yield* Deferred.await(started);
          assert.deepEqual(yield* h.removedWorktrees, []);
          const archived = yield* Effect.forkChild(h.pumpDomain(cardArchived(shelved, 3)));
          // Hangs here if the reclaim is queued behind the hanging retirement.
          yield* Deferred.await(otherRemoved);
          assert.deepEqual(yield* h.removedWorktrees, ["/tmp/wt/card-1"]);

          yield* Deferred.succeed(release, undefined);
          yield* Fiber.join(deleted);
          yield* Fiber.join(archived);
          assert.deepEqual(yield* h.removedWorktrees, ["/tmp/wt/card-1", "/tmp/wt/doomed"]);
        }),
    );
  });
});
