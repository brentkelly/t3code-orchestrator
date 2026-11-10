/**
 * Mod+Enter creates the card from anywhere in the create dialog. Either modifier
 * works on every platform; only the label is platform-shaped.
 */
import { isMacPlatform } from "../lib/utils";

export interface BoardCardCreateShortcutEvent {
  readonly key: string;
  readonly metaKey: boolean;
  readonly ctrlKey: boolean;
  readonly shiftKey: boolean;
  readonly altKey: boolean;
  /** Enter mid-IME commits the composition. It must not also submit the card. */
  readonly isComposing?: boolean;
}

export function isBoardCardCreateShortcut(event: BoardCardCreateShortcutEvent): boolean {
  if (event.key !== "Enter") return false;
  if (event.isComposing === true) return false;
  // Shift+Enter is the brief's newline and Alt+Enter belongs to nobody here:
  // an extra modifier means the user asked for something else.
  if (event.shiftKey || event.altKey) return false;
  return event.metaKey || event.ctrlKey;
}

export function boardCardCreateShortcutLabel(platform: string = navigator.platform): string {
  return isMacPlatform(platform) ? "⌘↵" : "Ctrl+↵";
}
