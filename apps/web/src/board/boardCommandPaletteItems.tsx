/**
 * The board's command palette entries (T3O-29): drill into the selected
 * group's board, and back up one level. The mounted board publishes them to
 * `boardUiStore`, so the palette lists them without subscribing to anything.
 */
import { LayersIcon } from "lucide-react";

import { ITEM_ICON_CLASS, type CommandPaletteActionItem } from "../components/CommandPalette.logic";
import { useBoardUiStore, type BoardPaletteAction } from "./boardUiStore";

/** The palette rows for the board's published actions. */
export function boardCommandPaletteItems(
  actions: ReadonlyArray<BoardPaletteAction>,
): ReadonlyArray<CommandPaletteActionItem> {
  return actions.map((action) => ({
    kind: "action",
    value: `board:${action.id}`,
    searchTerms: ["board", "group", "sub-board", ...action.title.toLowerCase().split(/\s+/)],
    title: action.title,
    description: action.description,
    icon: <LayersIcon className={ITEM_ICON_CLASS} />,
    run: async () => {
      action.run();
    },
  }));
}

export function useBoardCommandPaletteItems(): ReadonlyArray<CommandPaletteActionItem> {
  return boardCommandPaletteItems(useBoardUiStore((state) => state.paletteActions));
}
