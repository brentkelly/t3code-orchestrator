/**
 * A board-side capacity client for the supervisor harness (T3O-86): each worker has a fixed
 * declared capacity and grants a claim when the profile fits what is left, with no machine,
 * clock or network behind it. Tests read the claims it was asked and set room directly.
 */
import {
  BOARD_RESOURCE_DIMENSIONS,
  boardResourceProfileValue,
  ZERO_BOARD_RESOURCE_PROFILE,
  type BoardCapacityClaimInput,
  type BoardResourceProfile,
  type BoardSyncedCard,
  type BoardWorkerCapacitySnapshot,
  type BoardWorkerId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as PubSub from "effect/PubSub";
import * as Stream from "effect/Stream";

import type { BoardCapacityClientShape } from "./BoardCapacityClient.ts";

export interface FakeCapacity {
  readonly client: BoardCapacityClientShape;
  /** Every claim asked, in order, with the worker it went to. */
  readonly claims: Array<BoardCapacityClaimInput & { readonly workerId: BoardWorkerId }>;
  /** Every sync sent, per worker, in order. */
  readonly syncs: Array<{
    readonly workerId: BoardWorkerId;
    readonly cards: ReadonlyArray<BoardSyncedCard>;
  }>;
  /** What each worker offers now; change it to free or take room. */
  readonly headroom: Map<BoardWorkerId, BoardResourceProfile>;
  /** Push a snapshot change for a worker, as its stream would. */
  readonly publish: (workerId: BoardWorkerId) => Effect.Effect<void>;
  /** The local agent cap's refusal, or null. */
  agentCap: string | null;
}

const fits = (need: BoardResourceProfile, room: BoardResourceProfile) =>
  BOARD_RESOURCE_DIMENSIONS.every(
    (dimension) =>
      boardResourceProfileValue(need, dimension) <= boardResourceProfileValue(room, dimension),
  );

const short = (need: BoardResourceProfile, room: BoardResourceProfile) =>
  BOARD_RESOURCE_DIMENSIONS.find(
    (dimension) =>
      boardResourceProfileValue(need, dimension) > boardResourceProfileValue(room, dimension),
  );

const minus = (left: BoardResourceProfile, right: BoardResourceProfile): BoardResourceProfile => ({
  cpuCores: left.cpuCores - right.cpuCores,
  ramGiB: left.ramGiB - right.ramGiB,
  diskGB: left.diskGB - right.diskGB,
});

export const makeFakeCapacity = Effect.fn("makeFakeCapacity")(function* (
  declared: ReadonlyMap<BoardWorkerId, BoardResourceProfile>,
) {
  const pubsub = yield* PubSub.unbounded<BoardWorkerId>();
  const headroom = new Map(declared);
  let seq = 0;
  const fake: FakeCapacity = {
    claims: [],
    syncs: [],
    headroom,
    agentCap: null,
    publish: (workerId) => PubSub.publish(pubsub, workerId).pipe(Effect.asVoid),
    client: {
      localBoardId: "env-board",
      claim: (workerId, input) =>
        Effect.sync(() => {
          fake.claims.push({ ...input, seq: ++seq, workerId });
          const room = headroom.get(workerId) ?? ZERO_BOARD_RESOURCE_PROFILE;
          const need = input.kind === "grow" ? { ...input.profile, diskGB: 0 } : input.profile;
          if (input.force !== true && !fits(need, room)) {
            const dimension = short(need, room);
            return {
              outcome: "denied" as const,
              reason: "capacity",
              ...(dimension === undefined ? {} : { dimension }),
            };
          }
          headroom.set(workerId, minus(room, need));
          return { outcome: "granted" as const };
        }),
      nextSeq: () => Effect.sync(() => ++seq),
      syncCards: (workerId, cards) =>
        Effect.sync(() => {
          fake.syncs.push({ workerId, cards });
          return true;
        }),
      synced: () => Effect.succeed(true),
      latest: (workerId) =>
        Effect.sync((): BoardWorkerCapacitySnapshot | null => {
          const total = declared.get(workerId);
          if (total === undefined) return null;
          return {
            at: "2026-01-01T00:00:00.000Z",
            declared: total,
            headroom: headroom.get(workerId) ?? ZERO_BOARD_RESOURCE_PROFILE,
            over: { cpuRam: false, disk: false },
            agents: { running: 0, max: null },
            providers: [],
            readiness: [],
            heavyCards: [],
          };
        }),
      all: Effect.sync(() => new Map()),
      changes: Stream.fromPubSub(pubsub),
      localAgentCapRefusal: () => Effect.sync(() => fake.agentCap),
      connectionChanged: () => Effect.void,
      recordLocalProvision: () => Effect.void,
    },
  };
  return fake;
});
