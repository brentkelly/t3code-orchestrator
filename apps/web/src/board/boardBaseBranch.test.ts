/**
 * The two picker decisions that can be wrong in a way nothing else catches
 * (T3O-5, D12/D16): what a click STORES, and which row reads as current.
 */
import type { VcsRef } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  boardBaseBranchOptions,
  boardBaseBranchSelectedName,
  boardBaseBranchSelectionValue,
} from "./boardBaseBranch";

const ref = (name: string, extra?: Partial<VcsRef>): VcsRef => ({
  name,
  current: false,
  isDefault: false,
  worktreePath: null,
  ...extra,
});

describe("boardBaseBranchOptions", () => {
  it("AC16: shows a remote-only ref under its own name but stores the LOCAL one", () => {
    // Every reader of a recorded base re-qualifies it as `refs/heads/<name>`:
    // `measureBaseTip` would measure nothing, `pullMergedBaseBranch` would
    // create a branch literally named `origin/develop`, and the rebase would
    // target a ref that drifts. All three fail silently.
    const [option] = boardBaseBranchOptions([ref("origin/develop", { isRemote: true })]);
    expect(option?.name).toBe("origin/develop");
    expect(option?.localName).toBe("develop");
  });

  it("dedupes a branch that exists both locally and on the remote", () => {
    const options = boardBaseBranchOptions([
      ref("develop"),
      ref("origin/develop", { isRemote: true }),
    ]);
    expect(options.map((option) => option.localName)).toEqual(["develop"]);
  });

  it("drops refs whose local name is not a usable base", () => {
    // Offering a value the decider will refuse is worse than not offering it:
    // the user learns nothing from the rejection.
    expect(boardBaseBranchOptions([ref("refs/heads/develop")])).toEqual([]);
  });

  it("carries the default flag straight off the wire", () => {
    const options = boardBaseBranchOptions([ref("main", { isDefault: true }), ref("develop")]);
    expect(options.map((option) => option.isDefault)).toEqual([true, false]);
  });
});

describe("boardBaseBranchSelectionValue", () => {
  it("AC16: stores null for the project's CURRENT default, not its name", () => {
    // Keeps the nullable override meaningful: a project that later moves its
    // default carries every unopinionated card with it, rather than stranding a
    // fleet pinned to a branch that no longer exists.
    expect(boardBaseBranchSelectionValue({ localName: "main", isDefault: true })).toBeNull();
  });

  it("stores the local name for any other branch", () => {
    expect(boardBaseBranchSelectionValue({ localName: "develop", isDefault: false })).toBe(
      "develop",
    );
  });
});

describe("boardBaseBranchSelectedName", () => {
  const options = boardBaseBranchOptions([ref("main", { isDefault: true }), ref("develop")]);

  it("marks the card's pin when it has one", () => {
    expect(boardBaseBranchSelectedName({ baseBranch: "develop", options })).toBe("develop");
  });

  it("marks the project default when the card has no pin", () => {
    expect(boardBaseBranchSelectedName({ baseBranch: null, options })).toBe("main");
  });

  it("marks nothing while the refs are still loading", () => {
    // Nothing honest to point at yet, and guessing would flash a branch the
    // card is not actually set to.
    expect(boardBaseBranchSelectedName({ baseBranch: null, options: [] })).toBeNull();
  });

  it("keeps naming a pin that no longer exists in the ref list", () => {
    // A deleted branch must still read as what the card is SET to, or the row
    // would silently claim the default it is not — and the amber divergence
    // line would be the only hint anything was wrong.
    expect(boardBaseBranchSelectedName({ baseBranch: "gone", options })).toBe("gone");
  });
});
