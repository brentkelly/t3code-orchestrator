/**
 * The worker's capacity arithmetic (T3O-86), pure so every rule is testable without a
 * machine: card records and reservations per board, what they hold, what the worker
 * offers each board, and the verdict on a claim or a `syncCards`. Times are epoch millis
 * from the Effect clock; the service around this owns persistence and readings.
 */
import {
  BOARD_RESOURCE_DIMENSIONS,
  boardResourceProfileValue,
  ZERO_BOARD_RESOURCE_PROFILE,
  type BoardCapacityClaimInput,
  type BoardCapacityClaimResult,
  type BoardCardPhase,
  type BoardResourceDimension,
  type BoardResourceProfile,
  type BoardSyncCardsInput,
} from "@t3tools/contracts";

/** How long an unconsumed claim holds its load. */
export const CLAIM_TTL_MS = 60_000;
/** A card that went heavy this recently has not yet taken the RAM it reserved. */
const RECENT_HEAVY_MS = 10 * 60_000;
/** A planning thread's load while its turn runs. */
const PLANNING_THREAD_LOAD: BoardResourceProfile = { cpuCores: 0.5, ramGiB: 1, diskGB: 0 };

export interface CapacityRecord {
  readonly boardId: string;
  readonly cardId: string;
  readonly repositoryKey: string | null;
  readonly branch: string;
  readonly worktreePath: string | null;
  readonly profile: BoardResourceProfile;
  readonly phase: BoardCardPhase;
  readonly settled: boolean;
  /** The `seq` of the call that created or last raised it. */
  readonly seq: number;
  /** A backfilled or restored record counts its worktree's measured size, not the profile. */
  readonly diskFromMeasurement: boolean;
  /** The worktree's measured size in GB, or null before the first measurement. */
  readonly measuredDiskGB: number | null;
  readonly measuredAt: number | null;
  /** When the record last went heavy, or null while light. */
  readonly heavySince: number | null;
}

export interface Reservation {
  readonly boardId: string;
  readonly cardId: string;
  readonly claimId: string;
  readonly kind: "placement" | "grow";
  readonly profile: BoardResourceProfile;
  /** What the claim adds to the worker's load while unconsumed. */
  readonly load: BoardResourceProfile;
  readonly repositoryKey: string | null;
  readonly expiresAt: number;
}

export interface CapacityState {
  readonly records: ReadonlyArray<CapacityRecord>;
  readonly reservations: ReadonlyArray<Reservation>;
  /** Per board, the `seq` of the last call accepted. */
  readonly lastSeq: ReadonlyMap<string, number>;
}

export const EMPTY_CAPACITY_STATE: CapacityState = {
  records: [],
  reservations: [],
  lastSeq: new Map(),
};

/** What runs on the worker now, read from its own threads. */
export interface CapacityActivity {
  /** Worktree paths with a turn running (background work counts; waiting on a human not). */
  readonly runningWorktrees: ReadonlySet<string>;
  /** Board-spawned threads running outside any card worktree: planning. */
  readonly planningThreads: number;
}

export const IDLE_ACTIVITY: CapacityActivity = { runningWorktrees: new Set(), planningThreads: 0 };

export interface MachineReading {
  /** GiB the kernel reports available (`MemAvailable`), or null when unknown. */
  readonly availableRamGiB: number | null;
  /** GB free on the worktree volume, or null when unknown. */
  readonly freeDiskGB: number | null;
}

const add = (left: BoardResourceProfile, right: BoardResourceProfile): BoardResourceProfile => ({
  cpuCores: left.cpuCores + right.cpuCores,
  ramGiB: left.ramGiB + right.ramGiB,
  diskGB: left.diskGB + right.diskGB,
});

const round2 = (value: number) => Math.round(value * 100) / 100;
const clean = (profile: BoardResourceProfile): BoardResourceProfile => ({
  cpuCores: round2(profile.cpuCores),
  ramGiB: round2(profile.ramGiB),
  diskGB: round2(profile.diskGB),
});

const liveReservations = (state: CapacityState, now: number) =>
  state.reservations.filter((reservation) => reservation.expiresAt > now);

/** Whether the worker counts the record's CPU and RAM: heavy, or a turn running there. */
export const recordIsHeavy = (record: CapacityRecord, activity: CapacityActivity) =>
  record.phase === "heavy" ||
  (record.worktreePath !== null && activity.runningWorktrees.has(record.worktreePath));

/** The disk a record holds: its profile, or for a backfilled record its measured size. */
const recordDiskGB = (record: CapacityRecord) =>
  record.diskFromMeasurement ? Math.ceil(record.measuredDiskGB ?? 0) : record.profile.diskGB;

const recordLoad = (record: CapacityRecord, activity: CapacityActivity): BoardResourceProfile => {
  const heavy = recordIsHeavy(record, activity);
  return {
    cpuCores: heavy ? record.profile.cpuCores : 0,
    ramGiB: heavy ? record.profile.ramGiB : 0,
    diskGB: recordDiskGB(record),
  };
};

/** Everything the worker holds, across every board it serves. */
function heldLoad(
  state: CapacityState,
  activity: CapacityActivity,
  now: number,
): BoardResourceProfile {
  let held = {
    cpuCores: PLANNING_THREAD_LOAD.cpuCores * activity.planningThreads,
    ramGiB: PLANNING_THREAD_LOAD.ramGiB * activity.planningThreads,
    diskGB: 0,
  };
  for (const record of state.records) held = add(held, recordLoad(record, activity));
  for (const reservation of liveReservations(state, now)) held = add(held, reservation.load);
  return clean(held);
}

/** What one board's own cards and claims hold, for `t3o-worker status`. */
export function heldByBoard(
  state: CapacityState,
  activity: CapacityActivity,
  now: number,
): ReadonlyMap<string, BoardResourceProfile> {
  const byBoard = new Map<string, BoardResourceProfile>();
  const bump = (boardId: string, load: BoardResourceProfile) =>
    byBoard.set(boardId, clean(add(byBoard.get(boardId) ?? ZERO_BOARD_RESOURCE_PROFILE, load)));
  for (const record of state.records) bump(record.boardId, recordLoad(record, activity));
  for (const reservation of liveReservations(state, now)) {
    bump(reservation.boardId, reservation.load);
  }
  return byBoard;
}

/** Disk the burst of recent placements will still fill: unsettled records' unfilled
    profile, plus the disk unconsumed claims add. */
function pendingDiskGB(state: CapacityState, now: number): number {
  let pending = 0;
  for (const record of state.records) {
    if (record.settled || record.diskFromMeasurement) continue;
    pending += Math.max(0, record.profile.diskGB - (record.measuredDiskGB ?? 0));
  }
  for (const reservation of liveReservations(state, now)) {
    pending += reservation.load.diskGB;
  }
  return round2(pending);
}

/** RAM reserved by cards that went heavy in the last ten minutes, not yet in use. */
function recentHeavyRamGiB(state: CapacityState, activity: CapacityActivity, now: number): number {
  let recent = 0;
  for (const record of state.records) {
    if (!recordIsHeavy(record, activity)) continue;
    if (record.heavySince !== null && now - record.heavySince < RECENT_HEAVY_MS) {
      recent += record.profile.ramGiB;
    }
  }
  return round2(recent);
}

export interface Headroom {
  readonly declared: BoardResourceProfile;
  readonly held: BoardResourceProfile;
  /** What a claim may take now, each dimension at least 0. */
  readonly offered: BoardResourceProfile;
  readonly over: { readonly cpuRam: boolean; readonly disk: boolean };
}

/** CPU = declared - held; disk and RAM are also capped by what the machine really has. */
export function computeHeadroom(input: {
  readonly state: CapacityState;
  readonly declared: BoardResourceProfile;
  readonly activity: CapacityActivity;
  readonly machine: MachineReading;
  readonly now: number;
}): Headroom {
  const held = heldLoad(input.state, input.activity, input.now);
  const over = {
    cpuRam: held.cpuCores > input.declared.cpuCores || held.ramGiB > input.declared.ramGiB,
    disk: held.diskGB > input.declared.diskGB,
  };
  const cpu = input.declared.cpuCores - held.cpuCores;
  const disk = Math.min(
    input.declared.diskGB - held.diskGB,
    input.machine.freeDiskGB === null
      ? Number.POSITIVE_INFINITY
      : input.machine.freeDiskGB - pendingDiskGB(input.state, input.now),
  );
  const ram = Math.min(
    input.declared.ramGiB - held.ramGiB,
    input.machine.availableRamGiB === null
      ? Number.POSITIVE_INFINITY
      : input.machine.availableRamGiB - recentHeavyRamGiB(input.state, input.activity, input.now),
  );
  const offered = over.cpuRam
    ? ZERO_BOARD_RESOURCE_PROFILE
    : clean({
        cpuCores: Math.max(0, cpu),
        ramGiB: Math.max(0, ram),
        diskGB: Math.max(0, disk),
      });
  return { declared: input.declared, held, offered, over };
}

export const firstShort = (
  need: BoardResourceProfile,
  offered: BoardResourceProfile,
  dimensions: ReadonlyArray<BoardResourceDimension> = BOARD_RESOURCE_DIMENSIONS,
): BoardResourceDimension | null =>
  dimensions.find(
    (dimension) =>
      boardResourceProfileValue(need, dimension) > boardResourceProfileValue(offered, dimension),
  ) ?? null;

export interface ClaimContext {
  readonly boardId: string;
  readonly declared: BoardResourceProfile;
  readonly activity: CapacityActivity;
  readonly machine: MachineReading;
  readonly now: number;
  /** Null when the provider may take a placement; else when its window resets. */
  readonly quotaExhausted: (
    providerInstanceId: string | null,
  ) => { readonly resetsAt: string | null } | null;
  /** Whether the worker is ready for the repository: null when ready, else why not. */
  readonly notReady: (repositoryKey: string | null) => string | null;
  /** T3o: a held card starting early needs this share of its CPU and RAM free, and all its
      disk (T3O-87). Absent: the whole profile, as for any claim. */
  readonly earlyStartFraction?: number;
}

export interface ClaimDecision {
  readonly result: BoardCapacityClaimResult;
  readonly state: CapacityState;
}

const denied = (
  reason: string,
  extra: Omit<Extract<BoardCapacityClaimResult, { outcome: "denied" }>, "outcome" | "reason"> = {},
): BoardCapacityClaimResult => ({ outcome: "denied", reason, ...extra });

const withoutCardReservation = (state: CapacityState, boardId: string, cardId: string) =>
  state.reservations.filter(
    (reservation) => !(reservation.boardId === boardId && reservation.cardId === cardId),
  );

/**
 * A claim's verdict. A granted claim becomes a 60-second reservation that replaces any
 * other unconsumed reservation for the same card; a repeat of the same claim id is
 * answered again without counting twice.
 */
export function decideClaim(
  state: CapacityState,
  input: BoardCapacityClaimInput,
  context: ClaimContext,
): ClaimDecision {
  const now = context.now;
  const current = {
    ...state,
    reservations: liveReservations(state, now),
  };
  const existing = current.reservations.find(
    (reservation) =>
      reservation.boardId === context.boardId && reservation.claimId === input.claimId,
  );
  if (existing !== undefined) return { result: { outcome: "granted" }, state: current };
  const record = current.records.find(
    (candidate) => candidate.boardId === context.boardId && candidate.cardId === input.cardId,
  );
  // Judged without this card's own older reservation: the new one replaces it.
  const others: CapacityState = {
    ...current,
    reservations: withoutCardReservation(current, context.boardId, input.cardId),
  };
  const headroom = computeHeadroom({
    state: others,
    declared: context.declared,
    activity: context.activity,
    machine: context.machine,
    now,
  });

  if (input.kind === "placement") {
    // A resumed provision resends its claim; the record it made already exists.
    if (record !== undefined) return { result: { outcome: "granted" }, state: current };
    const why = context.notReady(input.repositoryKey);
    if (why !== null) return { result: denied("not-ready", { detail: why }), state: current };
    if (input.force === true) {
      const physical = physicalShortfall(input.profile, context.machine);
      if (physical !== null) {
        return { result: denied("capacity", physical), state: current };
      }
    } else {
      const quota = context.quotaExhausted(input.providerInstanceId);
      if (quota !== null) {
        return {
          result: denied("quota", {
            ...(input.providerInstanceId === null
              ? {}
              : { providerInstanceId: input.providerInstanceId }),
            resetsAt: quota.resetsAt,
          }),
          state: current,
        };
      }
      if (headroom.over.cpuRam) {
        const dimension = headroom.held.cpuCores > context.declared.cpuCores ? "cpu" : "ram";
        return { result: denied("capacity", { dimension }), state: current };
      }
      if (headroom.over.disk)
        return { result: denied("capacity", { dimension: "disk" }), state: current };
      const fraction = context.earlyStartFraction ?? 1;
      const need: BoardResourceProfile = {
        cpuCores: input.profile.cpuCores * fraction,
        ramGiB: input.profile.ramGiB * fraction,
        diskGB: input.profile.diskGB,
      };
      const short = firstShort(need, headroom.offered);
      if (short !== null)
        return { result: denied("capacity", { dimension: short }), state: current };
    }
    return {
      result: { outcome: "granted" },
      state: {
        ...others,
        reservations: [
          ...others.reservations,
          {
            boardId: context.boardId,
            cardId: input.cardId,
            claimId: input.claimId,
            kind: "placement",
            profile: input.profile,
            load: input.profile,
            repositoryKey: input.repositoryKey,
            expiresAt: now + CLAIM_TTL_MS,
          },
        ],
      },
    };
  }

  // A grow, for a card already here: CPU and RAM, plus disk only while the record is
  // unsettled (a settled record's disk is never regrown, see applySyncCards).
  if (record === undefined) {
    return {
      result: denied("capacity", { detail: "The card has no worktree on this worker." }),
      state: current,
    };
  }
  const heavyNow = recordIsHeavy(record, context.activity);
  const load: BoardResourceProfile = {
    cpuCores: Math.max(0, input.profile.cpuCores - (heavyNow ? record.profile.cpuCores : 0)),
    ramGiB: Math.max(0, input.profile.ramGiB - (heavyNow ? record.profile.ramGiB : 0)),
    diskGB:
      record.settled || record.diskFromMeasurement
        ? 0
        : Math.max(0, input.profile.diskGB - record.profile.diskGB),
  };
  if (input.force !== true) {
    if (headroom.over.cpuRam) {
      const dimension = headroom.held.cpuCores > context.declared.cpuCores ? "cpu" : "ram";
      return { result: denied("capacity", { dimension }), state: current };
    }
    if (load.diskGB > 0 && headroom.over.disk) {
      return { result: denied("capacity", { dimension: "disk" }), state: current };
    }
    // A held grow is served when half (the early-start share) of its extra is free.
    const fraction = context.earlyStartFraction ?? 1;
    const short = firstShort(
      { cpuCores: load.cpuCores * fraction, ramGiB: load.ramGiB * fraction, diskGB: load.diskGB },
      headroom.offered,
    );
    if (short !== null) return { result: denied("capacity", { dimension: short }), state: current };
  }
  return {
    result: { outcome: "granted" },
    state: {
      ...others,
      reservations: [
        ...others.reservations,
        {
          boardId: context.boardId,
          cardId: input.cardId,
          claimId: input.claimId,
          kind: "grow",
          profile: input.profile,
          load,
          repositoryKey: record.repositoryKey,
          expiresAt: now + CLAIM_TTL_MS,
        },
      ],
    },
  };
}

/** Force skips declared capacity, never the machine: less free disk than the card's disk
    profile, or less available RAM than half its RAM profile, refuses it. */
function physicalShortfall(
  profile: BoardResourceProfile,
  machine: MachineReading,
): { readonly dimension: BoardResourceDimension; readonly detail: string } | null {
  if (machine.freeDiskGB !== null && machine.freeDiskGB < profile.diskGB) {
    return {
      dimension: "disk",
      detail: `only ${Math.floor(machine.freeDiskGB)} GB free`,
    };
  }
  if (machine.availableRamGiB !== null && machine.availableRamGiB < profile.ramGiB / 2) {
    return {
      dimension: "ram",
      detail: `only ${Math.floor(machine.availableRamGiB)} GiB of RAM available`,
    };
  }
  return null;
}

/** A provision's claim becomes the card's record. checkProvision granted it before the worktree
    was cut, so a reservation that lapsed during a slow cut still records the claim's profile. */
export function consumePlacement(
  state: CapacityState,
  input: {
    readonly boardId: string;
    readonly cardId: string;
    readonly claimId: string;
    readonly seq: number;
    readonly repositoryKey: string | null;
    readonly branch: string;
    readonly worktreePath: string | null;
    readonly profile: BoardResourceProfile;
    readonly now: number;
  },
): { readonly state: CapacityState } {
  const existingRecord = state.records.find(
    (record) => record.boardId === input.boardId && record.cardId === input.cardId,
  );
  if (existingRecord !== undefined) {
    return {
      state: {
        ...state,
        records: state.records.map((record) =>
          record === existingRecord
            ? { ...record, worktreePath: input.worktreePath ?? record.worktreePath }
            : record,
        ),
      },
    };
  }
  const reservation = liveReservations(state, input.now).find(
    (candidate) =>
      candidate.boardId === input.boardId &&
      candidate.cardId === input.cardId &&
      candidate.claimId === input.claimId &&
      candidate.kind === "placement",
  );
  return {
    state: {
      ...state,
      reservations: state.reservations.filter(
        (candidate) =>
          !(
            candidate.boardId === input.boardId &&
            candidate.cardId === input.cardId &&
            candidate.kind === "placement"
          ),
      ),
      records: [
        ...state.records,
        {
          boardId: input.boardId,
          cardId: input.cardId,
          repositoryKey: input.repositoryKey,
          branch: input.branch,
          worktreePath: input.worktreePath,
          profile: reservation?.profile ?? input.profile,
          phase: "heavy",
          settled: false,
          seq: input.seq,
          diskFromMeasurement: false,
          measuredDiskGB: null,
          measuredAt: null,
          heavySince: input.now,
        },
      ],
    },
  };
}

/** What the worker found on disk for a `syncCards` entry it has no record of. */
export type WorktreePresence = "owned" | "adopted" | "foreign" | "missing";

const profileAbove = (next: BoardResourceProfile, current: BoardResourceProfile) =>
  next.cpuCores > current.cpuCores || next.ramGiB > current.ramGiB || next.diskGB > current.diskGB;
const profileBelow = (next: BoardResourceProfile, current: BoardResourceProfile) =>
  next.cpuCores < current.cpuCores || next.ramGiB < current.ramGiB || next.diskGB < current.diskGB;

/**
 * The board's granted state, adopted. Stale syncs are ignored; a sync never lowers or deletes
 * a record a later call stamped; a record is created only for a worktree with this board's
 * marker (or one it adopts) or for a card with an unconsumed placement claim. Restored and
 * backfilled records count their measured disk and are settled.
 */
export function applySyncCards(
  state: CapacityState,
  input: BoardSyncCardsInput & {
    readonly boardId: string;
    readonly now: number;
    readonly presence: (entry: BoardSyncCardsInput["cards"][number]) => WorktreePresence;
  },
): {
  readonly state: CapacityState;
  readonly applied: boolean;
  readonly lastSeq: number;
  readonly refused: ReadonlyArray<string>;
} {
  const previous = state.lastSeq.get(input.boardId);
  if (!input.authoritative && previous !== undefined && input.seq < previous) {
    return { state, applied: false, lastSeq: previous, refused: [] };
  }
  const lastSeq = new Map(state.lastSeq);
  lastSeq.set(input.boardId, input.seq);
  const live = liveReservations(state, input.now);
  let reservations = live;
  const refused: string[] = [];
  const records: CapacityRecord[] = [];
  const mine = (record: CapacityRecord) => record.boardId === input.boardId;
  // An authoritative sync (a new connection) speaks for every record of this board.
  const stampedBelow = (record: CapacityRecord) => input.authoritative || record.seq < input.seq;
  // A path is taken from the board only when that worktree carries this board's marker: the
  // setup RPCs authorise on a record's path, so a board must not aim one at another's worktree.
  const verifiedPath = (entry: BoardSyncCardsInput["cards"][number], current: string | null) => {
    if (entry.worktreePath === null || entry.worktreePath === current) return current;
    const presence = input.presence(entry);
    return presence === "owned" || presence === "adopted" ? entry.worktreePath : current;
  };

  for (const record of state.records) {
    if (!mine(record)) {
      records.push(record);
      continue;
    }
    const entry = input.cards.find((candidate) => candidate.cardId === record.cardId);
    if (entry === undefined) {
      if (!stampedBelow(record)) records.push(record);
      continue;
    }
    const raised =
      profileAbove(entry.grantedProfile, record.profile) ||
      (entry.phase === "heavy" && record.phase === "light");
    const lowered =
      profileBelow(entry.grantedProfile, record.profile) ||
      (entry.phase === "light" && record.phase === "heavy");
    if (raised || (lowered && stampedBelow(record)) || (!raised && !lowered)) {
      const goesHeavy = entry.phase === "heavy" && record.phase === "light";
      records.push({
        ...record,
        repositoryKey: entry.repositoryKey,
        branch: entry.branch,
        worktreePath: verifiedPath(entry, record.worktreePath),
        // A settled record's disk is never regrown: its worktree already exists.
        profile: record.settled
          ? { ...entry.grantedProfile, diskGB: record.profile.diskGB }
          : entry.grantedProfile,
        phase: entry.phase,
        settled: record.settled || entry.settled,
        seq: raised ? input.seq : record.seq,
        heavySince: goesHeavy ? input.now : entry.phase === "light" ? null : record.heavySince,
      });
    } else {
      records.push(record);
    }
    // A grow is consumed by the sync that lists the card larger or heavy.
    if (raised) {
      reservations = reservations.filter(
        (reservation) =>
          !(
            reservation.boardId === input.boardId &&
            reservation.cardId === record.cardId &&
            reservation.kind === "grow"
          ),
      );
    }
  }

  for (const entry of input.cards) {
    if (records.some((record) => mine(record) && record.cardId === entry.cardId)) continue;
    const placement = reservations.find(
      (reservation) =>
        reservation.boardId === input.boardId &&
        reservation.cardId === entry.cardId &&
        reservation.kind === "placement",
    );
    if (placement !== undefined) {
      // A card still provisioning: its entry consumes the placement.
      reservations = reservations.filter((reservation) => reservation !== placement);
      records.push({
        boardId: input.boardId,
        cardId: entry.cardId,
        repositoryKey: entry.repositoryKey,
        branch: entry.branch,
        worktreePath: verifiedPath(entry, null),
        profile: placement.profile,
        phase: entry.phase,
        settled: entry.settled,
        seq: input.seq,
        diskFromMeasurement: false,
        measuredDiskGB: null,
        measuredAt: null,
        heavySince: entry.phase === "heavy" ? input.now : null,
      });
      continue;
    }
    const presence = input.presence(entry);
    if (presence !== "owned" && presence !== "adopted") {
      refused.push(entry.cardId);
      continue;
    }
    // Restored or backfilled: no claim, may exceed capacity, never above what was granted.
    records.push({
      boardId: input.boardId,
      cardId: entry.cardId,
      repositoryKey: entry.repositoryKey,
      branch: entry.branch,
      worktreePath: entry.worktreePath,
      profile: entry.grantedProfile,
      phase: entry.phase,
      settled: true,
      seq: input.seq,
      diskFromMeasurement: true,
      measuredDiskGB: null,
      measuredAt: null,
      heavySince: entry.phase === "heavy" ? input.now : null,
    });
  }
  return {
    state: { records, reservations, lastSeq },
    applied: true,
    lastSeq: input.seq,
    refused,
  };
}

/** A board left: its records, claims and sequence go. */
export function forgetBoard(state: CapacityState, boardId: string): CapacityState {
  const lastSeq = new Map(state.lastSeq);
  lastSeq.delete(boardId);
  return {
    records: state.records.filter((record) => record.boardId !== boardId),
    reservations: state.reservations.filter((reservation) => reservation.boardId !== boardId),
    lastSeq,
  };
}
