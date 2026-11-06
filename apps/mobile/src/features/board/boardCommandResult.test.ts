import { AsyncResult } from "effect/reactivity";
import * as Cause from "effect/Cause";
import { describe, expect, it } from "vite-plus/test";

import {
  boardCanShowApprovePlans,
  boardCommandDidApply,
  describeBoardCommandResult,
} from "./boardCommandResult";

describe("boardCanShowApprovePlans", () => {
  it("hides Approve for a single plan", () => {
    expect(
      boardCanShowApprovePlans({
        planCount: 1,
        children: [],
        parentCardId: null,
        archivedAt: null,
      }),
    ).toBe(false);
  });

  it("shows Approve for two or more plans on a live top-level card", () => {
    expect(
      boardCanShowApprovePlans({
        planCount: 2,
        children: [{ archivedAt: "2026-01-01T00:00:00.000Z" }],
        parentCardId: null,
        archivedAt: null,
      }),
    ).toBe(true);
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
