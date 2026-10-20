import { describe, expect, it } from "vite-plus/test";

import { resolveGitHubRepository } from "./gitHubRepositoryResolution.ts";

const remotes = (...entries: ReadonlyArray<readonly [string, string]>) =>
  entries.map(([name, url]) => `${name}\t${url} (fetch)\n${name}\t${url} (push)`).join("\n");

const resolve = (remoteList: string, resolved = "") =>
  resolveGitHubRepository({
    remotes: remoteList,
    resolved,
    hostHint: undefined,
    defaultHost: "github.com",
  }).locator;

// T3O-48: in a fork with an `upstream` remote, gh's own rule picks the parent.
describe("origin-first repository resolution", () => {
  it("acts on origin even with an upstream remote, or a gh default set on it", () => {
    const fork = remotes(
      ["upstream", "git@github.com:pingdotgg/t3code.git"],
      ["origin", "git@github.com:brentkelly/t3code-orchestrator.git"],
    );
    const expected = { host: "github.com", owner: "brentkelly", name: "t3code-orchestrator" };
    expect(resolve(fork)).toEqual(expected);
    expect(resolve(fork, "remote.upstream.gh-resolved base")).toEqual(expected);
  });

  it("leaves upstream's choice alone without an origin on the host", () => {
    expect(resolve(remotes(["upstream", "git@github.com:pingdotgg/t3code.git"]))).toEqual({
      host: "github.com",
      owner: "pingdotgg",
      name: "t3code",
    });
    expect(
      resolve(
        remotes(["origin", "git@gitlab.com:me/web.git"], ["github", "git@github.com:acme/web.git"]),
      ),
    ).toEqual({ host: "github.com", owner: "acme", name: "web" });
  });
});
