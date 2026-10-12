/**
 * Naming a pull request to link to a card (T3O-18): what the card's input
 * and the agent tools accept, and the refusals that keep a link on the
 * card's own repository.
 */
import type { RepositoryIdentity } from "@t3tools/contracts";
import { describe, expect, it } from "vitest";

import { parseCardPullRequestText, resolveCardPullRequestTarget } from "./cardPullRequestTarget.ts";

const identity: RepositoryIdentity = {
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
