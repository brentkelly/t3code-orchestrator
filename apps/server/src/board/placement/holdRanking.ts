/**
 * Which workers a waiting card holds (T3O-87), as pure functions: the candidates, their order,
 * and the board's limit. The worker decides whether a hold is granted.
 */
import type { BoardResourceProfile, BoardWorkerId } from "@t3tools/contracts";

import type { PlacementWorkerFacts } from "./placementRanking.ts";

/** A card holds at most this many workers at once. */
const HOLDS_PER_CARD = 2;

/**
 * A board holds at most half of its ready workers, rounded down, at least one. Ready: online
 * workers ready for at least one of the board's projects that fit an M card of it.
 */
export const boardHoldLimit = (readyWorkers: number): number =>
  Math.max(1, Math.floor(readyWorkers / 2));

/**
 * Where a card may hold: every placement test but the CPU and RAM fit. Quota, readiness and a
 * provider sign-in hold nothing, since capacity can't cure them; nor does a disk shortfall,
 * which only frees when worktrees are retired. A held worker stays a candidate: asking it is
 * how it learns someone is waiting.
 */
export function holdCandidate(facts: PlacementWorkerFacts, profile: BoardResourceProfile): boolean {
  if (!facts.online || !facts.atFloor || !facts.hasCheckout) return false;
  if (facts.readiness !== "ready" || !facts.providerSignedIn || !facts.quotaRoom) return false;
  if (facts.declared === null || facts.headroom === null) return false;
  if (
    profile.cpuCores > facts.declared.cpuCores ||
    profile.ramGiB > facts.declared.ramGiB ||
    profile.diskGB > facts.declared.diskGB
  ) {
    return false;
  }
  if (facts.over?.disk === true) return false;
  return profile.diskGB <= facts.headroom.diskGB;
}

/** What a worker still lacks for a card to start early there, per dimension, never below 0. */
const earlyShortfall = (
  facts: PlacementWorkerFacts,
  profile: BoardResourceProfile,
  fraction: number,
) => {
  const headroom = facts.headroom!;
  const over = facts.over?.cpuRam === true;
  return {
    cpu: Math.max(0, profile.cpuCores * fraction - (over ? 0 : headroom.cpuCores)),
    ram: Math.max(0, profile.ramGiB * fraction - (over ? 0 : headroom.ramGiB)),
  };
};

/**
 * Hold candidates in order: those that already have the early-start share of CPU and RAM,
 * then the smallest shortfall on the short dimension (as a share of what it declares), then
 * the placement order (warm, room left, id) the caller passes.
 */
export function rankHoldCandidates(input: {
  readonly workers: ReadonlyArray<PlacementWorkerFacts>;
  readonly profile: BoardResourceProfile;
  /** Per worker, its `earlyStartFraction` (from its snapshot). */
  readonly fractionOf: (workerId: BoardWorkerId) => number;
  /** The placement order, for ties. */
  readonly placementOrder: ReadonlyArray<BoardWorkerId>;
  readonly pinnedWorkerId: BoardWorkerId | null;
}): ReadonlyArray<BoardWorkerId> {
  const candidates = input.workers.filter(
    (worker) =>
      (input.pinnedWorkerId === null || worker.workerId === input.pinnedWorkerId) &&
      holdCandidate(worker, input.profile),
  );
  const score = (worker: PlacementWorkerFacts) => {
    const short = earlyShortfall(worker, input.profile, input.fractionOf(worker.workerId));
    const declared = worker.declared!;
    const shareShort = Math.max(
      declared.cpuCores <= 0 ? 0 : short.cpu / declared.cpuCores,
      declared.ramGiB <= 0 ? 0 : short.ram / declared.ramGiB,
    );
    return { canStart: short.cpu === 0 && short.ram === 0, shareShort };
  };
  const placementIndex = (workerId: BoardWorkerId) => {
    const index = input.placementOrder.indexOf(workerId);
    return index === -1 ? Number.MAX_SAFE_INTEGER : index;
  };
  return [...candidates]
    .sort((left, right) => {
      const a = score(left);
      const b = score(right);
      if (a.canStart !== b.canStart) return a.canStart ? -1 : 1;
      if (a.shareShort !== b.shareShort) return a.shareShort - b.shareShort;
      const order = placementIndex(left.workerId) - placementIndex(right.workerId);
      if (order !== 0) return order;
      return left.workerId < right.workerId ? -1 : left.workerId > right.workerId ? 1 : 0;
    })
    .map((worker) => worker.workerId);
}

/**
 * The holds a card asks for this pass: its top candidates up to two, without a new worker
 * beyond the board's limit. A held worker it doesn't hold is still asked (that refused request
 * tells the worker someone waits); that ask isn't limited, and an unexpected grant at the limit
 * is released at once by the caller.
 */
export function holdsToAsk(input: {
  readonly ranked: ReadonlyArray<BoardWorkerId>;
  /** Workers this card already holds. */
  readonly holding: ReadonlySet<BoardWorkerId>;
  /** Distinct workers this board holds now, for any card. */
  readonly boardHolding: ReadonlySet<BoardWorkerId>;
  readonly limit: number;
  /** Workers held for someone else (closed to placements). */
  readonly closed: ReadonlySet<BoardWorkerId>;
  /** Workers this board holds for another of its cards: never asked for this one. */
  readonly heldForOthers: ReadonlySet<BoardWorkerId>;
}): {
  readonly ask: ReadonlyArray<BoardWorkerId>;
  readonly signal: ReadonlyArray<BoardWorkerId>;
} {
  const top = input.ranked
    .filter((workerId) => !input.heldForOthers.has(workerId))
    .slice(0, HOLDS_PER_CARD);
  const ask: Array<BoardWorkerId> = [];
  const signal: Array<BoardWorkerId> = [];
  let held = new Set(input.boardHolding);
  for (const workerId of top) {
    if (input.holding.has(workerId)) {
      ask.push(workerId);
      continue;
    }
    if (input.closed.has(workerId)) {
      signal.push(workerId);
      continue;
    }
    if (held.size >= input.limit && !held.has(workerId)) continue;
    ask.push(workerId);
    held = new Set([...held, workerId]);
  }
  return { ask, signal };
}
