import { describe, expect, it } from "vite-plus/test";

import {
  checkPinnedVersion,
  chromiumInstallDirs,
  formatResult,
  parseVersion,
  redactCredentials,
  verdict,
  type CheckResult,
} from "./t3o-ready.ts";

describe("parseVersion", () => {
  it.each([
    ["26.12.1", [26, 12, 1]],
    ["v26.12.1\n", [26, 12, 1]],
    ["pnpm@12.14.0", [12, 14, 0]],
    ["pnpm@12.14.0+sha512.abc", [12, 14, 0]],
    ["12.0.0-rc.1", [12, 0, 0]],
    [">=24.10", null],
    ["^22.16 || >=24.10", null],
    ["", null],
    [undefined, null],
  ] as const)("%s", (text, expected) => {
    expect(parseVersion(text)).toEqual(expected);
  });
});

describe("checkPinnedVersion", () => {
  const check = (actual: string | null, pin: string | undefined) =>
    checkPinnedVersion({ name: "node", actual, pin, pinSource: "engines.node", fix: "install" });

  it.each([
    ["26.12.1", "26.12.1", "pass"],
    ["v26.13.0", "26.12.1", "warn"],
    ["26.11.9", "26.12.1", "warn"],
    ["24.12.1", "26.12.1", "fail"],
    ["27.0.0", "26.12.1", "fail"],
    [null, "26.12.1", "fail"],
    ["garbage", "26.12.1", "fail"],
    ["26.12.1", ">=24.10", "skip"],
    ["26.12.1", undefined, "skip"],
  ] as const)("%s against %s is %s", (actual, pin, status) => {
    expect(check(actual, pin).status).toBe(status);
  });

  it("carries the fix only when something is wrong", () => {
    expect(check("26.12.1", "26.12.1").fix).toBeUndefined();
    expect(check(null, "26.12.1").fix).toBe("install");
  });
});

describe("redactCredentials", () => {
  it.each([
    ["https://x-access-token:ghp_secret@github.com/a/b.git", "https://***@github.com/a/b.git"],
    ["https://ghp_secret@github.com/a/b.git", "https://***@github.com/a/b.git"],
    ["https://github.com/a/b.git", "https://github.com/a/b.git"],
    ["ssh://git@github.com/a/b.git", "ssh://***@github.com/a/b.git"],
    ["git@github.com:a/b.git", "git@github.com:a/b.git"],
    [
      "fatal: unable to access 'https://u:p@github.com/a/' and 'https://t@x.io/'",
      "fatal: unable to access 'https://***@github.com/a/' and 'https://***@x.io/'",
    ],
  ])("%s", (url, expected) => {
    expect(redactCredentials(url)).toBe(expected);
  });
});

describe("chromiumInstallDirs", () => {
  it("names the chromium and headless shell directories", () => {
    const json = {
      browsers: [
        { name: "chromium", revision: "1255" },
        { name: "chromium-headless-shell", revision: "1255" },
        { name: "firefox", revision: "1500" },
      ],
    };
    expect(chromiumInstallDirs(json)).toEqual(["chromium-1255", "chromium_headless_shell-1255"]);
  });

  it("tolerates a malformed manifest", () => {
    expect(chromiumInstallDirs(null)).toEqual([]);
    expect(chromiumInstallDirs({ browsers: [null, { name: "chromium" }] })).toEqual([]);
  });
});

describe("verdict", () => {
  const result = (name: string, status: CheckResult["status"]): CheckResult => ({
    name,
    status,
    detail: "",
  });

  it("is ready with warnings and skips", () => {
    expect(verdict([result("node", "pass"), result("deps", "warn"), result("x", "skip")])).toEqual({
      ready: true,
      line: "READY (1 pass, 1 warn, 0 fail, 1 skip); warnings: deps",
    });
  });

  it("is not ready on any failure and names it", () => {
    expect(verdict([result("node", "pass"), result("gh", "fail"), result("git", "fail")])).toEqual({
      ready: false,
      line: "NOT READY: gh, git failed (1 pass, 0 warn, 2 fail, 0 skip)",
    });
  });

  it("is ready with no checks", () => {
    expect(verdict([]).ready).toBe(true);
  });
});

describe("formatResult", () => {
  const failed: CheckResult = {
    name: "gh",
    status: "fail",
    detail: "not found",
    fix: "install gh",
  };

  it("prints no ANSI without a terminal", () => {
    expect(formatResult(failed, false)).toBe(
      `  fail  gh               not found\n${" ".repeat(25)}fix: install gh`,
    );
  });

  it("colours the status on a terminal", () => {
    expect(formatResult(failed, true)).toContain("\x1b[31mfail\x1b[0m");
  });

  it("drops the fix on a pass", () => {
    expect(formatResult({ ...failed, status: "pass" }, false)).not.toContain("fix:");
  });
});
