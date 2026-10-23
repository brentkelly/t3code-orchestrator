import { BOARD_LOCAL_WORKER_ID, EnvironmentId, ProviderInstanceId } from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import {
  BoardStepSlots,
  BoardStepSlotsLive,
  type BoardConcurrencyLimit,
  type BoardSlotKey,
} from "./BoardStepSlots.ts";

const codex = ProviderInstanceId.make("codex");
const claude = ProviderInstanceId.make("claude");
const grok = ProviderInstanceId.make("grok");
const linuxBox = EnvironmentId.make("env-linux-box");

const here = (providerInstanceId: ProviderInstanceId): BoardSlotKey => ({
  workerId: BOARD_LOCAL_WORKER_ID,
  providerInstanceId,
});
const onLinuxBox = (providerInstanceId: ProviderInstanceId): BoardSlotKey => ({
  workerId: linuxBox,
  providerInstanceId,
});

const ADMITTED = { admitted: true } as const;
const blocked = (blockedBy: "board" | "worker" | "provider") =>
  ({ admitted: false, blockedBy }) as const;

/** No governance — used by the pure counting/leak assertions where admission
    policy is not under test. */
const UNCAPPED: BoardConcurrencyLimit = {
  global: Number.MAX_SAFE_INTEGER,
  worker: null,
  perInstance: null,
};

it.effect("acquire admits and counts; release balances back to zero (no leaks)", () =>
  Effect.gen(function* () {
    const slots = yield* BoardStepSlots;
    assert.deepStrictEqual(yield* slots.acquire(here(codex), UNCAPPED), ADMITTED);
    assert.deepStrictEqual(yield* slots.acquire(here(codex), UNCAPPED), ADMITTED);
    assert.strictEqual(yield* slots.heldFor(codex), 2);

    yield* slots.release(here(codex));
    assert.strictEqual(yield* slots.heldFor(codex), 1);
    yield* slots.release(here(codex));
    assert.strictEqual(yield* slots.heldFor(codex), 0);
  }).pipe(Effect.provide(BoardStepSlotsLive)),
);

it.effect("release never drops a count below zero even if called too many times", () =>
  Effect.gen(function* () {
    const slots = yield* BoardStepSlots;
    yield* slots.release(here(codex));
    yield* slots.release(here(codex));
    assert.strictEqual(yield* slots.heldFor(codex), 0);
  }).pipe(Effect.provide(BoardStepSlotsLive)),
);

it.effect("counts slots per worker and instance, and totals across all", () =>
  Effect.gen(function* () {
    const slots = yield* BoardStepSlots;
    yield* slots.acquire(here(codex), UNCAPPED);
    yield* slots.acquire(here(claude), UNCAPPED);
    yield* slots.acquire(onLinuxBox(claude), UNCAPPED);
    assert.strictEqual(yield* slots.heldFor(codex), 1);
    assert.strictEqual(yield* slots.heldFor(claude), 1);
    // The same instance id on another machine is another account: counted apart.
    assert.strictEqual(yield* slots.heldFor(claude, linuxBox), 1);
    assert.strictEqual(yield* slots.heldOnWorker(BOARD_LOCAL_WORKER_ID), 2);
    assert.strictEqual(yield* slots.heldOnWorker(linuxBox), 1);
    assert.strictEqual(yield* slots.heldTotal, 3);

    // A full acquire/release cycle over many steps leaks nothing.
    yield* slots.release(here(codex));
    yield* slots.release(here(claude));
    yield* slots.release(onLinuxBox(claude));
    assert.strictEqual(yield* slots.heldTotal, 0);
  }).pipe(Effect.provide(BoardStepSlotsLive)),
);

// ── Governor policy (t3o-11, D11; T3O-65) ──────────────────────────────────

it.effect("the board limit caps total running steps across every worker and instance", () =>
  Effect.gen(function* () {
    const slots = yield* BoardStepSlots;
    const limit: BoardConcurrencyLimit = { global: 2, worker: null, perInstance: null };
    assert.deepStrictEqual(yield* slots.acquire(here(codex), limit), ADMITTED);
    assert.deepStrictEqual(yield* slots.acquire(onLinuxBox(claude), limit), ADMITTED);
    // A third on a fresh instance and worker is still refused — the ceiling is
    // on the TOTAL — and the card says the board is what is full.
    assert.deepStrictEqual(yield* slots.acquire(here(grok), limit), blocked("board"));
    assert.strictEqual(yield* slots.heldTotal, 2);

    // Releasing one frees exactly one slot back under the ceiling.
    yield* slots.release(here(codex));
    assert.deepStrictEqual(yield* slots.acquire(here(grok), limit), ADMITTED);
    assert.strictEqual(yield* slots.heldTotal, 2);
  }).pipe(Effect.provide(BoardStepSlotsLive)),
);

it.effect("a worker limit bounds one worker without blocking another", () =>
  Effect.gen(function* () {
    const slots = yield* BoardStepSlots;
    const oneHere: BoardConcurrencyLimit = { global: 8, worker: 1, perInstance: null };
    const fourThere: BoardConcurrencyLimit = { global: 8, worker: 4, perInstance: null };
    assert.deepStrictEqual(yield* slots.acquire(here(codex), oneHere), ADMITTED);
    // A different instance on the same worker still waits on the worker.
    assert.deepStrictEqual(yield* slots.acquire(here(claude), oneHere), blocked("worker"));
    // Another worker has room.
    assert.deepStrictEqual(yield* slots.acquire(onLinuxBox(codex), fourThere), ADMITTED);
    yield* slots.release(here(codex));
    assert.deepStrictEqual(yield* slots.acquire(here(claude), oneHere), ADMITTED);
  }).pipe(Effect.provide(BoardStepSlotsLive)),
);

it.effect("a provider cap bounds one instance on one worker without blocking another", () =>
  Effect.gen(function* () {
    const slots = yield* BoardStepSlots;
    // maxConcurrent: 1 on codex (the first verification bullet), plenty global.
    const codexCap: BoardConcurrencyLimit = { global: 5, worker: null, perInstance: 1 };
    const claudeUncapped: BoardConcurrencyLimit = { global: 5, worker: null, perInstance: null };
    assert.deepStrictEqual(yield* slots.acquire(here(codex), codexCap), ADMITTED);
    // A second codex step must wait — strictly sequential on that instance.
    assert.deepStrictEqual(yield* slots.acquire(here(codex), codexCap), blocked("provider"));
    // ...but a step whose provider has headroom is NOT blocked by codex being
    // saturated (the second verification bullet), nor is codex on another
    // worker, which is a different account.
    assert.deepStrictEqual(yield* slots.acquire(here(claude), claudeUncapped), ADMITTED);
    assert.deepStrictEqual(yield* slots.acquire(onLinuxBox(codex), codexCap), ADMITTED);
    assert.strictEqual(yield* slots.heldFor(codex), 1);
    assert.strictEqual(yield* slots.heldFor(claude), 1);

    // Once the codex slot frees, the next codex step is admitted.
    yield* slots.release(here(codex));
    assert.deepStrictEqual(yield* slots.acquire(here(codex), codexCap), ADMITTED);
  }).pipe(Effect.provide(BoardStepSlotsLive)),
);

it.effect("a refusal names the narrowest full ceiling", () =>
  Effect.gen(function* () {
    const slots = yield* BoardStepSlots;
    const tight: BoardConcurrencyLimit = { global: 1, worker: 1, perInstance: 1 };
    assert.deepStrictEqual(yield* slots.acquire(here(codex), tight), ADMITTED);
    // All three are full: only codex freeing on this worker helps, so it is
    // the provider that is named.
    assert.deepStrictEqual(yield* slots.acquire(here(codex), tight), blocked("provider"));
    // Another instance here: its cap has room, the worker does not.
    assert.deepStrictEqual(yield* slots.acquire(here(claude), tight), blocked("worker"));
    // Another worker: only the board is full.
    assert.deepStrictEqual(yield* slots.acquire(onLinuxBox(claude), tight), blocked("board"));
  }).pipe(Effect.provide(BoardStepSlotsLive)),
);

it.effect("restore re-takes a slot unconditionally, ignoring the caps (boot reconcile)", () =>
  Effect.gen(function* () {
    const slots = yield* BoardStepSlots;
    // A restart restores steps that were running under an earlier, larger cap.
    // Restore must not be rejected by the current cap, or the ceiling would be
    // under-counted and the governor would over-admit.
    yield* slots.restore(here(codex));
    yield* slots.restore(onLinuxBox(codex));
    assert.strictEqual(yield* slots.heldFor(codex), 1);
    assert.strictEqual(yield* slots.heldFor(codex, linuxBox), 1);
    // A restored slot counts against its own worker's limit…
    assert.deepStrictEqual(
      yield* slots.acquire(onLinuxBox(claude), { global: 9, worker: 1, perInstance: null }),
      blocked("worker"),
    );
    // …and, with a global of 2, the governor admits no more anywhere.
    assert.deepStrictEqual(
      yield* slots.acquire(here(claude), { global: 2, worker: null, perInstance: null }),
      blocked("board"),
    );
    yield* slots.release(here(codex));
    yield* slots.release(onLinuxBox(codex));
    assert.strictEqual(yield* slots.heldTotal, 0);
  }).pipe(Effect.provide(BoardStepSlotsLive)),
);
