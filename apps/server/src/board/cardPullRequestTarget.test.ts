/**
 * Naming a pull request to link to a card (T3O-18): what the card's input
 * and the agent tools accept, and the refusals that keep a link on the
 * card's own repository.
 */
import type { RepositoryIdentity } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";

import { boardRepositoryOf } from "./boardRepository.ts";
import { parseCardPullRequestText, resolveCardPullRequestTarget } from "./cardPullRequestTarget.ts";

const zeald: RepositoryIdentity = {
  canonicalKey: "github.com/zeald/core.z5",
  locator: {
    source: "git-remote",
    remoteName: "origin",
    remoteUrl: "git@github.com:Zeald/core.z5.git",
  },
  provider: "github",
  owner: "Zeald",
  name: "core.z5",
};
/** A single-remote project: its identity is its origin. */
const identity = boardRepositoryOf(zeald, zeald.locator.remoteUrl);

describe("parseCardPullRequestText", () => {
  it("reads a bare number, with or without #", () => {
    expect(parseCardPullRequestText("312")).toEqual({ number: 312 });
    expect(parseCardPullRequestText(" #75 ")).toEqual({ number: 75 });
  });

  it("reads owner/repo#number and a URL", () => {
    expect(parseCardPullRequestText("Zeald/core.z5#76")).toEqual({
      repository: "Zeald/core.z5",
      number: 76,
    });
    expect(parseCardPullRequestText("https://github.com/Zeald/core.z5/pull/74")).toEqual({
      url: "https://github.com/Zeald/core.z5/pull/74",
    });
  });

  it("names nothing for text that is not a pull request", () => {
    expect(parseCardPullRequestText("#0")).toBeNull();
    expect(parseCardPullRequestText("fix the thing")).toBeNull();
    expect(parseCardPullRequestText("")).toBeNull();
  });
});

describe("resolveCardPullRequestTarget", () => {
  it("resolves a URL on the card's repository, whatever its case", () => {
    expect(
      resolveCardPullRequestTarget({ url: "https://github.com/Zeald/core.z5/pull/74" }, identity),
    ).toEqual({ number: 74 });
  });

  it("resolves repository and number, and a bare number, against the project", () => {
    expect(
      resolveCardPullRequestTarget({ repository: "zeald/core.z5", number: 75 }, identity),
    ).toEqual({ number: 75 });
    expect(resolveCardPullRequestTarget({ number: 76 }, identity)).toEqual({ number: 76 });
  });

  it("reads the repository however it is written: host-qualified, .git or URL", () => {
    for (const repository of [
      "github.com/Zeald/core.z5",
      "zeald/core.z5.git",
      "https://github.com/zeald/core.z5/",
    ]) {
      expect(resolveCardPullRequestTarget({ repository, number: 75 }, identity)).toEqual({
        number: 75,
      });
    }
    expect(
      "refused" in
        resolveCardPullRequestTarget({ repository: "github.com/zeald/core", number: 75 }, identity),
    ).toBe(true);
  });

  it("refuses a pull request on another repository, naming both", () => {
    const result = resolveCardPullRequestTarget(
      { url: "https://github.com/someone/else/pull/9" },
      identity,
    );
    expect("refused" in result && result.refused).toContain("someone/else#9");
    expect("refused" in result && result.refused).toContain("zeald/core.z5");
  });

  it("refuses a URL it cannot read, a target with no number, and a project with no remote", () => {
    expect(
      "refused" in resolveCardPullRequestTarget({ url: "https://example.com/nope" }, identity),
    ).toBe(true);
    expect(
      "refused" in resolveCardPullRequestTarget({ repository: "zeald/core.z5" }, identity),
    ).toBe(true);
    expect("refused" in resolveCardPullRequestTarget({ number: 1 }, null)).toBe(true);
  });
});

// T3O-24: upstream's identity prefers an `upstream` remote, so in a fork it
// names the repository the board's pull requests are NOT on.
describe("resolveCardPullRequestTarget in a fork", () => {
  const upstream: RepositoryIdentity = {
    canonicalKey: "github.com/pingdotgg/t3code",
    locator: {
      source: "git-remote",
      remoteName: "upstream",
      remoteUrl: "https://github.com/pingdotgg/t3code.git",
    },
    provider: "github",
    owner: "pingdotgg",
    name: "t3code",
  };
  const fork = boardRepositoryOf(upstream, "git@github.com:brentkelly/t3code-orchestrator.git");

  it("links the fork's own pull request", () => {
    expect(
      resolveCardPullRequestTarget(
        { url: "https://github.com/brentkelly/t3code-orchestrator/pull/175" },
        fork,
      ),
    ).toEqual({ number: 175 });
    expect(
      resolveCardPullRequestTarget(
        { repository: "brentkelly/t3code-orchestrator", number: 175 },
        fork,
      ),
    ).toEqual({ number: 175 });
  });

  it("refuses upstream's, naming the fork as the card's repository", () => {
    const result = resolveCardPullRequestTarget(
      { url: "https://github.com/pingdotgg/t3code/pull/175" },
      fork,
    );
    expect("refused" in result && result.refused).toContain("pingdotgg/t3code#175");
    expect("refused" in result && result.refused).toContain("brentkelly/t3code-orchestrator");
  });
});
