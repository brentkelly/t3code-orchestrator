import { describe, expect, it } from "vite-plus/test";

import { settingValueKey } from "./settingsCommandIdKey";

describe("settingValueKey", () => {
  it("is stable across key order and undefined members", () => {
    expect(settingValueKey({ instanceId: "codex", model: "gpt-5", options: undefined })).toBe(
      settingValueKey({ model: "gpt-5", instanceId: "codex" }),
    );
  });

  it("changes when the setting changes", () => {
    expect(settingValueKey({ instanceId: "codex", model: "gpt-5" })).not.toBe(
      settingValueKey({ instanceId: "codex", model: "gpt-5-mini" }),
    );
    expect(settingValueKey("full-access")).not.toBe(settingValueKey("approval-required"));
  });
});
