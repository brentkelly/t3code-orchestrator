/**
 * Every terminal step outcome must release its slot; a leak silently halves
 * throughput. `acquire` is the only place caps are enforced, atomically, and
 * holdings key on (worker, instance): the same instance id on another machine
 * is a different account and CPU.
 */
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SynchronizedRef from "effect/SynchronizedRef";
import {
  BOARD_LOCAL_WORKER_ID,
  type BoardStepQueuedBy,
  type BoardWorkerId,
  type ProviderInstanceId,
} from "@t3tools/contracts";

/** Where a slot is held: a provider instance on one worker. */
export interface BoardSlotKey {
  readonly workerId: BoardWorkerId;
  readonly providerInstanceId: ProviderInstanceId;
}

/** Resolved caps for one admission attempt: the board-wide ceiling on
    total running steps, the worker's own ceiling, and this instance's cap on
    that worker. `null` is "no limit of that kind". */
export interface BoardConcurrencyLimit {
  readonly global: number;
  readonly worker: number | null;
  readonly perInstance: number | null;
}

/** Admitted, or which ceiling refused it — the narrowest one that is full,
    since only a slot freeing there lets the step start. */
export type BoardSlotAdmission =
  | { readonly admitted: true }
  | {
      readonly admitted: false;
      readonly blockedBy: Exclude<BoardStepQueuedBy, "setup" | "worker-offline">;
    };

export interface BoardStepSlotsShape {
  /**
   * Admits iff the board, worker and instance-on-worker counts are each below
   * their ceiling; a refusal leaves counts untouched and names the binding one.
   */
  readonly acquire: (
    key: BoardSlotKey,
    limits: BoardConcurrencyLimit,
  ) => Effect.Effect<BoardSlotAdmission>;
  /** Unconditionally re-take a slot a step already held before a restart. The
      Ref is empty after a crash, so boot restores running steps' slots before
      any admission, ignoring caps: dropping one would let the governor
      over-admit. Kept apart from `acquire` so the live path cannot bypass it. */
  readonly restore: (key: BoardSlotKey) => Effect.Effect<void>;
  /** Release a held slot. Floors the count at zero, so a double-release (a
      crash and a settle racing to release the same step) never drives the
      count negative — callers gate on `BoardCardStepState.slotHeld` and this is
      the belt-and-braces backstop. */
  readonly release: (key: BoardSlotKey) => Effect.Effect<void>;
  /** Held slots for an instance on a worker (this server when omitted) — for
      leak assertions and the governor. */
  readonly heldFor: (
    providerInstanceId: ProviderInstanceId,
    workerId?: BoardWorkerId,
  ) => Effect.Effect<number>;
  /** Held slots on one worker, across its instances. */
  readonly heldOnWorker: (workerId: BoardWorkerId) => Effect.Effect<number>;
  /** Total held slots across every worker and instance. */
  readonly heldTotal: Effect.Effect<number>;
}

export class BoardStepSlots extends Context.Service<BoardStepSlots, BoardStepSlotsShape>()(
  "t3/board/BoardStepSlots",
) {}

type Holdings = Readonly<Record<string, Readonly<Record<string, number>>>>;

const sum = (counts: Readonly<Record<string, number>> | undefined): number =>
  Object.values(counts ?? {}).reduce((total, count) => total + count, 0);

const totalHeld = (held: Holdings): number =>
  Object.values(held).reduce((total, counts) => total + sum(counts), 0);

const withCount = (held: Holdings, key: BoardSlotKey, next: (count: number) => number) => {
  const onWorker = held[key.workerId] ?? {};
  return {
    ...held,
    [key.workerId]: {
      ...onWorker,
      [key.providerInstanceId]: next(onWorker[key.providerInstanceId] ?? 0),
    },
  };
};

const make = Effect.gen(function* () {
  const held = yield* SynchronizedRef.make<Holdings>({});

  const acquire: BoardStepSlotsShape["acquire"] = (key, limits) =>
    SynchronizedRef.modify(held, (current): [BoardSlotAdmission, Holdings] => {
      const instanceCount = current[key.workerId]?.[key.providerInstanceId] ?? 0;
      const blockedBy =
        limits.perInstance !== null && instanceCount >= limits.perInstance
          ? "provider"
          : limits.worker !== null && sum(current[key.workerId]) >= limits.worker
            ? "worker"
            : totalHeld(current) >= limits.global
              ? "board"
              : null;
      return blockedBy === null
        ? [{ admitted: true }, withCount(current, key, (count) => count + 1)]
        : [{ admitted: false, blockedBy }, current];
    });

  const restore: BoardStepSlotsShape["restore"] = (key) =>
    SynchronizedRef.update(held, (current) => withCount(current, key, (count) => count + 1));

  const release: BoardStepSlotsShape["release"] = (key) =>
    SynchronizedRef.update(held, (current) =>
      withCount(current, key, (count) => Math.max(0, count - 1)),
    );

  const heldFor: BoardStepSlotsShape["heldFor"] = (
    providerInstanceId,
    workerId = BOARD_LOCAL_WORKER_ID,
  ) =>
    SynchronizedRef.get(held).pipe(
      Effect.map((current) => current[workerId]?.[providerInstanceId] ?? 0),
    );

  const heldOnWorker: BoardStepSlotsShape["heldOnWorker"] = (workerId) =>
    SynchronizedRef.get(held).pipe(Effect.map((current) => sum(current[workerId])));

  const heldTotal = SynchronizedRef.get(held).pipe(Effect.map(totalHeld));

  return {
    acquire,
    restore,
    release,
    heldFor,
    heldOnWorker,
    heldTotal,
  } satisfies BoardStepSlotsShape;
});

export const BoardStepSlotsLive = Layer.effect(BoardStepSlots, make);
