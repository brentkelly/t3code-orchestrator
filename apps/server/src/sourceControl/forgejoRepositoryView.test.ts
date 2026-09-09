import { assert, describe, it } from "@effect/vitest";

import { parseForgejoRepositoryView } from "./forgejoRepositoryView.ts";
import { FORGEJO_REPO_VIEW_OUTPUT } from "./testing/forgejoFixtures.ts";

describe("parseForgejoRepositoryView", () => {
  it("reads the labelled lines of a real capture", () => {
    assert.deepStrictEqual(parseForgejoRepositoryView(FORGEJO_REPO_VIEW_OUTPUT), {
      nameWithOwner: "octocat/widgets",
      url: "https://forgejo.example.test/octocat/widgets",
      httpsCloneUrl: "https://forgejo.example.test/octocat/widgets.git",
      sshCloneUrl: "ssh://git@forgejo.example.test/octocat/widgets.git",
      defaultBranch: "main",
    });
  });

  it("reports the fields it did not find as null rather than guessing", () => {
    assert.deepStrictEqual(parseForgejoRepositoryView("Repository: octocat/widgets\nStars: 3\n"), {
      nameWithOwner: "octocat/widgets",
      url: null,
      httpsCloneUrl: null,
      sshCloneUrl: null,
      defaultBranch: null,
    });
  });

  it("keeps the first value when a label repeats", () => {
    const view = parseForgejoRepositoryView(`Repository: octocat/widgets
Default Branch: trunk
Repository: someone/else
Default Branch: main
`);

    assert.strictEqual(view.nameWithOwner, "octocat/widgets");
    assert.strictEqual(view.defaultBranch, "trunk");
  });

  it("returns nulls for output with no labelled lines at all", () => {
    assert.deepStrictEqual(parseForgejoRepositoryView("Error: something went wrong"), {
      nameWithOwner: null,
      url: null,
      httpsCloneUrl: null,
      sshCloneUrl: null,
      defaultBranch: null,
    });
  });
});
