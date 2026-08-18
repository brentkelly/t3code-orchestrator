import { ProviderInstanceId } from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { BoardStepSlots, BoardStepSlotsLive, type BoardConcurrencyLimit } from "./BoardStepSlots.ts";

const codex = ProviderInstanceId.make("codex");
const claude = ProviderInstanceId.make("claude");

/** No governance — used by the pure counting/leak assertions where admission
    policy is not under test. */
const UNCAPPED: BoardConcurrencyLimit = { perInstance: null, global: Number.MAX_SAFE_INTEGER };

it.effect("acquire admits and counts; release balances back to zero (no leaks)", () =>
  Effect.gen(function* () {
    const slots = yield* BoardStepSlots;
    assert.strictEqual(yield* slots.acquire(codex, UNCAPPED), true);
    assert.strictEqual(yield* slots.acquire(codex, UNCAPPED), true);
    assert.strictEqual(yield* slots.heldFor(codex), 2);

    yield* slots.release(codex);
    assert.strictEqual(yield* slots.heldFor(codex), 1);
    yield* slots.release(codex);
    assert.strictEqual(yield* slots.heldFor(codex), 0);
  }).pipe(Effect.provide(BoardStepSlotsLive)),
);

it.effect("release never drops a count below zero even if called too many times", () =>
  Effect.gen(function* () {
    const slots = yield* BoardStepSlots;
    yield* slots.release(codex);
    yield* slots.release(codex);
    assert.strictEqual(yield* slots.heldFor(codex), 0);
  }).pipe(Effect.provide(BoardStepSlotsLive)),
);

it.effect("counts slots per provider instance and totals across all", () =>
  Effect.gen(function* () {
    const slots = yield* BoardStepSlots;
    yield* slots.acquire(codex, UNCAPPED);
    yield* slots.acquire(claude, UNCAPPED);
    yield* slots.acquire(claude, UNCAPPED);
    assert.strictEqual(yield* slots.heldFor(codex), 1);
    assert.strictEqual(yield* slots.heldFor(claude), 2);
    assert.strictEqual(yield* slots.heldTotal, 3);

    // A full acquire/release cycle over many steps leaks nothing.
    yield* slots.release(codex);
    yield* slots.release(claude);
    yield* slots.release(claude);
    assert.strictEqual(yield* slots.heldTotal, 0);
  }).pipe(Effect.provide(BoardStepSlotsLive)),
);

// ── Governor policy (t3o-11, D11) ──────────────────────────────────────────

it.effect("the global ceiling caps total running steps across every instance", () =>
  Effect.gen(function* () {
    const slots = yield* BoardStepSlots;
    const limit: BoardConcurrencyLimit = { perInstance: null, global: 2 };
    assert.strictEqual(yield* slots.acquire(codex, limit), true);
    assert.strictEqual(yield* slots.acquire(claude, limit), true);
    // Third acquire on a fresh instance is still refused — the ceiling is on the
    // TOTAL, not per instance.
    assert.strictEqual(yield* slots.acquire(ProviderInstanceId.make("grok"), limit), false);
    assert.strictEqual(yield* slots.heldTotal, 2);

    // Releasing one frees exactly one slot back under the ceiling.
    yield* slots.release(codex);
    assert.strictEqual(yield* slots.acquire(ProviderInstanceId.make("grok"), limit), true);
    assert.strictEqual(yield* slots.heldTotal, 2);
  }).pipe(Effect.provide(BoardStepSlotsLive)),
);

it.effect("a per-instance cap bounds one instance without blocking another", () =>
  Effect.gen(function* () {
    const slots = yield* BoardStepSlots;
    // maxConcurrent: 1 on codex (the first verification bullet), plenty global.
    const codexCap: BoardConcurrencyLimit = { perInstance: 1, global: 5 };
    const claudeUncapped: BoardConcurrencyLimit = { perInstance: null, global: 5 };
    assert.strictEqual(yield* slots.acquire(codex, codexCap), true);
    // A second codex step must wait — strictly sequential on that instance.
    assert.strictEqual(yield* slots.acquire(codex, codexCap), false);
    // ...but a step whose provider has headroom is NOT blocked by codex being
    // saturated (the second verification bullet).
    assert.strictEqual(yield* slots.acquire(claude, claudeUncapped), true);
    assert.strictEqual(yield* slots.heldFor(codex), 1);
    assert.strictEqual(yield* slots.heldFor(claude), 1);

    // Once the codex slot frees, the next codex step is admitted.
    yield* slots.release(codex);
    assert.strictEqual(yield* slots.acquire(codex, codexCap), true);
  }).pipe(Effect.provide(BoardStepSlotsLive)),
);

it.effect("restore re-takes a slot unconditionally, ignoring the caps (boot reconcile)", () =>
  Effect.gen(function* () {
    const slots = yield* BoardStepSlots;
    // A restart restores steps that were running under an earlier, larger cap.
    // Restore must not be rejected by the current cap, or the ceiling would be
    // under-counted and the governor would over-admit.
    yield* slots.restore(codex);
    yield* slots.restore(codex);
    assert.strictEqual(yield* slots.heldFor(codex), 2);
    // With two already restored against a global of 2, the governor admits no
    // more until one drains.
    assert.strictEqual(
      yield* slots.acquire(claude, { perInstance: null, global: 2 }),
      false,
    );
    yield* slots.release(codex);
    yield* slots.release(codex);
    assert.strictEqual(yield* slots.heldTotal, 0);
  }).pipe(Effect.provide(BoardStepSlotsLive)),
);
