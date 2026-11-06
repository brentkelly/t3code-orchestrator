import { BOARD_SEED_STAGE_IDS, BOARD_SEED_STAGES } from "@t3tools/contracts";
import { AsyncResult } from "effect/reactivity";
import * as Cause from "effect/Cause";
import { describe, expect, it } from "vite-plus/test";

import {
  boardCanShowApprovePlans,
  boardCommandDidApply,
  describeBoardCommandResult,
} from "./boardCommandResult";

const liveTopLevel = {
  planCount: 2,
  children: [{ archivedAt: "2026-01-01T00:00:00.000Z" as const }],
  parentCardId: null,
  archivedAt: null,
  stages: BOARD_SEED_STAGES,
};

describe("boardCanShowApprovePlans", () => {
  it("hides Approve for a single plan", () => {
    expect(
      boardCanShowApprovePlans({
        ...liveTopLevel,
        planCount: 1,
        children: [],
        stage: BOARD_SEED_STAGE_IDS.planning,
      }),
    ).toBe(false);
  });

  it("shows Approve for two or more plans on a live top-level card before Building", () => {
    expect(
      boardCanShowApprovePlans({
        ...liveTopLevel,
        stage: BOARD_SEED_STAGE_IDS.planning,
      }),
    ).toBe(true);
  });

  it("shows Approve while the card is still in Building", () => {
    expect(
      boardCanShowApprovePlans({
        ...liveTopLevel,
        stage: BOARD_SEED_STAGE_IDS.building,
      }),
    ).toBe(true);
  });

  it("hides Approve once the card is past Building", () => {
    expect(
      boardCanShowApprovePlans({
        ...liveTopLevel,
        stage: BOARD_SEED_STAGE_IDS.review,
      }),
    ).toBe(false);
    expect(
      boardCanShowApprovePlans({
        ...liveTopLevel,
        stage: BOARD_SEED_STAGE_IDS.merge,
      }),
    ).toBe(false);
    expect(
      boardCanShowApprovePlans({
        ...liveTopLevel,
        stage: BOARD_SEED_STAGE_IDS.done,
      }),
    ).toBe(false);
  });
});

describe("boardCommandDidApply", () => {
  it("treats a dispatch receipt as applied", () => {
    expect(boardCommandDidApply(AsyncResult.success({ sequence: 12 }))).toBe(true);
  });

  it("does not treat a refused merge as applied", () => {
    expect(
      boardCommandDidApply(
        AsyncResult.success({ outcome: "refused", detail: "Checks are failing." }),
      ),
    ).toBe(false);
  });
});

describe("describeBoardCommandResult", () => {
  it("surfaces a dispatch invariant as the server's sentence", () => {
    const result = AsyncResult.failure(
      Cause.fail({ message: "Delete the child cards first, then this one." }),
    );
    expect(describeBoardCommandResult(result)).toBe("Delete the child cards first, then this one.");
    expect(boardCommandDidApply(result)).toBe(false);
  });

  it("surfaces a successful refusal instead of dropping it", () => {
    expect(
      describeBoardCommandResult(
        AsyncResult.success({
          outcome: "refused",
          detail: "Approve needs two or more plans.",
        }),
      ),
    ).toBe("Approve needs two or more plans.");
  });

  it("stays silent on a dispatch that committed", () => {
    expect(describeBoardCommandResult(AsyncResult.success({ sequence: 12 }))).toBeNull();
  });
});
