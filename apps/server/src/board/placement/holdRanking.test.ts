import { EnvironmentId, type BoardWorkerId } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";

import { boardHoldLimit, holdCandidate, holdsToAsk, rankHoldCandidates } from "./holdRanking.ts";
import type { PlacementWorkerFacts } from "./placementRanking.ts";

const W1 = EnvironmentId.make("env-w1");
const W2 = EnvironmentId.make("env-w2");
const W3 = EnvironmentId.make("env-w3");
const PROFILE = { cpuCores: 12, ramGiB: 40, diskGB: 45 };

const worker = (
  workerId: BoardWorkerId,
  overrides: Partial<PlacementWorkerFacts> = {},
): PlacementWorkerFacts => ({
  workerId,
  label: String(workerId),
  online: true,
  atFloor: true,
  hasCheckout: true,
  readiness: "ready",
  providerSignedIn: true,
  quotaRoom: true,
  closed: false,
  declared: { cpuCores: 32, ramGiB: 128, diskGB: 500 },
  headroom: { cpuCores: 2, ramGiB: 8, diskGB: 200 },
  over: { cpuRam: false, disk: false },
  ...overrides,
});

describe("hold candidates (T3O-87)", () => {
  it.each([
    { name: "short only on CPU and RAM: a candidate", facts: {}, expected: true },
    { name: "held for someone else: still asked", facts: { closed: true }, expected: true },
    { name: "out of quota: holds nothing", facts: { quotaRoom: false }, expected: false },
    { name: "not ready: holds nothing", facts: { readiness: "failed" as const }, expected: false },
    {
      name: "still setting up: holds nothing",
      facts: { readiness: "pending" as const },
      expected: false,
    },
    {
      name: "provider signed out: holds nothing",
      facts: { providerSignedIn: false },
      expected: false,
    },
    { name: "offline: holds nothing", facts: { online: false }, expected: false },
    {
      name: "the card's disk doesn't fit now: holds nothing",
      facts: { headroom: { cpuCores: 2, ramGiB: 8, diskGB: 40 } },
      expected: false,
    },
    {
      name: "over declared disk: holds nothing",
      facts: { over: { cpuRam: false, disk: true } },
      expected: false,
    },
    {
      name: "the profile exceeds what it declares: holds nothing",
      facts: { declared: { cpuCores: 8, ramGiB: 128, diskGB: 500 } },
      expected: false,
    },
  ])("$name", ({ facts, expected }) => {
    expect(holdCandidate(worker(W1, facts), PROFILE)).toBe(expected);
  });

  it("prefers a worker that can start early now to a warmer one that can't", () => {
    const ranked = rankHoldCandidates({
      workers: [
        // Warm (first in placement order) but short of the early-start share.
        worker(W1, { headroom: { cpuCores: 2, ramGiB: 8, diskGB: 200 } }),
        // Has half of 12 cores and half of 40 GiB free already.
        worker(W2, { headroom: { cpuCores: 6, ramGiB: 20, diskGB: 200 } }),
        // Closer than W1 on its short dimension.
        worker(W3, { headroom: { cpuCores: 5, ramGiB: 18, diskGB: 200 } }),
      ],
      profile: PROFILE,
      fractionOf: () => 0.5,
      placementOrder: [W1, W3, W2],
      pinnedWorkerId: null,
    });
    expect(ranked).toEqual([W2, W3, W1]);
  });

  it("a pin restricts holds to the pinned worker", () => {
    expect(
      rankHoldCandidates({
        workers: [worker(W1), worker(W2)],
        profile: PROFILE,
        fractionOf: () => 0.5,
        placementOrder: [],
        pinnedWorkerId: W2,
      }),
    ).toEqual([W2]);
  });
});

describe("how many holds (T3O-87)", () => {
  it("a board holds at most half its ready workers, rounded down, at least one", () => {
    expect([1, 2, 3, 4, 5, 9].map(boardHoldLimit)).toEqual([1, 1, 1, 2, 2, 4]);
  });

  it("a card holds its top two; a second hold needs four or more ready workers", () => {
    const base = {
      ranked: [W1, W2, W3],
      holding: new Set<BoardWorkerId>(),
      boardHolding: new Set<BoardWorkerId>(),
      closed: new Set<BoardWorkerId>(),
      heldForOthers: new Set<BoardWorkerId>(),
    };
    expect(holdsToAsk({ ...base, limit: boardHoldLimit(4) }).ask).toEqual([W1, W2]);
    expect(holdsToAsk({ ...base, limit: boardHoldLimit(3) }).ask).toEqual([W1]);
  });

  it("asks a held worker as a signal outside the limit, and never one held for its own board", () => {
    const answer = holdsToAsk({
      ranked: [W1, W2, W3],
      holding: new Set(),
      boardHolding: new Set([W3]),
      limit: 1,
      closed: new Set([W1]),
      heldForOthers: new Set([W3]),
    });
    expect(answer).toEqual({ ask: [], signal: [W1] });
  });

  it("keeps refreshing what it holds even at the limit", () => {
    expect(
      holdsToAsk({
        ranked: [W1, W2],
        holding: new Set([W1]),
        boardHolding: new Set([W1]),
        limit: 1,
        closed: new Set(),
        heldForOthers: new Set(),
      }).ask,
    ).toEqual([W1]);
  });
});
