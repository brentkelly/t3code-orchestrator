import { assert, describe, it } from "@effect/vitest";
import * as Option from "effect/Option";

import {
  boardBuildStepPayloadDefect,
  boardStepPayloadDefect,
  decodeBoardBuildSummaryPayloadOption,
} from "./board.ts";

const valid = {
  lead: "Built the `Summary` pane on `board/t3o-21`, 3 commits, pushed.",
  notes: [
    { kind: "plan_change", text: "Dropped the severity chip." },
    { kind: "shortcut", text: "Opened a normal PR.", detail: "The forge refused drafts." },
  ],
  checks: [{ status: "pass", name: "vitest", detail: "12 files" }],
  areas: [{ name: "Panel", items: ["Rewrote the pane."] }],
};

describe("decodeBoardBuildSummaryPayloadOption", () => {
  it("decodes a valid payload", () => {
    const decoded = decodeBoardBuildSummaryPayloadOption(JSON.stringify(valid));
    assert.isTrue(Option.isSome(decoded));
    const payload = Option.getOrThrow(decoded);
    assert.strictEqual(payload.notes[1]?.detail, "The forge refused drafts.");
    assert.strictEqual(payload.areas[0]?.items.length, 1);
  });

  it("accepts empty arrays", () => {
    const decoded = decodeBoardBuildSummaryPayloadOption(
      JSON.stringify({ lead: "Built it.", notes: [], checks: [], areas: [] }),
    );
    assert.isTrue(Option.isSome(decoded));
  });

  it("reads a payload the agent stringified itself", () => {
    const decoded = decodeBoardBuildSummaryPayloadOption(JSON.stringify(JSON.stringify(valid)));
    assert.isTrue(Option.isSome(decoded));
  });

  it("rejects a bad note kind", () => {
    const decoded = decodeBoardBuildSummaryPayloadOption(
      JSON.stringify({ ...valid, notes: [{ kind: "warning", text: "x" }] }),
    );
    assert.isTrue(Option.isNone(decoded));
  });

  it("rejects a bad check status", () => {
    const decoded = decodeBoardBuildSummaryPayloadOption(
      JSON.stringify({ ...valid, checks: [{ status: "error", name: "lint", detail: "" }] }),
    );
    assert.isTrue(Option.isNone(decoded));
  });

  it("rejects an empty lead", () => {
    const decoded = decodeBoardBuildSummaryPayloadOption(JSON.stringify({ ...valid, lead: "  " }));
    assert.isTrue(Option.isNone(decoded));
  });

  it("rejects missing arrays", () => {
    const decoded = decodeBoardBuildSummaryPayloadOption(JSON.stringify({ lead: "Built it." }));
    assert.isTrue(Option.isNone(decoded));
  });

  it("is None for no payload", () => {
    assert.isTrue(Option.isNone(decodeBoardBuildSummaryPayloadOption(null)));
  });
});

describe("boardBuildStepPayloadDefect", () => {
  it("is null for a valid payload", () => {
    assert.isNull(boardBuildStepPayloadDefect(JSON.stringify(valid)));
  });

  it("names the shape and the payload argument when none was sent", () => {
    const defect = boardBuildStepPayloadDefect(null);
    assert.isNotNull(defect);
    assert.include(defect!, "{ lead, notes:");
    assert.include(defect!, "none was recorded");
    assert.include(defect!, "`payload` argument");
  });

  it("says the payload does not parse when it is malformed", () => {
    const defect = boardBuildStepPayloadDefect(JSON.stringify({ lead: "x", notes: "no" }));
    assert.isNotNull(defect);
    assert.include(defect!, "does not parse");
  });

  it("leaves the review-loop contract untouched: a build step never reads as defective there", () => {
    assert.isNull(boardStepPayloadDefect({ stepId: "building", payload: null }));
  });
});
