/**
 * Concurrency governor end-to-end coverage (t3o-11, D11).
 *
 * The pure ordering and the slot-admission policy are unit-tested in
 * `supervisor.test.ts` and `BoardStepSlots.test.ts`; here we drive the live
 * reactor against a STATEFUL engine double — its `dispatch` runs the real board
 * decider + projector to evolve a `Ref`-held read model, so the reactor's own
 * `schedule` pass sees its own selects/admits/settles exactly as in production.
 * Domain and runtime events are fed through `Queue`s (buffered, so no
 * subscribe-before-publish race), and `reactor.drain` gates each assertion.
 *
 * The harness itself lives in `supervisorHarness.testkit.ts`, shared with the
 * t3o-12 building-stage acceptance suite (`buildingStageAutomation.test.ts`).
 *
 * The load-bearing test is the no-leak sweep: a slot leak silently halves
 * throughput forever, so we run a card through EVERY release path — success,
 * step failure, crash/death, and abandonment — and prove the held count returns
 * to baseline each time and zero after the whole run drains.
 */
import { BoardCardId, boardCardStepState, ProviderInstanceId } from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import {
  buildingCard,
  cardArchived,
  codexStep,
  movedToBuilding,
  settingsWith,
  stepCompleted,
  stepStatus,
  turnCompleted,
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

it.effect("maxConcurrent 1 runs two same-instance cards strictly sequentially", () =>
  withGovernor(
    {
      board: {
        cards: [buildingCard("card-a", "a"), buildingCard("card-b", "b")],
        nextCardNumberByProject: {},
      },
      settings: settingsWith({
        building: [codexStep],
        globalMaxConcurrent: 5,
        perInstance: { codex: 1 },
      }),
    },
    ({ slots, pumpDomain, board }) =>
      Effect.gen(function* () {
        yield* pumpDomain(movedToBuilding(buildingCard("card-a", "a"), 1));
        yield* pumpDomain(movedToBuilding(buildingCard("card-b", "b"), 2));
        // Only one codex slot: card-a runs, card-b holds in the queue.
        assert.strictEqual(yield* slots.heldFor(ProviderInstanceId.make("codex")), 1);
        const after = yield* board;
        assert.strictEqual(stepStatus(after, BoardCardId.make("card-a")), "running");
        assert.strictEqual(stepStatus(after, BoardCardId.make("card-b")), "queued");

        // card-a finishes → the freed slot goes to the queued card-b (D11).
        yield* pumpDomain(stepCompleted(BoardCardId.make("card-a"), "succeeded", 3));
        const promoted = yield* board;
        assert.strictEqual(stepStatus(promoted, BoardCardId.make("card-b")), "running");
        assert.strictEqual(yield* slots.heldFor(ProviderInstanceId.make("codex")), 1);
      }),
  ),
);

// (The "an idle provider is not blocked by a saturated one" guarantee is
// enforced by BoardStepSlots.acquire and unit-tested in BoardStepSlots.test.ts;
// it is not reproducible at the reactor level in the MVP because every Building
// card resolves the same single-stage recipe — per-card provider mixing is a
// multi-step/post-MVP recipe concern, D10/D4.)

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

        // ── step failure → recovery keeps the slot (not a leak, not premature
        //    release) → the eventual terminal (abandon) releases it ─────────
        yield* pumpDomain(movedToBuilding(buildingCard("fail", "b"), 3));
        assert.strictEqual(yield* slots.heldFor(codex), 1);
        yield* pumpDomain(stepCompleted(BoardCardId.make("fail"), "failed", 4));
        // A failed report enters recovery (retry) — the slot is HELD, so the
        // recovering card keeps its place rather than dropping out of the queue.
        assert.strictEqual(yield* slots.heldFor(codex), 1);
        assert.strictEqual(stepStatus(yield* board, BoardCardId.make("fail")), "running");
        yield* pumpDomain(cardArchived(buildingCard("fail", "b"), 5));
        assert.strictEqual(yield* slots.heldFor(codex), 0); // released at the terminal

        // ── crash / death → the step's thread vanishes; death detection
        //    recovers (respawns), still holding the slot → success releases ──
        yield* pumpDomain(movedToBuilding(buildingCard("crash", "c"), 6));
        assert.strictEqual(yield* slots.heldFor(codex), 1);
        const running = boardCardStepState(yield* board, BoardCardId.make("crash"));
        assert.strictEqual(running?.status, "running");
        // The thread is gone (never added to the shells map) → turn.completed
        // with no completion is death → recover, slot retained.
        yield* pumpRuntime(turnCompleted(running!.threadId!));
        assert.strictEqual(yield* slots.heldFor(codex), 1);
        assert.strictEqual(stepStatus(yield* board, BoardCardId.make("crash")), "running");
        yield* pumpDomain(stepCompleted(BoardCardId.make("crash"), "succeeded", 7));
        assert.strictEqual(yield* slots.heldFor(codex), 0); // released on eventual success

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
