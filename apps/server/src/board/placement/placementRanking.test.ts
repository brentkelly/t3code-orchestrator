import {
  BOARD_LOCAL_WORKER_ID,
  boardCardPlacementTarget,
  BoardCardId,
  EnvironmentId,
  ProjectId,
  ThreadId,
  type BoardCard,
  type BoardResourceProfile,
  type BoardStepCompletion,
  type BoardWorkerCapacitySnapshot,
  type BoardWorkerId,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";

import {
  boardBuildHistory,
  boardWorkerReadyForProject,
  localIsBuildCandidate,
  PLACEMENT_WARM_WINDOW_MS,
  placementWait,
  rankPlacement,
  warmWorkers,
  type PlacementWorkerFacts,
} from "./placementRanking.ts";

const W1 = EnvironmentId.make("env-w1");
const W2 = EnvironmentId.make("env-w2");
const W3 = EnvironmentId.make("env-w3");
const NOW = Date.parse("2026-06-01T12:00:00.000Z");
const HOUR = 60 * 60_000;

const M: BoardResourceProfile = { cpuCores: 4, ramGiB: 8, diskGB: 10 };

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
  declared: { cpuCores: 16, ramGiB: 32, diskGB: 200 },
  headroom: { cpuCores: 16, ramGiB: 32, diskGB: 200 },
  over: { cpuRam: false, disk: false },
  ...overrides,
});

const rank = (
  workers: ReadonlyArray<PlacementWorkerFacts>,
  options: {
    readonly warm?: ReadonlyMap<BoardWorkerId, number>;
    readonly pinnedWorkerId?: BoardWorkerId | null;
    readonly force?: boolean;
    readonly excluded?: ReadonlySet<BoardWorkerId>;
  } = {},
) =>
  rankPlacement({
    workers,
    profile: M,
    warm: options.warm ?? new Map(),
    pinnedWorkerId: options.pinnedWorkerId ?? null,
    repositoryLabel: "z5",
    ...(options.force === undefined ? {} : { force: options.force }),
    ...(options.excluded === undefined ? {} : { excluded: options.excluded }),
  });

const order = (result: ReturnType<typeof rank>) => result.ranked.map((entry) => entry.workerId);

describe("placement ranking (T3O-87)", () => {
  it.each([
    {
      name: "the most room left after the card wins, on the tighter of CPU and RAM",
      workers: [
        worker(W1, { headroom: { cpuCores: 8, ramGiB: 32, diskGB: 200 } }),
        worker(W2, { headroom: { cpuCores: 12, ramGiB: 16, diskGB: 200 } }),
      ],
      // W1: min((8-4)/16, (32-8)/32) = 0.25; W2: min((12-4)/16, (16-8)/32) = 0.25 → id.
      expected: [W1, W2],
    },
    {
      name: "room is a share of what each worker declares",
      workers: [
        worker(W1, {
          declared: { cpuCores: 64, ramGiB: 256, diskGB: 500 },
          headroom: { cpuCores: 20, ramGiB: 64, diskGB: 500 },
        }),
        worker(W2, { headroom: { cpuCores: 16, ramGiB: 32, diskGB: 200 } }),
      ],
      // W1: min(16/64, 56/256) = 0.22; W2: min(12/16, 24/32) = 0.75.
      expected: [W2, W1],
    },
    {
      name: "a tie on room goes to the worker id",
      workers: [worker(W2), worker(W1)],
      expected: [W1, W2],
    },
    {
      name: "the board server is a candidate when it is ready",
      workers: [
        worker(BOARD_LOCAL_WORKER_ID),
        worker(W1, { headroom: { cpuCores: 6, ramGiB: 12, diskGB: 200 } }),
      ],
      expected: [BOARD_LOCAL_WORKER_ID, W1],
    },
    {
      name: "a worker whose snapshot shows the card doesn't fit is not a candidate",
      workers: [worker(W1, { headroom: { cpuCores: 2, ramGiB: 32, diskGB: 200 } }), worker(W2)],
      expected: [W2],
    },
    {
      name: "over declared CPU or RAM offers nothing",
      workers: [worker(W1, { over: { cpuRam: true, disk: false } }), worker(W2)],
      expected: [W2],
    },
    {
      name: "offline, below the floor, without a checkout, not ready, signed out, out of quota or closed: none is eligible",
      workers: [
        worker(W1, { online: false }),
        worker(W2, { atFloor: false }),
        worker(W3, { hasCheckout: false }),
        worker(EnvironmentId.make("env-w4"), { readiness: "failed" }),
        worker(EnvironmentId.make("env-w5"), { readiness: "pending" }),
        worker(EnvironmentId.make("env-w6"), { providerSignedIn: false }),
        worker(EnvironmentId.make("env-w7"), { quotaRoom: false }),
        worker(EnvironmentId.make("env-w8"), { closed: true }),
      ],
      expected: [],
    },
  ])("$name", ({ workers, expected }) => {
    expect(order(rank(workers))).toEqual(expected);
  });

  it("warm first inside 24 hours, most recent first, whatever the room", () => {
    const warm = warmWorkers({
      builds: [
        { workerId: W2, at: NOW - 3 * HOUR },
        { workerId: W3, at: NOW - 1 * HOUR },
        // Outside the window: not warm.
        { workerId: W1, at: NOW - PLACEMENT_WARM_WINDOW_MS - 1 },
      ],
      now: NOW,
    });
    expect([...warm.keys()].sort()).toEqual([W2, W3]);
    const result = rank(
      [
        worker(W1),
        worker(W2, { headroom: { cpuCores: 5, ramGiB: 9, diskGB: 200 } }),
        worker(W3, { headroom: { cpuCores: 5, ramGiB: 9, diskGB: 200 } }),
      ],
      { warm },
    );
    expect(order(result)).toEqual([W3, W2, W1]);
    expect(result.ranked[0]!.reason).toBe("built z5 most recently");
    expect(result.ranked[2]!.reason).toBe("offered the most RAM among ready workers");
  });

  it("a warm worker that can't take the card now is passed over", () => {
    const warm = warmWorkers({ builds: [{ workerId: W1, at: NOW - HOUR }], now: NOW });
    expect(order(rank([worker(W1, { closed: true }), worker(W2)], { warm }))).toEqual([W2]);
  });

  it("only Building steps on the same repository warm a worker", () => {
    const completion = (
      cardId: string,
      stepId: string,
      outcome: BoardStepCompletion["outcome"],
      threadId: string,
    ): BoardStepCompletion => ({
      cardId: BoardCardId.make(cardId),
      stepId,
      outcome,
      summary: "Done.",
      payload: null,
      threadId: ThreadId.make(threadId),
      completedAt: "2026-06-01T11:00:00.000Z",
    });
    const card = (id: string, projectId: string, threadId: string, workerId?: BoardWorkerId) =>
      ({
        id: BoardCardId.make(id),
        projectId: ProjectId.make(projectId),
        threadLinks: [
          {
            threadId: ThreadId.make(threadId),
            role: "building",
            linkedAt: "2026-06-01T10:00:00.000Z",
            tombstonedAt: null,
            ...(workerId === undefined || workerId === BOARD_LOCAL_WORKER_ID ? {} : { workerId }),
          },
        ],
      }) as unknown as BoardCard;
    const history = boardBuildHistory({
      board: {
        cards: [
          card("built", "repo", "t-built", W1),
          card("reviewed", "repo", "t-reviewed", W2),
          card("failed", "repo", "t-failed", W3),
          card("other-repo", "other", "t-other", W3),
          card("here", "repo", "t-here"),
        ],
        stepCompletions: [
          completion("built", "building", "succeeded", "t-built"),
          completion("reviewed", "review", "succeeded", "t-reviewed"),
          completion("failed", "building", "failed", "t-failed"),
          completion("other-repo", "building", "succeeded", "t-other"),
          completion("here", "building", "succeeded", "t-here"),
          // Its thread link is gone: where it ran is unknown, so it warms nothing.
          completion("built", "building", "succeeded", "t-unlinked"),
        ],
      },
      buildStageId: "building",
      sameRepository: (projectId) => projectId === ProjectId.make("repo"),
    });
    expect(history.map((build) => build.workerId)).toEqual([W1, BOARD_LOCAL_WORKER_ID]);
  });

  it("a pin restricts the candidates to the pinned worker", () => {
    const result = rank([worker(W1), worker(W2)], { pinnedWorkerId: W2 });
    expect(order(result)).toEqual([W2]);
    expect(result.ranked[0]!.reason).toBe("pinned");
    expect(order(rank([worker(W1), worker(W2, { closed: true })], { pinnedWorkerId: W2 }))).toEqual(
      [],
    );
  });

  it("force-start ignores capacity, quota and holds, but not readiness or the provider", () => {
    const result = rank(
      [
        worker(W1, { headroom: { cpuCores: 0, ramGiB: 0, diskGB: 0 }, closed: true }),
        worker(W2, { quotaRoom: false }),
        worker(W3, { readiness: "failed" }),
      ],
      { force: true },
    );
    expect(order(result).sort()).toEqual([W1, W2]);
  });

  it("a worker excluded this pass is not a candidate", () => {
    expect(order(rank([worker(W1), worker(W2)], { excluded: new Set([W1]) }))).toEqual([W2]);
  });

  it("the board server is excluded at zero declared build capacity", () => {
    expect(localIsBuildCandidate({ cpuCores: 0, ramGiB: 0, diskGB: 50 })).toBe(false);
    expect(localIsBuildCandidate({ cpuCores: 4, ramGiB: 8, diskGB: 50 })).toBe(true);
    expect(localIsBuildCandidate(null)).toBe(true);
  });

  it("a worker counts ready for a project only with its gate ready and its readiness clear", () => {
    const snapshot = (
      declared: BoardResourceProfile,
      state: "ready" | "not-ready" | "cloning" | null = null,
    ): BoardWorkerCapacitySnapshot => ({
      at: "2026-06-01T12:00:00.000Z",
      declared,
      headroom: declared,
      over: { cpuRam: false, disk: false },
      agents: { running: 0, max: null },
      providers: [],
      readiness:
        state === null
          ? []
          : [{ repositoryKey: "repo", path: "/r", state, version: null, checkedAt: null }],
      heavyCards: [],
    });
    const big = { cpuCores: 64, ramGiB: 256, diskGB: 1000 };
    const ready = (
      workerId: BoardWorkerId,
      gate: "ready" | "offline" | "no-checkout",
      snap: BoardWorkerCapacitySnapshot,
    ) =>
      boardWorkerReadyForProject({
        workerId,
        gate,
        snapshot: snap,
        repositoryKey: "repo",
        projectId: "p",
      });
    expect(ready(W1, "ready", snapshot(big))).toBe(true);
    expect(ready(W1, "ready", snapshot(big, "ready"))).toBe(true);
    expect(ready(W1, "offline", snapshot(big))).toBe(false);
    expect(ready(W1, "no-checkout", snapshot(big))).toBe(false);
    expect(ready(W1, "ready", snapshot(big, "not-ready"))).toBe(false);
    expect(ready(W1, "ready", snapshot(big, "cloning"))).toBe(false);
    expect(
      ready(BOARD_LOCAL_WORKER_ID, "ready", snapshot({ cpuCores: 0, ramGiB: 0, diskGB: 50 })),
    ).toBe(false);
    expect(ready(BOARD_LOCAL_WORKER_ID, "ready", snapshot(big))).toBe(true);
  });
});

describe("the placement target (T3O-87)", () => {
  const worktree = (status: "ready" | "provisioning" | "reclaimed" | "branch-only") => ({
    branch: "board/card-1",
    baseRefName: "main",
    path: status === "ready" ? "/wt/card-1" : null,
    status,
    attempts: 1,
    lastError: null,
    reclaimBlockedReason: null,
  });
  it.each([
    {
      name: "unplaced and pinned: none until placed",
      card: { worktree: null, pinnedWorkerId: W1, placedWorkerId: null },
      expected: null,
    },
    {
      name: "placed but no worktree: none",
      card: { worktree: null, pinnedWorkerId: null, placedWorkerId: W1 },
      expected: null,
    },
    {
      name: "placed with a worktree being cut",
      card: { worktree: worktree("provisioning"), pinnedWorkerId: null, placedWorkerId: W1 },
      expected: W1,
    },
    {
      name: "placed with a ready worktree, whatever the pin",
      card: { worktree: worktree("ready"), pinnedWorkerId: W2, placedWorkerId: W1 },
      expected: W1,
    },
    {
      name: "a reclaimed worktree: none",
      card: { worktree: worktree("reclaimed"), pinnedWorkerId: null, placedWorkerId: W1 },
      expected: null,
    },
    {
      name: "an integration branch only: none",
      card: { worktree: worktree("branch-only"), pinnedWorkerId: null, placedWorkerId: W1 },
      expected: null,
    },
    {
      name: "a worktree from before workers: this server",
      card: { worktree: worktree("ready"), pinnedWorkerId: null, placedWorkerId: null },
      expected: BOARD_LOCAL_WORKER_ID,
    },
  ])("$name", ({ card, expected }) => {
    expect(boardCardPlacementTarget(card)).toBe(expected);
  });
});

describe("why a card waits (T3O-87)", () => {
  const wait = (
    workers: ReadonlyArray<PlacementWorkerFacts>,
    pinnedWorkerId: BoardWorkerId | null = null,
  ) =>
    placementWait({
      verdicts: rank(workers, { pinnedWorkerId }).verdicts,
      pinned: pinnedWorkerId !== null,
    });

  it("no worker ready for the project is amber", () => {
    expect(wait([worker(W1, { hasCheckout: false }), worker(W2, { readiness: "failed" })])).toEqual(
      { kind: "no-ready-worker" },
    );
  });

  it("too big for every ready worker, unpinned, names no worker; pinned, names the pin", () => {
    const small = { cpuCores: 2, ramGiB: 4, diskGB: 200 };
    expect(wait([worker(W1, { declared: small }), worker(W2, { declared: small })])).toEqual({
      kind: "too-big",
      dimension: "cpu",
      workerId: null,
    });
    expect(wait([worker(W1, { declared: small }), worker(W2)], W1)).toEqual({
      kind: "too-big",
      dimension: "cpu",
      workerId: W1,
    });
  });

  it("too big for one worker but not another is a capacity wait, not too big", () => {
    const full = { cpuCores: 0, ramGiB: 0, diskGB: 200 };
    expect(
      wait([
        worker(W1, { declared: { cpuCores: 2, ramGiB: 4, diskGB: 200 } }),
        worker(W2, { headroom: full }),
      ]),
    ).toEqual({ kind: "queued", reason: "capacity", workerId: W2, dimension: "cpu" });
  });

  it("among queued reasons, the one that rules out the most workers", () => {
    expect(
      wait([
        worker(W1, { quotaRoom: false }),
        worker(W2, { quotaRoom: false }),
        worker(W3, { closed: true }),
      ]),
    ).toMatchObject({ kind: "queued", reason: "quota" });
  });

  it("a worker still setting up is a wait that clears by itself, not amber", () => {
    expect(wait([worker(W1, { readiness: "pending" })])).toMatchObject({
      kind: "queued",
      reason: "setting-up",
    });
  });
});
