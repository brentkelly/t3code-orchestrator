import { describe, expect, it } from "vite-plus/test";

import {
  BOARD_CARD_COMPACT_CHROME_QUERY,
  boardCardCompactChrome,
  boardCardCompactThreadLabel,
  boardCardThreadLinkHint,
} from "./boardCardCompactChrome";

describe("boardCardCompactChrome", () => {
  it("is on only when the sheet is maximised on a short viewport", () => {
    expect(boardCardCompactChrome(true, true)).toBe(true);
    expect(boardCardCompactChrome(true, false)).toBe(false);
    expect(boardCardCompactChrome(false, true)).toBe(false);
    expect(boardCardCompactChrome(false, false)).toBe(false);
  });

  it("uses the same height cutoff as the T3O-51 sheet", () => {
    expect(BOARD_CARD_COMPACT_CHROME_QUERY).toBe("(max-height: 999.98px)");
  });
});

describe("boardCardCompactThreadLabel", () => {
  it("joins the role and title, and names a missing title a deleted thread", () => {
    expect(boardCardCompactThreadLabel("planning", "T3-7 · Planning")).toBe(
      "planning · T3-7 · Planning",
    );
    expect(boardCardCompactThreadLabel("building", null)).toBe("building · Deleted thread");
  });
});

describe("boardCardThreadLinkHint", () => {
  it("matches the tab-strip hover: role, then the worker when one is set", () => {
    expect(boardCardThreadLinkHint({ tombstoned: false, role: "planning", ranOn: null })).toBe(
      "planning",
    );
    expect(
      boardCardThreadLinkHint({
        tombstoned: false,
        role: "building",
        ranOn: "ran on linux-box",
      }),
    ).toBe("building · ran on linux-box");
    expect(
      boardCardThreadLinkHint({ tombstoned: true, role: "linked", ranOn: "ran on linux-box" }),
    ).toBe("Deleted thread");
  });
});
