/**
 * Holds on a worker (T3O-87): a board's queued card reserving the worker's next placement, and a
 * placed card waiting to grow. Pure functions of (state, event, now); the capacity service's
 * fibers only call them. Holds, flags and cool-offs live in worker memory: after a restart
 * holds return on the next refresh.
 */
import type { BoardResourceProfile } from "@t3tools/contracts";

/** A board refreshes a hold this often while its card waits. */
export const HOLD_REFRESH_MS = 20_000;
/** A hold its board stops refreshing lapses within a minute. */
export const HOLD_LAPSE_MS = 60_000;
/** A board's hold clock resets once it has held nothing here this long. */
export const HOLD_CLOCK_RESET_MS = 10 * 60_000;
/** After an early start, the same board can't hold here again for this long (or until the
    worker is back within capacity). */
export const HOLD_TURN_MS = 30 * 60_000;
const DEFAULT_EARLY_START_FRACTION = 0.5;
const DEFAULT_HOLD_MAX_MINUTES = 120;

export interface HoldSettings {
  readonly earlyStartFraction: number;
  readonly maxMinutes: number;
}

export const DEFAULT_HOLD_SETTINGS: HoldSettings = {
  earlyStartFraction: DEFAULT_EARLY_START_FRACTION,
  maxMinutes: DEFAULT_HOLD_MAX_MINUTES,
};

export interface WorkerHold {
  readonly boardId: string;
  readonly cardId: string;
  readonly kind: "placement" | "grow";
  readonly profile: BoardResourceProfile;
  readonly since: number;
  readonly refreshedAt: number;
  /** A grow hold that refused another board's placement: its time limit now runs. */
  readonly blockedOthers?: boolean;
}

/** Per (board, worker): the 2-hour clock and whether someone else is waiting. */
interface HoldClock {
  readonly firstHeldAt: number;
  readonly lastHeldAt: number;
  /** Time the clock didn't run: a live grow hold blocked the placement hold. */
  readonly pausedMs: number;
  readonly pausedSince: number | null;
  readonly someoneWaiting: boolean;
}

export interface HoldState {
  /** One placement hold at a time, first to ask. */
  readonly placement: WorkerHold | null;
  /** Any number of grow holds, beside it. */
  readonly grows: ReadonlyArray<WorkerHold>;
  readonly clocks: ReadonlyMap<string, HoldClock>;
  /** Per board, until when it can't hold here after its 2 hours ran out. */
  readonly coolOffs: ReadonlyMap<string, number>;
  /** Per board, when one of its cards last started early here. */
  readonly turns: ReadonlyMap<string, number>;
}

export const EMPTY_HOLD_STATE: HoldState = {
  placement: null,
  grows: [],
  clocks: new Map(),
  coolOffs: new Map(),
  turns: new Map(),
};

export type HoldRefusalReason = "held" | "disk" | "too-big" | "not-eligible" | "cool-off" | "turn";

export type HoldAnswer =
  | { readonly outcome: "held"; readonly until: number | null }
  | {
      readonly outcome: "refused";
      readonly reason: HoldRefusalReason;
      readonly until: number | null;
    };

/** Whether a card may hold here: every placement test but the CPU and RAM fit. */
export interface HoldEligibility {
  /** Online, at the floor, ready for the project, provider signed in with quota room. */
  readonly eligible: boolean;
  /** The profile exceeds the worker's declared capacity. */
  readonly tooBig: boolean;
  /** The card's disk fits now. */
  readonly diskFits: boolean;
  /** For a grow hold: the card has a worktree here for this board. */
  readonly placedHere: boolean;
}

const withClock = (
  state: HoldState,
  boardId: string,
  update: (clock: HoldClock | undefined) => HoldClock | null,
): HoldState => {
  const clocks = new Map(state.clocks);
  const next = update(clocks.get(boardId));
  if (next === null) clocks.delete(boardId);
  else clocks.set(boardId, next);
  return { ...state, clocks };
};

const heldFor = (clock: HoldClock, now: number) =>
  now -
  clock.firstHeldAt -
  clock.pausedMs -
  (clock.pausedSince === null ? 0 : now - clock.pausedSince);

/** A grow hold older than the placement hold blocks its early start (and pauses its clock). */
const growBlocks = (state: HoldState, placement: WorkerHold) =>
  state.grows.some((grow) => grow.since < placement.since);

/**
 * Time passing: lapses, the end of turns and cool-offs, the clock's pause while a grow hold
 * blocks, the 10-minute reset, and the 2-hour limit once someone is waiting.
 */
export function tickHolds(
  state: HoldState,
  input: {
    readonly now: number;
    readonly withinCapacity: boolean;
    readonly settings: HoldSettings;
  },
): HoldState {
  const { now } = input;
  const live = (hold: WorkerHold) => now - hold.refreshedAt < HOLD_LAPSE_MS;
  let next: HoldState = {
    ...state,
    placement: state.placement !== null && live(state.placement) ? state.placement : null,
    grows: state.grows.filter(live),
    coolOffs: new Map([...state.coolOffs].filter(([, until]) => until > now)),
    turns: new Map(
      [...state.turns].filter(([, at]) => !input.withinCapacity && now - at < HOLD_TURN_MS),
    ),
  };
  const clocks = new Map<string, HoldClock>();
  for (const [boardId, clock] of next.clocks) {
    const holding = next.placement?.boardId === boardId;
    if (!holding && now - clock.lastHeldAt >= HOLD_CLOCK_RESET_MS) continue;
    const blocked = holding && growBlocks(next, next.placement!);
    let updated: HoldClock = holding ? { ...clock, lastHeldAt: now } : clock;
    if (blocked && updated.pausedSince === null) updated = { ...updated, pausedSince: now };
    if (!blocked && updated.pausedSince !== null) {
      updated = {
        ...updated,
        pausedMs: updated.pausedMs + (now - updated.pausedSince),
        pausedSince: null,
      };
    }
    clocks.set(boardId, updated);
  }
  next = { ...next, clocks };
  const placement = next.placement;
  if (placement !== null) {
    const clock = next.clocks.get(placement.boardId);
    if (
      clock !== undefined &&
      clock.someoneWaiting &&
      heldFor(clock, now) >= input.settings.maxMinutes * 60_000
    ) {
      // Past the limit with someone waiting: the hold ends, and a cool-off starts.
      const coolOffs = new Map(next.coolOffs);
      coolOffs.set(placement.boardId, now + input.settings.maxMinutes * 60_000);
      const remaining = new Map(next.clocks);
      remaining.delete(placement.boardId);
      next = { ...next, placement: null, coolOffs, clocks: remaining };
    }
  }
  // A grow hold past the limit that has kept another board out ends too, with the same cool-off.
  const limitMs = input.settings.maxMinutes * 60_000;
  const expired = next.grows.filter(
    (grow) => grow.blockedOthers === true && now - grow.since >= limitMs,
  );
  if (expired.length > 0) {
    const coolOffs = new Map(next.coolOffs);
    for (const grow of expired) coolOffs.set(grow.boardId, now + limitMs);
    next = { ...next, grows: next.grows.filter((grow) => !expired.includes(grow)), coolOffs };
  }
  return next;
}

/** When a board's hold here ends at the latest: only once someone is waiting. */
export function holdUntil(
  state: HoldState,
  boardId: string,
  settings: HoldSettings,
  now: number,
): number | null {
  const clock = state.clocks.get(boardId);
  if (clock === undefined || !clock.someoneWaiting) return null;
  return now + Math.max(0, settings.maxMinutes * 60_000 - heldFor(clock, now));
}

/** Mark that another board was refused because of this board's placement hold. */
const flagWaiting = (state: HoldState, refusedBoardId: string): HoldState => {
  const holder = state.placement;
  if (holder === null || holder.boardId === refusedBoardId) return state;
  return withClock(state, holder.boardId, (clock) =>
    clock === undefined ? null : { ...clock, someoneWaiting: true },
  );
};

/** Mark the grow holds of other boards as keeping this board out. */
const flagGrowsWaiting = (state: HoldState, refusedBoardId: string): HoldState =>
  state.grows.some((grow) => grow.boardId !== refusedBoardId && grow.blockedOthers !== true)
    ? {
        ...state,
        grows: state.grows.map((grow) =>
          grow.boardId === refusedBoardId ? grow : { ...grow, blockedOthers: true },
        ),
      }
    : state;

/** Ask for, or refresh, a hold. An idempotent upsert. */
export function requestHold(
  state: HoldState,
  input: {
    readonly boardId: string;
    readonly cardId: string;
    readonly kind: "placement" | "grow";
    readonly profile: BoardResourceProfile;
    readonly eligibility: HoldEligibility;
    readonly now: number;
    readonly settings: HoldSettings;
    readonly withinCapacity: boolean;
    /** This board's later card holding here, which gives way if this request succeeds. */
    readonly replacesCardId?: string | undefined;
  },
): { readonly state: HoldState; readonly answer: HoldAnswer } {
  const { boardId, cardId, now } = input;
  const refuse = (s: HoldState, reason: HoldRefusalReason, until: number | null = null) => ({
    state: s,
    answer: { outcome: "refused", reason, until } as HoldAnswer,
  });
  let current = tickHolds(state, input);
  if (input.kind === "grow") {
    const existing = current.grows.find(
      (grow) => grow.boardId === boardId && grow.cardId === cardId,
    );
    const dropGrow = (s: HoldState) =>
      existing === undefined ? s : { ...s, grows: s.grows.filter((grow) => grow !== existing) };
    if (!input.eligibility.placedHere) return refuse(dropGrow(current), "not-eligible");
    // A grow that can never fit, or whose extra disk isn't free, would close the worker for nothing.
    if (input.eligibility.tooBig) return refuse(dropGrow(current), "too-big");
    if (!input.eligibility.diskFits) return refuse(dropGrow(current), "disk");
    const coolOff = current.coolOffs.get(boardId);
    if (existing === undefined && coolOff !== undefined) {
      return refuse(current, "cool-off", coolOff);
    }
    const grow: WorkerHold = {
      boardId,
      cardId,
      kind: "grow",
      profile: input.profile,
      since: existing?.since ?? now,
      refreshedAt: now,
      ...(existing?.blockedOthers === true ? { blockedOthers: true } : {}),
    };
    current = {
      ...current,
      grows: [...current.grows.filter((candidate) => candidate !== existing), grow],
    };
    return { state: current, answer: { outcome: "held", until: null } };
  }
  const own =
    current.placement !== null &&
    current.placement.boardId === boardId &&
    current.placement.cardId === cardId;
  const dropOwn = (s: HoldState) => (own ? { ...s, placement: null } : s);
  if (!input.eligibility.eligible) return refuse(dropOwn(current), "not-eligible");
  if (input.eligibility.tooBig) return refuse(dropOwn(current), "too-big");
  if (!input.eligibility.diskFits) return refuse(dropOwn(current), "disk");
  if (own) {
    current = { ...current, placement: { ...current.placement!, refreshedAt: now } };
    return {
      state: current,
      answer: { outcome: "held", until: holdUntil(current, boardId, input.settings, now) },
    };
  }
  const coolOff = current.coolOffs.get(boardId);
  if (coolOff !== undefined) return refuse(current, "cool-off", coolOff);
  const turn = current.turns.get(boardId);
  if (turn !== undefined) return refuse(current, "turn", turn + HOLD_TURN_MS);
  const replaced =
    current.placement !== null &&
    current.placement.boardId === boardId &&
    current.placement.cardId === input.replacesCardId;
  if (current.placement !== null && !replaced) {
    const holder = current.placement.boardId;
    current = tickHolds(flagWaiting(current, boardId), input);
    // A refusal after the limit ends the hold at once: the slot may be free now.
    if (current.placement !== null) {
      return refuse(current, "held", holdUntil(current, holder, input.settings, now));
    }
    const freshCoolOff = current.coolOffs.get(boardId);
    if (freshCoolOff !== undefined) return refuse(current, "cool-off", freshCoolOff);
  }
  current = {
    ...current,
    placement: {
      boardId,
      cardId,
      kind: "placement",
      profile: input.profile,
      since: now,
      refreshedAt: now,
    },
  };
  // A swapped card keeps the board's clock; a first hold starts it.
  current = withClock(current, boardId, (clock) =>
    clock === undefined
      ? { firstHeldAt: now, lastHeldAt: now, pausedMs: 0, pausedSince: null, someoneWaiting: false }
      : { ...clock, lastHeldAt: now },
  );
  return {
    state: current,
    answer: { outcome: "held", until: holdUntil(current, boardId, input.settings, now) },
  };
}

/** A board withdraws a card's holds: it was placed elsewhere or left the queue. */
export function releaseHold(state: HoldState, boardId: string, cardId: string): HoldState {
  const matches = (hold: WorkerHold) => hold.boardId === boardId && hold.cardId === cardId;
  return {
    ...state,
    placement: state.placement !== null && matches(state.placement) ? null : state.placement,
    grows: state.grows.filter((grow) => !matches(grow)),
  };
}

/** A board left this worker (`release`, or the reconcile after `leave`): its holds go. */
export function releaseBoardHolds(state: HoldState, boardId: string): HoldState {
  return {
    ...state,
    placement: state.placement?.boardId === boardId ? null : state.placement,
    grows: state.grows.filter((grow) => grow.boardId !== boardId),
  };
}

/**
 * Why a claim is refused because of a hold, or null. A live grow hold, or another card's
 * placement hold, refuses every board's new placement (`reserved`); grow and force claims
 * are unaffected. Another board refused this way counts as someone waiting.
 */
export function holdClaimRefusal(
  state: HoldState,
  input: {
    readonly boardId: string;
    readonly cardId: string;
    readonly kind: "placement" | "grow";
    readonly force: boolean;
    readonly early: boolean;
    readonly now: number;
    readonly settings: HoldSettings;
    readonly withinCapacity: boolean;
    /** This board's later card holding here, which gives way to this claim. */
    readonly replacesCardId?: string | undefined;
  },
): { readonly state: HoldState; readonly refusal: "reserved" | null } {
  if (input.force) return { state, refusal: null };
  if (input.kind === "grow") {
    if (!input.early) return { state, refusal: null };
    // Grow holds are served oldest first.
    const own = state.grows.find(
      (grow) => grow.boardId === input.boardId && grow.cardId === input.cardId,
    );
    if (own === undefined) return { state, refusal: null };
    const older = state.grows.some((grow) => grow !== own && grow.since < own.since);
    return { state, refusal: older ? "reserved" : null };
  }
  const placement = state.placement;
  const ownPlacement =
    placement !== null && placement.boardId === input.boardId && placement.cardId === input.cardId;
  // A grow hold blocks new placements, and the early start only of placement holds younger
  // than it: a hold that was there first still starts early.
  const growBlocking =
    state.grows.length > 0 && !(ownPlacement && input.early && !growBlocks(state, placement!));
  const givesWay =
    placement !== null &&
    placement.boardId === input.boardId &&
    placement.cardId === input.replacesCardId;
  if (!growBlocking && (placement === null || ownPlacement || givesWay)) {
    return { state, refusal: null };
  }
  const flagged = tickHolds(
    flagGrowsWaiting(flagWaiting(state, input.boardId), input.boardId),
    input,
  );
  return { state: flagged, refusal: "reserved" };
}

/** An early start was granted: the board takes its turn; the hold stays until consumed. */
export function noteEarlyStart(state: HoldState, boardId: string, now: number): HoldState {
  return { ...state, turns: new Map(state.turns).set(boardId, now) };
}

/** A provision consumed a placement here: that card's holds end, and its board's clock resets. */
export function noteConsumed(state: HoldState, boardId: string, cardId: string): HoldState {
  const released = releaseHold(state, boardId, cardId);
  return withClock(released, boardId, () => null);
}

/** What a board sees of the holds here: never another board's card. */
export function holdView(
  state: HoldState,
  boardId: string,
  settings: HoldSettings,
  now: number,
): {
  readonly closed: boolean;
  readonly until: number | null;
  readonly earlyStartFraction: number;
  readonly cardId: string | null;
} {
  const placement = state.placement;
  return {
    closed: placement !== null || state.grows.length > 0,
    until: placement === null ? null : holdUntil(state, placement.boardId, settings, now),
    earlyStartFraction: settings.earlyStartFraction,
    cardId: placement !== null && placement.boardId === boardId ? placement.cardId : null,
  };
}
