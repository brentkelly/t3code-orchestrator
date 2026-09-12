/**
 * Card-to-card navigation (T3O-37): neighbour resolution inside one column,
 * and which keystrokes ask for a step.
 */
import type { BoardCardShell } from "@t3tools/contracts";
import type { BoardStageColumns } from "@t3tools/client-runtime/state/shell";
import { describe, expect, it } from "vite-plus/test";

import {
  boardCardStepForKey,
  isBoardTextEntryTarget,
  resolveBoardCardNeighbours,
  type BoardCardNavKeyEvent,
} from "./boardCardNav";

function card(cardId: string): BoardCardShell {
  return { cardId, key: cardId.toUpperCase(), title: cardId } as unknown as BoardCardShell;
}

function columnsOf(shape: Record<string, ReadonlyArray<string>>): BoardStageColumns {
  return Object.fromEntries(
    Object.entries(shape).map(([stage, ids]) => [stage, ids.map(card)]),
  ) as BoardStageColumns;
}

const columns = columnsOf({
  building: ["a", "b", "c"],
  review: ["d"],
  done: [],
});

describe("resolveBoardCardNeighbours", () => {
  it("gives both neighbours, in column order, for a card mid-column", () => {
    const neighbours = resolveBoardCardNeighbours(columns, "b");
    expect(neighbours.stage).toBe("building");
    expect(neighbours.index).toBe(1);
    expect(neighbours.total).toBe(3);
    expect(neighbours.prev?.cardId).toBe("a");
    expect(neighbours.next?.cardId).toBe("c");
  });

  it("has no previous card at the top of a column", () => {
    const neighbours = resolveBoardCardNeighbours(columns, "a");
    expect(neighbours.index).toBe(0);
    expect(neighbours.prev).toBeNull();
    expect(neighbours.next?.cardId).toBe("b");
  });

  it("has no next card at the bottom of a column", () => {
    const neighbours = resolveBoardCardNeighbours(columns, "c");
    expect(neighbours.index).toBe(2);
    expect(neighbours.prev?.cardId).toBe("b");
    expect(neighbours.next).toBeNull();
  });

  it("never steps out of the card's own column into an adjacent one", () => {
    // `d` is alone in Review and sits between Building and Done in the map;
    // a naive flatten would hand back `c` and nothing would say the user had
    // crossed a column boundary.
    const neighbours = resolveBoardCardNeighbours(columns, "d");
    expect(neighbours.stage).toBe("review");
    expect(neighbours.total).toBe(1);
    expect(neighbours.prev).toBeNull();
    expect(neighbours.next).toBeNull();
  });

  it("reports a card the filters are hiding as absent, so the rails go quiet", () => {
    const neighbours = resolveBoardCardNeighbours(columns, "missing");
    expect(neighbours.stage).toBeNull();
    expect(neighbours.index).toBe(-1);
    expect(neighbours.total).toBe(0);
    expect(neighbours.prev).toBeNull();
    expect(neighbours.next).toBeNull();
  });

  it("resolves nothing with no card open", () => {
    expect(resolveBoardCardNeighbours(columns, null).index).toBe(-1);
  });

  it("resolves nothing over empty columns", () => {
    const neighbours = resolveBoardCardNeighbours(columnsOf({ building: [] }), "a");
    expect(neighbours.index).toBe(-1);
    expect(neighbours.prev).toBeNull();
    expect(neighbours.next).toBeNull();
  });
});

function keyEvent(
  overrides: Partial<BoardCardNavKeyEvent> & { key: string },
): BoardCardNavKeyEvent {
  return {
    metaKey: false,
    ctrlKey: false,
    altKey: false,
    shiftKey: false,
    repeat: false,
    ...overrides,
  };
}

/** A stand-in for a focused node — the suite runs without a DOM, and the
    resolution only ever reads the tag name and the editable flag. */
function element(tagName: string, contentEditable = false): Element {
  return {
    tagName: tagName.toUpperCase(),
    isContentEditable: contentEditable,
  } as unknown as Element;
}

describe("boardCardStepForKey", () => {
  it("steps forward on the right arrow and on J", () => {
    expect(boardCardStepForKey(keyEvent({ key: "ArrowRight" }), null)).toBe(1);
    expect(boardCardStepForKey(keyEvent({ key: "j" }), null)).toBe(1);
    expect(boardCardStepForKey(keyEvent({ key: "J" }), null)).toBe(1);
  });

  it("steps back on the left arrow and on K", () => {
    expect(boardCardStepForKey(keyEvent({ key: "ArrowLeft" }), null)).toBe(-1);
    expect(boardCardStepForKey(keyEvent({ key: "k" }), null)).toBe(-1);
    expect(boardCardStepForKey(keyEvent({ key: "K" }), null)).toBe(-1);
  });

  it("leaves the up and down arrows to scroll the sheet", () => {
    expect(boardCardStepForKey(keyEvent({ key: "ArrowUp" }), null)).toBeNull();
    expect(boardCardStepForKey(keyEvent({ key: "ArrowDown" }), null)).toBeNull();
  });

  it("ignores any keystroke with a modifier held", () => {
    for (const modifier of ["metaKey", "ctrlKey", "altKey", "shiftKey"] as const) {
      expect(
        boardCardStepForKey(keyEvent({ key: "ArrowRight", [modifier]: true }), null),
      ).toBeNull();
    }
  });

  it("ignores auto-repeat, so holding a key cannot flood the socket", () => {
    expect(boardCardStepForKey(keyEvent({ key: "ArrowRight", repeat: true }), null)).toBeNull();
  });

  it("ignores unrelated keys", () => {
    for (const key of ["a", "Enter", "Escape", " ", "Tab", "h", "l"]) {
      expect(boardCardStepForKey(keyEvent({ key }), null)).toBeNull();
    }
  });

  it("stands down while a text caret owns the keystroke", () => {
    for (const target of [
      element("input"),
      element("textarea"),
      element("select"),
      element("div", true),
    ]) {
      expect(boardCardStepForKey(keyEvent({ key: "ArrowRight" }), target)).toBeNull();
      expect(boardCardStepForKey(keyEvent({ key: "j" }), target)).toBeNull();
    }
  });

  it("still steps when focus sits on a plain element", () => {
    expect(boardCardStepForKey(keyEvent({ key: "j" }), element("button"))).toBe(1);
  });
});

describe("isBoardTextEntryTarget", () => {
  it("reads no focused element as no caret", () => {
    expect(isBoardTextEntryTarget(null)).toBe(false);
  });

  it("reads a non-editable div as no caret", () => {
    expect(isBoardTextEntryTarget(element("div"))).toBe(false);
  });

  it("reads a contenteditable region as a caret", () => {
    expect(isBoardTextEntryTarget(element("div", true))).toBe(true);
  });
});
