/**
 * Board card filter (T3O-16): the top bar's filter box. Typing narrows the
 * board to the cards whose title or key matches, across every column, without
 * disturbing the ordering substrate the drag path anchors into.
 */
import type { BoardCardShell } from "@t3tools/contracts";
import type { BoardStageColumns } from "@t3tools/client-runtime/state/shell";
import { describe, expect, it } from "vite-plus/test";

import {
  boardCardMatchesQuery,
  countBoardColumnCards,
  filterBoardColumnsByQuery,
  normaliseBoardCardQuery,
} from "./boardCardFilter";

function card(key: string, title: string): Pick<BoardCardShell, "key" | "title"> {
  return { key, title } as Pick<BoardCardShell, "key" | "title">;
}

const columns = {
  backlog: [card("T3O-16", "Board view has lost its header"), card("T3O-17", "Stall detection")],
  building: [card("MW-33", "Nav overlaps hero on iPad portrait")],
  done: [],
} as unknown as BoardStageColumns;

describe("normaliseBoardCardQuery", () => {
  it("trims and lowercases so stray whitespace and caps still match", () => {
    expect(normaliseBoardCardQuery("  HeAdEr ")).toBe("header");
  });

  it("reads whitespace-only as no filter at all", () => {
    expect(normaliseBoardCardQuery("   ")).toBe("");
  });
});

describe("boardCardMatchesQuery", () => {
  const subject = card("T3O-16", "Board view has lost its header");

  it("keeps every card when nothing is typed", () => {
    expect(boardCardMatchesQuery(subject, "")).toBe(true);
  });

  it("matches a substring of the title", () => {
    expect(boardCardMatchesQuery(subject, "lost its")).toBe(true);
  });

  it("matches a card key, the way people quote a card", () => {
    expect(boardCardMatchesQuery(subject, "t3o-16")).toBe(true);
  });

  it("does not match an unrelated word", () => {
    expect(boardCardMatchesQuery(subject, "footer")).toBe(false);
  });

  it("matches title and key independently, not their concatenation", () => {
    // "header t3o" spans the two fields; a naive `title + " " + key` match
    // would let it through and claim a card the user never asked for.
    expect(boardCardMatchesQuery(subject, "header t3o")).toBe(false);
  });
});

describe("filterBoardColumnsByQuery", () => {
  it("returns the very same columns when the query is empty", () => {
    // Identity, not just equality: the unfiltered board must not rebuild every
    // column array on each keystroke of an emptied box.
    expect(filterBoardColumnsByQuery(columns, "   ")).toBe(columns);
  });

  it("narrows every column at once and keeps the columns that lose everything", () => {
    const filtered = filterBoardColumnsByQuery(columns, "nav");
    expect((filtered["backlog"] ?? []).map((entry) => entry.key)).toEqual([]);
    expect((filtered["building"] ?? []).map((entry) => entry.key)).toEqual(["MW-33"]);
    expect(Object.keys(filtered)).toEqual(["backlog", "building", "done"]);
  });

  it("keeps the surviving cards in their column order", () => {
    const filtered = filterBoardColumnsByQuery(columns, "t3o");
    expect((filtered["backlog"] ?? []).map((entry) => entry.key)).toEqual(["T3O-16", "T3O-17"]);
  });

  it("leaves the board empty when nothing matches", () => {
    expect(countBoardColumnCards(filterBoardColumnsByQuery(columns, "zzz"))).toBe(0);
  });
});

describe("countBoardColumnCards", () => {
  it("counts across every column", () => {
    expect(countBoardColumnCards(columns)).toBe(3);
  });
});
