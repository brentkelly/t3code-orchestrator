import { ProviderInstanceId } from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { BoardStepSlots, BoardStepSlotsLive } from "./BoardStepSlots.ts";

const codex = ProviderInstanceId.make("codex");
const claude = ProviderInstanceId.make("claude");

it.effect("acquire admits and counts; release balances back to zero (no leaks)", () =>
  Effect.gen(function* () {
    const slots = yield* BoardStepSlots;
    assert.strictEqual(yield* slots.acquire(codex), true);
    assert.strictEqual(yield* slots.acquire(codex), true);
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
    yield* slots.acquire(codex);
    yield* slots.acquire(claude);
    yield* slots.acquire(claude);
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
