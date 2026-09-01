/**
 * T3o board settings search index (t3o-07).
 *
 * Spread into the core `SETTINGS_SEARCH_ITEMS` (`components/settings/settingsSearch.ts`)
 * as `...BOARD_SETTINGS_SEARCH_ITEMS` — a t3o-02a registry spread, so each
 * board setting is findable beside the settings it belongs to without
 * enumerating board entries in that upstream-owned file. New board settings
 * register here, next to the panel section they anchor to. `targetId`s match
 * the section/row `id`s in `BoardSettingsPanel`.
 */
import type { SettingsSearchItem } from "../components/settings/settingsSearch";

export const BOARD_SETTINGS_SEARCH_ITEMS = [
  { id: "board-projects", title: "Card keys and colour", to: "/settings/board" },
  {
    id: "board-key-prefix",
    title: "Card key prefix",
    to: "/settings/board",
    targetId: "board-projects",
  },
  {
    id: "board-accent",
    title: "Project accent colour",
    to: "/settings/board",
    targetId: "board-projects",
  },
  { id: "board-pipeline", title: "Pipeline", to: "/settings/board" },
  {
    id: "board-default-model",
    title: "Board default model",
    to: "/settings/board",
    targetId: "board-pipeline",
  },
  { id: "board-concurrency", title: "Board concurrency", to: "/settings/board" },
  {
    id: "board-reclaim-worktree-on-done",
    title: 'Reclaim worktrees at "Done"',
    to: "/settings/board",
    targetId: "board-lifecycle",
  },
] as const satisfies ReadonlyArray<SettingsSearchItem>;
