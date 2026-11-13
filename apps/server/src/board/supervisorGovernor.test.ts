/**
 * Governor end-to-end: the live reactor against a stateful engine double, so `schedule` sees
 * its own selects, admits and settles as in production. Every release path must leave no step
 * admitted; capacity (T3O-86) holds a card its worker has no room for.
 */
import {
  BOARD_LOCAL_WORKER_ID,
  BoardCardId,
  boardCardStepState,
  ProviderInstanceId,
} from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { makeFakeCapacity } from "./capacity/capacityClient.testkit.ts";
import {
  buildingCard,
  cardArchived,
  cardDeleted,
  codexStep,
  forceStartRequested,
  makeBoardCard,
  movedToBuilding,
  settingsWith,
  stepCompleted,
  stepStatus,
  turnCompleted,
  userInputRequested,
  withGovernor,
} from "./supervisorHarness.testkit.ts";

it.effect("admits a card's build step and holds one slot, then releases it on success", () =>
  withGovernor(
    {
      board: { cards: [buildingCard("card-1", "m")], nextCardNumberByProject: {} },
      settings: settingsWith({ building: [codexStep], globalMaxConcurrent: 3 }),
    },
    ({ slots, pumpDomain, board }) =>
      Effect.gen(function* () {
        yield* pumpDomain(movedToBuilding(buildingCard("card-1", "m"), 1));
        assert.strictEqual(yield* slots.heldTotal, 1);
        assert.strictEqual(stepStatus(yield* board, BoardCardId.make("card-1")), "running");

        yield* pumpDomain(stepCompleted(BoardCardId.make("card-1"), "succeeded", 2));
        assert.strictEqual(yield* slots.heldTotal, 0);
      }),
  ),
);

/** `local` with room for one default-sized card (2 cores of the 2/4/5 placeholder). */
const oneCardOfRoom = () =>
  makeFakeCapacity(new Map([[BOARD_LOCAL_WORKER_ID, { cpuCores: 3, ramGiB: 16, diskGB: 100 }]]));

it.effect("capacity runs two cards strictly in queue order on a worker with room for one", () =>
  Effect.flatMap(oneCardOfRoom(), (capacity) =>
    withGovernor(
      {
        board: {
          cards: [buildingCard("card-a", "a"), buildingCard("card-b", "b")],
          nextCardNumberByProject: {},
        },
        settings: settingsWith({ building: [codexStep], globalMaxConcurrent: 5 }),
        capacity,
      },
      ({ pumpDomain, board, reactor }) =>
        Effect.gen(function* () {
          yield* pumpDomain(movedToBuilding(buildingCard("card-a", "a"), 1));
          yield* pumpDomain(movedToBuilding(buildingCard("card-b", "b"), 2));
          const after = yield* board;
          assert.strictEqual(stepStatus(after, BoardCardId.make("card-a")), "running");
          assert.strictEqual(stepStatus(after, BoardCardId.make("card-b")), "queued");
          const waiting = boardCardStepState(after, BoardCardId.make("card-b"));
          assert.strictEqual(waiting?.queuedBy, "capacity");
          assert.deepStrictEqual(waiting?.queuedDetail, {
            workerId: BOARD_LOCAL_WORKER_ID,
            dimension: "cpu",
          });
          // Both cards already hold a worktree with no grant: each asks to grow, and card-a's
          // grant is on record at its whole profile.
          const grant = after.cards.find((card) => card.id === "card-a")?.resources?.grant;
          assert.deepStrictEqual(grant?.profile, { cpuCores: 2, ramGiB: 4, diskGB: 5 });
          assert.isTrue(grant?.heavy);
          assert.deepStrictEqual(
            capacity.claims.map((claim) => [claim.cardId, claim.kind]),
            [
              ["card-a", "grow"],
              ["card-b", "grow"],
            ],
          );

          // card-a's step ends; the capacity sweep releases it (card-b waits on that worker)
          // and places card-b.
          yield* pumpDomain(stepCompleted(BoardCardId.make("card-a"), "succeeded", 3));
          yield* reactor.sweep;
          assert.strictEqual(stepStatus(yield* board, BoardCardId.make("card-b")), "running");
        }),
    ),
  ),
);

it.effect("a force start places a queued card over capacity", () =>
  Effect.flatMap(oneCardOfRoom(), (capacity) =>
    withGovernor(
      {
        board: {
          cards: [buildingCard("card-a", "b"), buildingCard("card-b", "c")],
          nextCardNumberByProject: {},
        },
        settings: settingsWith({ building: [codexStep], globalMaxConcurrent: 1 }),
        capacity,
      },
      ({ pumpDomain, board }) =>
        Effect.gen(function* () {
          yield* pumpDomain(movedToBuilding(buildingCard("card-a", "b"), 1));
          yield* pumpDomain(movedToBuilding(buildingCard("card-b", "c"), 2));
          const queued = yield* board;
          assert.strictEqual(stepStatus(queued, BoardCardId.make("card-b")), "queued");
          const held = boardCardStepState(queued, BoardCardId.make("card-b"));
          yield* pumpDomain(forceStartRequested(held!, 3));
          const forced = yield* board;
          assert.strictEqual(stepStatus(forced, BoardCardId.make("card-b")), "running");
          assert.isTrue(capacity.claims.some((claim) => claim.cardId === "card-b" && claim.force));
          // Spent on admission, so the card's NEXT step waits normally.
          assert.strictEqual(
            boardCardStepState(forced, BoardCardId.make("card-b"))?.forceStart,
            false,
          );
        }),
    ),
  ),
);

it.effect("no slot leaks across success, failure, crash/death, and abandonment", () =>
  withGovernor(
    {
      board: {
        cards: [
          buildingCard("succ", "a"),
          buildingCard("fail", "b"),
          buildingCard("crash", "c"),
          buildingCard("abandon", "d"),
        ],
        nextCardNumberByProject: {},
      },
      settings: settingsWith({ building: [codexStep], globalMaxConcurrent: 5 }),
    },
    ({ slots, pumpDomain, pumpRuntime, board }) =>
      Effect.gen(function* () {
        const codex = ProviderInstanceId.make("codex");
        const baseline = yield* slots.heldTotal;
        assert.strictEqual(baseline, 0);

        // ── success ──────────────────────────────────────────────────────
        yield* pumpDomain(movedToBuilding(buildingCard("succ", "a"), 1));
        assert.strictEqual(yield* slots.heldFor(codex), 1);
        yield* pumpDomain(stepCompleted(BoardCardId.make("succ"), "succeeded", 2));
        assert.strictEqual(yield* slots.heldFor(codex), 0); // released

        // ── step failure → recovery parks for its backoff rung and GIVES THE
        //    SLOT BACK → the eventual terminal must not release it twice ────
        yield* pumpDomain(movedToBuilding(buildingCard("fail", "b"), 3));
        assert.strictEqual(yield* slots.heldFor(codex), 1);
        yield* pumpDomain(stepCompleted(BoardCardId.make("fail"), "failed", 4));
        // A failed report enters recovery, and a retry WAITS: the step parks with a `retryAt` and
        // releases its slot. `orderBoardQueue` puts the started card back ahead of fresh work.
        assert.strictEqual(yield* slots.heldFor(codex), 0);
        assert.strictEqual(stepStatus(yield* board, BoardCardId.make("fail")), "stalled");
        yield* pumpDomain(cardArchived(buildingCard("fail", "b"), 5));
        // Still zero, not minus one: the release is gated on the persisted
        // `slotHeld`, which the park already cleared.
        assert.strictEqual(yield* slots.heldFor(codex), 0);

        // ── crash / death → the step's thread vanishes; death detection parks
        //    it for a rung and releases the slot → a later success must not
        //    release it again ────────────────────────────────────────────────
        yield* pumpDomain(movedToBuilding(buildingCard("crash", "c"), 6));
        assert.strictEqual(yield* slots.heldFor(codex), 1);
        const running = boardCardStepState(yield* board, BoardCardId.make("crash"));
        assert.strictEqual(running?.status, "running");
        // The thread is gone (never added to the shells map) → turn.completed
        // with no completion is death → recovery parks it and the
        // slot goes back. The respawn happens when the rung arrives, through the
        // ordinary queue, which is where the slot is re-acquired.
        yield* pumpRuntime(turnCompleted(running!.threadId!));
        assert.strictEqual(yield* slots.heldFor(codex), 0);
        assert.strictEqual(stepStatus(yield* board, BoardCardId.make("crash")), "stalled");
        yield* pumpDomain(stepCompleted(BoardCardId.make("crash"), "succeeded", 7));
        assert.strictEqual(yield* slots.heldFor(codex), 0); // still zero, never negative

        // ── abandonment of a live running step ─────────────────────────────
        yield* pumpDomain(movedToBuilding(buildingCard("abandon", "d"), 8));
        assert.strictEqual(yield* slots.heldFor(codex), 1);
        yield* pumpDomain(cardArchived(buildingCard("abandon", "d"), 9));
        assert.strictEqual(yield* slots.heldFor(codex), 0); // released

        // Over the whole run, accounting reconciles exactly to baseline.
        assert.strictEqual(yield* slots.heldTotal, baseline);
      }),
  ),
);

it.effect("a card DELETE deletes the running step's threads", () =>
  withGovernor(
    {
      board: { cards: [buildingCard("doomed", "m")], nextCardNumberByProject: {} },
      settings: settingsWith({ building: [codexStep], globalMaxConcurrent: 3 }),
    },
    ({ slots, pumpDomain, board, commands }) =>
      Effect.gen(function* () {
        yield* pumpDomain(movedToBuilding(buildingCard("doomed", "m"), 1));
        assert.strictEqual(yield* slots.heldTotal, 1);
        const running = boardCardStepState(yield* board, BoardCardId.make("doomed"));
        assert.strictEqual(running?.status, "running");
        const spawned = running!.threadId!;

        const deleted = (yield* board).cards.find(
          (card) => card.id === BoardCardId.make("doomed"),
        )!;
        yield* pumpDomain(cardDeleted(deleted, 2, running!));

        const dispatched = yield* commands;
        assert.deepStrictEqual(
          dispatched
            .filter((command) => command.type === "thread.delete")
            .map((command) => command.threadId),
          [spawned],
        );
      }),
  ),
);

it.effect(
  "t3o-18 AC 18: an ordinary agent question parks the step on the gate with no board tool call",
  () =>
    withGovernor(
      {
        board: { cards: [buildingCard("asks", "m")], nextCardNumberByProject: {} },
        settings: settingsWith({ building: [codexStep], globalMaxConcurrent: 3 }),
      },
      ({ pumpDomain, pumpRuntime, board }) =>
        Effect.gen(function* () {
          yield* pumpDomain(movedToBuilding(buildingCard("asks", "m"), 1));
          const running = boardCardStepState(yield* board, BoardCardId.make("asks"));
          assert.strictEqual(running?.status, "running");

          // The agent asks through its own question mechanism. It calls NO board
          // tool — the exact case that used to leave the board blind, because
          // `board_request_input` was the only signal and agents skipped it.
          yield* pumpRuntime(userInputRequested(running!.threadId!));
          assert.strictEqual(stepStatus(yield* board, BoardCardId.make("asks")), "awaiting-input");
        }),
    ),
);

/** A card in Building with no worktree yet, of the given CPU size. */
const unplaced = (id: string, orderKey: string, cpu: "S" | "M" | "L" | "XL" = "M") => ({
  ...makeBoardCard({ id, stage: "building", orderKey, worktree: null }),
  resources: {
    sizing: { planner: null, edit: { size: { cpu, ram: "M", disk: "M" }, by: "human" } },
    grant: null,
    setup: null,
  } as const,
});

it.effect("after a capacity denial no later card is placed on that worker in the pass", () =>
  Effect.flatMap(
    makeFakeCapacity(new Map([[BOARD_LOCAL_WORKER_ID, { cpuCores: 4, ramGiB: 64, diskGB: 100 }]])),
    (capacity) => {
      // a takes 2 cores, b (XL, 3 cores) doesn't fit the 2 left, and c (S, 1.5) would.
      const cards = [unplaced("a", "a"), unplaced("b", "b", "XL"), unplaced("c", "c", "S")];
      return withGovernor(
        {
          board: { cards, nextCardNumberByProject: {} },
          settings: settingsWith({ building: [codexStep], globalMaxConcurrent: 9 }),
          capacity,
        },
        ({ pumpDomain, board }) =>
          Effect.gen(function* () {
            for (const [index, card] of cards.entries()) {
              yield* pumpDomain(movedToBuilding(card, index + 1));
            }
            const after = yield* board;
            assert.strictEqual(stepStatus(after, BoardCardId.make("a")), "running");
            assert.strictEqual(
              boardCardStepState(after, BoardCardId.make("b"))?.queuedBy,
              "capacity",
            );
            const behind = boardCardStepState(after, BoardCardId.make("c"));
            assert.strictEqual(behind?.status, "queued");
            assert.deepStrictEqual(behind?.queuedDetail, {
              workerId: BOARD_LOCAL_WORKER_ID,
              behindCardId: BoardCardId.make("b"),
            });
            // The local filter caught b: no claim was sent for b or c.
            assert.deepStrictEqual(
              capacity.claims.map((claim) => claim.cardId),
              ["a"],
            );
          }),
      );
    },
  ),
);

it.effect("a Too-big card at the head of the queue doesn't hold up the card behind it", () =>
  Effect.flatMap(
    makeFakeCapacity(
      new Map([[BOARD_LOCAL_WORKER_ID, { cpuCores: 2.5, ramGiB: 64, diskGB: 100 }]]),
    ),
    (capacity) => {
      const cards = [unplaced("big", "a", "XL"), unplaced("small", "b")];
      return withGovernor(
        {
          board: { cards, nextCardNumberByProject: {} },
          settings: settingsWith({ building: [codexStep], globalMaxConcurrent: 9 }),
          capacity,
        },
        ({ pumpDomain, board }) =>
          Effect.gen(function* () {
            for (const [index, card] of cards.entries()) {
              yield* pumpDomain(movedToBuilding(card, index + 1));
            }
            const after = yield* board;
            assert.deepStrictEqual(
              boardCardStepState(after, BoardCardId.make("big"))?.queuedDetail,
              {
                workerId: BOARD_LOCAL_WORKER_ID,
                dimension: "cpu",
                tooBig: true,
              },
            );
            assert.strictEqual(stepStatus(after, BoardCardId.make("small")), "running");
            assert.isNull(after.cards.find((card) => card.id === "big")?.worktree ?? null);
          }),
      );
    },
  ),
);
