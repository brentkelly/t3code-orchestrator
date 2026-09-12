/**
 * The create-card submit shortcut (T3O-43): which keystrokes create the card,
 * and what the Create button says the shortcut is.
 */
import { describe, expect, it } from "vite-plus/test";

import {
  boardCardCreateShortcutLabel,
  isBoardCardCreateShortcut,
  type BoardCardCreateShortcutEvent,
} from "./boardCardCreateShortcut";

function keystroke(
  overrides: Partial<BoardCardCreateShortcutEvent> = {},
): BoardCardCreateShortcutEvent {
  return {
    key: "Enter",
    metaKey: false,
    ctrlKey: false,
    shiftKey: false,
    altKey: false,
    ...overrides,
  };
}

describe("isBoardCardCreateShortcut", () => {
  it("fires on Ctrl+Enter", () => {
    expect(isBoardCardCreateShortcut(keystroke({ ctrlKey: true }))).toBe(true);
  });

  it("fires on Cmd+Enter", () => {
    expect(isBoardCardCreateShortcut(keystroke({ metaKey: true }))).toBe(true);
  });

  it("ignores a bare Enter, which is the brief's newline", () => {
    expect(isBoardCardCreateShortcut(keystroke())).toBe(false);
  });

  it("ignores Enter with another key's modifiers", () => {
    expect(isBoardCardCreateShortcut(keystroke({ ctrlKey: true, shiftKey: true }))).toBe(false);
    expect(isBoardCardCreateShortcut(keystroke({ altKey: true, metaKey: true }))).toBe(false);
    expect(isBoardCardCreateShortcut(keystroke({ shiftKey: true }))).toBe(false);
  });

  it("ignores any other key held with the modifier", () => {
    expect(isBoardCardCreateShortcut(keystroke({ ctrlKey: true, key: "s" }))).toBe(false);
    expect(isBoardCardCreateShortcut(keystroke({ key: "Escape", metaKey: true }))).toBe(false);
  });

  it("ignores the Enter that commits an IME composition", () => {
    expect(isBoardCardCreateShortcut(keystroke({ ctrlKey: true, isComposing: true }))).toBe(false);
  });
});

describe("boardCardCreateShortcutLabel", () => {
  it("reads as Command on Apple platforms", () => {
    expect(boardCardCreateShortcutLabel("MacIntel")).toBe("⌘↵");
    expect(boardCardCreateShortcutLabel("iPad")).toBe("⌘↵");
  });

  it("reads as Ctrl everywhere else", () => {
    expect(boardCardCreateShortcutLabel("Win32")).toBe("Ctrl+↵");
    expect(boardCardCreateShortcutLabel("Linux x86_64")).toBe("Ctrl+↵");
  });
});
