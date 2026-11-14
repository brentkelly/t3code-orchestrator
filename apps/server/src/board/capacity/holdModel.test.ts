import { describe, expect, it } from "@effect/vitest";

import {
  DEFAULT_HOLD_SETTINGS,
  EMPTY_HOLD_STATE,
  HOLD_CLOCK_RESET_MS,
  HOLD_LAPSE_MS,
  HOLD_TURN_MS,
  holdClaimRefusal,
  holdView,
  noteConsumed,
  noteEarlyStart,
  releaseBoardHolds,
  releaseHold,
  requestHold,
  tickHolds,
  type HoldEligibility,
  type HoldState,
} from "./holdModel.ts";

const MIN = 60_000;
const HOUR = 60 * MIN;
const PROFILE = { cpuCores: 12, ramGiB: 40, diskGB: 45 };
const OK: HoldEligibility = { eligible: true, tooBig: false, diskFits: true, placedHere: false };

const ask = (
  state: HoldState,
  boardId: string,
  cardId: string,
  now: number,
  options: {
    readonly kind?: "placement" | "grow";
    readonly eligibility?: Partial<HoldEligibility>;
    readonly withinCapacity?: boolean;
    readonly replacesCardId?: string;
  } = {},
) =>
  requestHold(state, {
    boardId,
    cardId,
    kind: options.kind ?? "placement",
    profile: PROFILE,
    eligibility: { ...OK, ...options.eligibility },
    now,
    settings: DEFAULT_HOLD_SETTINGS,
    withinCapacity: options.withinCapacity ?? false,
    replacesCardId: options.replacesCardId,
  });

const claim = (
  state: HoldState,
  boardId: string,
  cardId: string,
  now: number,
  options: {
    readonly kind?: "placement" | "grow";
    readonly force?: boolean;
    readonly early?: boolean;
    readonly replacesCardId?: string;
  } = {},
) =>
  holdClaimRefusal(state, {
    boardId,
    cardId,
    kind: options.kind ?? "placement",
    force: options.force ?? false,
    early: options.early ?? false,
    now,
    settings: DEFAULT_HOLD_SETTINGS,
    withinCapacity: false,
    replacesCardId: options.replacesCardId,
  });

const tick = (state: HoldState, now: number, withinCapacity = false) =>
  tickHolds(state, { now, withinCapacity, settings: DEFAULT_HOLD_SETTINGS });

describe("holds on a worker (T3O-87)", () => {
  it("holds only where every test but the CPU and RAM fit passes", () => {
    expect(
      ask(EMPTY_HOLD_STATE, "a", "c1", 0, { eligibility: { eligible: false } }).answer,
    ).toMatchObject({ outcome: "refused", reason: "not-eligible" });
    expect(
      ask(EMPTY_HOLD_STATE, "a", "c1", 0, { eligibility: { tooBig: true } }).answer,
    ).toMatchObject({ outcome: "refused", reason: "too-big" });
    expect(
      ask(EMPTY_HOLD_STATE, "a", "c1", 0, { eligibility: { diskFits: false } }).answer,
    ).toMatchObject({ outcome: "refused", reason: "disk" });
    expect(ask(EMPTY_HOLD_STATE, "a", "c1", 0).answer).toEqual({ outcome: "held", until: null });
  });

  it("a hold is dropped at its next refresh when the worker stops being eligible", () => {
    const held = ask(EMPTY_HOLD_STATE, "a", "c1", 0).state;
    const dropped = ask(held, "a", "c1", 20_000, { eligibility: { diskFits: false } });
    expect(dropped.answer).toMatchObject({ outcome: "refused", reason: "disk" });
    expect(dropped.state.placement).toBeNull();
  });

  it("one placement hold per worker, first to ask; the holder's own refusals set no flag", () => {
    const held = ask(EMPTY_HOLD_STATE, "a", "c1", 0).state;
    const sameBoard = ask(held, "a", "c2", 1_000);
    expect(sameBoard.answer).toMatchObject({ outcome: "refused", reason: "held", until: null });
    expect(holdView(sameBoard.state, "a", DEFAULT_HOLD_SETTINGS, 1_000).until).toBeNull();
    const refusedClaim = claim(sameBoard.state, "a", "c3", 2_000);
    expect(refusedClaim.refusal).toBe("reserved");
    expect(holdView(refusedClaim.state, "a", DEFAULT_HOLD_SETTINGS, 2_000).until).toBeNull();
  });

  it("a held worker refuses other placements but grants grow, force and the holder's claim", () => {
    const held = ask(EMPTY_HOLD_STATE, "a", "c1", 0).state;
    expect(claim(held, "b", "x", 1).refusal).toBe("reserved");
    expect(claim(held, "b", "x", 1, { kind: "grow" }).refusal).toBeNull();
    expect(claim(held, "b", "x", 1, { force: true }).refusal).toBeNull();
    expect(claim(held, "a", "c1", 1, { early: true }).refusal).toBeNull();
  });

  it("a later card's hold passes to an earlier card of its board only when that one may hold", () => {
    const held = ask(EMPTY_HOLD_STATE, "a", "c9", 0).state;
    const refused = ask(held, "a", "c1", 1_000, {
      replacesCardId: "c9",
      eligibility: { diskFits: false },
    });
    expect(refused.answer).toMatchObject({ outcome: "refused", reason: "disk" });
    expect(refused.state.placement?.cardId).toBe("c9");
    const swapped = ask(held, "a", "c1", 1_000, { replacesCardId: "c9" });
    expect(swapped.answer).toMatchObject({ outcome: "held" });
    expect(swapped.state.placement?.cardId).toBe("c1");
    // Another board's card is never displaced, and a claim gives way only to the named card.
    expect(ask(held, "b", "x", 1_000, { replacesCardId: "c9" }).answer).toMatchObject({
      reason: "held",
    });
    expect(claim(held, "a", "c1", 1, { replacesCardId: "c9" }).refusal).toBeNull();
    expect(claim(held, "a", "c1", 1, { replacesCardId: "c8" }).refusal).toBe("reserved");
  });

  it("lapses without a refresh, and goes when withdrawn or its board leaves", () => {
    const held = ask(EMPTY_HOLD_STATE, "a", "c1", 0).state;
    expect(tick(held, HOLD_LAPSE_MS - 1).placement).not.toBeNull();
    expect(tick(held, HOLD_LAPSE_MS).placement).toBeNull();
    expect(releaseHold(held, "a", "c1").placement).toBeNull();
    expect(releaseBoardHolds(held, "a").placement).toBeNull();
    expect(releaseBoardHolds(held, "b").placement).not.toBeNull();
  });

  it("the board's own card is named to it, never to another board", () => {
    const held = ask(EMPTY_HOLD_STATE, "a", "c1", 0).state;
    expect(holdView(held, "a", DEFAULT_HOLD_SETTINGS, 0)).toMatchObject({
      closed: true,
      cardId: "c1",
    });
    expect(holdView(held, "b", DEFAULT_HOLD_SETTINGS, 0)).toMatchObject({
      closed: true,
      cardId: null,
    });
  });
});

describe("the 2-hour limit (T3O-87)", () => {
  /** Board a holds for c1, refreshed every 20 s until `until`. */
  const holdFor = (until: number, start: HoldState = EMPTY_HOLD_STATE, cardId = "c1") => {
    let state = start;
    for (let now = 0; now <= until; now += 20_000) state = ask(state, "a", cardId, now).state;
    return state;
  };

  it("with nobody waiting the hold carries on, with no until time", () => {
    const state = holdFor(3 * HOUR);
    expect(state.placement?.cardId).toBe("c1");
    expect(holdView(state, "b", DEFAULT_HOLD_SETTINGS, 3 * HOUR).until).toBeNull();
  });

  it("a board that never sends a placement claim counts as waiting through its refused hold", () => {
    let state = holdFor(HOUR);
    const refused = ask(state, "b", "x", HOUR + 1);
    expect(refused.answer).toMatchObject({ outcome: "refused", reason: "held" });
    expect((refused.answer as { until: number | null }).until).toBe(2 * HOUR);
    state = refused.state;
    expect(holdView(state, "b", DEFAULT_HOLD_SETTINGS, HOUR + 1).until).toBe(2 * HOUR);
    // At two hours, with someone waiting, the hold ends and a cool-off starts.
    for (let now = HOUR + 20_000; now < 2 * HOUR; now += 20_000) {
      state = ask(state, "a", "c1", now).state;
      expect(state.placement?.cardId).toBe("c1");
    }
    state = ask(state, "a", "c1", 2 * HOUR).state;
    expect(state.placement).toBeNull();
    expect(ask(state, "a", "c1", 2 * HOUR + MIN).answer).toMatchObject({
      outcome: "refused",
      reason: "cool-off",
      until: 4 * HOUR,
    });
  });

  it("a swapped card keeps the clock and the flag; a refusal past the limit ends it at once", () => {
    let state = holdFor(HOUR);
    state = ask(state, "b", "x", HOUR).state;
    state = releaseHold(state, "a", "c1");
    state = holdFor(3 * HOUR, ask(state, "a", "c2", HOUR + 1).state, "c2");
    // The flag stayed, so past two hours the swapped hold ended on its own refresh.
    expect(state.placement).toBeNull();
    // The cool-off applies whichever card asks.
    expect(ask(state, "a", "c9", 3 * HOUR).answer).toMatchObject({ reason: "cool-off" });
  });

  it("past the limit with nobody waiting, the next refusal ends the hold at once", () => {
    const state = holdFor(3 * HOUR);
    const refused = ask(state, "b", "x", 3 * HOUR + 1);
    // The slot freed as the flag was set: the asking board gets it.
    expect(refused.answer).toMatchObject({ outcome: "held" });
    expect(refused.state.placement?.boardId).toBe("b");
  });

  it("the clock resets after ten minutes holding nothing, and when the board places here", () => {
    let state = holdFor(HOUR);
    state = ask(state, "b", "x", HOUR).state;
    state = releaseHold(state, "a", "c1");
    state = tick(state, HOUR + HOLD_CLOCK_RESET_MS);
    expect(state.clocks.has("a")).toBe(false);
    const placed = noteConsumed(ask(EMPTY_HOLD_STATE, "a", "c1", 0).state, "a", "c1");
    expect(placed.clocks.has("a")).toBe(false);
    expect(placed.placement).toBeNull();
  });

  it("the clock pauses while a live grow hold blocks the hold", () => {
    let state = ask(EMPTY_HOLD_STATE, "z", "g", 0, {
      kind: "grow",
      eligibility: { placedHere: true },
    }).state;
    for (let now = 20_000; now <= 3 * HOUR; now += 20_000) {
      state = ask(state, "a", "c1", now).state;
      state = ask(state, "z", "g", now, { kind: "grow", eligibility: { placedHere: true } }).state;
    }
    state = ask(state, "b", "x", 3 * HOUR).state;
    // Blocked the whole time: the clock never ran, so someone waiting doesn't end it.
    expect(state.placement?.boardId).toBe("a");
    // Paused, the hold has no end to show, rather than one that moves with every tick.
    expect(holdView(state, "b", DEFAULT_HOLD_SETTINGS, 3 * HOUR).until).toBeNull();
  });
});

describe("starting early and taking turns (T3O-87)", () => {
  it("after an early start the same board can't hold again until within capacity or 30 minutes", () => {
    let state = ask(EMPTY_HOLD_STATE, "a", "c1", 0).state;
    state = noteEarlyStart(state, "a", 0);
    // The grant leaves the hold in place until the provision consumes it.
    expect(state.placement?.cardId).toBe("c1");
    state = noteConsumed(state, "a", "c1");
    expect(ask(state, "a", "c2", MIN).answer).toMatchObject({
      outcome: "refused",
      reason: "turn",
      until: HOLD_TURN_MS,
    });
    // Another board can.
    expect(ask(state, "b", "x", MIN).answer).toMatchObject({ outcome: "held" });
    expect(ask(state, "a", "c2", HOLD_TURN_MS).answer).toMatchObject({ outcome: "held" });
    expect(ask(state, "a", "c2", 2 * MIN, { withinCapacity: true }).answer).toMatchObject({
      outcome: "held",
    });
  });
});

describe("grow holds (T3O-87)", () => {
  const grow = (state: HoldState, boardId: string, cardId: string, now: number) =>
    ask(state, boardId, cardId, now, { kind: "grow", eligibility: { placedHere: true } }).state;

  it("only on its own worker, beside a placement hold, any number of them", () => {
    expect(
      ask(EMPTY_HOLD_STATE, "a", "c1", 0, { kind: "grow", eligibility: { placedHere: false } })
        .answer,
    ).toMatchObject({ reason: "not-eligible" });
    let state = ask(EMPTY_HOLD_STATE, "a", "c1", 0).state;
    state = grow(grow(state, "b", "g1", 1), "a", "g2", 2);
    expect(state.placement?.cardId).toBe("c1");
    expect(state.grows.map((hold) => hold.cardId)).toEqual(["g1", "g2"]);
  });

  it("while one waits no new placement is granted; force is", () => {
    const state = grow(EMPTY_HOLD_STATE, "a", "g", 0);
    expect(claim(state, "b", "x", 1).refusal).toBe("reserved");
    expect(claim(state, "a", "y", 1).refusal).toBe("reserved");
    expect(claim(state, "b", "x", 1, { force: true }).refusal).toBeNull();
  });

  it("blocks the early start of a younger placement hold, not an older one", () => {
    const older = grow(ask(EMPTY_HOLD_STATE, "a", "c1", 0).state, "z", "g", 10);
    expect(claim(older, "a", "c1", 20, { early: true }).refusal).toBeNull();
    const younger = ask(grow(EMPTY_HOLD_STATE, "z", "g", 0), "a", "c1", 10).state;
    expect(claim(younger, "a", "c1", 20, { early: true }).refusal).toBe("reserved");
  });

  it("is refused, and dropped, when it can never fit or its extra disk isn't free", () => {
    const held = grow(EMPTY_HOLD_STATE, "a", "g", 0);
    const tooBig = ask(held, "a", "g", 1, {
      kind: "grow",
      eligibility: { placedHere: true, tooBig: true },
    });
    expect(tooBig.answer).toMatchObject({ outcome: "refused", reason: "too-big" });
    expect(tooBig.state.grows).toEqual([]);
    expect(claim(tooBig.state, "b", "x", 2).refusal).toBeNull();
    const disk = ask(held, "a", "g", 1, {
      kind: "grow",
      eligibility: { placedHere: true, diskFits: false },
    });
    expect(disk.answer).toMatchObject({ outcome: "refused", reason: "disk" });
    expect(disk.state.grows).toEqual([]);
  });

  it("ends after the time limit once it has kept another board out, with a cool-off", () => {
    const limit = DEFAULT_HOLD_SETTINGS.maxMinutes * MIN;
    // Nobody else waiting: it keeps its place past the limit, refreshed.
    let state = grow(EMPTY_HOLD_STATE, "a", "g", 0);
    for (let at = 20_000; at <= limit + MIN; at += 20_000) state = grow(state, "a", "g", at);
    expect(state.grows).toHaveLength(1);
    // Another board refused by it: its limit has run out, so it ends at once.
    state = claim(state, "b", "x", limit + MIN).state;
    expect(state.grows).toEqual([]);
    expect(claim(state, "b", "x", limit + MIN).refusal).toBeNull();
    expect(
      ask(state, "a", "g", limit + 2 * MIN, { kind: "grow", eligibility: { placedHere: true } })
        .answer,
    ).toMatchObject({ reason: "cool-off" });
  });

  it("are served oldest first", () => {
    const state = grow(grow(EMPTY_HOLD_STATE, "a", "g1", 0), "b", "g2", 5);
    expect(claim(state, "b", "g2", 10, { kind: "grow", early: true }).refusal).toBe("reserved");
    expect(claim(state, "a", "g1", 10, { kind: "grow", early: true }).refusal).toBeNull();
  });
});
