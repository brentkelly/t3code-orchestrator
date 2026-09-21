import { assert, describe, it } from "@effect/vitest";

import { gitHubRepositoryArgs, parseGitHubRemoteUrl } from "./githubRemote.ts";

describe("parseGitHubRemoteUrl", () => {
  it("reads an HTTPS remote", () => {
    assert.deepStrictEqual(parseGitHubRemoteUrl("https://github.com/octocat/widgets.git"), {
      host: "github.com",
      nameWithOwner: "octocat/widgets",
    });
  });

  it("reads an scp-style SSH remote", () => {
    assert.deepStrictEqual(parseGitHubRemoteUrl("git@github.com:octocat/widgets.git"), {
      host: "github.com",
      nameWithOwner: "octocat/widgets",
    });
  });

  it("reads an ssh:// remote", () => {
    assert.deepStrictEqual(parseGitHubRemoteUrl("ssh://git@github.com/octocat/widgets.git"), {
      host: "github.com",
      nameWithOwner: "octocat/widgets",
    });
  });

  it("keeps an enterprise host rather than assuming github.com", () => {
    assert.deepStrictEqual(parseGitHubRemoteUrl("https://ghe.example.test/octocat/widgets.git"), {
      host: "ghe.example.test",
      nameWithOwner: "octocat/widgets",
    });
  });

  it("keeps a non-standard port", () => {
    assert.deepStrictEqual(
      parseGitHubRemoteUrl("https://ghe.example.test:8443/octocat/widgets.git"),
      { host: "ghe.example.test:8443", nameWithOwner: "octocat/widgets" },
    );
  });

  it("tolerates a missing .git suffix and a trailing slash", () => {
    assert.deepStrictEqual(parseGitHubRemoteUrl("https://github.com/octocat/widgets/"), {
      host: "github.com",
      nameWithOwner: "octocat/widgets",
    });
  });

  it("lower-cases the host but leaves owner and name as written", () => {
    assert.deepStrictEqual(parseGitHubRemoteUrl("https://GitHub.com/OctoCat/Widgets"), {
      host: "github.com",
      nameWithOwner: "OctoCat/Widgets",
    });
  });

  it("takes the final owner/name pair when an install is served below a path prefix", () => {
    assert.deepStrictEqual(parseGitHubRemoteUrl("https://example.test/git/octocat/widgets.git"), {
      host: "example.test",
      nameWithOwner: "octocat/widgets",
    });
  });

  it("returns null when there is no owner to address", () => {
    assert.strictEqual(parseGitHubRemoteUrl("https://github.com/widgets.git"), null);
  });

  it("returns null for junk", () => {
    assert.strictEqual(parseGitHubRemoteUrl("not a url"), null);
    assert.strictEqual(parseGitHubRemoteUrl("   "), null);
  });
});

describe("gitHubRepositoryArgs", () => {
  it("qualifies the repository with its host", () => {
    assert.deepStrictEqual(
      gitHubRepositoryArgs({ host: "github.com", nameWithOwner: "octocat/widgets" }),
      ["--repo", "github.com/octocat/widgets"],
    );
  });

  it("adds no flag at all when the remote could not be resolved", () => {
    assert.deepStrictEqual(gitHubRepositoryArgs(null), []);
    assert.deepStrictEqual(gitHubRepositoryArgs(undefined), []);
  });
});
