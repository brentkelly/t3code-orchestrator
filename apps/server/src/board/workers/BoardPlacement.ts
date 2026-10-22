/**
 * T3o (T3O-65, D20): what the supervisor needs to know about workers to place
 * a card's step on one.
 *
 * Where a card runs is read-model state (`boardCardEffectiveWorkerId`). Whether
 * it can run there NOW is not: the worker must be online, have a checkout of
 * the card's project, and have the step's provider instance. Those come from
 * the board's worker summary, which this service hands the supervisor along
 * with a tick whenever it changes — a clone finishing or a worker reconnecting
 * is what starts a held card.
 *
 * Absent on a local-only harness: everything runs on this server, which always
 * qualifies.
 */
import {
  BOARD_LOCAL_WORKER_ID,
  resolveBoardWorkerCheckout,
  type BoardWorkerId,
  type BoardWorkersState,
  type ProjectId,
  type ProviderInstanceId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

import { BoardWorkers } from "./BoardWorkers.ts";

export interface BoardPlacementShape {
  /** The board's worker summary now: statuses, last-known snapshots, setups. */
  readonly workers: Effect.Effect<BoardWorkersState>;
  /** Ticks after every change to that summary. Each access subscribes. */
  readonly changes: Stream.Stream<void>;
}

export class BoardPlacement extends Context.Service<BoardPlacement, BoardPlacementShape>()(
  "t3/board/workers/BoardPlacement",
) {}

/** The board's worker summary, as `BoardWorkers` keeps it. */
export const BoardPlacementLive = Layer.effect(
  BoardPlacement,
  Effect.map(BoardWorkers, (workers) => ({
    workers: workers.state,
    changes: workers.states.pipe(
      Stream.drop(1),
      Stream.map(() => undefined),
    ),
  })),
);

/**
 * Whether a step can start on a worker now (D20):
 *
 * - `ready` — go.
 * - `offline` — the worker is not online (or no longer registered). Held
 *   silently; the worker's own notice says why (T3O-66).
 * - `no-checkout` — the worker has no checkout of the project: one is being
 *   set up, a setup failed, or none was ever made. Held as queued; the card
 *   says which from the board's setups.
 * - `provider-missing` — the worker does not have the step's provider
 *   instance. The step stalls amber for a human: a different worker, or a
 *   model this one offers.
 *
 * This server always qualifies — its projects and providers are the board's.
 */
export type BoardPlacementGate =
  | { readonly kind: "ready"; readonly workerProjectId: ProjectId | null }
  | { readonly kind: "offline" }
  | { readonly kind: "no-checkout" }
  | { readonly kind: "provider-missing" };

export function boardPlacementGate(input: {
  readonly workerId: BoardWorkerId;
  readonly workers: BoardWorkersState;
  /** The board project's repository grouping key, null when it has none. */
  readonly projectRepositoryKey: string | null;
  readonly providerInstanceId: ProviderInstanceId;
}): BoardPlacementGate {
  if (input.workerId === BOARD_LOCAL_WORKER_ID) return { kind: "ready", workerProjectId: null };
  const worker = input.workers.workers.find((candidate) => candidate.id === input.workerId);
  if (worker === undefined || worker.status.state !== "online") return { kind: "offline" };
  const checkout = resolveBoardWorkerCheckout(
    input.projectRepositoryKey,
    worker.snapshot?.checkouts ?? [],
  );
  if (checkout === null) return { kind: "no-checkout" };
  const provider = (worker.snapshot?.providers ?? []).find(
    (candidate) => candidate.instanceId === input.providerInstanceId,
  );
  if (provider === undefined || !provider.enabled) return { kind: "provider-missing" };
  return { kind: "ready", workerProjectId: checkout.projectId };
}
