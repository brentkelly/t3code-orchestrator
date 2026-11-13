/**
 * The board's side of worker-owned capacity (T3O-86): claims, `syncCards` and the snapshot
 * cache per worker. `local` is called in-process under this server's environment id.
 */
import {
  BOARD_LOCAL_WORKER_ID,
  type BoardCapacityClaimInput,
  type BoardCapacityClaimResult,
  type BoardProvisionClaim,
  type BoardCardSetupProgress,
  type BoardWorkerCheckReadinessInput,
  type BoardWorkerReadiness,
  type BoardWorkerRunSetupInput,
  type BoardWorkerSetupState,
  type BoardSyncedCard,
  type BoardWorkerCapacitySnapshot,
  type BoardWorkerId,
  type EnvironmentId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as Stream from "effect/Stream";

import { ServerEnvironment } from "../../environment/ServerEnvironment.ts";
import type { WorkerGatewayRpc } from "../workers/gatewayWire.ts";
import { WorkerConnections } from "../workers/WorkerConnections.ts";
import { BoardWorkerCapacity } from "./BoardWorkerCapacity.ts";

/** A claim the worker didn't answer: it is offline, or took longer than the time-box. */
export type BoardClaimAnswer = BoardCapacityClaimResult | { readonly outcome: "unavailable" };

const CLAIM_TIMEOUT = "5 seconds";
const UNAVAILABLE: BoardClaimAnswer = { outcome: "unavailable" };

export interface BoardCapacityClientShape {
  /** The board id this server uses on its own worker, `local`. */
  readonly localBoardId: string;
  /** Claim on a worker, stamped with its next `seq`. Never fails: an unreachable or slow
      worker answers `unavailable`, and a timed-out claim is retried once with the same id. */
  readonly claim: (
    workerId: BoardWorkerId,
    input: Omit<BoardCapacityClaimInput, "seq">,
  ) => Effect.Effect<BoardClaimAnswer>;
  /** The next `seq` for a worker, persisted. */
  readonly nextSeq: (workerId: BoardWorkerId) => Effect.Effect<number>;
  /** Send the board's granted state for a worker when it changed, or when this connection
      has not been synced yet (that first sync is authoritative). Whether the worker has
      acknowledged a sync on its current connection. */
  readonly syncCards: (
    workerId: BoardWorkerId,
    cards: ReadonlyArray<BoardSyncedCard>,
  ) => Effect.Effect<boolean>;
  /** Whether this connection's first sync was acknowledged: until then the board sends the
      worker no claim, provision or spawn. */
  readonly synced: (workerId: BoardWorkerId) => Effect.Effect<boolean>;
  readonly latest: (workerId: BoardWorkerId) => Effect.Effect<BoardWorkerCapacitySnapshot | null>;
  readonly all: Effect.Effect<ReadonlyMap<BoardWorkerId, BoardWorkerCapacitySnapshot>>;
  /** Ticks with the worker whose snapshot changed. Each access subscribes. */
  readonly changes: Stream.Stream<BoardWorkerId>;
  /** A provision on `local` consumed its claim. */
  readonly recordLocalProvision: (
    claim: BoardProvisionClaim,
    worktree: { readonly branch: string; readonly worktreePath: string },
  ) => Effect.Effect<void>;
  /** Why a board-started turn can't start on `local` now (its agent cap), or null. */
  readonly localAgentCapRefusal: (
    providerInstanceId: string | null,
  ) => Effect.Effect<string | null>;
  /** Section 5, on a card's worker: its setup, and a project's readiness. A worker out of
      reach fails the stream or answers null. */
  readonly runSetup: (
    workerId: BoardWorkerId,
    input: BoardWorkerRunSetupInput,
  ) => Stream.Stream<BoardCardSetupProgress, BoardCapacityUnavailable>;
  readonly setupState: (
    workerId: BoardWorkerId,
    worktreePath: string,
  ) => Effect.Effect<BoardWorkerSetupState | null>;
  readonly cancelSetup: (workerId: BoardWorkerId, worktreePath: string) => Effect.Effect<void>;
  readonly readSetupLog: (
    workerId: BoardWorkerId,
    worktreePath: string,
  ) => Effect.Effect<string | null>;
  readonly checkReadiness: (
    workerId: BoardWorkerId,
    input: BoardWorkerCheckReadinessInput,
  ) => Effect.Effect<BoardWorkerReadiness | null>;
  readonly readinessOutput: (
    workerId: BoardWorkerId,
    repositoryKey: string | null,
    path: string,
  ) => Effect.Effect<string | null>;
  /** The worker went away or came back: its next sync is authoritative again. */
  readonly connectionChanged: (workerId: BoardWorkerId) => Effect.Effect<void>;
}

export class BoardCapacityUnavailable extends Schema.TaggedError<BoardCapacityUnavailable>()(
  "BoardCapacityUnavailable",
  { workerId: Schema.String, message: Schema.String },
) {}

export class BoardCapacityClient extends Context.Service<
  BoardCapacityClient,
  BoardCapacityClientShape
>()("t3/board/capacity/BoardCapacityClient") {}

const canonical = (cards: ReadonlyArray<BoardSyncedCard>) =>
  JSON.stringify([...cards].sort((left, right) => left.cardId.localeCompare(right.cardId)));

const makeBoardCapacityClient = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const localCapacity = yield* BoardWorkerCapacity;
  const connections = yield* Effect.serviceOption(WorkerConnections);
  const localBoardId = yield* Effect.flatMap(ServerEnvironment, (env) => env.getEnvironmentId);
  const pubsub = yield* PubSub.unbounded<BoardWorkerId>();
  const snapshots = new Map<BoardWorkerId, BoardWorkerCapacitySnapshot>();
  /** What each worker last acknowledged on its current connection; absent is unsynced. */
  const lastSynced = new Map<BoardWorkerId, string>();
  const seqs = new Map<string, number>();

  const nextSeq = Effect.fn("BoardCapacityClient.nextSeq")(function* (workerId: BoardWorkerId) {
    let current = seqs.get(workerId);
    if (current === undefined) {
      const rows = yield* sql<{ readonly seq: number }>`
        SELECT seq FROM board_capacity_seq WHERE worker_id = ${workerId}
      `.pipe(Effect.orElseSucceed(() => []));
      current = rows[0]?.seq ?? 0;
    }
    const next = current + 1;
    seqs.set(workerId, next);
    yield* sql`
      INSERT INTO board_capacity_seq (worker_id, seq) VALUES (${workerId}, ${next})
      ON CONFLICT (worker_id) DO UPDATE SET seq = excluded.seq
    `.pipe(Effect.ignore);
    return next;
  });

  const gatewayOf = Effect.fn("BoardCapacityClient.gatewayOf")(function* (workerId: EnvironmentId) {
    if (Option.isNone(connections)) return null;
    return yield* connections.value.get(workerId).pipe(
      Effect.map((rpc): WorkerGatewayRpc | null => rpc.gateway),
      Effect.orElseSucceed(() => null),
    );
  });

  const claimOnce = Effect.fn("BoardCapacityClient.claimOnce")(function* (
    workerId: BoardWorkerId,
    input: BoardCapacityClaimInput,
  ) {
    if (workerId === BOARD_LOCAL_WORKER_ID) {
      return (yield* localCapacity.claim(localBoardId, input)) as BoardClaimAnswer;
    }
    const gateway = yield* gatewayOf(workerId);
    if (gateway === null) return { outcome: "unavailable" } as BoardClaimAnswer;
    const answer = yield* gateway.claimCapacity(input).pipe(
      Effect.timeoutOption(CLAIM_TIMEOUT),
      Effect.orElseSucceed(() => Option.none<BoardCapacityClaimResult>()),
    );
    return Option.isSome(answer) ? (answer.value as BoardClaimAnswer) : UNAVAILABLE;
  });

  const claim = Effect.fn("BoardCapacityClient.claim")(function* (
    workerId: BoardWorkerId,
    input: Omit<BoardCapacityClaimInput, "seq">,
  ) {
    const seq = yield* nextSeq(workerId);
    const first = yield* claimOnce(workerId, { ...input, seq });
    // A timed-out claim is retried once with the same id on the same worker.
    if (first.outcome !== "unavailable" || workerId === BOARD_LOCAL_WORKER_ID) return first;
    return yield* claimOnce(workerId, { ...input, seq });
  });

  const syncCards = Effect.fn("BoardCapacityClient.syncCards")(function* (
    workerId: BoardWorkerId,
    cards: ReadonlyArray<BoardSyncedCard>,
  ) {
    const payload = canonical(cards);
    const previous = lastSynced.get(workerId);
    if (previous === payload) return true;
    const seq = yield* nextSeq(workerId);
    const input = { seq, authoritative: previous === undefined, cards };
    let acked = false;
    if (workerId === BOARD_LOCAL_WORKER_ID) {
      yield* localCapacity.syncCards(localBoardId, input);
      acked = true;
    } else {
      const gateway = yield* gatewayOf(workerId);
      if (gateway !== null) {
        acked = yield* gateway.syncCards(input).pipe(
          Effect.timeoutOption(CLAIM_TIMEOUT),
          Effect.map(Option.isSome),
          Effect.orElseSucceed(() => false),
        );
      }
    }
    if (acked) lastSynced.set(workerId, payload);
    return acked || previous !== undefined;
  });

  const unavailable = (workerId: BoardWorkerId) =>
    new BoardCapacityUnavailable({ workerId, message: "The worker is out of reach." });
  const remoteOrNull = <A, E>(
    workerId: EnvironmentId,
    run: (gateway: WorkerGatewayRpc) => Effect.Effect<A, E>,
  ): Effect.Effect<A | null> =>
    gatewayOf(workerId).pipe(
      Effect.flatMap((gateway) =>
        gateway === null
          ? Effect.succeed(null)
          : run(gateway).pipe(Effect.orElseSucceed(() => null)),
      ),
    );

  const publish = (workerId: BoardWorkerId, snapshot: BoardWorkerCapacitySnapshot) =>
    Effect.suspend(() => {
      snapshots.set(workerId, snapshot);
      return PubSub.publish(pubsub, workerId);
    });

  // `local` streams in-process; each online worker over its gateway, restarted as it
  // reconnects.
  yield* localCapacity.subscribe(localBoardId).pipe(
    Stream.runForEach((snapshot) => publish(BOARD_LOCAL_WORKER_ID, snapshot)),
    Effect.forkScoped,
  );
  if (Option.isSome(connections)) {
    const following = new Map<EnvironmentId, Fiber.Fiber<unknown>>();
    yield* connections.value.states.pipe(
      Stream.runForEach((states) =>
        Effect.gen(function* () {
          for (const [workerId, runtime] of states) {
            const online = runtime.status.state === "online";
            const current = following.get(workerId);
            if (online && current === undefined) {
              lastSynced.delete(workerId);
              const fiber = yield* gatewayOf(workerId).pipe(
                Effect.flatMap((gateway) =>
                  gateway === null
                    ? Effect.void
                    : gateway.subscribeCapacity.pipe(
                        Stream.runForEach((snapshot) => publish(workerId, snapshot)),
                        Effect.ignore,
                      ),
                ),
                Effect.repeat(Schedule.spaced("5 seconds")),
                Effect.forkScoped,
              );
              following.set(workerId, fiber);
            } else if (!online && current !== undefined) {
              following.delete(workerId);
              lastSynced.delete(workerId);
              yield* Fiber.interrupt(current);
            }
          }
          for (const [workerId, fiber] of following) {
            if (states.has(workerId)) continue;
            following.delete(workerId);
            lastSynced.delete(workerId);
            snapshots.delete(workerId);
            yield* Fiber.interrupt(fiber);
          }
        }),
      ),
      Effect.forkScoped,
    );
  }

  return {
    localBoardId,
    claim,
    nextSeq,
    syncCards,
    synced: (workerId) => Effect.sync(() => lastSynced.has(workerId)),
    latest: (workerId) => Effect.sync(() => snapshots.get(workerId) ?? null),
    all: Effect.sync(() => new Map(snapshots)),
    changes: Stream.fromPubSub(pubsub),
    localAgentCapRefusal: (providerInstanceId) => localCapacity.agentCapRefusal(providerInstanceId),
    recordLocalProvision: (claim, worktree) =>
      localCapacity.recordProvision(localBoardId, claim, worktree),
    runSetup: (workerId, input) =>
      workerId === BOARD_LOCAL_WORKER_ID
        ? localCapacity.runSetup(input)
        : Stream.unwrap(
            gatewayOf(workerId).pipe(
              Effect.map((gateway) =>
                gateway === null
                  ? Stream.fail(unavailable(workerId))
                  : gateway.runSetup(input).pipe(Stream.mapError(() => unavailable(workerId))),
              ),
            ),
          ),
    setupState: (workerId, worktreePath) =>
      workerId === BOARD_LOCAL_WORKER_ID
        ? localCapacity.setupState(worktreePath)
        : remoteOrNull(workerId, (gateway) => gateway.setupState(worktreePath)),
    cancelSetup: (workerId, worktreePath) =>
      workerId === BOARD_LOCAL_WORKER_ID
        ? localCapacity.cancelSetup(worktreePath)
        : remoteOrNull(workerId, (gateway) => gateway.cancelSetup(worktreePath)).pipe(
            Effect.asVoid,
          ),
    readSetupLog: (workerId, worktreePath) =>
      workerId === BOARD_LOCAL_WORKER_ID
        ? localCapacity.readSetupLog(worktreePath)
        : remoteOrNull(workerId, (gateway) => gateway.readSetupLog(worktreePath)),
    checkReadiness: (workerId, input) =>
      workerId === BOARD_LOCAL_WORKER_ID
        ? localCapacity.checkReadiness(localBoardId, input)
        : remoteOrNull(workerId, (gateway) => gateway.checkReadiness(input)),
    readinessOutput: (workerId, repositoryKey, path) =>
      workerId === BOARD_LOCAL_WORKER_ID
        ? localCapacity.readinessOutput(localBoardId, repositoryKey, path)
        : remoteOrNull(workerId, (gateway) => gateway.readinessOutput(repositoryKey, path)).pipe(
            Effect.map((value) => value ?? null),
          ),
    connectionChanged: (workerId) => Effect.sync(() => void lastSynced.delete(workerId)),
  } satisfies BoardCapacityClientShape;
});

export const BoardCapacityClientLive = Layer.effect(BoardCapacityClient, makeBoardCapacityClient);
