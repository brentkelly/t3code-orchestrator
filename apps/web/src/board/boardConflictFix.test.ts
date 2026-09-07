/**
 * The words both conflict surfaces show (T3O-9). One module produces them, so
 * the board card's tooltip and the modal's banner cannot drift apart — which is
 * what this asserts: the copy, the queued variant, and the fallback for a card
 * whose base branch the surface does not know.
 */
import { describe, expect, it } from "vite-plus/test";

import { boardConflictFix } from "./boardConflictFix";

describe("boardConflictFix (T3O-9)", () => {
  it("says nothing at all when the merge is not held", () => {
    expect(boardConflictFix({ live: false })).toBeNull();
    // Queued alone is not a conflict fix — an ordinary build waiting for a slot
    // has its own pill, and must not grow this one.
    expect(boardConflictFix({ live: false, queued: true })).toBeNull();
  });

  it("names the base branch a running fix is merging against", () => {
    const info = boardConflictFix({ live: true, baseRef: "main" });
    expect(info?.headline).toBe("Resolving conflicts against main");
    // The point of the detail line: nothing is expected of the user.
    expect(info?.detail).toBe("The merge holds until the thread finishes.");
    expect(info?.label).toBe("Conflicts");
  });

  it("falls back to a true sentence when the surface has no base branch", () => {
    // The column card is that surface: the shell carries no base, and should
    // not grow one for a tooltip.
    expect(boardConflictFix({ live: true })?.headline).toBe(
      "Resolving conflicts against the base branch",
    );
    expect(boardConflictFix({ live: true, baseRef: null })?.headline).toBe(
      "Resolving conflicts against the base branch",
    );
    expect(boardConflictFix({ live: true, baseRef: "" })?.headline).toBe(
      "Resolving conflicts against the base branch",
    );
  });

  it("says a fix waiting for an agent is waiting, and starts by itself", () => {
    // The build-queue pill covers the wait but not the reason — it says
    // "queued for build" and nothing about a held merge.
    const info = boardConflictFix({ live: true, queued: true, baseRef: "t3o" });
    expect(info?.headline).toBe("Waiting for an agent to resolve conflicts against t3o");
    // The mechanics — the queue position, the agent count, the override
    // buttons — belong to the build-queue banner beside it (t3o-33), so this
    // names the wait and stops rather than printing its sentence twice.
    expect(info?.detail).toBe("The merge holds until an agent is free and the thread finishes.");
    // The PILL is the same word either way: it asserts the held merge, not
    // motion, which is exactly why it survives the queued case.
    expect(info?.label).toBe("Conflicts");
  });

  it("tells the user, in both states, that nothing is needed from them", () => {
    for (const queued of [false, true]) {
      expect(boardConflictFix({ live: true, queued })?.tooltip).toContain("nothing is needed");
    }
  });
});
