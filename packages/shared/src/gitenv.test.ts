// @effect-diagnostics nodeBuiltinImport:off - exercises the deliberately
// synchronous gitenv module against real temp directories.
// @effect-diagnostics globalDate:off - forces a distinct file mtime.
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { afterEach, describe, expect, it } from "vite-plus/test";

import {
  githubRepoFromUrl,
  gitenvGitHubRepo,
  gitenvToken,
  gitenvTokenEnv,
  gitenvTokenForRepo,
  originUrlFromGitConfig,
  initGitenv,
  resetGitenvForTesting,
  scrubGitenvTokens,
  withGitenvTokenEnv,
} from "./gitenv.ts";

const TOKEN = "ghp_testTokenValue0123456789abcdef";

interface Fixture {
  readonly stateDir: string;
  readonly projectRoot: string;
  readonly nestedDir: string;
  readonly worktreeDir: string;
  readonly outsideDir: string;
}

/** A main checkout, a linked worktree pointing back at it (as `git worktree
    add` lays it out), a directory outside any repository, and a state dir. */
function makeFixture(): Fixture {
  const base = NodeFS.realpathSync(NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "gitenv-")));
  const stateDir = NodePath.join(base, "state");
  const projectRoot = NodePath.join(base, "project");
  const nestedDir = NodePath.join(projectRoot, "src", "deep");
  const worktreeGitDir = NodePath.join(projectRoot, ".git", "worktrees", "card-1");
  const worktreeDir = NodePath.join(base, "worktrees", "card-1");
  const outsideDir = NodePath.join(base, "elsewhere");
  for (const dir of [stateDir, nestedDir, worktreeGitDir, worktreeDir, outsideDir]) {
    NodeFS.mkdirSync(dir, { recursive: true });
  }
  NodeFS.writeFileSync(NodePath.join(worktreeDir, ".git"), `gitdir: ${worktreeGitDir}\n`);
  return { stateDir, projectRoot, nestedDir, worktreeDir, outsideDir };
}

function setOrigin(root: string, url: string, remote = "origin"): void {
  const configPath = NodePath.join(root, ".git", "config");
  NodeFS.mkdirSync(NodePath.dirname(configPath), { recursive: true });
  NodeFS.writeFileSync(
    configPath,
    `[core]\n\tbare = false\n[remote "${remote}"]\n\turl = ${url}\n\tfetch = +refs/heads/*:refs/remotes/${remote}/*\n`,
  );
  // A rewrite can land in the same mtime tick as an earlier one; force a new mtime.
  const later = new Date(NodeFS.statSync(configPath).mtimeMs + 2_000);
  NodeFS.utimesSync(configPath, later, later);
}

function writeGitenv(fixture: Fixture, contents: string): string {
  const filePath = NodePath.join(fixture.stateDir, "gitenv");
  NodeFS.writeFileSync(filePath, contents, { mode: 0o600 });
  initGitenv(fixture.stateDir);
  return filePath;
}

afterEach(() => {
  resetGitenvForTesting();
});

describe("gitenv", () => {
  it("returns undefined before initGitenv and when the file is absent", () => {
    const fixture = makeFixture();
    expect(gitenvTokenEnv(fixture.projectRoot)).toBeUndefined();
    initGitenv(fixture.stateDir);
    expect(gitenvTokenEnv(fixture.projectRoot)).toBeUndefined();
  });

  it("ignores comments, blank lines, and malformed entries", () => {
    const fixture = makeFixture();
    writeGitenv(
      fixture,
      [
        "# a comment",
        "",
        "not-an-entry",
        "=missing-key",
        `${fixture.projectRoot}=`,
        `relative/path=${TOKEN}`,
        `${fixture.projectRoot}=${TOKEN}`,
      ].join("\n"),
    );
    expect(gitenvTokenEnv(fixture.projectRoot)).toEqual({
      GH_TOKEN: TOKEN,
      GITHUB_TOKEN: TOKEN,
    });
    expect(gitenvTokenEnv(fixture.outsideDir)).toBeUndefined();
  });

  it("matches any directory inside the main checkout", () => {
    const fixture = makeFixture();
    writeGitenv(fixture, `${fixture.projectRoot}=${TOKEN}\n`);
    expect(gitenvTokenEnv(fixture.nestedDir)).toEqual({
      GH_TOKEN: TOKEN,
      GITHUB_TOKEN: TOKEN,
    });
  });

  it("resolves a linked worktree back to the project entry", () => {
    const fixture = makeFixture();
    writeGitenv(fixture, `${fixture.projectRoot}=${TOKEN}\n`);
    expect(gitenvTokenEnv(fixture.worktreeDir)).toEqual({
      GH_TOKEN: TOKEN,
      GITHUB_TOKEN: TOKEN,
    });
  });

  it("names the matched root and a digest of the token for the API transport", () => {
    const fixture = makeFixture();
    writeGitenv(fixture, `${fixture.projectRoot}=${TOKEN}\n`);
    expect(gitenvToken(fixture.worktreeDir)).toEqual({
      root: fixture.projectRoot,
      token: TOKEN,
      digest: NodeCrypto.createHash("sha256").update(TOKEN).digest("hex"),
      entry: { kind: "folder", key: fixture.projectRoot },
    });
    expect(gitenvToken(fixture.outsideDir)).toBeUndefined();
    expect(gitenvToken(undefined)).toBeUndefined();
  });

  it("wins over an ambient GH_TOKEN but leaves unmatched env untouched", () => {
    const fixture = makeFixture();
    writeGitenv(fixture, `${fixture.projectRoot}=${TOKEN}\n`);
    const ambient = { GH_TOKEN: "ambient", PATH: "/usr/bin" };
    expect(withGitenvTokenEnv(ambient, fixture.projectRoot)).toEqual({
      GH_TOKEN: TOKEN,
      GITHUB_TOKEN: TOKEN,
      PATH: "/usr/bin",
    });
    expect(withGitenvTokenEnv(ambient, fixture.outsideDir)).toBe(ambient);
    expect(withGitenvTokenEnv(undefined, fixture.outsideDir)).toBeUndefined();
  });

  it("picks up edits without re-initialization", () => {
    const fixture = makeFixture();
    const filePath = writeGitenv(fixture, `${fixture.projectRoot}=${TOKEN}\n`);
    expect(gitenvTokenEnv(fixture.projectRoot)?.GH_TOKEN).toBe(TOKEN);

    NodeFS.writeFileSync(filePath, `${fixture.projectRoot}=${TOKEN}-rotated\n`);
    // mtime can land in the same clock tick as the first write; force it.
    const later = new Date(NodeFS.statSync(filePath).mtimeMs + 2_000);
    NodeFS.utimesSync(filePath, later, later);
    expect(gitenvTokenEnv(fixture.projectRoot)?.GH_TOKEN).toBe(`${TOKEN}-rotated`);
  });

  it("scrubs configured token values from free text", () => {
    const fixture = makeFixture();
    writeGitenv(fixture, `${fixture.projectRoot}=${TOKEN}\n`);
    expect(scrubGitenvTokens(`remote said ${TOKEN} twice: ${TOKEN}`)).toBe(
      "remote said *** twice: ***",
    );
    expect(scrubGitenvTokens("nothing sensitive")).toBe("nothing sensitive");
  });

  it("does not scrub a short/placeholder configured value", () => {
    const fixture = makeFixture();
    writeGitenv(fixture, `${fixture.projectRoot}=todo\n`);
    expect(scrubGitenvTokens("the value todo appears in ordinary text")).toBe(
      "the value todo appears in ordinary text",
    );
  });
  it("matches when the key is a linked worktree's path", () => {
    const fixture = makeFixture();
    writeGitenv(fixture, `${fixture.worktreeDir}=${TOKEN}\n`);
    expect(gitenvTokenEnv(fixture.nestedDir)?.GH_TOKEN).toBe(TOKEN);
    expect(gitenvTokenEnv(fixture.worktreeDir)?.GH_TOKEN).toBe(TOKEN);
  });

  it("does not remember a worktree path that did not exist yet", () => {
    const fixture = makeFixture();
    writeGitenv(fixture, `${fixture.projectRoot}=${TOKEN}\n`);
    const futureWorktree = NodePath.join(NodePath.dirname(fixture.worktreeDir), "card-2");
    expect(gitenvTokenEnv(futureWorktree)).toBeUndefined();
    NodeFS.mkdirSync(futureWorktree, { recursive: true });
    NodeFS.writeFileSync(
      NodePath.join(futureWorktree, ".git"),
      `gitdir: ${NodePath.join(fixture.projectRoot, ".git", "worktrees", "card-2")}\n`,
    );
    expect(gitenvTokenEnv(futureWorktree)?.GH_TOKEN).toBe(TOKEN);
  });
});

const OWNER_TOKEN = "github_pat_ownerToken0123456789abcdef";
const REPO_TOKEN = "github_pat_repoToken0123456789abcdef";

describe("gitenv owner and repo keys", () => {
  it("prefers the folder entry, then the repo entry, then the owner entry", () => {
    const fixture = makeFixture();
    setOrigin(fixture.projectRoot, "git@github.com:Zeald/client.z5.macjimray.git");
    const filePath = writeGitenv(
      fixture,
      [
        `github.com/Zeald = ${OWNER_TOKEN}`,
        `github.com/Zeald/client.z5.macjimray = ${REPO_TOKEN}`,
        `${fixture.projectRoot} = ${TOKEN}`,
      ].join("\n"),
    );
    expect(gitenvToken(fixture.worktreeDir)?.entry).toEqual({
      kind: "folder",
      key: fixture.projectRoot,
    });

    const rewrite = (contents: string) => {
      NodeFS.writeFileSync(filePath, contents);
      const later = new Date(NodeFS.statSync(filePath).mtimeMs + 2_000);
      NodeFS.utimesSync(filePath, later, later);
    };
    rewrite(
      `github.com/Zeald=${OWNER_TOKEN}\ngithub.com/Zeald/client.z5.macjimray.git=${REPO_TOKEN}\n`,
    );
    expect(gitenvToken(fixture.worktreeDir)).toMatchObject({
      root: fixture.projectRoot,
      token: REPO_TOKEN,
      entry: { kind: "repo", key: "github.com/Zeald/client.z5.macjimray.git" },
    });

    rewrite(`github.com/Zeald=${OWNER_TOKEN}\n`);
    expect(gitenvToken(fixture.nestedDir)).toMatchObject({
      root: fixture.projectRoot,
      token: OWNER_TOKEN,
      entry: { kind: "owner", key: "github.com/Zeald" },
    });
    // Every existing seam reads through gitenvTokenEnv, so it picks the owner up unchanged.
    expect(gitenvTokenEnv(fixture.worktreeDir)?.GH_TOKEN).toBe(OWNER_TOKEN);
    expect(scrubGitenvTokens(`leaked ${OWNER_TOKEN}`)).toBe("leaked ***");
  });

  it("matches owner and repo keys without regard to case", () => {
    const fixture = makeFixture();
    setOrigin(fixture.projectRoot, "https://github.com/brentkelly/T3O");
    writeGitenv(fixture, `GitHub.com/BrentKelly=${OWNER_TOKEN}\n`);
    expect(gitenvToken(fixture.projectRoot)?.token).toBe(OWNER_TOKEN);
    expect(gitenvTokenForRepo({ owner: "BRENTKELLY", repo: "walls" })?.entry).toEqual({
      kind: "owner",
      key: "GitHub.com/BrentKelly",
    });
  });

  it("gives no match for a non-GitHub origin or one that is not called origin", () => {
    const fixture = makeFixture();
    writeGitenv(fixture, `github.com/Zeald=${OWNER_TOKEN}\n`);
    setOrigin(fixture.projectRoot, "https://gitlab.com/Zeald/core.z5.git");
    expect(gitenvToken(fixture.projectRoot)).toBeUndefined();
    setOrigin(fixture.projectRoot, "git@github.com:Zeald/core.z5.git", "upstream");
    expect(gitenvToken(fixture.projectRoot)).toBeUndefined();
    expect(gitenvToken(fixture.outsideDir)).toBeUndefined();
  });

  it("resolves a linked worktree's repo through its main checkout's config", () => {
    const fixture = makeFixture();
    setOrigin(fixture.projectRoot, "ssh://git@github.com/Zeald/core.z5.git");
    writeGitenv(fixture, `github.com/Zeald=${OWNER_TOKEN}\n`);
    expect(gitenvGitHubRepo(fixture.worktreeDir)).toEqual({ owner: "Zeald", repo: "core.z5" });
    expect(gitenvToken(fixture.worktreeDir)?.token).toBe(OWNER_TOKEN);
  });

  it("names a repo directly for the credential helper, a folder entry still first", () => {
    const fixture = makeFixture();
    writeGitenv(
      fixture,
      [
        `github.com/Zeald=${OWNER_TOKEN}`,
        `github.com/Zeald/open-design=${REPO_TOKEN}`,
        `${fixture.projectRoot}=${TOKEN}`,
      ].join("\n"),
    );
    expect(gitenvTokenForRepo({ owner: "Zeald", repo: "open-design" })?.token).toBe(REPO_TOKEN);
    expect(gitenvTokenForRepo({ owner: "Zeald", repo: "core.z5" })?.token).toBe(OWNER_TOKEN);
    expect(gitenvTokenForRepo({ owner: "brentkelly", repo: "t3o" })).toBeUndefined();
    expect(
      gitenvTokenForRepo({ owner: "Zeald", repo: "open-design", cwd: fixture.worktreeDir })?.entry,
    ).toEqual({ kind: "folder", key: fixture.projectRoot });
  });

  it("skips malformed GitHub keys", () => {
    const fixture = makeFixture();
    setOrigin(fixture.projectRoot, "git@github.com:Zeald/core.z5.git");
    writeGitenv(fixture, `github.com/=${OWNER_TOKEN}\ngithub.com/Zeald/a/b=${OWNER_TOKEN}\n`);
    expect(gitenvToken(fixture.projectRoot)).toBeUndefined();
  });
});

describe("githubRepoFromUrl", () => {
  it.each([
    ["https://github.com/Zeald/core.z5.git", { owner: "Zeald", repo: "core.z5" }],
    ["https://x-access-token@github.com/Zeald/core.z5", { owner: "Zeald", repo: "core.z5" }],
    ["https://github.com/Zeald/core.z5/", { owner: "Zeald", repo: "core.z5" }],
    ["git@github.com:brentkelly/t3o.git", { owner: "brentkelly", repo: "t3o" }],
    ["github.com:brentkelly/t3o", { owner: "brentkelly", repo: "t3o" }],
    ["ssh://git@github.com:22/brentkelly/t3o.git", { owner: "brentkelly", repo: "t3o" }],
    ["https://gitlab.com/Zeald/core.z5.git", null],
    ["git@github.example.com:Zeald/core.z5.git", null],
    ["https://github.com/Zeald", null],
    ["/srv/git/core.z5.git", null],
  ])("%s", (url, expected) => {
    expect(githubRepoFromUrl(url)).toEqual(expected);
  });
});

describe("originUrlFromGitConfig", () => {
  it("reads only the origin remote's url", () => {
    const text = [
      '[remote "upstream"]',
      "\turl = git@github.com:pingdotgg/t3code.git",
      '[remote "origin"]',
      "\tfetch = +refs/heads/*:refs/remotes/origin/*",
      "\turl = git@github.com:brentkelly/t3o.git",
      '[branch "t3o"]',
      "\tremote = origin",
    ].join("\n");
    expect(originUrlFromGitConfig(text)).toBe("git@github.com:brentkelly/t3o.git");
    expect(originUrlFromGitConfig("[core]\n\tbare = false\n")).toBeNull();
  });
});
