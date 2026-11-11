// A step-state row persisted before migration 021 has a NULL `runtime_mode` and
// must keep the authority it was running under (`full-access` for a build-mode
// run), not drop to the newer safer default.
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
