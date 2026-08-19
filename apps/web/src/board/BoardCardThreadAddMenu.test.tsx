/**
 * t3o-14 — the card thread pane's `+` menu.
 *
 * The load-bearing invariant is the Planning-only gate on "restart planning".
 * It must never appear in Building: the supervisor owns build threads, and one
 * started through this path would carry the build prompt with no step state, no
 * worktree and no governor slot — a thread that looks like a build and that the
 * supervisor does not know exists.
 *
 * The gate is computed in `BoardCardDetail` and threaded through
 * `BoardCardDetailView` → `BoardCardThreadPane` → the menu, so both ends are
 * pinned here: `canRestartBoardPlanning` (the decision) and
 * `BoardCardThreadAddMenuBody` (the rows it produces). The popover itself
 * portals, and a portal renders nothing on the server, so the body is exported
 * separately rather than reached through the trigger.
 */
import { DEFAULT_BOARD_PLANNING_STEP } from "@t3tools/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { BoardCardThreadAddMenuBody } from "./BoardCardThreadAddMenu";
import { canRestartBoardPlanning } from "./boardCardThreadSpawn";

const noop = () => {};

const body = (canRestartPlanning: boolean, mode: "menu" | "adopt" = "menu") =>
  renderToStaticMarkup(
    <BoardCardThreadAddMenuBody
      adoptableThreads={[{ id: "thread-1", key: "", title: "An existing thread" }]}
      canRestartPlanning={canRestartPlanning}
      mode={mode}
      onAdoptThread={noop}
      onCreateBlankThread={noop}
      onEnterAdoptMode={noop}
      onRestartPlanning={noop}
    />,
  );

describe("canRestartBoardPlanning", () => {
  it("is Planning-only, and only while the recipe has a step", () => {
    expect(canRestartBoardPlanning("planning", DEFAULT_BOARD_PLANNING_STEP)).toBe(true);
    // Clearing every planning step in settings takes the item away too.
    expect(canRestartBoardPlanning("planning", null)).toBe(false);
  });

  it("is false in Building, where the supervisor owns the threads", () => {
    for (const stage of ["backlog", "sprint", "ready", "building", "review", "done"] as const) {
      expect(canRestartBoardPlanning(stage, DEFAULT_BOARD_PLANNING_STEP)).toBe(false);
    }
  });
});

describe("BoardCardThreadAddMenuBody", () => {
  it("offers all three actions in Planning", () => {
    const html = body(true);
    expect(html).toContain("Restart planning");
    expect(html).toContain("New blank thread");
    expect(html).toContain("Adopt an existing thread");
  });

  it("drops the restart row everywhere else, and the blank item becomes the plain New thread", () => {
    const html = body(false);
    expect(html).not.toContain("Restart planning");
    expect(html).toContain("New thread");
    expect(html).not.toContain("New blank thread");
    expect(html).toContain("Adopt an existing thread");
  });

  it("swaps the whole body for the thread search in adopt mode", () => {
    const html = body(true, "adopt");
    expect(html).toContain("An existing thread");
    expect(html).not.toContain("Restart planning");
  });
});
