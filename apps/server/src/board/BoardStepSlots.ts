/**
 * T3o board concurrency slots (t3o-10, D11).
 *
 * The supervisor reactor acquires a slot before spawning a step's thread and
 * releases it at every terminal outcome — success, failure, crash and
 * abandonment. A leaked slot silently halves throughput and is very hard to
 * notice, so release is centralised here and the held count is observable
 * (`heldFor`) for leak assertions.
 *
 * This spec only *acquires and releases*; the governor's POLICY — per-instance
 * `maxConcurrent` and the global ceiling (D11) — is t3o-11. The MVP
 * implementation therefore admits every request and only counts, so t3o-11
 * adds the ceiling check in `acquire` and nothing else in the reactor changes.
 */
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SynchronizedRef from "effect/SynchronizedRef";
import type { ProviderInstanceId } from "@t3tools/contracts";

export interface BoardStepSlotsShape {
  /**
   * Try to acquire a slot for a provider instance. Returns whether admission
   * succeeded; a `false` leaves the step `queued` (D11) — visible on the card,
   * never lying about its state. The MVP always admits and counts.
   */
  readonly acquire: (providerInstanceId: ProviderInstanceId) => Effect.Effect<boolean>;
  /** Release a held slot. Idempotent-safe callers pass `slotHeld` so a
      double-release (crash + settle racing) never drops the count below zero. */
  readonly release: (providerInstanceId: ProviderInstanceId) => Effect.Effect<void>;
  /** Currently held slots for an instance — for leak assertions and the future
      governor. */
  readonly heldFor: (providerInstanceId: ProviderInstanceId) => Effect.Effect<number>;
  /** Total held slots across all instances. */
  readonly heldTotal: Effect.Effect<number>;
}

export class BoardStepSlots extends Context.Service<BoardStepSlots, BoardStepSlotsShape>()(
  "t3/board/BoardStepSlots",
) {}

const make = Effect.gen(function* () {
  const held = yield* SynchronizedRef.make<Record<string, number>>({});

  const acquire: BoardStepSlotsShape["acquire"] = (providerInstanceId) =>
    SynchronizedRef.updateAndGet(held, (current) => ({
      ...current,
      [providerInstanceId]: (current[providerInstanceId] ?? 0) + 1,
    })).pipe(Effect.as(true));

  const release: BoardStepSlotsShape["release"] = (providerInstanceId) =>
    SynchronizedRef.update(held, (current) => {
      const next = Math.max(0, (current[providerInstanceId] ?? 0) - 1);
      return { ...current, [providerInstanceId]: next };
    });

  const heldFor: BoardStepSlotsShape["heldFor"] = (providerInstanceId) =>
    SynchronizedRef.get(held).pipe(Effect.map((current) => current[providerInstanceId] ?? 0));

  const heldTotal = SynchronizedRef.get(held).pipe(
    Effect.map((current) => Object.values(current).reduce((sum, count) => sum + count, 0)),
  );

  return { acquire, release, heldFor, heldTotal } satisfies BoardStepSlotsShape;
});

export const BoardStepSlotsLive = Layer.effect(BoardStepSlots, make);
