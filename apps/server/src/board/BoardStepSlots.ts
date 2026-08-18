/**
 * T3o board concurrency slots + admission policy (t3o-10 counting, t3o-11
 * governance, D11).
 *
 * The supervisor reactor acquires a slot before spawning a step's thread and
 * releases it at every terminal outcome — success, failure, crash and
 * abandonment. A leaked slot silently halves throughput and is very hard to
 * notice, so release is centralised here and the held count is observable
 * (`heldFor`) for leak assertions.
 *
 * The governor's POLICY lives in `acquire` (t3o-11): admission is gated by a
 * per-instance `maxConcurrent` and a global ceiling. The check-and-increment is
 * a single atomic `modify`, so two step-boundary schedules racing for the last
 * slot can never both win. `acquire` is the sole source of truth for the
 * limit — the reactor orders candidates by priority and offers each to
 * `acquire`, which enforces the caps — so per-instance saturation on one vendor
 * never blocks a candidate whose step targets a vendor with headroom.
 */
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SynchronizedRef from "effect/SynchronizedRef";
import type { ProviderInstanceId } from "@t3tools/contracts";

/** Resolved concurrency caps for one admission attempt (D11): the per-instance
    ceiling for this provider (`null` = no instance-specific cap, fall back to
    the global one) and the board-wide global ceiling on total running steps. */
export interface BoardConcurrencyLimit {
  readonly perInstance: number | null;
  readonly global: number;
}

export interface BoardStepSlotsShape {
  /**
   * Try to acquire a slot for a provider instance under the given caps (D11).
   * Admits iff the total held is below the global ceiling AND this instance is
   * below its per-instance cap; increments and returns `true` on admission,
   * leaves the counts untouched and returns `false` otherwise. A `false` leaves
   * the step `queued` — visible on the card, never lying about its state.
   */
  readonly acquire: (
    providerInstanceId: ProviderInstanceId,
    limits: BoardConcurrencyLimit,
  ) => Effect.Effect<boolean>;
  /** Unconditionally re-take a slot a step already held before a restart. The
      in-memory Ref is empty after a crash, so boot reconciliation must restore
      every still-running step's slot BEFORE the governor admits anything — and
      it restores unconditionally (never rejected by a cap), because the step
      genuinely holds that slot and dropping it would under-count and let the
      governor over-admit past the ceiling. Separate from `acquire` so the
      admission policy is never accidentally bypassed on the live path. */
  readonly restore: (providerInstanceId: ProviderInstanceId) => Effect.Effect<void>;
  /** Release a held slot. Floors the count at zero, so a double-release (a
      crash and a settle racing to release the same step) never drives the
      count negative — callers gate on `BoardCardStepState.slotHeld` and this is
      the belt-and-braces backstop. */
  readonly release: (providerInstanceId: ProviderInstanceId) => Effect.Effect<void>;
  /** Currently held slots for an instance — for leak assertions and the
      governor. */
  readonly heldFor: (providerInstanceId: ProviderInstanceId) => Effect.Effect<number>;
  /** Total held slots across all instances. */
  readonly heldTotal: Effect.Effect<number>;
}

export class BoardStepSlots extends Context.Service<BoardStepSlots, BoardStepSlotsShape>()(
  "t3/board/BoardStepSlots",
) {}

const totalHeld = (current: Record<string, number>): number =>
  Object.values(current).reduce((sum, count) => sum + count, 0);

const make = Effect.gen(function* () {
  const held = yield* SynchronizedRef.make<Record<string, number>>({});

  const acquire: BoardStepSlotsShape["acquire"] = (providerInstanceId, limits) =>
    SynchronizedRef.modify(held, (current) => {
      const instanceCount = current[providerInstanceId] ?? 0;
      const admit =
        totalHeld(current) < limits.global &&
        (limits.perInstance === null || instanceCount < limits.perInstance);
      return admit
        ? [true, { ...current, [providerInstanceId]: instanceCount + 1 }]
        : [false, current];
    });

  const restore: BoardStepSlotsShape["restore"] = (providerInstanceId) =>
    SynchronizedRef.update(held, (current) => ({
      ...current,
      [providerInstanceId]: (current[providerInstanceId] ?? 0) + 1,
    }));

  const release: BoardStepSlotsShape["release"] = (providerInstanceId) =>
    SynchronizedRef.update(held, (current) => {
      const next = Math.max(0, (current[providerInstanceId] ?? 0) - 1);
      return { ...current, [providerInstanceId]: next };
    });

  const heldFor: BoardStepSlotsShape["heldFor"] = (providerInstanceId) =>
    SynchronizedRef.get(held).pipe(Effect.map((current) => current[providerInstanceId] ?? 0));

  const heldTotal = SynchronizedRef.get(held).pipe(Effect.map(totalHeld));

  return { acquire, restore, release, heldFor, heldTotal } satisfies BoardStepSlotsShape;
});

export const BoardStepSlotsLive = Layer.effect(BoardStepSlots, make);
