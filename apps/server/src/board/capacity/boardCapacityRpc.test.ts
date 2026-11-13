import { assert, it } from "@effect/vitest";

import { boardPinReadinessRefusal } from "./boardCapacityRpc.ts";

it("a worker that isn't ready for a project can't be chosen as that project's pin", () => {
  const snapshot = (state: string) => ({
    readiness: [{ repositoryKey: "github.com/acme/app", state }],
  });
  assert.include(
    boardPinReadinessRefusal(snapshot("not-ready"), "github.com/acme/app", "build-01") ?? "",
    "build-01 isn't ready for this project yet (not-ready)",
  );
  assert.isNotNull(boardPinReadinessRefusal(snapshot("not-set-up"), "github.com/acme/app", "b"));
  assert.isNull(boardPinReadinessRefusal(snapshot("ready"), "github.com/acme/app", "b"));
  // Not reported yet (an offline worker, or a project it was never asked about): no refusal.
  assert.isNull(boardPinReadinessRefusal(snapshot("not-ready"), "github.com/other/repo", "b"));
  assert.isNull(boardPinReadinessRefusal(null, "github.com/acme/app", "b"));
});
