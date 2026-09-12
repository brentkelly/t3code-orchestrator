/**
 * The create-card submit shortcut (T3O-43). Mod+Enter creates the card from
 * anywhere in the create dialog — title, brief, dependency picker — rather than
 * from the title field alone, and the Create button carries the label so the
 * shortcut is discoverable instead of folklore.
 *
 * Either modifier fires it on every platform (a Mac user with a PC keyboard
 * habit should not be told no); only the label is platform-shaped.
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
