/**
 * The pre-build dependency gate, asserted as a pure decision rather
 * than by rendering the modal.
 */
import { BOARD_SEED_STAGES, BOARD_SEED_STAGE_IDS } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { boardCardMoveBlocked } from "./boardCardMoveGate";

const gate = (input: {
  readonly stage?: (typeof BOARD_SEED_STAGE_IDS)[keyof typeof BOARD_SEED_STAGE_IDS];
  readonly toStage?: (typeof BOARD_SEED_STAGE_IDS)[keyof typeof BOARD_SEED_STAGE_IDS] | null;
  readonly unmetCount?: number;
}) => ({
  moveBlocked: boardCardMoveBlocked({
    stages: BOARD_SEED_STAGES,
    stage: input.stage ?? BOARD_SEED_STAGE_IDS.ready,
    toStage: input.toStage === undefined ? BOARD_SEED_STAGE_IDS.building : input.toStage,
    unmetCount: input.unmetCount ?? 1,
  }),
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
