// @effect-diagnostics nodeBuiltinImport:off - the helper reads a real gitenv file and PATH dirs.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { initGitenvFile, resetGitenvForTesting } from "@t3tools/shared/gitenv";
import { afterEach, describe, expect, it } from "vite-plus/test";

import {
  T3O_SHIM_MARKER,
  credentialAnswer,
  findRealGh,
  ghTargetRepo,
  ghToken,
  parseCredentialRequest,
  resolveGitenvFile,
} from "./gitCredential.ts";

const OWNER_TOKEN = "github_pat_zealdOwner0123456789abcdef";
const REPO_TOKEN = "github_pat_zealdRepo0123456789abcdef";
const FOLDER_TOKEN = "github_pat_folderEntry0123456789abcdef";

function makeFixture() {
  const base = NodeFS.realpathSync(NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3o-gc-")));
  const project = NodePath.join(base, "z5");
  const pinned = NodePath.join(base, "pinned");
  const outside = NodePath.join(base, "outside");
  for (const dir of [NodePath.join(project, ".git"), NodePath.join(pinned, ".git"), outside]) {
    NodeFS.mkdirSync(dir, { recursive: true });
  }
  NodeFS.writeFileSync(
    NodePath.join(project, ".git", "config"),
    '[remote "origin"]\n\turl = git@github.com:Zeald/core.z5.git\n',
  );
  NodeFS.writeFileSync(
    NodePath.join(pinned, ".git", "config"),
    '[remote "origin"]\n\turl = https://github.com/Zeald/open-design.git\n',
  );
  const file = NodePath.join(base, "gitenv");
  NodeFS.writeFileSync(
    file,
    [
      `github.com/Zeald=${OWNER_TOKEN}`,
      `github.com/Zeald/open-design=${REPO_TOKEN}`,
      `${pinned}=${FOLDER_TOKEN}`,
    ].join("\n"),
    { mode: 0o600 },
  );
  initGitenvFile(file);
  return { base, project, pinned, outside };
}

const request = (fields: Record<string, string>) =>
  parseCredentialRequest(
    `${Object.entries(fields)
      .map(([key, value]) => `${key}=${value}`)
      .join("\n")}\n\n`,
  );

afterEach(() => {
  resetGitenvForTesting();
});

describe("resolveGitenvFile", () => {
  it("takes --file, then T3CODE_HOME, then ~/.t3", () => {
    expect(resolveGitenvFile(["--file", "/x/gitenv", "get"], {}, "/home/me")).toEqual({
      file: "/x/gitenv",
      rest: ["get"],
    });
    expect(resolveGitenvFile(["--file=/y/gitenv", "gh", "pr"], {}, "/home/me")).toEqual({
      file: "/y/gitenv",
      rest: ["gh", "pr"],
    });
    expect(resolveGitenvFile(["get"], { T3CODE_HOME: "/srv/t3" }, "/home/me").file).toBe(
      "/srv/t3/userdata/gitenv",
    );
    expect(resolveGitenvFile(["get"], {}, "/home/me").file).toBe("/home/me/.t3/userdata/gitenv");
  });
});

describe("credentialAnswer", () => {
  it("answers github.com over https by the repo in path=", () => {
    const { outside } = makeFixture();
    const answer = (path: string) =>
      credentialAnswer(request({ protocol: "https", host: "github.com", path }), outside);
    expect(answer("Zeald/open-design.git")).toBe(
      `username=x-access-token\npassword=${REPO_TOKEN}\n`,
    );
    expect(answer("Zeald/core.z5.git")).toBe(`username=x-access-token\npassword=${OWNER_TOKEN}\n`);
    expect(answer("brentkelly/t3o.git")).toBeNull();
  });

  it("falls back to the folder's origin without path=, and puts a folder entry first", () => {
    const { project, pinned } = makeFixture();
    expect(credentialAnswer(request({ protocol: "https", host: "github.com" }), project)).toBe(
      `username=x-access-token\npassword=${OWNER_TOKEN}\n`,
    );
    expect(
      credentialAnswer(
        request({ protocol: "https", host: "github.com", path: "Zeald/open-design.git" }),
        pinned,
      ),
    ).toBe(`username=x-access-token\npassword=${FOLDER_TOKEN}\n`);
    // A submodule or second remote naming another repo never borrows the folder entry.
    expect(
      credentialAnswer(
        request({ protocol: "https", host: "github.com", path: "Zeald/core.z5.git" }),
        pinned,
      ),
    ).toBe(`username=x-access-token\npassword=${OWNER_TOKEN}\n`);
  });

  it("stays silent for other hosts and protocols so git asks its next helper", () => {
    const { project } = makeFixture();
    const path = "Zeald/core.z5.git";
    expect(credentialAnswer(request({ protocol: "http", host: "github.com", path }), project)).toBe(
      null,
    );
    expect(
      credentialAnswer(request({ protocol: "https", host: "gitlab.com", path }), project),
    ).toBeNull();
  });

  it("reads fields only up to the blank line", () => {
    expect([...parseCredentialRequest("protocol=https\nhost=github.com\n\nhost=evil\n")]).toEqual([
      ["protocol", "https"],
      ["host", "github.com"],
    ]);
  });
});

describe("ghTargetRepo", () => {
  it.each([
    [["pr", "list", "-R", "Zeald/core.z5"], {}, { owner: "Zeald", repo: "core.z5" }],
    [["pr", "list", "--repo", "github.com/Zeald/core.z5"], {}, { owner: "Zeald", repo: "core.z5" }],
    [
      ["pr", "list", "--repo=https://github.com/Zeald/core.z5.git"],
      {},
      { owner: "Zeald", repo: "core.z5" },
    ],
    [["pr", "list", "-RZeald/core.z5"], {}, { owner: "Zeald", repo: "core.z5" }],
    [["api", "user"], { GH_REPO: "brentkelly/t3o" }, { owner: "brentkelly", repo: "t3o" }],
    [["pr", "list", "-R", "git.acme.io/Zeald/core.z5"], {}, null],
  ])("%j with %j", (args, env, repo) => {
    expect(ghTargetRepo(args, env)).toEqual({ explicit: true, repo });
  });

  it("ignores -R after -- and reports no explicit repo", () => {
    expect(ghTargetRepo(["api", "--", "-R", "Zeald/core.z5"], {})).toEqual({
      explicit: false,
      repo: null,
    });
  });
});

describe("ghToken", () => {
  it("uses the named repo, else the folder's origin, and never falls back past another host", () => {
    const { project, outside } = makeFixture();
    expect(ghToken(["pr", "list", "-R", "Zeald/open-design"], {}, outside)?.token).toBe(REPO_TOKEN);
    expect(ghToken(["pr", "list"], {}, project)?.entry).toEqual({
      kind: "owner",
      key: "github.com/Zeald",
    });
    expect(ghToken(["pr", "list"], {}, outside)).toBeUndefined();
    expect(ghToken(["pr", "list", "-R", "git.acme.io/Zeald/x"], {}, project)).toBeUndefined();
  });
});

describe("findRealGh", () => {
  it("skips T3o shims and itself, and finds the next gh on PATH", () => {
    const { base } = makeFixture();
    const shimDir = NodePath.join(base, "local-bin");
    const linkDir = NodePath.join(base, "link-bin");
    const realDir = NodePath.join(base, "usr-bin");
    for (const dir of [shimDir, linkDir, realDir]) NodeFS.mkdirSync(dir);
    const self = NodePath.join(base, "t3oGitCredential.mjs");
    NodeFS.writeFileSync(self, "// entry\n", { mode: 0o755 });
    NodeFS.writeFileSync(
      NodePath.join(shimDir, "gh"),
      `#!/bin/sh\n${T3O_SHIM_MARKER}\nexec node x gh "$@"\n`,
      { mode: 0o755 },
    );
    NodeFS.symlinkSync(self, NodePath.join(linkDir, "gh"));
    NodeFS.writeFileSync(NodePath.join(realDir, "gh"), "#!/bin/sh\n", { mode: 0o755 });
    const path = [shimDir, linkDir, NodePath.join(base, "missing"), realDir].join(
      NodePath.delimiter,
    );
    expect(findRealGh(path, [self], "gh")).toBe(NodePath.join(realDir, "gh"));
    expect(findRealGh([shimDir, linkDir].join(NodePath.delimiter), [self], "gh")).toBeNull();
  });
});
