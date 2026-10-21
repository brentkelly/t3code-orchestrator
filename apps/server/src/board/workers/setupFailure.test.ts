import { describe, expect, it } from "vitest";

import { classifyCloneFailure, cloneDestination, repositoryFolderName } from "./setupFailure.ts";

describe("classifyCloneFailure", () => {
  it.each([
    ["git@github.com: Permission denied (publickey).", "no-credentials"],
    [
      "fatal: could not read Username for 'https://github.com': terminal prompts disabled",
      "no-credentials",
    ],
    ["fatal: Authentication failed for 'https://github.com/acme/app.git/'", "no-credentials"],
    ["ssh: Could not resolve hostname github.com: Name or service not known", "remote-unreachable"],
    [
      "fatal: unable to access 'https://git.internal/acme/app.git/': Could not resolve host: git.internal",
      "remote-unreachable",
    ],
    [
      "fatal: destination path 'app' already exists and is not an empty directory.",
      "folder-exists",
    ],
    ["error: unable to write file src/index.ts: No space left on device", "disk-full"],
    ["something nobody has seen before", "unknown"],
  ] as const)("%s → %s", (text, kind) => {
    expect(classifyCloneFailure(text)).toBe(kind);
  });
});

describe("clone destination", () => {
  it("names the folder after the repository", () => {
    expect(repositoryFolderName("https://github.com/acme/app.git")).toBe("app");
    expect(repositoryFolderName("git@github.com:acme/app.git")).toBe("app");
    expect(repositoryFolderName("https://github.com/acme/app/")).toBe("app");
  });

  it("clones into the folder, keeping a ~ for the worker to expand", () => {
    expect(cloneDestination("~/projects/", "git@github.com:acme/app.git")).toBe("~/projects/app");
  });
});
