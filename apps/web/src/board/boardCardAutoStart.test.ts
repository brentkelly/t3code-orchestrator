/**
 * The pre-build dependency gate and the auto-start control (T3O-24), asserted
 * as pure decisions rather than by rendering the modal.
 */
import { BOARD_SEED_STAGES, BOARD_SEED_STAGE_IDS, BoardCardId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { boardCardAutoStartChip } from "./boardCardAutoStartChip";
import { boardCardAutoStartCopy, boardCardAutoStartGate } from "./boardCardAutoStart";

const gate = (input: {
  readonly stage?: (typeof BOARD_SEED_STAGE_IDS)[keyof typeof BOARD_SEED_STAGE_IDS];
  readonly toStage?: (typeof BOARD_SEED_STAGE_IDS)[keyof typeof BOARD_SEED_STAGE_IDS] | null;
  readonly unmetCount?: number;
  readonly parentCardId?: string;
  readonly archived?: boolean;
}) =>
  boardCardAutoStartGate({
    stages: BOARD_SEED_STAGES,
    stage: input.stage ?? BOARD_SEED_STAGE_IDS.ready,
    toStage: input.toStage === undefined ? BOARD_SEED_STAGE_IDS.building : input.toStage,
    parentCardId: input.parentCardId === undefined ? null : BoardCardId.make(input.parentCardId),
    archived: input.archived ?? false,
    unmetCount: input.unmetCount ?? 1,
  });

describe("the pre-build dependency gate (T3O-24, D7)", () => {
  it("blocks Begin build on a card at Ready with an unmet dependency", () => {
    // The reported bug. `BoardCard.blocked` is false here — it is derived from
    // the build role onward — so without this the button was live at the one
    // gate the decider actually refuses, and the click printed a raw invariant.
    expect(gate({}).moveBlocked).toBe(true);
  });

  it("does not block once every dependency is met", () => {
    expect(gate({ unmetCount: 0 }).moveBlocked).toBe(false);
  });

  it("does not block a move that stays BEFORE the build role", () => {
    // Planning → Ready is not a crossing, so unmet dependencies say nothing
    // about it. Mirrors the decider's move arm exactly.
    expect(
      gate({
        stage: BOARD_SEED_STAGE_IDS.planning,
        toStage: BOARD_SEED_STAGE_IDS.ready,
      }).moveBlocked,
    ).toBe(false);
  });

  it("does not re-block a move already inside the build-or-after zone", () => {
    // A card in Building moving to Code review has already crossed; the
    // stored `blocked` flag owns that case, and re-deriving it here would
    // disable a forward button for a reason the decider does not apply.
    expect(
      gate({
        stage: BOARD_SEED_STAGE_IDS.building,
        toStage: BOARD_SEED_STAGE_IDS.review,
      }).moveBlocked,
    ).toBe(false);
  });

  it("does not block when there is no forward move to make", () => {
    expect(gate({ toStage: null }).moveBlocked).toBe(false);
  });
});

describe("offering the arm (T3O-24, D2)", () => {
  it("offers it exactly where the move would be refused", () => {
    expect(gate({}).canArm).toBe(true);
    expect(gate({ unmetCount: 0 }).canArm).toBe(false);
    expect(gate({ stage: BOARD_SEED_STAGE_IDS.building, toStage: null }).canArm).toBe(false);
  });

  it("never offers it on a sub-board child, which already cascades", () => {
    expect(gate({ parentCardId: "card-parent" }).canArm).toBe(false);
  });

  it("never offers it on an archived card", () => {
    expect(gate({ archived: true }).canArm).toBe(false);
  });

  it("follows a REORDERED pipeline rather than a stage called Ready", () => {
    // Ready and Planning swapped: the arm belongs wherever the crossing into
    // the build role now happens.
    const swapped = BOARD_SEED_STAGES.map((stage) =>
      stage.stageId === BOARD_SEED_STAGE_IDS.ready
        ? { ...stage, orderKey: "e" }
        : stage.stageId === BOARD_SEED_STAGE_IDS.planning
          ? { ...stage, orderKey: "h" }
          : stage,
    );
    const at = (stage: (typeof BOARD_SEED_STAGE_IDS)[keyof typeof BOARD_SEED_STAGE_IDS]) =>
      boardCardAutoStartGate({
        stages: swapped,
        stage,
        toStage: BOARD_SEED_STAGE_IDS.building,
        parentCardId: null,
        archived: false,
        unmetCount: 1,
      }).canArm;
    expect(at(BOARD_SEED_STAGE_IDS.planning)).toBe(true);
    expect(at(BOARD_SEED_STAGE_IDS.ready)).toBe(true);
  });
});

describe("the switch row's copy (T3O-24, D9)", () => {
  it("states the consequence of leaving it off, and what will happen with it on", () => {
    // Off has to argue for itself: the whole point of the feature is that the
    // alternative is coming back to check.
    expect(boardCardAutoStartCopy(false)).toEqual({
      label: "Start automatically when unblocked",
      hint: "Otherwise this card waits here until you come back and start it.",
    });
    expect(boardCardAutoStartCopy(true)).toEqual({
      label: "Will start automatically",
      hint: "Moves to Building the moment the last dependency is done.",
    });
  });
});

describe("the card face's auto-start chip (T3O-24, D8)", () => {
  it("labels an armed card and says what will happen, without naming a blocker", () => {
    // The shell carries a dependency COUNT, not the edges, so a column card
    // says the true general thing rather than inventing a key. The blocked
    // callout inside the card names them.
    expect(boardCardAutoStartChip({ autoStart: true, done: false, scheduled: false })).toEqual({
      label: "Auto-start",
      tooltip: "Starts automatically when its dependencies are done",
    });
  });

  it("yields the slot to a schedule pill", () => {
    // ONE slot in the right-hand cluster, and a schedule names a concrete
    // moment — the more specific claim (D8: schedule > auto-start > queue).
    expect(boardCardAutoStartChip({ autoStart: true, done: false, scheduled: true })).toBe(null);
  });

  it("shows nothing on an unarmed or a done card", () => {
    expect(boardCardAutoStartChip({ autoStart: false, done: false, scheduled: false })).toBe(null);
    expect(boardCardAutoStartChip({ autoStart: true, done: true, scheduled: false })).toBe(null);
  });
});
