/**
 * A board-side capacity client for the supervisor harness (T3O-86): each worker has a fixed
 * declared capacity and grants a claim when the profile fits what is left, with no machine,
 * clock or network behind it. Tests read the claims it was asked and set room directly.
 */
import {
  BOARD_LOCAL_WORKER_ID,
  BOARD_RESOURCE_DIMENSIONS,
  boardResourceProfileValue,
  ZERO_BOARD_RESOURCE_PROFILE,
  type BoardCapacityClaimInput,
  type BoardCapacityHoldInput,
  type BoardCapacityHoldResult,
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
  /** Room another board holds on each worker; change it to free or take room. */
  readonly external: Map<BoardWorkerId, BoardResourceProfile>;
  /** What a worker offers this board now. */
  readonly headroomOf: (workerId: BoardWorkerId) => BoardResourceProfile;
  /** Push a snapshot change for a worker, as its stream would. */
  readonly publish: (workerId: BoardWorkerId) => Effect.Effect<void>;
  /** The local agent cap's refusal, or null. */
  agentCap: string | null;
  /** Workers whose claims go unanswered, as a timed-out RPC would. */
  readonly unreachable: Set<BoardWorkerId>;
  /** A snapshot `latest` keeps answering for a worker, as one not yet pushed again would. */
  readonly frozen: Map<BoardWorkerId, BoardWorkerCapacitySnapshot>;
  /** T3o: every hold asked, and every withdrawal (T3O-87). */
  readonly holds: Array<BoardCapacityHoldInput & { readonly workerId: BoardWorkerId }>;
  readonly releasedHolds: Array<{ readonly workerId: BoardWorkerId; readonly cardId: string }>;
  /** The early-start share every worker reports. 1 (the default) needs the whole profile, so
      a suite about queue order sees no early start. */
  earlyStartFraction: number;
  /** Run before the next hold is answered, once: a test parks a call mid-flight with it. */
  beforeNextHold: Effect.Effect<void> | null;
  /** How a worker answers a hold; by default it holds, short of nothing. */
  holdAnswer: (workerId: BoardWorkerId, input: BoardCapacityHoldInput) => BoardCapacityHoldResult;
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

/** `local` with room for `n` cards of the 2/4/5 placeholder at size M, and no more. */
export const roomForCards = (n: number): ReadonlyMap<BoardWorkerId, BoardResourceProfile> =>
  new Map([[BOARD_LOCAL_WORKER_ID, { cpuCores: 2 * n + 1, ramGiB: 4 * n + 2, diskGB: 1000 }]]);

export const makeFakeCapacity = Effect.fn("makeFakeCapacity")(function* (
  declared: ReadonlyMap<BoardWorkerId, BoardResourceProfile>,
) {
  const pubsub = yield* PubSub.unbounded<BoardWorkerId>();
  /** Room taken from outside this board (another board's cards), per worker. */
  const external = new Map<BoardWorkerId, BoardResourceProfile>();
  /** Granted claims not yet consumed by a sync, per worker and card. */
  const pending = new Map<BoardWorkerId, Map<string, BoardResourceProfile>>();
  /** What the board last synced, per worker. */
  const synced = new Map<BoardWorkerId, ReadonlyArray<BoardSyncedCard>>();
  let seq = 0;
  const headroomOf = (workerId: BoardWorkerId): BoardResourceProfile => {
    let room = declared.get(workerId) ?? ZERO_BOARD_RESOURCE_PROFILE;
    room = minus(room, external.get(workerId) ?? ZERO_BOARD_RESOURCE_PROFILE);
    for (const card of synced.get(workerId) ?? []) {
      room = minus(room, {
        cpuCores: card.phase === "heavy" ? card.grantedProfile.cpuCores : 0,
        ramGiB: card.phase === "heavy" ? card.grantedProfile.ramGiB : 0,
        diskGB: card.grantedProfile.diskGB,
      });
    }
    for (const load of pending.get(workerId)?.values() ?? []) room = minus(room, load);
    return room;
  };
  const fake: FakeCapacity = {
    claims: [],
    syncs: [],
    external,
    headroomOf,
    agentCap: null,
    unreachable: new Set(),
    frozen: new Map(),
    holds: [],
    releasedHolds: [],
    earlyStartFraction: 1,
    beforeNextHold: null,
    holdAnswer: () => ({ outcome: "held", short: ZERO_BOARD_RESOURCE_PROFILE, until: null }),
    publish: (workerId) => PubSub.publish(pubsub, workerId).pipe(Effect.asVoid),
    client: {
      localBoardId: "env-board",
      claim: (workerId, input) =>
        Effect.sync(() => {
          fake.claims.push({ ...input, seq: ++seq, workerId });
          if (fake.unreachable.has(workerId)) return { outcome: "unavailable" as const };
          const listed = (synced.get(workerId) ?? []).find((card) => card.cardId === input.cardId);
          const need: BoardResourceProfile =
            input.kind === "grow"
              ? {
                  cpuCores:
                    input.profile.cpuCores -
                    (listed?.phase === "heavy" ? listed.grantedProfile.cpuCores : 0),
                  ramGiB:
                    input.profile.ramGiB -
                    (listed?.phase === "heavy" ? listed.grantedProfile.ramGiB : 0),
                  diskGB: 0,
                }
              : input.profile;
          const room = headroomOf(workerId);
          // T3o: a held card starts early at its share of CPU and RAM, as a worker does (T3O-87).
          const share = fake.earlyStartFraction;
          const asked =
            input.hold === true
              ? { ...need, cpuCores: need.cpuCores * share, ramGiB: need.ramGiB * share }
              : need;
          if (input.force !== true && !fits(asked, room)) {
            const dimension = short(need, room);
            return {
              outcome: "denied" as const,
              reason: "capacity",
              ...(dimension === undefined ? {} : { dimension }),
            };
          }
          const onWorker = pending.get(workerId) ?? new Map<string, BoardResourceProfile>();
          onWorker.set(input.cardId, need);
          pending.set(workerId, onWorker);
          return { outcome: "granted" as const };
        }),
      nextSeq: () => Effect.sync(() => ++seq),
      hold: (workerId, input) =>
        Effect.suspend(() => {
          const before = fake.beforeNextHold ?? Effect.void;
          fake.beforeNextHold = null;
          return before;
        }).pipe(
          Effect.andThen(
            Effect.sync(() => {
              fake.holds.push({ ...input, workerId });
              return fake.holdAnswer(workerId, input);
            }),
          ),
        ),
      releaseHold: (workerId, cardId) =>
        Effect.sync(() => void fake.releasedHolds.push({ workerId, cardId })),
      syncCards: (workerId, read) =>
        Effect.map(read, (cards) => {
          fake.syncs.push({ workerId, cards });
          if (fake.unreachable.has(workerId)) return false;
          synced.set(workerId, cards);
          const onWorker = pending.get(workerId);
          for (const card of cards) onWorker?.delete(card.cardId);
          return true;
        }),
      synced: (workerId) => Effect.sync(() => synced.has(workerId)),
      latest: (workerId) =>
        Effect.sync((): BoardWorkerCapacitySnapshot | null => {
          const frozen = fake.frozen.get(workerId);
          if (frozen !== undefined) return frozen;
          const total = declared.get(workerId);
          if (total === undefined) return null;
          const room = headroomOf(workerId);
          return {
            at: "2026-01-01T00:00:00.000Z",
            declared: total,
            headroom: {
              cpuCores: Math.max(0, room.cpuCores),
              ramGiB: Math.max(0, room.ramGiB),
              diskGB: Math.max(0, room.diskGB),
            },
            over: { cpuRam: room.cpuCores < 0 || room.ramGiB < 0, disk: room.diskGB < 0 },
            agents: { running: 0, max: null },
            providers: [],
            readiness: [],
            heavyCards: [],
            hold: {
              closed: false,
              until: null,
              earlyStartFraction: fake.earlyStartFraction,
              cardId: null,
            },
          };
        }),
      all: Effect.sync(() => new Map()),
      changes: Stream.fromPubSub(pubsub),
      localAgentCapRefusal: () => Effect.sync(() => fake.agentCap),
      connectionChanged: () => Effect.void,
      provisionLocally: (_claim, _branch, run) => run,
      runSetup: () => Stream.empty,
      setupState: () => Effect.succeed("none" as const),
      cancelSetup: () => Effect.void,
      readSetupLog: () => Effect.succeed(""),
      checkReadiness: () => Effect.succeed(null),
      readinessOutput: () => Effect.succeed(null),
    },
  };
  return fake;
});
