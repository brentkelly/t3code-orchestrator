/**
 * The board's command palette entries: switching between the Board, List and
 * Threads modes (T3O-30), plus whatever the mounted board publishes to
 * `boardUiStore` (T3O-29: drill into the selected group, back up one level),
 * so the palette lists them without subscribing to the board itself.
 */
import { useRouter, useRouterState } from "@tanstack/react-router";
import { Columns3Icon, LayersIcon, ListTreeIcon, MessageSquareIcon } from "lucide-react";

import { ITEM_ICON_CLASS, type CommandPaletteActionItem } from "../components/CommandPalette.logic";
import { navigateToMode } from "./BoardModeTabs";
import {
  modeForHref,
  useBoardUiStore,
  type BoardPaletteAction,
  type WorkspaceMode,
} from "./boardUiStore";

/** The palette rows for the board's published actions. */
function boardCommandPaletteItems(
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

const MODE_ITEMS: ReadonlyArray<{
  readonly mode: WorkspaceMode;
  readonly title: string;
  readonly description: string;
  readonly searchTerms: ReadonlyArray<string>;
  readonly Icon: typeof Columns3Icon;
}> = [
  {
    mode: "board",
    title: "Go to Board",
    description: "Cards in stage columns",
    searchTerms: ["board", "kanban", "mode", "columns"],
    Icon: Columns3Icon,
  },
  {
    mode: "list",
    title: "Go to List",
    description: "Every card as an outline: indent, outdent and move",
    searchTerms: ["list", "outline", "tree", "mode", "group", "indent"],
    Icon: ListTreeIcon,
  },
  {
    mode: "threads",
    title: "Go to Threads",
    description: "Threads and chats",
    searchTerms: ["threads", "chat", "mode"],
    Icon: MessageSquareIcon,
  },
];

/** "Go to Board / List / Threads", leaving out the mode you are in. Off the
    workspace (settings, pairing) only the board-owned modes are offered. */
function useBoardModePaletteItems(): ReadonlyArray<CommandPaletteActionItem> {
  const router = useRouter();
  const href = useRouterState({ select: (state) => state.location.href });
  const lastLocationByMode = useBoardUiStore((state) => state.lastLocationByMode);
  const current = modeForHref(href);
  return MODE_ITEMS.filter(
    (item) => item.mode !== current && (current !== null || item.mode !== "threads"),
  ).map((item) => ({
    kind: "action",
    value: `board-mode:${item.mode}`,
    searchTerms: [...item.searchTerms],
    title: item.title,
    description: item.description,
    icon: <item.Icon className={ITEM_ICON_CLASS} />,
    run: async () => {
      navigateToMode(router, current ?? "threads", item.mode, lastLocationByMode);
    },
  }));
}

export function useBoardCommandPaletteItems(): ReadonlyArray<CommandPaletteActionItem> {
  const modeItems = useBoardModePaletteItems();
  const published = boardCommandPaletteItems(useBoardUiStore((state) => state.paletteActions));
  return [...modeItems, ...published];
}
