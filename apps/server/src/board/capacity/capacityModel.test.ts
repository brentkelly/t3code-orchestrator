import type {
  BoardCapacityClaimInput,
  BoardResourceProfile,
  BoardSyncedCard,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  applySyncCards,
  CLAIM_TTL_MS,
  computeHeadroom,
  consumePlacement,
  decideClaim,
  EMPTY_CAPACITY_STATE,
  forgetBoard,
  heldByBoard,
  IDLE_ACTIVITY,
  type CapacityActivity,
  type CapacityState,
  type ClaimContext,
  type MachineReading,
  type WorktreePresence,
} from "./capacityModel.ts";

const declared: BoardResourceProfile = { cpuCores: 16, ramGiB: 64, diskGB: 200 };
const card: BoardResourceProfile = { cpuCores: 4, ramGiB: 8, diskGB: 20 };
const roomy: MachineReading = { availableRamGiB: 1000, freeDiskGB: 1000 };

const context = (overrides: Partial<ClaimContext> = {}): ClaimContext => ({
  boardId: "board-a",
  declared,
  activity: IDLE_ACTIVITY,
  machine: roomy,
  now: 0,
  quotaExhausted: () => null,
  notReady: () => null,
  ...overrides,
});

const claim = (overrides: Partial<BoardCapacityClaimInput> = {}): BoardCapacityClaimInput => ({
  claimId: "card-1:1",
  seq: 1,
  cardId: "card-1",
  repositoryKey: "github.com/acme/app",
  kind: "placement",
  profile: card,
  providerInstanceId: "claude",
  ...overrides,
});

const entry = (overrides: Partial<BoardSyncedCard> = {}): BoardSyncedCard => ({
  cardId: "card-1",
  repositoryKey: "github.com/acme/app",
  branch: "board/A-1",
  worktreePath: "/w/A-1",
  grantedProfile: card,
  phase: "heavy",
  settled: false,
  ...overrides,
});

/** Grant then provision a card, as a placement does. */
function placed(
  state: CapacityState,
  boardId: string,
  cardId: string,
  profile = card,
  now = 0,
): CapacityState {
  const granted = decideClaim(
    state,
    claim({ cardId, claimId: `${cardId}:1`, profile }),
    context({ boardId, now }),
  );
  expect(granted.result.outcome).toBe("granted");
  return consumePlacement(granted.state, {
    boardId,
    cardId,
    claimId: `${cardId}:1`,
    seq: 1,
    repositoryKey: null,
    branch: `board/${cardId}`,
    worktreePath: `/w/${cardId}`,
    profile,
    now,
  }).state;
}

const sync = (
  state: CapacityState,
  input: {
    readonly boardId?: string;
    readonly seq: number;
    readonly cards: ReadonlyArray<BoardSyncedCard>;
    readonly authoritative?: boolean;
    readonly presence?: WorktreePresence;
    readonly now?: number;
  },
) =>
  applySyncCards(state, {
    boardId: input.boardId ?? "board-a",
    seq: input.seq,
    authoritative: input.authoritative ?? false,
    cards: input.cards,
    now: input.now ?? 0,
    presence: () => input.presence ?? "owned",
  });

describe("headroom", () => {
  it("counts disk always and CPU/RAM only while heavy or a turn runs there", () => {
    let state = placed(EMPTY_CAPACITY_STATE, "board-a", "card-1");
    state = sync(state, {
      seq: 2,
      cards: [entry({ phase: "light", worktreePath: "/w/card-1" })],
    }).state;
    const light = computeHeadroom({
      state,
      declared,
      activity: IDLE_ACTIVITY,
      machine: roomy,
      now: 0,
    });
    expect(light.held).toEqual({ cpuCores: 0, ramGiB: 0, diskGB: 20 });
    const running: CapacityActivity = {
      runningWorktrees: new Set(["/w/card-1"]),
      planningThreads: 2,
    };
    const busy = computeHeadroom({ state, declared, activity: running, machine: roomy, now: 0 });
    // The card's turn makes it heavy whatever phase the board sent, plus two planning threads.
    expect(busy.held).toEqual({ cpuCores: 5, ramGiB: 10, diskGB: 20 });
  });

  it("subtracts pending disk from free space during a burst, shrinking as worktrees fill", () => {
    // 100 GB free on a part-full volume; two 20 GB cards just placed.
    const machine: MachineReading = { availableRamGiB: 1000, freeDiskGB: 100 };
    let state = placed(EMPTY_CAPACITY_STATE, "board-a", "card-1");
    state = placed(state, "board-a", "card-2");
    const burst = computeHeadroom({ state, declared, activity: IDLE_ACTIVITY, machine, now: 0 });
    expect(burst.offered.diskGB).toBe(60);
    const filled: CapacityState = {
      ...state,
      records: state.records.map((record) =>
        record.cardId === "card-1" ? { ...record, measuredDiskGB: 15 } : record,
      ),
    };
    // card-1 has written 15 of its 20 GB, which the free reading now reflects.
    const later = computeHeadroom({
      state: filled,
      declared,
      activity: IDLE_ACTIVITY,
      machine: { ...machine, freeDiskGB: 85 },
      now: 0,
    });
    expect(later.offered.diskGB).toBe(60);
    const settled: CapacityState = {
      ...filled,
      records: filled.records.map((record) => ({ ...record, settled: true })),
    };
    expect(
      computeHeadroom({
        state: settled,
        declared,
        activity: IDLE_ACTIVITY,
        machine: { ...machine, freeDiskGB: 85 },
        now: 0,
      }).offered.diskGB,
    ).toBe(85);
  });

  it("holds back the RAM of cards that went heavy in the last ten minutes", () => {
    const state = placed(EMPTY_CAPACITY_STATE, "board-a", "card-1");
    const machine: MachineReading = { availableRamGiB: 20, freeDiskGB: 1000 };
    const now = computeHeadroom({ state, declared, activity: IDLE_ACTIVITY, machine, now: 0 });
    expect(now.offered.ramGiB).toBe(12);
    const later = computeHeadroom({
      state,
      declared,
      activity: IDLE_ACTIVITY,
      machine,
      now: 10 * 60_000,
    });
    expect(later.offered.ramGiB).toBe(20);
  });

  it("offers no CPU or RAM over declared CPU or RAM, and refuses only placements over disk", () => {
    const over: CapacityState = sync(EMPTY_CAPACITY_STATE, {
      seq: 1,
      cards: [entry({ grantedProfile: { cpuCores: 20, ramGiB: 8, diskGB: 20 } })],
    }).state;
    const headroom = computeHeadroom({
      state: over,
      declared,
      activity: IDLE_ACTIVITY,
      machine: roomy,
      now: 0,
    });
    expect(headroom.over.cpuRam).toBe(true);
    // No CPU or RAM; its free disk still counts (T3O-87).
    expect(headroom.offered).toEqual({ cpuCores: 0, ramGiB: 0, diskGB: 200 });

    let fullDisk = sync(EMPTY_CAPACITY_STATE, {
      seq: 1,
      cards: [entry({ phase: "light", grantedProfile: { cpuCores: 4, ramGiB: 8, diskGB: 250 } })],
      presence: "owned",
    }).state;
    // Restored records count measured disk: say the worktree really is 250 GB.
    fullDisk = {
      ...fullDisk,
      records: fullDisk.records.map((record) => ({ ...record, measuredDiskGB: 250 })),
    };
    const placement = decideClaim(fullDisk, claim({ cardId: "card-9" }), context());
    expect(placement.result).toMatchObject({
      outcome: "denied",
      reason: "capacity",
      dimension: "disk",
    });
    const grow = decideClaim(fullDisk, claim({ kind: "grow", claimId: "grow-1" }), context());
    expect(grow.result.outcome).toBe("granted");
  });

  it("starts an upgrade with many small worktrees within capacity", () => {
    const cards = Array.from({ length: 30 }, (_, index) =>
      entry({
        cardId: `card-${index}`,
        branch: `board/A-${index}`,
        worktreePath: `/w/${index}`,
        phase: "light",
        settled: true,
      }),
    );
    const restored = sync(EMPTY_CAPACITY_STATE, { seq: 1, authoritative: true, cards }).state;
    // Each restored record counts its measured size (1 GB), not the 20 GB profile.
    const measured: CapacityState = {
      ...restored,
      records: restored.records.map((record) => ({ ...record, measuredDiskGB: 0.4 })),
    };
    const headroom = computeHeadroom({
      state: measured,
      declared,
      activity: IDLE_ACTIVITY,
      machine: roomy,
      now: 0,
    });
    expect(headroom.held.diskGB).toBe(30);
    expect(headroom.over).toEqual({ cpuRam: false, disk: false });
  });
});

describe("claims", () => {
  it("a placement is consumed by its provision, even once its reservation lapsed mid-cut", () => {
    const granted = decideClaim(EMPTY_CAPACITY_STATE, claim(), context());
    expect(granted.state.reservations).toHaveLength(1);
    const consumed = consumePlacement(granted.state, {
      boardId: "board-a",
      cardId: "card-1",
      claimId: "card-1:1",
      seq: 1,
      repositoryKey: null,
      branch: "board/A-1",
      worktreePath: "/w/A-1",
      profile: card,
      now: 1_000,
    });
    expect(consumed.state.records).toHaveLength(1);
    expect(consumed.state.reservations).toHaveLength(0);
    const late = consumePlacement(granted.state, {
      boardId: "board-a",
      cardId: "card-1",
      claimId: "card-1:1",
      seq: 1,
      repositoryKey: null,
      branch: "board/A-1",
      worktreePath: "/w/A-1",
      profile: card,
      now: CLAIM_TTL_MS + 1,
    });
    expect(late.state.records).toEqual([
      expect.objectContaining({ cardId: "card-1", profile: card, phase: "heavy", settled: false }),
    ]);
    expect(late.state.reservations).toHaveLength(0);
  });

  it("a timed-out claim retried with the same id, or replaced for the same card, never double-counts", () => {
    const first = decideClaim(EMPTY_CAPACITY_STATE, claim(), context());
    const retried = decideClaim(first.state, claim(), context({ now: 5_000 }));
    expect(retried.result.outcome).toBe("granted");
    expect(retried.state.reservations).toHaveLength(1);
    const replaced = decideClaim(retried.state, claim({ claimId: "card-1:2" }), context());
    expect(replaced.state.reservations.map((reservation) => reservation.claimId)).toEqual([
      "card-1:2",
    ]);
    // Two cards of one board sit side by side, each counting.
    const second = decideClaim(
      replaced.state,
      claim({ cardId: "card-2", claimId: "card-2:1" }),
      context(),
    );
    expect(
      computeHeadroom({
        state: second.state,
        declared,
        activity: IDLE_ACTIVITY,
        machine: roomy,
        now: 0,
      }).held,
    ).toEqual({ cpuCores: 8, ramGiB: 16, diskGB: 40 });
  });

  it("a grow granted but never consumed leaves the record light after expiry", () => {
    let state = placed(EMPTY_CAPACITY_STATE, "board-a", "card-1");
    state = sync(state, {
      seq: 2,
      cards: [entry({ phase: "light", worktreePath: "/w/card-1" })],
    }).state;
    const grow = decideClaim(
      state,
      claim({ kind: "grow", claimId: "grow-1" }),
      context({ now: 0 }),
    );
    expect(grow.result.outcome).toBe("granted");
    const during = computeHeadroom({
      state: grow.state,
      declared,
      activity: IDLE_ACTIVITY,
      machine: roomy,
      now: 1_000,
    });
    expect(during.held.cpuCores).toBe(4);
    const after = computeHeadroom({
      state: grow.state,
      declared,
      activity: IDLE_ACTIVITY,
      machine: roomy,
      now: CLAIM_TTL_MS + 1,
    });
    expect(after.held.cpuCores).toBe(0);
    expect(grow.state.records[0]?.phase).toBe("light");
  });

  it("refuses quota and readiness for a placement but not for a grow", () => {
    const exhausted = context({
      quotaExhausted: () => ({ resetsAt: "2026-11-20T09:00:00.000Z" }),
      notReady: () => "not-set-up",
    });
    expect(decideClaim(EMPTY_CAPACITY_STATE, claim(), exhausted).result).toMatchObject({
      reason: "not-ready",
    });
    expect(
      decideClaim(EMPTY_CAPACITY_STATE, claim(), { ...exhausted, notReady: () => null }).result,
    ).toMatchObject({ reason: "quota", resetsAt: "2026-11-20T09:00:00.000Z" });
    const state = placed(EMPTY_CAPACITY_STATE, "board-a", "card-1");
    expect(
      decideClaim(
        state,
        claim({ kind: "grow", claimId: "g", profile: { ...card, cpuCores: 6 } }),
        exhausted,
      ).result.outcome,
    ).toBe("granted");
  });

  it("force skips declared capacity and quota, but not the machine or readiness", () => {
    const full = sync(EMPTY_CAPACITY_STATE, {
      seq: 1,
      cards: [entry({ grantedProfile: { cpuCores: 16, ramGiB: 64, diskGB: 20 } })],
    }).state;
    const forced = claim({ cardId: "card-2", claimId: "card-2:1", force: true });
    const quota = context({ quotaExhausted: () => ({ resetsAt: null }) });
    expect(decideClaim(full, forced, quota).result.outcome).toBe("granted");
    expect(
      decideClaim(full, forced, context({ machine: { availableRamGiB: 100, freeDiskGB: 9 } }))
        .result,
    ).toMatchObject({ reason: "capacity", dimension: "disk", detail: "only 9 GB free" });
    expect(
      decideClaim(full, forced, context({ machine: { availableRamGiB: 3, freeDiskGB: 100 } }))
        .result,
    ).toMatchObject({ reason: "capacity", dimension: "ram" });
    expect(decideClaim(full, forced, context({ notReady: () => "cloning" })).result).toMatchObject({
      reason: "not-ready",
    });
  });

  it("two boards compete for one worker's headroom, and neither sees the other's records", () => {
    let state = placed(EMPTY_CAPACITY_STATE, "board-a", "card-1", {
      cpuCores: 13,
      ramGiB: 8,
      diskGB: 20,
    });
    const refused = decideClaim(
      state,
      claim({ cardId: "card-x", claimId: "x" }),
      context({ boardId: "board-b" }),
    );
    expect(refused.result).toMatchObject({ reason: "capacity", dimension: "cpu" });
    // board-a's card finishes and goes light: board-b's claim fits.
    state = sync(state, {
      seq: 2,
      cards: [
        entry({
          phase: "light",
          worktreePath: "/w/card-1",
          grantedProfile: { cpuCores: 13, ramGiB: 8, diskGB: 20 },
        }),
      ],
    }).state;
    const granted = decideClaim(
      state,
      claim({ cardId: "card-x", claimId: "x" }),
      context({ boardId: "board-b" }),
    );
    expect(granted.result.outcome).toBe("granted");
    const byBoard = heldByBoard(granted.state, IDLE_ACTIVITY, 0);
    expect(byBoard.get("board-a")).toEqual({ cpuCores: 0, ramGiB: 0, diskGB: 20 });
    expect(byBoard.get("board-b")).toEqual(card);
  });
});

describe("syncCards", () => {
  it("adopts listed cards, deletes the board's unlisted ones, and leaves other boards alone", () => {
    let state = placed(EMPTY_CAPACITY_STATE, "board-a", "card-1");
    state = placed(state, "board-b", "card-b");
    const next = sync(state, { seq: 5, cards: [entry({ cardId: "card-2", branch: "board/A-2" })] });
    expect(next.state.records.map((record) => `${record.boardId}/${record.cardId}`).sort()).toEqual(
      ["board-a/card-2", "board-b/card-b"],
    );
  });

  it("restores a lost record over capacity without a claim, at no more than was granted", () => {
    const huge = { cpuCores: 40, ramGiB: 200, diskGB: 20 };
    const restored = sync(EMPTY_CAPACITY_STATE, {
      seq: 1,
      cards: [entry({ grantedProfile: huge })],
    });
    expect(restored.state.records[0]).toMatchObject({
      profile: huge,
      settled: true,
      diskFromMeasurement: true,
    });
    expect(
      computeHeadroom({
        state: restored.state,
        declared,
        activity: IDLE_ACTIVITY,
        machine: roomy,
        now: 0,
      }).over.cpuRam,
    ).toBe(true);
  });

  it("can't create a record for a worktree that isn't there, or is another board's", () => {
    for (const presence of ["missing", "foreign"] as const) {
      const result = sync(EMPTY_CAPACITY_STATE, { seq: 1, cards: [entry()], presence });
      expect(result.state.records).toEqual([]);
      expect(result.refused).toEqual(["card-1"]);
    }
  });

  it("never takes a path from the board for a worktree that isn't this board's", () => {
    const state = placed(EMPTY_CAPACITY_STATE, "board-a", "card-1");
    const moved = sync(state, {
      seq: 2,
      cards: [entry({ worktreePath: "/w/other-board" })],
      presence: "foreign",
    });
    expect(moved.state.records[0]?.worktreePath).toBe("/w/card-1");
    // A placement's entry, too: no path until the worktree there carries this board's marker.
    const granted = decideClaim(EMPTY_CAPACITY_STATE, claim(), context());
    const aimed = sync(granted.state, {
      seq: 2,
      cards: [entry({ worktreePath: "/w/other-board" })],
      presence: "foreign",
    });
    expect(aimed.state.records[0]?.worktreePath).toBeNull();
  });

  it("ignores a stale seq, and never lowers or deletes a record a later call stamped", () => {
    let state = placed(EMPTY_CAPACITY_STATE, "board-a", "card-1");
    state = sync(state, {
      seq: 3,
      cards: [entry({ worktreePath: "/w/card-1", phase: "light" })],
    }).state;
    // A grow lands as seq 5 (the board raised the card to heavy).
    state = sync(state, {
      seq: 5,
      cards: [entry({ worktreePath: "/w/card-1", phase: "heavy" })],
    }).state;
    const stale = sync(state, { seq: 4, cards: [] });
    expect(stale.applied).toBe(false);
    expect(stale.state.records).toHaveLength(1);
    // A sync reordered against the later grow: seq 5 again, saying light, may not lower it…
    const sameSeq = sync(state, {
      seq: 5,
      cards: [entry({ worktreePath: "/w/card-1", phase: "light" })],
    });
    expect(sameSeq.state.records[0]?.phase).toBe("heavy");
    // …but seq 6 may, and an empty seq 6 deletes it.
    expect(
      sync(state, { seq: 6, cards: [entry({ worktreePath: "/w/card-1", phase: "light" })] }).state
        .records[0]?.phase,
    ).toBe("light");
    expect(sync(state, { seq: 6, cards: [] }).state.records).toEqual([]);
  });

  it("the first sync on a new connection is authoritative, even with a lower seq", () => {
    let state = placed(EMPTY_CAPACITY_STATE, "board-a", "card-1");
    state = sync(state, { seq: 40, cards: [entry({ worktreePath: "/w/card-1" })] }).state;
    // The board's database was restored: its counter is back at 7.
    const restored = sync(state, { seq: 7, authoritative: true, cards: [] });
    expect(restored.applied).toBe(true);
    expect(restored.state.records).toEqual([]);
    expect(restored.state.lastSeq.get("board-a")).toBe(7);
  });

  it("a card still provisioning is listed and its entry consumes the placement claim", () => {
    const granted = decideClaim(EMPTY_CAPACITY_STATE, claim(), context());
    const synced = sync(granted.state, {
      seq: 2,
      cards: [entry({ worktreePath: null })],
      presence: "missing",
    });
    expect(synced.refused).toEqual([]);
    expect(synced.state.reservations).toEqual([]);
    expect(synced.state.records[0]).toMatchObject({ cardId: "card-1", settled: false });
  });

  it("a grow is consumed by the sync that lists the card heavy", () => {
    let state = placed(EMPTY_CAPACITY_STATE, "board-a", "card-1");
    state = sync(state, {
      seq: 2,
      cards: [entry({ worktreePath: "/w/card-1", phase: "light" })],
    }).state;
    state = decideClaim(state, claim({ kind: "grow", claimId: "g" }), context()).state;
    expect(state.reservations).toHaveLength(1);
    state = sync(state, {
      seq: 3,
      cards: [entry({ worktreePath: "/w/card-1", phase: "heavy" })],
    }).state;
    expect(state.reservations).toEqual([]);
    expect(state.records[0]?.phase).toBe("heavy");
  });

  it("a settled record's disk is never regrown", () => {
    let state = placed(EMPTY_CAPACITY_STATE, "board-a", "card-1");
    state = sync(state, {
      seq: 2,
      cards: [entry({ worktreePath: "/w/card-1", settled: true })],
    }).state;
    state = sync(state, {
      seq: 3,
      cards: [
        entry({
          worktreePath: "/w/card-1",
          settled: true,
          grantedProfile: { ...card, diskGB: 40 },
        }),
      ],
    }).state;
    expect(state.records[0]?.profile.diskGB).toBe(20);
  });

  it("a grow judges an unsettled card's larger disk, never a settled one's", () => {
    // 20 GB placed, 170 GB held by another card: 10 GB of declared disk is left.
    let state = placed(EMPTY_CAPACITY_STATE, "board-a", "card-1");
    state = placed(state, "board-b", "card-b", { ...card, diskGB: 170 });
    const bigger = { ...card, diskGB: 40 };
    const grow = (from: CapacityState) =>
      decideClaim(from, claim({ kind: "grow", claimId: "g", profile: bigger }), context());
    expect(grow(state).result).toMatchObject({ outcome: "denied", dimension: "disk" });
    const within = decideClaim(
      state,
      claim({ kind: "grow", claimId: "g", profile: { ...card, diskGB: 30 } }),
      context(),
    );
    expect(within.result.outcome).toBe("granted");
    const settled = sync(state, {
      seq: 2,
      cards: [entry({ worktreePath: "/w/card-1", settled: true })],
    }).state;
    expect(grow(settled).result.outcome).toBe("granted");
  });

  it("forgetting a board drops its records and claims only", () => {
    let state = placed(EMPTY_CAPACITY_STATE, "board-a", "card-1");
    state = decideClaim(state, claim({ cardId: "card-2", claimId: "c2" }), context()).state;
    state = placed(state, "board-b", "card-b");
    const after = forgetBoard(state, "board-a");
    expect(after.records.map((record) => record.boardId)).toEqual(["board-b"]);
    expect(after.reservations).toEqual([]);
    expect(after.lastSeq.has("board-a")).toBe(false);
  });
});
