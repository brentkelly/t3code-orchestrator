import { BOARD_SEED_STAGE_IDS, BOARD_SEED_STAGES } from "@t3tools/contracts";
import { AsyncResult } from "effect/reactivity";
import * as Cause from "effect/Cause";
import { describe, expect, it } from "vite-plus/test";

import {
  boardCanShowApprovePlans,
  boardCommandAlert,
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

  it("treats Skip CI skipped as applied and not-in-ci as a refusal", () => {
    expect(
      boardCommandDidApply(AsyncResult.success({ outcome: "skipped", toStage: "merge" })),
    ).toBe(true);
    expect(
      describeBoardCommandResult(AsyncResult.success({ outcome: "skipped", toStage: "merge" })),
    ).toBeNull();
    expect(boardCommandDidApply(AsyncResult.success({ outcome: "not-in-ci" }))).toBe(false);
    expect(boardCommandAlert(AsyncResult.success({ outcome: "not-in-ci" }))).toEqual({
      title: "Could not complete",
      message: "This card is no longer in CI.",
    });
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
    expect(boardCommandAlert(AsyncResult.success({ sequence: 12 }))).toBeNull();
  });

  it("titles a failed create as Could not complete", () => {
    const result = AsyncResult.failure(Cause.fail({ message: "Title is required." }));
    expect(boardCommandAlert(result)).toEqual({
      title: "Could not complete",
      message: "Title is required.",
    });
    expect(boardCommandDidApply(result)).toBe(false);
  });

  it("titles a merge follow-up as Started follow-up", () => {
    expect(
      boardCommandAlert(
        AsyncResult.success({
          outcome: "conflict",
          detail: "The branch conflicts with its base.",
        }),
      ),
    ).toEqual({
      title: "Started follow-up",
      message: "The branch conflicts with its base. Resolving the conflicts, then merging.",
    });
    expect(
      boardCommandAlert(
        AsyncResult.success({
          outcome: "checks-fix",
        }),
      ),
    ).toEqual({
      title: "Started follow-up",
      message: "The pull request's checks failed. Fixing them, then merging once CI passes.",
    });
    expect(boardCommandDidApply(AsyncResult.success({ outcome: "conflict" }))).toBe(true);
  });

  it("titles a stale-base merge as Started follow-up and explains the return to review", () => {
    const result = AsyncResult.success({ outcome: "stale-base" as const });
    expect(describeBoardCommandResult(result)).toBe(
      "The base branch moved since this card's last review round. The card went back to review to rebase and re-review before merging.",
    );
    expect(boardCommandAlert(result)).toEqual({
      title: "Started follow-up",
      message:
        "The base branch moved since this card's last review round. The card went back to review to rebase and re-review before merging.",
    });
    expect(boardCommandDidApply(result)).toBe(true);
  });

  it("keeps a refusal under Could not complete", () => {
    expect(
      boardCommandAlert(
        AsyncResult.success({
          outcome: "refused",
          detail: "Approve needs two or more plans.",
        }),
      ),
    ).toEqual({
      title: "Could not complete",
      message: "Approve needs two or more plans.",
    });
  });
});
