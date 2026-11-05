import { ProviderDriverKind, ProviderInstanceId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { boardModelDisplayName } from "./boardModelDisplayName";

describe("boardModelDisplayName", () => {
  const instanceId = ProviderInstanceId.make("antigravity");
  const options = new Map([[instanceId, [{ slug: "gemini-3-pro", name: "Gemini 3 Pro" }]]]);
  const entries = [{ instanceId, driverKind: ProviderDriverKind.make("antigravity") }];

  it("names a model the way the picker's trigger does", () => {
    expect(
      boardModelDisplayName({ instanceId, model: "gemini-3-pro" }, () => options, entries),
    ).toBe("3 Pro");
  });

  it("falls back to the slug for a model the instance no longer lists", () => {
    expect(boardModelDisplayName({ instanceId, model: "gone" }, () => options, entries)).toBe(
      "gone",
    );
  });
});
