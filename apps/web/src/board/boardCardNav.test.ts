/**
 * Card-to-card navigation (T3O-37, T3O-44): neighbour resolution across the
 * board's columns, and which keystrokes ask for a step.
 */
import type { BoardCardShell, BoardStageId } from "@t3tools/contracts";
import type { BoardStageColumns } from "@t3tools/client-runtime/state/shell";
import { describe, expect, it } from "vite-plus/test";

import {
  boardCardMaximisedAfterStep,
  boardCardNavStep,
  boardCardNavTarget,
  boardCardStepForKey,
  isBoardTextEntryTarget,
  resolveBoardCardNeighbours,
  type BoardCardNavKeyEvent,
} from "./boardCardNav";

function card(cardId: string, stage: string): BoardCardShell {
  return { cardId, key: cardId.toUpperCase(), title: cardId, stage } as unknown as BoardCardShell;
}

function columnsOf(shape: Record<string, ReadonlyArray<string>>): BoardStageColumns {
  return Object.fromEntries(
    Object.entries(shape).map(([stage, ids]) => [stage, ids.map((id) => card(id, stage))]),
  ) as BoardStageColumns;
}

function stages(...ids: ReadonlyArray<string>): ReadonlyArray<BoardStageId> {
  return ids as ReadonlyArray<BoardStageId>;
}

// Deliberately NOT in stage order in the object: a `BoardStageColumns` is keyed
// by stage id and carries no order of its own, so `stageOrder` is the only
// thing that can put the columns left to right.
const columns = columnsOf({
  review: ["d"],
  backlog: ["a", "b"],
  done: ["e", "f"],
  building: [],
});
const order = stages("backlog", "building", "review", "done");

describe("resolveBoardCardNeighbours", () => {
  it("gives both neighbours, in column order, for a card mid-column", () => {
    const neighbours = resolveBoardCardNeighbours(columns, order, "e");
    expect(neighbours.stage).toBe("done");
    expect(neighbours.prev?.cardId).toBe("d");
    expect(neighbours.next?.cardId).toBe("f");
  });

  it("steps off the bottom of a column into the top of the next one", () => {
    const neighbours = resolveBoardCardNeighbours(columns, order, "b");
    expect(neighbours.stage).toBe("backlog");
    expect(neighbours.next?.cardId).toBe("d");
  });

  it("steps off the top of a column into the bottom of the previous one", () => {
    const neighbours = resolveBoardCardNeighbours(columns, order, "d");
    expect(neighbours.stage).toBe("review");
    expect(neighbours.prev?.cardId).toBe("b");
    expect(neighbours.next?.cardId).toBe("e");
  });

  it("skips a stage holding no cards rather than dead-ending on it", () => {
    // Building is empty and sits between Backlog and Review in `order`.
    expect(resolveBoardCardNeighbours(columns, order, "b").next?.cardId).toBe("d");
    expect(resolveBoardCardNeighbours(columns, order, "d").prev?.cardId).toBe("b");
  });

  it("has no previous card only at the very start of the board", () => {
    const first = resolveBoardCardNeighbours(columns, order, "a");
    expect(first.prev).toBeNull();
    for (const cardId of ["b", "d", "e", "f"]) {
      expect(resolveBoardCardNeighbours(columns, order, cardId).prev).not.toBeNull();
    }
  });

  it("has no next card only at the very end of the board", () => {
    const last = resolveBoardCardNeighbours(columns, order, "f");
    expect(last.prev?.cardId).toBe("e");
    expect(last.next).toBeNull();
    for (const cardId of ["a", "b", "d", "e"]) {
      expect(resolveBoardCardNeighbours(columns, order, cardId).next).not.toBeNull();
    }
  });

  it("reads the columns in stage order, not in the column map's key order", () => {
    // Reversing the stage order reverses which way each step goes, over the
    // very same columns object.
    const reversed = stages("done", "review", "building", "backlog");
    const neighbours = resolveBoardCardNeighbours(columns, reversed, "d");
    expect(neighbours.prev?.cardId).toBe("f");
    expect(neighbours.next?.cardId).toBe("a");
  });

  it("never steps into a stage the board is not rendering", () => {
    // A sub-board renders the materialisation floor onward, so its pre-floor
    // columns are not part of the list even though the map still keys them.
    const subBoard = stages("review", "done");
    const neighbours = resolveBoardCardNeighbours(columns, subBoard, "d");
    expect(neighbours.prev).toBeNull();
    expect(neighbours.next?.cardId).toBe("e");
  });

  it("reports a card in an unrendered stage as absent, so the rails go quiet", () => {
    const neighbours = resolveBoardCardNeighbours(columns, stages("review", "done"), "a");
    expect(neighbours.stage).toBeNull();
    expect(neighbours.prev).toBeNull();
    expect(neighbours.next).toBeNull();
  });

  it("reports a card the filters are hiding as absent, so the rails go quiet", () => {
    const neighbours = resolveBoardCardNeighbours(columns, order, "missing");
    expect(neighbours.stage).toBeNull();
    expect(neighbours.prev).toBeNull();
    expect(neighbours.next).toBeNull();
  });

  it("resolves nothing with no card open", () => {
    expect(resolveBoardCardNeighbours(columns, order, null).stage).toBeNull();
  });

  it("resolves nothing over empty columns", () => {
    const neighbours = resolveBoardCardNeighbours(columnsOf({ backlog: [] }), order, "a");
    expect(neighbours.stage).toBeNull();
    expect(neighbours.prev).toBeNull();
    expect(neighbours.next).toBeNull();
  });
});

describe("boardCardNavTarget", () => {
  const labels = new Map([
    ["backlog", "Backlog"],
    ["review", "Code review"],
  ]);

  it("names the target's column when the step crosses stages", () => {
    const target = boardCardNavTarget(card("d", "review"), "backlog" as BoardStageId, labels);
    expect(target).toEqual({ key: "D", title: "d", stageLabel: "Code review" });
  });

  it("names no column when the step stays in this one", () => {
    const target = boardCardNavTarget(card("b", "backlog"), "backlog" as BoardStageId, labels);
    expect(target?.stageLabel).toBeNull();
  });

  it("names the card alone when the stage has no label to give", () => {
    const target = boardCardNavTarget(card("e", "done"), "backlog" as BoardStageId, labels);
    expect(target?.stageLabel).toBeNull();
  });

  it("has no target where there is no card", () => {
    expect(boardCardNavTarget(null, "backlog" as BoardStageId, labels)).toBeNull();
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

describe("boardCardNavStep", () => {
  const target = { key: "T3O-1", title: "A card", stageLabel: null };
  const both = { prev: target, next: target };

  it("takes the step a live keystroke asks for", () => {
    expect(boardCardNavStep(both, keyEvent({ key: "ArrowRight" }), null)).toBe(1);
    expect(boardCardNavStep(both, keyEvent({ key: "k" }), null)).toBe(-1);
  });

  it("does nothing at the start of the board, where the left rail is absent too", () => {
    const atStart = { prev: null, next: target };
    expect(boardCardNavStep(atStart, keyEvent({ key: "ArrowLeft" }), null)).toBeNull();
    expect(boardCardNavStep(atStart, keyEvent({ key: "ArrowRight" }), null)).toBe(1);
  });

  it("does nothing at the end of the board", () => {
    const atEnd = { prev: target, next: null };
    expect(boardCardNavStep(atEnd, keyEvent({ key: "ArrowRight" }), null)).toBeNull();
    expect(boardCardNavStep(atEnd, keyEvent({ key: "ArrowLeft" }), null)).toBe(-1);
  });

  it("does nothing with no navigation at all — an archived or filtered-out card", () => {
    expect(boardCardNavStep(null, keyEvent({ key: "ArrowRight" }), null)).toBeNull();
  });

  it("still stands down for a text caret even with both neighbours present", () => {
    expect(boardCardNavStep(both, keyEvent({ key: "j" }), element("textarea"))).toBeNull();
  });
});

describe("boardCardMaximisedAfterStep", () => {
  it("carries fullscreen to the card the step lands on", () => {
    expect(boardCardMaximisedAfterStep("a", "a", "b")).toBe("b");
  });

  it("leaves a windowed sheet windowed", () => {
    expect(boardCardMaximisedAfterStep(null, "a", "b")).toBeNull();
  });

  it("does not hand fullscreen to a card stepped to from a DIFFERENT card", () => {
    // The flag belongs to card "a" — the one the user actually maximised —
    // and a step between two other cards must not steal it. This is the leak
    // a bare "the sheet is fullscreen" boolean could not express: it would
    // have opened every card of that walk full-screen.
    expect(boardCardMaximisedAfterStep("a", "b", "c")).toBe("a");
  });

  it("does not adopt a step taken with no card open", () => {
    expect(boardCardMaximisedAfterStep("a", null, "b")).toBe("a");
  });
});
