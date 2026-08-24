// t3o-21: the legacy-NULL authority fallback for a rehydrated step-state row.
// A card mid-stage at deploy (a row persisted before migration 021, so its
// `runtime_mode` column is NULL) must keep the authority it was RUNNING under —
// `full-access` for a build-mode run — not silently drop to the new safer
// default. This guards that backward-compat path directly.
import { assert, describe, it } from "@effect/vitest";

import { resolveStoredStepRuntimeMode } from "./projection.ts";

describe("resolveStoredStepRuntimeMode (t3o-21 legacy fallback)", () => {
  it("a NULL column resolves to the PRE-t3o-21 behaviour, keyed by mode", () => {
    // The whole point of the fallback: a build-mode row that was running under
    // the old forced posture stays full-access after the upgrade.
    assert.strictEqual(resolveStoredStepRuntimeMode(null, "build"), "full-access");
    assert.strictEqual(resolveStoredStepRuntimeMode(null, "plan"), "approval-required");
  });

  it("a stored value is honoured verbatim, for either mode", () => {
    assert.strictEqual(resolveStoredStepRuntimeMode("auto", "build"), "auto");
    assert.strictEqual(
      resolveStoredStepRuntimeMode("approval-required", "build"),
      "approval-required",
    );
    assert.strictEqual(resolveStoredStepRuntimeMode("full-access", "plan"), "full-access");
  });
});
