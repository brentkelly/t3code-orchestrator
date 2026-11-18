import { describe, expect, it } from "vite-plus/test";

import { headlessShellDir } from "./t3o-playwright.ts";

describe("headlessShellDir", () => {
  it("names the headless shell directory, not full chromium", () => {
    const json = {
      browsers: [
        { name: "chromium", revision: "1248" },
        { name: "chromium-headless-shell", revision: "1248" },
        { name: "firefox", revision: "1500" },
      ],
    };
    expect(headlessShellDir(json)).toBe("chromium_headless_shell-1248");
  });

  it("tolerates a malformed manifest", () => {
    expect(headlessShellDir(null)).toBeNull();
    expect(headlessShellDir({ browsers: [null, { name: "chromium-headless-shell" }] })).toBeNull();
  });
});
