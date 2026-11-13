import { BOARD_SEED_STAGES, BOARD_SEED_STAGE_IDS } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  boardCardBlocksHint,
  boardCardPriorityFromShortcut,
  boardCardPriorityStartedNote,
} from "./boardCardPriority";

const key = (
  code: string,
  modifiers: {
    alt?: boolean;
    ctrl?: boolean;
    meta?: boolean;
    key?: string;
    editable?: boolean;
  } = {},
) => ({
  altKey: modifiers.alt ?? true,
  ctrlKey: modifiers.ctrl ?? false,
  metaKey: modifiers.meta ?? false,
  code,
  key: modifiers.key ?? "¡",
  editable: modifiers.editable ?? false,
});

describe("boardCardPriorityFromShortcut", () => {
  it("maps Alt+1–4 to Low → Urgent by key position, not the typed character", () => {
    expect(
      ["Digit1", "Digit2", "Digit3", "Digit4"].map((code) =>
        boardCardPriorityFromShortcut(key(code)),
      ),
    ).toEqual(["low", "normal", "high", "urgent"]);
  });

  it("ignores other digits, plain digits and other modifiers", () => {
    expect(boardCardPriorityFromShortcut(key("Digit5"))).toBeNull();
    expect(boardCardPriorityFromShortcut(key("Digit1", { alt: false }))).toBeNull();
    expect(boardCardPriorityFromShortcut(key("Digit1", { ctrl: true }))).toBeNull();
    expect(boardCardPriorityFromShortcut(key("Digit1", { meta: true }))).toBeNull();
  });

  it("leaves a character Alt+digit types in a text field to the field", () => {
    // Option+2 on a Swedish Mac types @, the brief's mention trigger.
    expect(boardCardPriorityFromShortcut(key("Digit2", { key: "@", editable: true }))).toBeNull();
    expect(boardCardPriorityFromShortcut(key("Digit4", { key: "4", editable: true }))).toBe(
      "urgent",
    );
  });
});

describe("boardCardPriorityStartedNote", () => {
  const note = (stageId: string, running: boolean) =>
    boardCardPriorityStartedNote({ stageId, running, stages: BOARD_SEED_STAGES });

  it("shows past the first slot-taking stage, or while the card's step runs", () => {
    expect(note(BOARD_SEED_STAGE_IDS.review, false)).toContain("already in Code review");
    expect(note(BOARD_SEED_STAGE_IDS.building, true)).toContain("already in Building");
  });

  it("never shows on a queued card that has not started, before build, or in Done", () => {
    expect(note(BOARD_SEED_STAGE_IDS.building, false)).toBeNull();
    expect(note(BOARD_SEED_STAGE_IDS.ready, false)).toBeNull();
    expect(note(BOARD_SEED_STAGE_IDS.done, false)).toBeNull();
  });
});

describe("boardCardBlocksHint", () => {
  it("names a blocked card only when it outranks this one", () => {
    expect(boardCardBlocksHint("normal", "urgent")).toBe("Blocks an Urgent card");
    expect(boardCardBlocksHint("low", "high")).toBe("Blocks a High card");
    expect(boardCardBlocksHint("high", "high")).toBeNull();
    expect(boardCardBlocksHint("urgent", "high")).toBeNull();
    expect(boardCardBlocksHint("normal", null)).toBeNull();
  });
});
