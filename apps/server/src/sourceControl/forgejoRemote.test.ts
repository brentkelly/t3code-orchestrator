import { assert, describe, it } from "@effect/vitest";

import { parseForgejoRemoteUrl } from "./forgejoRemote.ts";

describe("parseForgejoRemoteUrl", () => {
  it("reads an HTTPS remote", () => {
    assert.deepStrictEqual(parseForgejoRemoteUrl("https://codeberg.org/octocat/widgets.git"), {
      host: "codeberg.org",
      nameWithOwner: "octocat/widgets",
    });
  });

  it("keeps a non-standard port, because that is how fgj keys an instance", () => {
    assert.deepStrictEqual(
      parseForgejoRemoteUrl("https://forgejo.example.test:3000/octocat/widgets.git"),
      { host: "forgejo.example.test:3000", nameWithOwner: "octocat/widgets" },
    );
  });

  it("reads an scp-style SSH remote", () => {
    assert.deepStrictEqual(parseForgejoRemoteUrl("git@forgejo.example.test:octocat/widgets.git"), {
      host: "forgejo.example.test",
      nameWithOwner: "octocat/widgets",
    });
  });

  it("reads an ssh:// remote", () => {
    assert.deepStrictEqual(
      parseForgejoRemoteUrl("ssh://git@forgejo.example.test/octocat/widgets.git"),
      { host: "forgejo.example.test", nameWithOwner: "octocat/widgets" },
    );
  });

  it("tolerates a missing .git suffix and a trailing slash", () => {
    assert.deepStrictEqual(parseForgejoRemoteUrl("https://codeberg.org/octocat/widgets/"), {
      host: "codeberg.org",
      nameWithOwner: "octocat/widgets",
    });
  });

  it("lower-cases the host but leaves owner and name as written", () => {
    assert.deepStrictEqual(parseForgejoRemoteUrl("https://Forgejo.Example.Test/OctoCat/Widgets"), {
      host: "forgejo.example.test",
      nameWithOwner: "OctoCat/Widgets",
    });
  });

  it("takes the final owner/name pair when the instance is served below a path prefix", () => {
    assert.deepStrictEqual(parseForgejoRemoteUrl("https://example.test/git/octocat/widgets.git"), {
      host: "example.test",
      nameWithOwner: "octocat/widgets",
    });
  });

  it("returns null when there is no owner to address", () => {
    assert.strictEqual(parseForgejoRemoteUrl("https://codeberg.org/widgets.git"), null);
  });

  it("returns null for junk", () => {
    assert.strictEqual(parseForgejoRemoteUrl("not a url"), null);
    assert.strictEqual(parseForgejoRemoteUrl("   "), null);
  });
});
